// controllers/result.controller.js
import Result from "../models/result.js";
import Course from "../models/course.js";
import Student from "../models/student.js";
import Lecturer from "../models/lecturer.js";
import CourseRegistration from "../models/courseRegistration.js";
import calculateAcademicMetrics from '../utills/calculateAcademicMetrics.js';
import AcademicMetrics from '../models/academicMetrics.js';
import mongoose from 'mongoose';
import {
  buildDepartmentScopeFilter,
  ensureResourceMatchesUserScope,
  ensureUserCanAccessDepartment,
} from '../services/accessControl.js';

const DEFAULT_DEPARTMENT_NAME = 'Biochemistry';
const DEFAULT_COLLEGE_NAME = 'Biological Science';


// === helper: letter grade from numeric total ===
function gradeFromScore(score) {
  const s = Number(score) || 0;
  if (s >= 70) return 'A';
  if (s >= 60) return 'B';
  if (s >= 50) return 'C';
  if (s >= 45) return 'D';
  if (s >= 40) return 'E';
  return 'F';
}

// Helper: build attempted courses for a student in a term using registrations ∪ results
async function computeAttemptedCourses(studentId, session, semester, level) {
  const sem = Number(semester);
  const lvl = String(level);
  const sid = new mongoose.Types.ObjectId(studentId);

  // All registered courseIds for this student in the term
  const regAgg = await CourseRegistration.aggregate([
    { $match: { session, semester: sem, level: lvl } },
    { $unwind: '$student' },
    { $match: { student: sid } },
    { $group: { _id: null, courses: { $addToSet: '$course' } } },
  ]);

  const regCourseIds = new Set((regAgg[0]?.courses || []).map((id) => String(id)));

  // Existing results for the term (with units)
  const resDocs = await Result.find({ student: sid, session, semester: sem, level: lvl })
    .populate('course', 'unit')
    .lean();

  const byCourse = new Map(
    resDocs.map((r) => [String(r.course._id), { unit: Number(r.course.unit) || 0, grade: String(r.grade || 'F') }])
  );

  // Missing courses (registered but no score)
  const missingIds = [...regCourseIds].filter((cid) => !byCourse.has(cid));
  let missingCourses = [];
  if (missingIds.length) {
    missingCourses = await Course.find({ _id: { $in: missingIds } }).select('_id unit').lean();
  }
  const infoById = new Map(missingCourses.map((c) => [String(c._id), Number(c.unit) || 0]));

  const attempted = [];

  // Count every registered course (results first, else F)
  for (const cid of regCourseIds) {
    if (byCourse.has(cid)) {
      attempted.push(byCourse.get(cid));
    } else {
      attempted.push({ unit: infoById.get(cid) || 0, grade: 'F' });
    }
  }

  // If somehow there is a result but no registration row, count the result (safety)
  if (!regCourseIds.size) {
    for (const v of byCourse.values()) attempted.push(v);
  }

  return attempted;
}

const studentInstitutionCache = new Map();

async function getStudentInstitution(studentId) {
  if (!studentId) {
    return { departmentName: '', collegeName: '' };
  }
  const key = String(studentId);
  if (studentInstitutionCache.has(key)) {
    return studentInstitutionCache.get(key);
  }
  const doc = await Student.findById(studentId)
    .populate('department', 'name')
    .populate('college', 'name')
    .select('_id department college')
    .lean();

  const info = {
    departmentName: doc?.department?.name || '',
    collegeName: doc?.college?.name || '',
  };
  studentInstitutionCache.set(key, info);
  return info;
}

// Create
export const createResult = async (req, res) => {
  try {
    const {
      course,             // ObjectId string
      studentRegNo,       // Reg No
      lecturerStaffId,    // PF No
      department,
      session,
      semester,
      date,
      level,
      resultType,
      // detailed inputs (optional)
      q1, q2, q3, q4, q5, q6, q7, q8,
      ca,
      // optional simple input
      grandtotal,
      // optional incoming grade (ignored; we recompute)
      grade
    } = req.body;

    // --- required fields sanity ---
    if (!course || !studentRegNo || !lecturerStaffId || !session || !semester || !date || !level || !resultType) {
      return res.status(400).json({ message: "Missing required fields." });
    }

    // --- resolve course/student/lecturer ---
    const courseDoc = await Course.findById(course)
      .select("_id unit department college programme programmeType")
      .lean();
    if (!courseDoc) return res.status(404).json({ message: "Course not found." });

    ensureUserCanAccessDepartment(req.user, courseDoc.department, courseDoc.college);

    const student = await Student.findOne({ regNo: studentRegNo })
      .populate('department', 'name')
      .populate('college', 'name')
      .select("_id level department college")
      .lean();
    if (!student) return res.status(404).json({ message: `Student with regNo "${studentRegNo}" not found.` });

    const lecturer = await Lecturer.findOne({ pfNo: lecturerStaffId }).select("_id").lean();
    if (!lecturer) return res.status(404).json({ message: `Lecturer with staff ID "${lecturerStaffId}" not found.` });

    const n = (v) => (v === undefined || v === null || v === "" ? undefined : Math.round(Number(v)));

    // Detect which fields were actually sent (so we can distinguish 0 vs not provided)
    const hasKey = (k) => Object.prototype.hasOwnProperty.call(req.body, k) && req.body[k] !== "" && req.body[k] !== null;

    const qValsRaw = { q1, q2, q3, q4, q5, q6, q7, q8 };
    const hasAnyQ  = Object.keys(qValsRaw).some((k) => hasKey(k));
    const hasCA    = hasKey('ca');
    const hasGrand = hasKey('grandtotal');

    // Normalize numbers only for provided fields
    const qNums = {};
    for (const k of ['q1','q2','q3','q4','q5','q6','q7','q8']) {
      if (hasKey(k)) qNums[k] = Math.max(0, Number(n(qValsRaw[k]) || 0));
    }
    const caNumProvided = hasCA ? Math.max(0, Number(n(ca) || 0)) : undefined;
    const grandProvided = hasGrand ? Math.min(100, Math.max(0, Number(n(grandtotal) || 0))) : undefined;

    const resolvedDepartment =
      (student.department && typeof student.department === 'object' && student.department !== null
        ? student.department.name
        : '') ||
      (typeof department === 'string' ? department : '');
    const resolvedCollege =
      (student.college && typeof student.college === 'object' && student.college !== null
        ? student.college.name
        : '') || '';
    const fallbackDepartment = resolvedDepartment || DEFAULT_DEPARTMENT_NAME;
    const fallbackCollege = resolvedCollege || DEFAULT_COLLEGE_NAME;

    // === Mode selection ===
    // SIMPLE: grandtotal provided AND no CA AND no Q’s → trust grand total
    // DETAILED: otherwise, compute from CA + Q’s (missing pieces default to 0)
    let payload = {
      course: courseDoc._id,
      student: student._id,
      lecturer: lecturer._id,
      department: String(fallbackDepartment),
      college: String(fallbackCollege),
      session: String(session),
      semester: Number(semester),
      date: new Date(date),
      level: String(level),
      resultType: String(resultType),
    };

    if (hasGrand && !hasCA && !hasAnyQ) {
      // ----- SIMPLE MODE -----
      const gt = grandProvided ?? 0; // already clamped 0..100
      const gradeAuto = gradeFromScore(gt);

      payload = {
        ...payload,
        grandtotal: gt,
        grade: gradeAuto,
        // deliberately DO NOT set ca/totalexam/q1..q8
      };

    } else {
      // ----- DETAILED MODE -----
      // Use 0 for any missing question values in computation
      const qSum = ['q1','q2','q3','q4','q5','q6','q7','q8']
        .reduce((acc, k) => acc + (qNums[k] ?? 0), 0);

      // clamp exam and CA
      const examClamped = Math.min(70, Math.max(0, qSum));
      const caClamped   = Math.min(30, Math.max(0, caNumProvided ?? 0));

      // validations (only in detailed mode)
      if (caClamped > 30) {
        return res.status(400).json({ message: "CA must be between 0 and 30" });
      }
      if (examClamped > 70) {
        return res.status(400).json({ message: "Exam total must be between 0 and 70" });
      }

      const grand = Math.min(100, caClamped + examClamped);
      const gradeAuto = gradeFromScore(grand);

      // Only store Q fields that were actually sent (and non-zero is optional — up to you)
      payload = {
        ...payload,
        ...(qNums.q1 !== undefined ? { q1: qNums.q1 } : {}),
        ...(qNums.q2 !== undefined ? { q2: qNums.q2 } : {}),
        ...(qNums.q3 !== undefined ? { q3: qNums.q3 } : {}),
        ...(qNums.q4 !== undefined ? { q4: qNums.q4 } : {}),
        ...(qNums.q5 !== undefined ? { q5: qNums.q5 } : {}),
        ...(qNums.q6 !== undefined ? { q6: qNums.q6 } : {}),
        ...(qNums.q7 !== undefined ? { q7: qNums.q7 } : {}),
        ...(qNums.q8 !== undefined ? { q8: qNums.q8 } : {}),
        ca: caClamped,
        totalexam: examClamped,
        grandtotal: grand,
        grade: gradeAuto,
      };
    }

    const newResult = await Result.create(payload);
    return res.status(201).json(newResult);
  } catch (error) {
    console.error("Error creating result:", error);
    if (error.name === "ValidationError") {
      return res.status(400).json({ message: "Validation Error", errors: error.errors });
    }
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// Read All with optional pagination
export const getAllResults = async (req, res) => {
  try {
    const {
      regNo,
      courseCode,
      session,
      level,
      semester,
      name,
      q,
      course,
      resultType,
      limit: limitParam,
      page: pageParam,
    } = req.query;

    const limitNum = Number(limitParam);
    const pageNum = Number(pageParam);
    const limit = Number.isFinite(limitNum) && limitNum > 0 ? Math.min(limitNum, 500) : 0;
    const page = Number.isFinite(pageNum) && pageNum > 0 ? pageNum : 1;
    const skip = limit ? (page - 1) * limit : 0;

    const pipeline = [];
    const baseMatch = {};

    if (session) baseMatch.session = String(session);
    if (level) baseMatch.level = String(level);
    if (semester) baseMatch.semester = Number(semester);
    if (resultType) baseMatch.resultType = String(resultType).toUpperCase();
    if (course) {
      if (!mongoose.Types.ObjectId.isValid(course)) {
        return res.status(400).json({ message: 'Invalid course ID supplied.' });
      }
      baseMatch.course = new mongoose.Types.ObjectId(course);
    }

    if (Object.keys(baseMatch).length) {
      pipeline.push({ $match: baseMatch });
    }

    pipeline.push(
      { $lookup: { from: 'students', localField: 'student', foreignField: '_id', as: 'studentInfo' } },
      { $unwind: '$studentInfo' },
      { $lookup: { from: 'courses', localField: 'course', foreignField: '_id', as: 'courseInfo' } },
      { $unwind: '$courseInfo' }
    );

    const scopeFilter = buildDepartmentScopeFilter(req.user);
    if (scopeFilter.department) {
      pipeline.push({
        $match: { 'courseInfo.department': new mongoose.Types.ObjectId(scopeFilter.department) },
      });
    }

    pipeline.push({ $lookup: { from: 'lecturers', localField: 'lecturer', foreignField: '_id', as: 'lecturerInfo' } });
    pipeline.push({ $unwind: { path: '$lecturerInfo', preserveNullAndEmptyArrays: true } });

    const andFilters = [];
    if (regNo) {
      andFilters.push({ 'studentInfo.regNo': { $regex: regNo, $options: 'i' } });
    }
    if (courseCode) {
      andFilters.push({ 'courseInfo.code': { $regex: courseCode, $options: 'i' } });
    }

    pipeline.push({
      $addFields: {
        fullName: {
          $trim: {
            input: {
              $concat: [
                { $ifNull: ['$studentInfo.surname', ''] }, ' ',
                { $ifNull: ['$studentInfo.firstname', ''] }, ' ',
                { $ifNull: ['$studentInfo.middlename', ''] },
              ],
            },
          },
        },
      },
    });

    const term = (q || name || '').trim();
    if (term) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = { $regex: escaped, $options: 'i' };
      andFilters.push({
        $or: [
          { 'studentInfo.regNo': rx },
          { 'studentInfo.surname': rx },
          { 'studentInfo.firstname': rx },
          { 'studentInfo.middlename': rx },
          { fullName: rx },
        ],
      });
    }

    if (andFilters.length) {
      pipeline.push({ $match: { $and: andFilters } });
    }

    pipeline.push({
      $addFields: {
        regNoNumeric: {
          $convert: {
            input: { $arrayElemAt: [{ $split: ['$studentInfo.regNo', '/'] }, 1] },
            to: 'int',
            onError: 0,
            onNull: 0,
          },
        },
      },
    });

    const projectionStage = {
      $project: {
        _id: 1,
        department: 1,
        session: 1,
        semester: 1,
        level: 1,
        grade: 1,
        totalexam: 1,
        ca: 1,
        grandtotal: 1,
        moderated: 1,
        moderationStatus: 1,
        moderationPendingGrandtotal: 1,
        moderationOriginalGrandtotal: 1,
        moderationApprovedAt: 1,
        moderationProof: 1,
        moderationAuthorizedPfNo: 1,
        q1: 1,
        q2: 1,
        q3: 1,
        q4: 1,
        q5: 1,
        q6: 1,
        q7: 1,
        q8: 1,
        createdAt: 1,
        updatedAt: 1,
        student: {
          _id: '$studentInfo._id',
          surname: '$studentInfo.surname',
          firstname: '$studentInfo.firstname',
          middlename: '$studentInfo.middlename',
          regNo: '$studentInfo.regNo',
        },
        course: {
          _id: '$courseInfo._id',
          title: '$courseInfo.title',
          code: '$courseInfo.code',
          unit: '$courseInfo.unit',
        },
        lecturer: {
          _id: '$lecturerInfo._id',
          title: '$lecturerInfo.title',
          surname: '$lecturerInfo.surname',
          firstname: '$lecturerInfo.firstname',
        },
        regNoNumeric: 1,
      },
    };

    const sortStage = { $sort: { regNoNumeric: 1, _id: 1 } };

    if (limit) {
      pipeline.push({
        $facet: {
          data: [
            sortStage,
            { $skip: skip },
            { $limit: limit },
            projectionStage,
          ],
          totalCount: [
            { $count: 'value' },
          ],
        },
      });
      pipeline.push({
        $project: {
          items: '$data',
          total: {
            $ifNull: [
              { $arrayElemAt: ['$totalCount.value', 0] },
              0,
            ],
          },
        },
      });

      const aggregateResult = await Result.aggregate(pipeline).option({ allowDiskUse: true });
      const doc = aggregateResult[0] || { items: [], total: 0 };
      const items = doc.items || [];
      const total = doc.total ?? items.length;
      const pageCount = Math.max(1, Math.ceil((total || 0) / limit));

      res.set('X-Total-Count', String(total));
      res.set('X-Page', String(page));
      res.set('X-Page-Size', String(limit));
      res.set('X-Page-Count', String(pageCount));
      return res.status(200).json(items);
    }

    pipeline.push(sortStage, projectionStage);
    const results = await Result.aggregate(pipeline).option({ allowDiskUse: true });
    return res.status(200).json(results);
  } catch (error) {
    console.error("Error fetching results:", error);
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

export const getResultsSummary = async (req, res) => {
  try {
    const { session, level, semester } = req.query;
    const baseMatch = {};
    if (session) baseMatch.session = String(session);
    if (level) baseMatch.level = String(level);
    if (semester) baseMatch.semester = Number(semester);

    const pipeline = [];
    if (Object.keys(baseMatch).length) {
      pipeline.push({ $match: baseMatch });
    }

    pipeline.push({
      $group: {
        _id: {
          course: '$course',
          session: '$session',
          semester: '$semester',
          level: '$level',
        },
        resultsCount: { $sum: 1 },
        department: { $first: '$department' },
        college: { $first: '$college' },
        lastUpdated: { $max: '$updatedAt' },
        lecturerId: { $first: '$lecturer' },
      },
    });

    pipeline.push(
      { $lookup: { from: 'courses', localField: '_id.course', foreignField: '_id', as: 'courseInfo' } },
      { $unwind: { path: '$courseInfo', preserveNullAndEmptyArrays: true } }
    );

    const scopeFilter = buildDepartmentScopeFilter(req.user);
    if (scopeFilter.department) {
      pipeline.push({
        $match: { 'courseInfo.department': new mongoose.Types.ObjectId(scopeFilter.department) },
      });
    }

    pipeline.push(
      { $lookup: { from: 'lecturers', localField: 'lecturerId', foreignField: '_id', as: 'lecturerInfo' } },
      { $unwind: { path: '$lecturerInfo', preserveNullAndEmptyArrays: true } }
    );

    pipeline.push({
      $project: {
        _id: 0,
        courseId: '$_id.course',
        session: '$_id.session',
        semester: '$_id.semester',
        level: '$_id.level',
        department: '$department',
        departmentId: '$courseInfo.department',
        college: '$college',
        resultsCount: '$resultsCount',
        lastUpdated: '$lastUpdated',
        course: {
          _id: '$courseInfo._id',
          code: '$courseInfo.code',
          title: '$courseInfo.title',
          unit: '$courseInfo.unit',
        },
        lecturer: {
          _id: '$lecturerInfo._id',
          title: '$lecturerInfo.title',
          surname: '$lecturerInfo.surname',
          firstname: '$lecturerInfo.firstname',
        },
      },
    });

    pipeline.push({
      $facet: {
        items: [
          { $sort: { session: -1, department: 1, level: 1, semester: 1, 'course.code': 1 } },
        ],
        stats: [
          {
            $group: {
              _id: null,
              totalResults: { $sum: '$resultsCount' },
              totalCourses: { $sum: 1 },
            },
          },
        ],
      },
    });

    pipeline.push({
      $project: {
        items: '$items',
        totalResults: {
          $ifNull: [{ $arrayElemAt: ['$stats.totalResults', 0] }, 0],
        },
        totalCourses: {
          $ifNull: [{ $arrayElemAt: ['$stats.totalCourses', 0] }, 0],
        },
      },
    });

    const aggregateResult = await Result.aggregate(pipeline).option({ allowDiskUse: true });
    const doc = aggregateResult[0] || { items: [], totalResults: 0, totalCourses: 0 };
    const items = doc.items || [];
    const totalResults = doc.totalResults || 0;
    const totalCourses = doc.totalCourses || 0;
    const avgPerCourse = totalCourses ? Math.round(totalResults / totalCourses) : 0;

    return res.status(200).json({
      success: true,
      items,
      totalResults,
      totalCourses,
      avgPerCourse,
    });
  } catch (error) {
    console.error('Error fetching results summary:', error);
    res.status(500).json({ message: 'Server Error', error: error.message });
  }
};

// Read One (unchanged)
export const getResultById = async (req, res) => {
  try {
    const result = await Result.findById(req.params.id)
      .populate("student", "surname firstname regNo")
      .populate("course", "title code department college")
      .populate("lecturer", "title surname firstname");

    if (!result) return res.status(404).json({ message: "Result not found" });
    if (!result.course) {
      return res.status(404).json({ message: "Associated course not found" });
    }
    ensureResourceMatchesUserScope(req.user, result.course);
    res.status(200).json(result);
  } catch (error) {
    console.error("Error fetching result:", error);
    if (error.name === "CastError" && error.kind === "ObjectId") {
      return res.status(400).json({ message: "Invalid ID format" });
    }
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// === Update with moderation support & metrics recompute ===
export const updateResult = async (req, res) => {
  try {
    const id = req.params.id;

    // Load the doc (we need values to compute grade, detect changes, and recompute metrics)
    const result = await Result.findById(id);
    if (!result) return res.status(404).json({ message: "Result not found" });

    const courseDoc = await Course.findById(result.course).select('_id department college').lean();
    if (!courseDoc) {
      return res.status(404).json({ message: "Associated course not found" });
    }
    ensureUserCanAccessDepartment(req.user, courseDoc.department, courseDoc.college);

    const payload = req.body || {};
    const hasGrand = Object.prototype.hasOwnProperty.call(payload, 'grandtotal');
    const hasGrade = Object.prototype.hasOwnProperty.call(payload, 'grade');
    const hasModerationProof = Object.prototype.hasOwnProperty.call(payload, 'moderationProof');
    const hasModerationPfNo = Object.prototype.hasOwnProperty.call(payload, 'moderationAuthorizedPfNo');
    const hasModerationGrand = Object.prototype.hasOwnProperty.call(payload, 'moderationGrandtotal');
    const moderationAction = typeof payload.moderationAction === 'string'
      ? payload.moderationAction.trim().toLowerCase()
      : null;

    // Direct updates to grand total (outside moderation approval flow)
    if (hasGrand) {
      const gtNum = Number(payload.grandtotal);
      if (Number.isNaN(gtNum)) {
        return res.status(400).json({ message: "grandtotal must be a number" });
      }
      result.grandtotal = gtNum;

      // Reset moderation state on manual edits
      result.moderated = false;
      result.moderationStatus = 'none';
      result.moderationPendingGrandtotal = undefined;
      result.moderationOriginalGrandtotal = undefined;
      result.moderationApprovedAt = undefined;
    }

    // Direct grade updates (outside moderation approval flow)
    if (hasGrade) {
      const g = String(payload.grade || '').toUpperCase();
      result.grade = (g === 'AUTO' || g === '')
        ? gradeFromScore(result.grandtotal)
        : g;

      result.moderated = false;
      if (result.moderationStatus !== 'pending') {
        result.moderationStatus = 'none';
        result.moderationPendingGrandtotal = undefined;
        result.moderationOriginalGrandtotal = undefined;
        result.moderationApprovedAt = undefined;
      }
    } else if (hasGrand) {
      // If total changed but grade not sent, keep consistency by recomputing grade
      result.grade = gradeFromScore(result.grandtotal);
    }

    if (hasModerationGrand) {
      const proposed = Number(payload.moderationGrandtotal);
      if (Number.isNaN(proposed)) {
        return res.status(400).json({ message: "moderationGrandtotal must be a number" });
      }

      const proofProvided = String(payload.moderationProof ?? '').trim();
      const pfProvided = String(payload.moderationAuthorizedPfNo ?? '').trim();
      if (!proofProvided || !pfProvided) {
        return res.status(400).json({ message: "Provide proof and authorizing PF No to submit moderation." });
      }

      if (result.moderationStatus !== 'pending') {
        result.moderationOriginalGrandtotal = result.grandtotal;
      }

      result.moderationPendingGrandtotal = proposed;
      result.moderationStatus = 'pending';
      result.moderated = false;
      result.moderationApprovedAt = undefined;
      result.moderationProof = proofProvided;
      result.moderationAuthorizedPfNo = pfProvided;
    } else {
      if (hasModerationProof) {
        result.moderationProof = String(payload.moderationProof ?? '').trim();
      }
      if (hasModerationPfNo) {
        result.moderationAuthorizedPfNo = String(payload.moderationAuthorizedPfNo ?? '').trim();
      }
    }

    if (moderationAction) {
      if (!['approve', 'reject'].includes(moderationAction)) {
        return res.status(400).json({ message: `Unknown moderationAction "${moderationAction}"` });
      }

      if (moderationAction === 'approve') {
        if (result.moderationStatus !== 'pending') {
          return res.status(400).json({ message: "No pending moderation request to approve." });
        }
        const pendingGrand = result.moderationPendingGrandtotal;
        if (pendingGrand === undefined || pendingGrand === null) {
          return res.status(400).json({ message: "Pending moderation is missing a proposed grand total." });
        }

        const proofCurrent = String(result.moderationProof ?? '').trim();
        const pfCurrent = String(result.moderationAuthorizedPfNo ?? '').trim();
        if (!proofCurrent || !pfCurrent) {
          return res.status(400).json({ message: "Moderation proof and authorizer PF No must be recorded before approval." });
        }

        result.grandtotal = pendingGrand;
        result.grade = gradeFromScore(pendingGrand);
        result.moderationStatus = 'approved';
        result.moderated = true;
        result.moderationApprovedAt = new Date();
        result.moderationPendingGrandtotal = undefined;
      } else if (moderationAction === 'reject') {
        if (result.moderationStatus === 'pending') {
          result.moderationStatus = 'none';
          result.moderated = false;
          result.moderationPendingGrandtotal = undefined;
          result.moderationOriginalGrandtotal = undefined;
          result.moderationApprovedAt = undefined;
          result.moderationProof = "";
          result.moderationAuthorizedPfNo = "";
        } else if (result.moderationStatus === 'approved') {
          const original = result.moderationOriginalGrandtotal;
          if (original === undefined || original === null) {
            return res.status(400).json({ message: "Cannot unapprove because original score is unavailable." });
          }
          result.grandtotal = original;
          result.grade = gradeFromScore(original);
          result.moderated = false;
          result.moderationStatus = 'none';
          result.moderationPendingGrandtotal = undefined;
          result.moderationOriginalGrandtotal = undefined;
          result.moderationApprovedAt = undefined;
          result.moderationProof = "";
          result.moderationAuthorizedPfNo = "";
        }
      }
    }

    const { departmentName: currentDepartmentName, collegeName: currentCollegeName } = await getStudentInstitution(result.student);

    const normalizedDepartmentName = currentDepartmentName || result.department || DEFAULT_DEPARTMENT_NAME;
    const normalizedCollegeName = currentCollegeName || result.college || DEFAULT_COLLEGE_NAME;

    result.department = normalizedDepartmentName;
    result.college = normalizedCollegeName;
    studentInstitutionCache.set(String(result.student), {
      departmentName: normalizedDepartmentName,
      collegeName: normalizedCollegeName,
    });

    // Persist the result first (validates enum grade etc.)
    const saved = await result.save();

    // === Recompute academic metrics for this student's term ===
    const attempted = await computeAttemptedCourses(
      saved.student, saved.session, saved.semester, saved.level
    );

    // previous snapshot
    const previousMetricsDoc = await AcademicMetrics.findOne({
      student: saved.student,
      $or: [
        { session: { $lt: saved.session } },
        { session: saved.session, semester: { $lt: saved.semester } }
      ]
    }).sort({ session: -1, semester: -1, level: -1 }).lean();

    const previousMetrics = previousMetricsDoc ? {
      CCC: previousMetricsDoc.CCC,
      CCE: previousMetricsDoc.CCE,
      CPE: previousMetricsDoc.CPE,
      CGPA: previousMetricsDoc.CGPA
    } : { CCC: 0, CCE: 0, CPE: 0, CGPA: 0 };

    if (attempted.length > 0) {
      const current = calculateAcademicMetrics(attempted, previousMetrics);
      await AcademicMetrics.findOneAndUpdate(
        {
          student: saved.student,
          session: saved.session,
          semester: saved.semester,
          level: saved.level
        },
        {
          ...current,
          previousMetrics,
          department: normalizedDepartmentName,
          college: normalizedCollegeName,
          lastUpdated: new Date(),
        },
        { upsert: true }
      );
    } else {
      await AcademicMetrics.deleteOne({
        student: saved.student,
        session: saved.session,
        semester: saved.semester,
        level: saved.level
      });
    }

    // Optionally re-populate like getAllResults projection (lightweight here)
    const updated = await Result.findById(saved._id)
      .populate("student", "surname firstname regNo")
      .populate("course", "title code unit")
      .populate("lecturer", "title surname firstname");

    return res.status(200).json(updated);
  } catch (error) {
    console.error("Error updating result:", error);
    if (error.name === "ValidationError") {
      return res.status(400).json({ message: "Validation Error", errors: error.errors });
    }
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// Delete Single Result — recompute using registrations ∪ results
export const deleteResult = async (req, res) => {
  try {
    const result = await Result.findById(req.params.id).populate('student').populate('course');
    if (!result) return res.status(404).json({ message: "Result not found" });
    if (!result.course) {
      return res.status(404).json({ message: "Associated course not found" });
    }
    ensureResourceMatchesUserScope(req.user, result.course);

    await Result.findByIdAndDelete(result._id);

    // Build attempted courses (includes registered-no-score as F)
    const attempted = await computeAttemptedCourses(
      result.student._id, result.session, result.semester, result.level
    );

    // Previous snapshot
    const previousMetricsDoc = await AcademicMetrics.findOne({
      student: result.student._id,
      $or: [
        { session: { $lt: result.session } },
        { session: result.session, semester: { $lt: result.semester } }
      ]
    }).sort({ session: -1, semester: -1, level: -1 }).lean();

    const previousMetrics = previousMetricsDoc ? {
      CCC: previousMetricsDoc.CCC,
      CCE: previousMetricsDoc.CCE,
      CPE: previousMetricsDoc.CPE,
      CGPA: previousMetricsDoc.CGPA
    } : { CCC: 0, CCE: 0, CPE: 0, CGPA: 0 };

    const { departmentName: deletedDepartmentName, collegeName: deletedCollegeName } = await getStudentInstitution(result.student._id);
    const deletedDepartment = deletedDepartmentName || result.department || DEFAULT_DEPARTMENT_NAME;
    const deletedCollege = deletedCollegeName || result.college || DEFAULT_COLLEGE_NAME;

    if (attempted.length > 0) {
      const current = calculateAcademicMetrics(attempted, previousMetrics);
      await AcademicMetrics.findOneAndUpdate(
        {
          student: result.student._id,
          session: result.session,
          semester: result.semester,
          level: result.level
        },
        {
          ...current,
          previousMetrics,
          department: deletedDepartment,
          college: deletedCollege,
          lastUpdated: new Date(),
        },
        { upsert: true }
      );
    } else {
      // No registration & no results → remove per-term metrics doc
      await AcademicMetrics.deleteOne({
        student: result.student._id,
        session: result.session,
        semester: result.semester,
        level: result.level
      });
    }

    res.status(200).json({ message: "Result deleted successfully" });
  } catch (error) {
    console.error("Error deleting result:", error);
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// Delete All Results for a Course — recompute per student via registrations ∪ results
export const deleteAllResultsForCourse = async (req, res) => {
  try {
    const courseId = req.params.id;
    const { level, session, semester } = req.query;

    const course = await Course.findById(courseId);
    if (!course) return res.status(404).json({ message: "Course not found" });

    ensureUserCanAccessDepartment(req.user, course.department, course.college);

    const matchFilter = { course: courseId };
    if (level)    matchFilter.level   = String(level);
    if (session)  matchFilter.session = session;
    if (semester) matchFilter.semester = parseInt(semester, 10);

    const resultsToDelete = await Result.find(matchFilter).populate('student').lean();
    if (resultsToDelete.length === 0) {
      return res.status(404).json({ message: "No results found for the specified filters" });
    }

    await Result.deleteMany(matchFilter);

    // Group affected students/terms
    const groups = resultsToDelete.reduce((acc, r) => {
      const key = `${r.student._id}-${r.session}-${r.semester}-${r.level}`;
      if (!acc[key]) acc[key] = { student: r.student._id, session: r.session, semester: r.semester, level: r.level };
      return acc;
    }, {});

    await Promise.all(Object.values(groups).map(async (g) => {
      const attempted = await computeAttemptedCourses(g.student, g.session, g.semester, g.level);

      const previousMetricsDoc = await AcademicMetrics.findOne({
        student: g.student,
        $or: [{ session: { $lt: g.session } }, { session: g.session, semester: { $lt: g.semester } }]
      }).sort({ session: -1, semester: -1, level: -1 }).lean();

      const previousMetrics = previousMetricsDoc ? {
        CCC: previousMetricsDoc.CCC, CCE: previousMetricsDoc.CCE,
        CPE: previousMetricsDoc.CPE, CGPA: previousMetricsDoc.CGPA
      } : { CCC: 0, CCE: 0, CPE: 0, CGPA: 0 };

      if (attempted.length > 0) {
        const current = calculateAcademicMetrics(attempted, previousMetrics);
        const { departmentName, collegeName } = await getStudentInstitution(g.student);
        const normalizedDepartment = departmentName || DEFAULT_DEPARTMENT_NAME;
        const normalizedCollege = collegeName || DEFAULT_COLLEGE_NAME;
        await AcademicMetrics.findOneAndUpdate(
          { student: g.student, session: g.session, semester: g.semester, level: g.level },
          {
            ...current,
            previousMetrics,
            department: normalizedDepartment,
            college: normalizedCollege,
            lastUpdated: new Date(),
          },
          { upsert: true }
        );
      } else {
        await AcademicMetrics.deleteOne({ student: g.student, session: g.session, semester: g.semester, level: g.level });
      }
    }));

    res.status(200).json({ message: "Filtered results deleted and metrics updated" });
  } catch (error) {
    console.error("Error deleting filtered results:", error);
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// Delete Multiple Results — recompute via registrations ∪ results
export const deleteMultipleResults = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "No result IDs provided" });
    }

    const results = await Result.find({ _id: { $in: ids } }).populate('course student').lean();
    if (!results.length) {
      return res.status(404).json({ message: "No results found for provided IDs" });
    }

    for (const r of results) {
      if (!r.course) {
        return res.status(404).json({ message: "Associated course not found for one or more results" });
      }
      ensureResourceMatchesUserScope(req.user, r.course);
    }

    const groups = results.reduce((acc, r) => {
      const key = `${r.student._id}-${r.session}-${r.semester}-${r.level}`;
      if (!acc[key]) acc[key] = { student: r.student._id, session: r.session, semester: r.semester, level: r.level };
      return acc;
    }, {});

    await Result.deleteMany({ _id: { $in: ids } });

    for (const g of Object.values(groups)) {
      const attempted = await computeAttemptedCourses(g.student, g.session, g.semester, g.level);

      const previousMetricsDoc = await AcademicMetrics.findOne({
        student: g.student,
        $or: [{ session: { $lt: g.session } }, { session: g.session, semester: { $lt: g.semester } }]
      }).sort({ session: -1, semester: -1, level: -1 }).lean();

      const previousMetrics = previousMetricsDoc ? {
        CCC: previousMetricsDoc.CCC, CCE: previousMetricsDoc.CCE,
        CPE: previousMetricsDoc.CPE, CGPA: previousMetricsDoc.CGPA
      } : { CCC: 0, CCE: 0, CPE: 0, CGPA: 0 };

      if (attempted.length > 0) {
        const current = calculateAcademicMetrics(attempted, previousMetrics);
        const { departmentName, collegeName } = await getStudentInstitution(g.student);
        const normalizedDepartment = departmentName || DEFAULT_DEPARTMENT_NAME;
        const normalizedCollege = collegeName || DEFAULT_COLLEGE_NAME;
        await AcademicMetrics.findOneAndUpdate(
          { student: g.student, session: g.session, semester: g.semester, level: g.level },
          {
            ...current,
            previousMetrics,
            department: normalizedDepartment,
            college: normalizedCollege,
            lastUpdated: new Date(),
          },
          { upsert: true }
        );
      } else {
        await AcademicMetrics.deleteOne({ student: g.student, session: g.session, semester: g.semester, level: g.level });
      }
    }

    res.status(200).json({ message: "Multiple results deleted and metrics updated" });
  } catch (error) {
    console.error("Bulk delete error:", error);
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};
