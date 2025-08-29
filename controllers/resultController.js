// controllers/result.controller.js
import Result from "../models/result.js";
import Course from "../models/course.js";
import CourseRegistration from "../models/courseRegistration.js";
import calculateAcademicMetrics from '../utills/calculateAcademicMetrics.js';
import AcademicMetrics from '../models/academicMetrics.js';
import mongoose from 'mongoose';

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

// Create
export const createResult = async (req, res) => {
  try {
    const newResult = await Result.create(req.body);
    res.status(201).json(newResult);
  } catch (error) {
    console.error("Error creating result:", error);
    if (error.name === "ValidationError") {
      return res.status(400).json({ message: "Validation Error", errors: error.errors });
    }
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// Read All (unchanged)
export const getAllResults = async (req, res) => {
  try {
    const { regNo, courseCode, session, level, semester, name, q } = req.query;
    const pipeline = [];

    pipeline.push({ $lookup: { from: 'students',  localField: 'student',   foreignField: '_id', as: 'studentInfo' }});
    pipeline.push({ $unwind: '$studentInfo' });
    pipeline.push({ $lookup: { from: 'courses',   localField: 'course',    foreignField: '_id', as: 'courseInfo' }});
    pipeline.push({ $unwind: '$courseInfo' });
    pipeline.push({ $lookup: { from: 'lecturers', localField: 'lecturer',  foreignField: '_id', as: 'lecturerInfo' }});
    pipeline.push({ $unwind: { path: '$lecturerInfo', preserveNullAndEmptyArrays: true }});

    const andFilters = [];
    const eqMatch = {};
    if (session)  eqMatch.session = session;
    if (level)    eqMatch.level   = level;
    if (semester) eqMatch.semester = parseInt(semester, 10);
    if (courseCode) eqMatch['courseInfo.code'] = { $regex: courseCode, $options: 'i' };
    if (regNo)      eqMatch['studentInfo.regNo'] = { $regex: regNo, $options: 'i' };
    if (Object.keys(eqMatch).length) andFilters.push(eqMatch);

    pipeline.push({
      $addFields: {
        fullName: {
          $trim: {
            input: {
              $concat: [
                { $ifNull: ['$studentInfo.surname', ''] }, ' ',
                { $ifNull: ['$studentInfo.firstname', ''] }, ' ',
                { $ifNull: ['$studentInfo.middlename', ''] }
              ]
            }
          }
        }
      }
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
          { fullName: rx }
        ]
      });
    }

    if (andFilters.length) pipeline.push({ $match: { $and: andFilters } });

    pipeline.push({
      $addFields: {
        regNoNumeric: {
          $convert: {
            input: { $arrayElemAt: [{ $split: ['$studentInfo.regNo', '/'] }, 1] },
            to: 'int',
            onError: 0,
            onNull: 0
          }
        }
      }
    });

    pipeline.push({
      $project: {
        _id: 1, department: 1, session: 1, semester: 1, level: 1,
        grade: 1, totalexam: 1, ca: 1, grandtotal: 1, moderated: 1,
        q1: 1, q2: 1, q3: 1, q4: 1, q5: 1, q6: 1, q7: 1, q8: 1,
        student: {
          _id: '$studentInfo._id',
          surname: '$studentInfo.surname',
          firstname: '$studentInfo.firstname',
          middlename: '$studentInfo.middlename',
          regNo: '$studentInfo.regNo'
        },
        course: {
          _id: '$courseInfo._id',
          title: '$courseInfo.title',
          code: '$courseInfo.code',
          unit: '$courseInfo.unit'
        },
        lecturer: {
          _id: '$lecturerInfo._id',
          title: '$lecturerInfo.title',
          surname: '$lecturerInfo.surname',
          firstname: '$lecturerInfo.firstname'
        }
      }
    });

    pipeline.push({ $sort: { regNoNumeric: 1 } });

    const results = await Result.aggregate(pipeline);
    return res.status(200).json(results);
  } catch (error) {
    console.error("Error fetching results:", error);
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// Read One (unchanged)
export const getResultById = async (req, res) => {
  try {
    const result = await Result.findById(req.params.id)
      .populate("student", "surname firstname regNo")
      .populate("course", "title code")
      .populate("lecturer", "title surname firstname");

    if (!result) return res.status(404).json({ message: "Result not found" });
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

    const payload = req.body || {};
    const hasGrand = Object.prototype.hasOwnProperty.call(payload, 'grandtotal');
    const hasGrade = Object.prototype.hasOwnProperty.call(payload, 'grade');

    // Apply changes
    if (hasGrand) {
      const gtNum = Number(payload.grandtotal);
      if (Number.isNaN(gtNum)) {
        return res.status(400).json({ message: "grandtotal must be a number" });
      }
      result.grandtotal = gtNum;
    }

    if (hasGrade) {
      // Accept explicit letter; if client sent "auto", compute from (new) grandtotal
      const g = String(payload.grade || '').toUpperCase();
      result.grade = (g === 'AUTO' || g === '')
        ? gradeFromScore(result.grandtotal)
        : g;
    } else if (hasGrand) {
      // If total changed but grade not sent, keep consistency by recomputing grade
      result.grade = gradeFromScore(result.grandtotal);
    }

    // Flip moderated if any moderation-ish field changed or explicitly requested
    if (payload.moderated === true || hasGrand || hasGrade) {
      result.moderated = true;
    } else if (payload.moderated === false) {
      // allow unmarking if you want that behavior; remove this branch to make it sticky
      result.moderated = false;
    }

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
        { ...current, previousMetrics },
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

    if (attempted.length > 0) {
      const current = calculateAcademicMetrics(attempted, previousMetrics);
      await AcademicMetrics.findOneAndUpdate(
        {
          student: result.student._id,
          session: result.session,
          semester: result.semester,
          level: result.level
        },
        { ...current, previousMetrics },
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
        await AcademicMetrics.findOneAndUpdate(
          { student: g.student, session: g.session, semester: g.semester, level: g.level },
          { ...current, previousMetrics },
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
        await AcademicMetrics.findOneAndUpdate(
          { student: g.student, session: g.session, semester: g.semester, level: g.level },
          { ...current, previousMetrics },
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
