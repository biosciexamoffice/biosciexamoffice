// controllers/academicMetrics.controller.js
import AcademicMetrics from '../models/academicMetrics.js';
import Result from '../models/result.js';
import Student from '../models/student.js';
import Course from '../models/course.js';
import CourseRegistration from '../models/courseRegistration.js';
import calculateAcademicMetrics from '../utills/calculateAcademicMetrics.js';
import mongoose from 'mongoose';
import {
  buildDepartmentScopeFilter,
  ensureResourceMatchesUserScope,
  ensureUserCanAccessDepartment,
} from '../services/accessControl.js';

const DEFAULT_DEPARTMENT_NAME = 'Biochemistry';
const DEFAULT_COLLEGE_NAME = 'Biological Science';

const normalizeRegNo = (value) => String(value || '').trim().toUpperCase();

const normalizeOfficerApproval = (approval = {}) => ({
  approved: Boolean(approval?.approved),
  flagged: Boolean(approval?.flagged),
  name: approval?.name || '',
  title: approval?.title || '',
  surname: approval?.surname || '',
  firstname: approval?.firstname || '',
  middlename: approval?.middlename || '',
  department: approval?.department || '',
  college: approval?.college || '',
  note: approval?.note || '',
  updatedAt: approval?.updatedAt || null,
});

const resolveDepartmentScope = (user) => {
  const filter = buildDepartmentScopeFilter(user);
  const departmentId = filter.department || null;
  return {
    departmentId,
    departmentObjectId: departmentId ? new mongoose.Types.ObjectId(departmentId) : null,
  };
};

/** ---------------------------
 * Session helpers (dynamic)
 * ----------------------------
 * Sessions look like "2023/2024".
 * We derive a sortable numeric index from the first year (e.g., 2023).
 */
function parseSessionIndex(session) {
  const s = String(session || '').trim();
  const m = /^(\d{4})\s*\/\s*(\d{4})$/.exec(s);
  return m ? parseInt(m[1], 10) : Number.NEGATIVE_INFINITY; // push malformed to the far past
}

function isBeforeTerm(aSession, aSem, bSession, bSem) {
  const ai = parseSessionIndex(aSession);
  const bi = parseSessionIndex(bSession);
  if (ai !== bi) return ai < bi;
  return Number(aSem) < Number(bSem);
}

async function findPreviousMetrics(studentId, session, semNumber) {
  const docs = await AcademicMetrics.find({ student: studentId })
    .select('session semester CCC CCE CPE CGPA')
    .lean();

  let best = null;
  for (const d of docs) {
    if (isBeforeTerm(d.session, d.semester, session, semNumber)) {
      if (!best || isBeforeTerm(best.session, best.semester, d.session, d.semester)) {
        best = d;
      }
    }
  }
  if (!best) return { CCC: 0, CCE: 0, CPE: 0, CGPA: 0 };
  return { CCC: best.CCC, CCE: best.CCE, CPE: best.CPE, CGPA: best.CGPA };
}

// Preload registrations for the cohort once: studentId -> Set(courseId)
async function preloadRegistrations(session, semNumber, lvlStr) {
  const regs = await CourseRegistration.aggregate([
    { $match: { session, semester: semNumber, level: lvlStr } },
    { $unwind: '$student' }, // student is an array in CourseRegistration
    { $group: { _id: '$student', courses: { $addToSet: '$course' } } },
  ]);

  const regByStudent = new Map();
  const allCourseIds = new Set();
  regs.forEach((r) => {
    const sid = String(r._id);
    const set = new Set(r.courses.map((id) => String(id)));
    regByStudent.set(sid, set);
    set.forEach((cid) => allCourseIds.add(cid));
  });

  // Basic course info for any registered course (unit/code/title/option)
  const courses = await Course.find({ _id: { $in: [...allCourseIds] } })
    .select('_id unit code title option')
    .lean();

  const courseInfo = new Map(courses.map((c) => [String(c._id), c]));
  return { regByStudent, courseInfo };
}

/**
 * Prefer stored current fields (TCC/TCE/TPE/GPA) when present.
 * Only compute on the fly if those fields are truly absent (null/undefined).
 * This makes "edit" persistent in UI refreshes.
 */
async function computeCurrentIfNeeded(doc) {
  const hasAnyStored =
    doc.TCC !== undefined && doc.TCC !== null ||
    doc.TCE !== undefined && doc.TCE !== null ||
    doc.TPE !== undefined && doc.TPE !== null ||
    doc.GPA !== undefined && doc.GPA !== null;

  if (hasAnyStored) {
    return {
      TCC: Number.isFinite(doc.TCC) ? doc.TCC : 0,
      TCE: Number.isFinite(doc.TCE) ? doc.TCE : 0,
      TPE: Number.isFinite(doc.TPE) ? doc.TPE : 0,
      GPA: Number.isFinite(doc.GPA) ? doc.GPA : 0,
    };
  }

  // Compute only when current is truly absent
  if (!doc.session || !doc.semester || !doc.level || !doc.student) {
    return { TCC: 0, TCE: 0, TPE: 0, GPA: 0 };
  }

  const lvlStr = String(doc.level);
  const regsAgg = await CourseRegistration.aggregate([
    { $match: { session: doc.session, semester: Number(doc.semester), level: lvlStr } },
    { $unwind: '$student' },
    { $match: { student: doc.student } },
    { $group: { _id: '$student', courses: { $addToSet: '$course' } } },
    { $project: { _id: 0, courses: 1 } },
  ]);
  const registeredCourseIds = new Set((regsAgg[0]?.courses || []).map(id => String(id)));

  const results = await Result.find({
    student: doc.student,
    session: doc.session,
    semester: Number(doc.semester),
    level: lvlStr,
  }).populate('course', '_id unit').lean();

  const byCourse = new Map(
    results.map(r => [String(r.course?._id), { unit: Number(r.course?.unit) || 0, grade: String(r.grade || 'F') }])
  );

  const allCourseIds = [...new Set([...registeredCourseIds, ...byCourse.keys()])];
  const courses = allCourseIds.length
    ? await Course.find({ _id: { $in: allCourseIds } }).select('_id unit').lean()
    : [];
  const unitById = new Map(courses.map(c => [String(c._id), Number(c.unit) || 0]));

  const attempted = [];
  registeredCourseIds.forEach(cid => {
    if (byCourse.has(cid)) attempted.push(byCourse.get(cid));
    else attempted.push({ unit: unitById.get(cid) || 0, grade: 'F' });
  });

  const prev = await findPreviousMetrics(doc.student, doc.session, Number(doc.semester));
  const current = calculateAcademicMetrics(attempted, prev);

  return { TCC: current.TCC, TCE: current.TCE, TPE: current.TPE, GPA: current.GPA };
}

// STRICTLY REGISTERED-ONLY comprehensive feed for Result Computation views/exports
export const getComprehensiveResults = async (req, res) => {
  try {
    const { session, semester, level } = req.query;

    if (!session || !semester || !level) {
      return res.status(400).json({ error: 'Session, semester and level are required parameters' });
    }

    const parseListParam = (raw) => {
      if (!raw) return [];
      const arr = Array.isArray(raw) ? raw : [raw];
      return arr
        .flatMap((value) => String(value).split(','))
        .map((value) => value.trim())
        .filter(Boolean);
    };

    const requestedStudentIds = new Set(parseListParam(req.query.studentIds).map(String));
    const requestedRegNos = new Set(parseListParam(req.query.studentRegNos || req.query.regNos).map(normalizeRegNo));
    const onlyStudents = String(req.query.onlyStudents || '').toLowerCase() === 'true';

    const semNum = Number(semester); // AcademicMetrics expects Number
    const lvlNum = Number(level);    // AcademicMetrics expects Number
    const lvlStr = String(level);    // Result/CourseRegistration store level as String

    // 1) Pull registrations for this term: studentId -> Set(courseId)
    const { departmentId, departmentObjectId } = resolveDepartmentScope(req.user);

    const registrationMatch = { session, semester: semNum, level: lvlStr };
    if (departmentObjectId) {
      registrationMatch.department = departmentObjectId;
    }

    let regs = await CourseRegistration.aggregate([
      { $match: registrationMatch },
      { $unwind: '$student' },
      { $group: { _id: '$student', courses: { $addToSet: '$course' } } },
    ]);

    if (!regs.length) {
      return res.json({ students: [], courses: [], registrationsByCourse: {} });
    }

    // Build maps
    const regByStudent = new Map(); // sid -> Set(courseId)
    const allStudentIds = new Set();
    const allCourseIds = new Set();

    regs.forEach((r) => {
      const sid = String(r._id);
      const set = new Set((r.courses || []).map(String));
      if (set.size) {
        regByStudent.set(sid, set);
        allStudentIds.add(sid);
        set.forEach((cid) => allCourseIds.add(cid));
      }
    });

    if (!allStudentIds.size) {
      return res.json({ students: [], courses: [], registrationsByCourse: {} });
    }

    // 2) Minimal course info for registered courses
    const courseDocs = await Course.find({ _id: { $in: [...allCourseIds] } })
      .select('_id unit code title option')
      .lean();
    const courseInfo = new Map(courseDocs.map((c) => [String(c._id), c]));

    // 3) Student info (name/regNo) for registered students
    const studentQuery = { _id: { $in: [...allStudentIds] } };
    if (departmentId) {
      studentQuery.department = departmentId;
    }

    const studentDocs = await Student.find(studentQuery)
      .select('_id surname firstname middlename regNo standing status department')
      .lean();
    const studentInfo = new Map(studentDocs.map((s) => [String(s._id), s]));

    const filterByRequest = (doc) => {
      const idMatch = !requestedStudentIds.size || requestedStudentIds.has(String(doc._id));
      const regMatch = !requestedRegNos.size || requestedRegNos.has(normalizeRegNo(doc.regNo));
      return idMatch && regMatch;
    };

    const filteredStudentDocs = requestedStudentIds.size || requestedRegNos.size
      ? studentDocs.filter(filterByRequest)
      : studentDocs;

    if (requestedStudentIds.size || requestedRegNos.size) {
      const allowedIds = new Set(filteredStudentDocs.map((doc) => String(doc._id)));
      for (const sid of [...regByStudent.keys()]) {
        if (!allowedIds.has(sid)) {
          regByStudent.delete(sid);
        }
      }
    }

    if (onlyStudents) {
      const list = (filteredStudentDocs.length ? filteredStudentDocs : studentDocs).map((s) => ({
        id: String(s._id),
        fullName: `${s.surname} ${s.firstname} ${s.middlename || ''}`.trim(),
        regNo: s.regNo,
        standing: s.standing || 'goodstanding',
        status: s.status || 'undergraduate',
      }));
      return res.json({ students: list, total: list.length });
    }

    // 4) Pull only results that belong to this term and these students/courses
    const filteredStudentIds = [...regByStudent.keys()];
    const results = await Result.find({
      session,
      semester: semNum,
      level: lvlStr,
      student: { $in: filteredStudentIds.length ? filteredStudentIds : [...allStudentIds] },
      course: { $in: [...allCourseIds] },
    })
      .populate('course', '_id unit')
      .select('student course grandtotal grade')
      .lean();

    // Index results by (studentId, courseId)
    const resultKey = (sid, cid) => `${sid}::${cid}`;
    const byStudentCourse = new Map();
    results.forEach((r) => {
      const sid = String(r.student);
      const cid = String(r.course?._id || r.course);
      byStudentCourse.set(resultKey(sid, cid), {
        grandtotal: r.grandtotal,
        grade: r.grade,
        unit: Number(r.course?.unit ?? courseInfo.get(cid)?.unit ?? 0),
      });
    });

    // 5) Build registrationsByCourse: courseId -> [REGNO...]
    const registrationsByCourse = {};
    for (const [sid, set] of regByStudent.entries()) {
      const s = studentInfo.get(sid);
      const regUpper = String(s?.regNo || '').toUpperCase();
      if (!regUpper) continue;
      set.forEach((cid) => {
        if (!registrationsByCourse[cid]) registrationsByCourse[cid] = [];
        registrationsByCourse[cid].push(regUpper);
      });
    }

    // 5b) Helper to build attempted array per student (regs ∪ results; missing score => F with course unit)
    function makeAttemptedFor(sid) {
      const regSet = regByStudent.get(sid) || new Set();
      const attempted = [];
      regSet.forEach((cid) => {
        const k = resultKey(sid, cid);
        const stored = byStudentCourse.get(k);
        const unit = stored?.unit ?? Number(courseInfo.get(cid)?.unit || 0);
        if (stored) attempted.push({ unit, grade: stored.grade || 'F' });
        else attempted.push({ unit, grade: 'F' }); // registered but no score -> 00F -> F
      });
      return attempted;
    }

    // 6) Load existing metrics for the cohort, compute+upsert ONLY where missing
    const existingMetricsDocs = await AcademicMetrics.find({
      student: { $in: [...allStudentIds] },
      session,
      semester: semNum,
      level: lvlNum,
    })
      .select('student TCC TCE TPE GPA CCC CCE CPE CGPA previousMetrics ceoApproval hodApproval deanApproval')
      .lean();

    const metricsByStudent = new Map(
      (existingMetricsDocs || []).map((m) => [String(m.student), m])
    );

    const missingStudentIds = [];
    for (const sid of regByStudent.keys()) {
      if (!metricsByStudent.has(sid)) {
        missingStudentIds.push(sid);
      }
    }

    let previousMetricsByStudent = new Map();
    if (missingStudentIds.length) {
      const previousDocs = await AcademicMetrics.find({
        student: { $in: missingStudentIds },
        $nor: [
          { session, semester: semNum, level: lvlNum },
        ],
      })
        .select('student session semester CCC CCE CPE CGPA')
        .lean();

      previousMetricsByStudent = previousDocs.reduce((map, doc) => {
        const sid = String(doc.student);
        if (!isBeforeTerm(doc.session, doc.semester, session, semNum)) {
          return map;
        }
        const existing = map.get(sid);
        if (!existing || isBeforeTerm(existing.session, existing.semester, doc.session, doc.semester)) {
          map.set(sid, {
            session: doc.session,
            semester: doc.semester,
            CCC: Number(doc.CCC || 0),
            CCE: Number(doc.CCE || 0),
            CPE: Number(doc.CPE || 0),
            CGPA: Number(doc.CGPA || 0),
          });
        }
        return map;
      }, new Map());
    }

    const metricsBulkOps = [];
    const metricsNeedingRefresh = new Set();
    const now = new Date();

    for (const sid of missingStudentIds) {
      const attempted = makeAttemptedFor(sid);
      if (!attempted.length) {
        continue;
      }

      const prev = previousMetricsByStudent.get(sid) || { CCC: 0, CCE: 0, CPE: 0, CGPA: 0 };
      const previousMetrics = {
        CCC: prev.CCC || 0,
        CCE: prev.CCE || 0,
        CPE: prev.CPE || 0,
        CGPA: prev.CGPA || 0,
      };

      const current = calculateAcademicMetrics(attempted, previousMetrics);

      metricsBulkOps.push({
        updateOne: {
          filter: { student: sid, session, semester: semNum, level: lvlNum },
          update: {
            $set: {
              previousMetrics,
              lastUpdated: now,
            },
            $setOnInsert: {
              TCC: current.TCC,
              TCE: current.TCE,
              TPE: current.TPE,
              GPA: current.GPA,
              CCC: current.CCC,
              CCE: current.CCE,
              CPE: current.CPE,
              CGPA: current.CGPA,
            },
          },
          upsert: true,
        },
      });
      metricsNeedingRefresh.add(sid);
    }

    if (metricsBulkOps.length) {
      await AcademicMetrics.bulkWrite(metricsBulkOps, { ordered: false });
    }

    if (metricsNeedingRefresh.size) {
      const refreshedDocs = await AcademicMetrics.find({
        student: { $in: [...metricsNeedingRefresh] },
        session,
        semester: semNum,
        level: lvlNum,
      })
        .select('student TCC TCE TPE GPA CCC CCE CPE CGPA previousMetrics ceoApproval hodApproval deanApproval')
        .lean();

      refreshedDocs.forEach((doc) => {
        metricsByStudent.set(String(doc.student), doc);
      });
    }

    // 7) Build students array (registered students only), attach metrics & strictly registered results
    const students = [];
    for (const sid of regByStudent.keys()) {
      const s = studentInfo.get(sid);
      if (!s) continue;

      const regSet = regByStudent.get(sid) || new Set();
      const resultsMap = new Map();

      regSet.forEach((cid) => {
        const k = resultKey(sid, cid);
        const stored = byStudentCourse.get(k);

        if (stored) {
          resultsMap.set(cid, {
            grandtotal: stored.grandtotal,
            grade: stored.grade,
            unit: stored.unit ?? Number(courseInfo.get(cid)?.unit || 0),
          });
        } else {
          resultsMap.set(cid, {
            unit: Number(courseInfo.get(cid)?.unit || 0),
            // grandtotal/grade omitted -> UI shows "00F"
          });
        }
      });

      const m = metricsByStudent.get(sid);
      const previousMetrics = m?.previousMetrics || { CCC: 0, CCE: 0, CPE: 0, CGPA: 0 };
      const currentMetrics = {
        TCC: Number(m?.TCC || 0),
        TCE: Number(m?.TCE || 0),
        TPE: Number(m?.TPE || 0),
        GPA: Number(m?.GPA || 0),
      };
      const metrics = {
        CCC: Number(m?.CCC || 0),
        CCE: Number(m?.CCE || 0),
        CPE: Number(m?.CPE || 0),
        CGPA: Number(m?.CGPA || 0),
        _id: m?._id, // client uses this for updates
      };

      const ceoApproval = normalizeOfficerApproval(m?.ceoApproval);
      const hodApproval = normalizeOfficerApproval(m?.hodApproval);
      const deanApproval = normalizeOfficerApproval(m?.deanApproval);

      students.push({
        id: sid,
        fullName: `${s.surname} ${s.firstname} ${s.middlename || ''}`.trim(),
        regNo: s.regNo,
        standing: s.standing || 'goodstanding',
        status: s.status || 'undergraduate',
        results: Object.fromEntries(resultsMap),
        previousMetrics,
        currentMetrics,
        metrics,
        ceoApproval,
        hodApproval,
        deanApproval,
      });
    }

    // 8) Courses list: only those that had at least one registration
    const courses = courseDocs.map((c) => ({
      id: String(c._id),
      code: c.code,
      unit: c.unit,
      title: c.title,
      option: c.option,
    }));

    return res.json({ students, courses, registrationsByCourse });
  } catch (error) {
    console.error('Error in getComprehensiveResults (registered-only):', error);
    res.status(500).json({ error: 'Failed to fetch comprehensive results', details: error.message });
  }
};



// GET all metrics
export const getMetrics = async (req, res) => {
  try {
    const { departmentId } = resolveDepartmentScope(req.user);
    const response = await AcademicMetrics.find()
      .populate({ path: 'student', select: 'surname firstname middlename regNo department college' });

    const filtered = departmentId
      ? response.filter((doc) => doc.student && String(doc.student.department) === departmentId)
      : response;

    if (!filtered || filtered.length === 0) {
      return res.status(404).json({ message: "Metrics not found" });
    }
    res.status(200).json({ response: filtered });
  } catch (error) {
    res.status(500).json({ message: "Internal server error", error });
  }
};

// DELETE a metrics document
export const deleteMetrics = async (req, res) => {
  try {
    const { metricsId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(metricsId)) {
      return res.status(400).json({ error: 'Invalid metrics ID' });
    }

    const metrics = await AcademicMetrics.findById(metricsId);
    if (!metrics) {
      return res.status(404).json({ error: 'Metrics not found' });
    }

    if (metrics.student) {
      const student = await Student.findById(metrics.student).select('department college');
      if (student) {
        ensureUserCanAccessDepartment(req.user, student.department, student.college);
      }
    }

    await AcademicMetrics.findByIdAndDelete(metricsId);

    res.status(200).json({
      message: 'Academic metrics deleted successfully',
      deletedMetrics: {
        id: metricsId,
        student: metrics.student,
        session: metrics.session,
        semester: metrics.semester,
        level: metrics.level
      }
    });

  } catch (error) {
    console.error('Error deleting academic metrics:', error);
    res.status(500).json({ error: 'Failed to delete academic metrics', details: error.message });
  }
};

// SEARCH metrics by filters (PREFERS STORED CURRENT; computes only if missing)
// --- SIMPLE SEARCH: no registrations, no recompute, no result lookups ---
// Accepts any of session / semester / level / regNo, singly or in combination.
// Returns ONLY what is already stored in AcademicMetrics.

export const searchMetrics = async (req, res) => {
  try {
    const { session, semester, level, regNo } = req.query;

    const query = {};
    const { departmentId } = resolveDepartmentScope(req.user);

    if (session) query.session = String(session).trim();
    if (semester) query.semester = Number(semester);
    if (level) query.level = Number(level);

    if (regNo) {
      const student = await Student.findOne({
        regNo: String(regNo).trim().toUpperCase(),
      }).select('_id department');
      if (!student) return res.json({ students: [] });
      if (departmentId && String(student.department) !== departmentId) {
        return res.json({ students: [] });
      }
      query.student = student._id;
    }

    const docs = await AcademicMetrics.find(query)
      .populate({ path: 'student', select: 'surname firstname middlename regNo department' })
      .sort({ createdAt: -1, semester: -1 })
      .lean();

    const scopedDocs = departmentId
      ? (docs || []).filter((m) => m.student && String(m.student.department) === departmentId)
      : (docs || []);

    const rows = scopedDocs.map((m) => {
      const fullName = m.student
        ? `${m.student.surname} ${m.student.firstname} ${m.student.middlename || ''}`.trim()
        : '';
      const ceoApproval = normalizeOfficerApproval(m?.ceoApproval);
      const hodApproval = normalizeOfficerApproval(m?.hodApproval);
      const deanApproval = normalizeOfficerApproval(m?.deanApproval);

      return {
        id: m.student?._id || m.student,                // for table keys
        fullName,
        regNo: m.student?.regNo || '',
        session: m.session,
        semester: Number(m.semester ?? 0),
        level: Number(m.level ?? 0),

        // Previous snapshot (as stored)
        previousMetrics: m.previousMetrics || { CCC: 0, CCE: 0, CPE: 0, CGPA: 0 },

        // Current metrics (as stored on this doc — no recompute)
        currentMetrics: {
          TCC: Number(m.TCC || 0),
          TCE: Number(m.TCE || 0),
          TPE: Number(m.TPE || 0),
          GPA: Number(m.GPA || 0),
        },

        // Cumulative metrics (as stored on this doc)
        metrics: {
          CCC: Number(m.CCC || 0),
          CCE: Number(m.CCE || 0),
          CPE: Number(m.CPE || 0),
          CGPA: Number(m.CGPA || 0),
          _id: m._id, // used by the client for updates
        },
        ceoApproval,
        hodApproval,
        deanApproval,
      };
    });

    return res.json({ students: rows });
  } catch (error) {
    console.error('Error in simple searchMetrics:', error);
    res.status(500).json({ error: 'Failed to search metrics', details: error.message });
  }
};

// --- SIMPLE UPDATE: allow updating previous + current + cumulative fields ---
// Accepts any subset of fields: previousMetrics object, and/or TCC/TCE/TPE/GPA,
// and/or CCC/CCE/CPE/CGPA. Does not recompute anything.

export const updateMetrics = async (req, res) => {
  try {
    const { metricsId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(metricsId)) {
      return res.status(400).json({ error: 'Invalid metrics ID' });
    }

    const existingDoc = await AcademicMetrics.findById(metricsId).lean();
    if (!existingDoc) {
      return res.status(404).json({ error: 'Metrics not found' });
    }

    if (existingDoc.student) {
      const student = await Student.findById(existingDoc.student).select('department college');
      if (student) {
        ensureUserCanAccessDepartment(req.user, student.department, student.college);
      }
    }

    // Whitelist only fields we want to allow from the client
    const {
      previousMetrics, // { CCC, CCE, CPE, CGPA }
      TCC, TCE, TPE, GPA, // current
      CCC, CCE, CPE, CGPA, // cumulative
      ceoApproval,
      ceoApproved,
      ceoFlagged,
      ceoName,
      ceoNote,
      ceoTitle,
      ceoSurname,
      ceoFirstname,
      ceoMiddlename,
      ceoDepartment,
      ceoCollege,
      hodApproval,
      hodApproved,
      hodFlagged,
      hodName,
      hodNote,
      hodTitle,
      hodSurname,
      hodFirstname,
      hodMiddlename,
      hodDepartment,
      hodCollege,
      deanApproval,
      deanApproved,
      deanFlagged,
      deanName,
      deanNote,
      deanTitle,
      deanSurname,
      deanFirstname,
      deanMiddlename,
      deanDepartment,
      deanCollege,
    } = req.body || {};

    const $set = { lastUpdated: new Date() };
    const isAdmin = req.user?.roles?.includes('ADMIN');
    const adminNote =
      isAdmin && (req.user?.pfNo || req.user?.email)
        ? `Admin override by ${req.user.pfNo || req.user.email}`
        : 'Admin override';

    if (previousMetrics && typeof previousMetrics === 'object') {
      $set.previousMetrics = {
        CCC: Number(previousMetrics.CCC ?? 0),
        CCE: Number(previousMetrics.CCE ?? 0),
        CPE: Number(previousMetrics.CPE ?? 0),
        CGPA: Number(previousMetrics.CGPA ?? 0),
      };
    }

    if (TCC !== undefined) $set.TCC = Number(TCC || 0);
    if (TCE !== undefined) $set.TCE = Number(TCE || 0);
    if (TPE !== undefined) $set.TPE = Number(TPE || 0);
    if (GPA !== undefined) $set.GPA = Number(GPA || 0);

    if (CCC !== undefined) $set.CCC = Number(CCC || 0);
    if (CCE !== undefined) $set.CCE = Number(CCE || 0);
    if (CPE !== undefined) $set.CPE = Number(CPE || 0);
    if (CGPA !== undefined) $set.CGPA = Number(CGPA || 0);

    const ceoPayload = {
      ...((ceoApproval && typeof ceoApproval === 'object') ? ceoApproval : {}),
    };
    if (ceoApproved !== undefined) ceoPayload.approved = ceoApproved;
    if (ceoFlagged !== undefined) ceoPayload.flagged = ceoFlagged;
    if (ceoName !== undefined) ceoPayload.name = ceoName;
    if (ceoNote !== undefined) ceoPayload.note = ceoNote;
    if (ceoTitle !== undefined) ceoPayload.title = String(ceoTitle ?? '').trim();
    if (ceoSurname !== undefined) ceoPayload.surname = String(ceoSurname ?? '').trim();
    if (ceoFirstname !== undefined) ceoPayload.firstname = String(ceoFirstname ?? '').trim();
    if (ceoMiddlename !== undefined) ceoPayload.middlename = String(ceoMiddlename ?? '').trim();
    if (ceoDepartment !== undefined) ceoPayload.department = String(ceoDepartment ?? '').trim();
    if (ceoCollege !== undefined) ceoPayload.college = String(ceoCollege ?? '').trim();
    if (isAdmin && ('approved' in ceoPayload || 'flagged' in ceoPayload)) {
      if (!('note' in ceoPayload) || !ceoPayload.note) {
        ceoPayload.note = adminNote;
      }
    }

    const ceoSet = {};
    if ('approved' in ceoPayload) ceoSet['ceoApproval.approved'] = Boolean(ceoPayload.approved);
    if ('flagged' in ceoPayload) ceoSet['ceoApproval.flagged'] = Boolean(ceoPayload.flagged);
    if ('name' in ceoPayload) ceoSet['ceoApproval.name'] = String(ceoPayload.name ?? '').trim();
    if ('note' in ceoPayload) ceoSet['ceoApproval.note'] = String(ceoPayload.note ?? '').trim();
    if ('title' in ceoPayload) ceoSet['ceoApproval.title'] = String(ceoPayload.title ?? '').trim();
    if ('surname' in ceoPayload) ceoSet['ceoApproval.surname'] = String(ceoPayload.surname ?? '').trim();
    if ('firstname' in ceoPayload) ceoSet['ceoApproval.firstname'] = String(ceoPayload.firstname ?? '').trim();
    if ('middlename' in ceoPayload) ceoSet['ceoApproval.middlename'] = String(ceoPayload.middlename ?? '').trim();
    if ('department' in ceoPayload) ceoSet['ceoApproval.department'] = String(ceoPayload.department ?? '').trim();
    if ('college' in ceoPayload) ceoSet['ceoApproval.college'] = String(ceoPayload.college ?? '').trim();
    if (Object.keys(ceoSet).length) {
      ceoSet['ceoApproval.updatedAt'] = new Date();
      Object.assign($set, ceoSet);
    }

    const hodPayload = {
      ...((hodApproval && typeof hodApproval === 'object') ? hodApproval : {}),
    };
    if (hodApproved !== undefined) hodPayload.approved = hodApproved;
    if (hodFlagged !== undefined) hodPayload.flagged = hodFlagged;
    if (hodName !== undefined) hodPayload.name = hodName;
    if (hodNote !== undefined) hodPayload.note = hodNote;
    if (hodTitle !== undefined) hodPayload.title = String(hodTitle ?? '').trim();
    if (hodSurname !== undefined) hodPayload.surname = String(hodSurname ?? '').trim();
    if (hodFirstname !== undefined) hodPayload.firstname = String(hodFirstname ?? '').trim();
    if (hodMiddlename !== undefined) hodPayload.middlename = String(hodMiddlename ?? '').trim();
    if (hodDepartment !== undefined) hodPayload.department = String(hodDepartment ?? '').trim();
    if (hodCollege !== undefined) hodPayload.college = String(hodCollege ?? '').trim();
    if (isAdmin && ('approved' in hodPayload || 'flagged' in hodPayload)) {
      if (!('note' in hodPayload) || !hodPayload.note) {
        hodPayload.note = adminNote;
      }
    }

    const hodSet = {};
    if ('approved' in hodPayload) hodSet['hodApproval.approved'] = Boolean(hodPayload.approved);
    if ('flagged' in hodPayload) hodSet['hodApproval.flagged'] = Boolean(hodPayload.flagged);
    if ('name' in hodPayload) hodSet['hodApproval.name'] = String(hodPayload.name ?? '').trim();
    if ('note' in hodPayload) hodSet['hodApproval.note'] = String(hodPayload.note ?? '').trim();
    if ('title' in hodPayload) hodSet['hodApproval.title'] = String(hodPayload.title ?? '').trim();
    if ('surname' in hodPayload) hodSet['hodApproval.surname'] = String(hodPayload.surname ?? '').trim();
    if ('firstname' in hodPayload) hodSet['hodApproval.firstname'] = String(hodPayload.firstname ?? '').trim();
    if ('middlename' in hodPayload) hodSet['hodApproval.middlename'] = String(hodPayload.middlename ?? '').trim();
    if ('department' in hodPayload) hodSet['hodApproval.department'] = String(hodPayload.department ?? '').trim();
    if ('college' in hodPayload) hodSet['hodApproval.college'] = String(hodPayload.college ?? '').trim();
    if (Object.keys(hodSet).length) {
      hodSet['hodApproval.updatedAt'] = new Date();
      Object.assign($set, hodSet);
    }

    const deanPayload = {
      ...((deanApproval && typeof deanApproval === 'object') ? deanApproval : {}),
    };
    if (deanApproved !== undefined) deanPayload.approved = deanApproved;
    if (deanFlagged !== undefined) deanPayload.flagged = deanFlagged;
    if (deanName !== undefined) deanPayload.name = deanName;
    if (deanNote !== undefined) deanPayload.note = deanNote;
    if (deanTitle !== undefined) deanPayload.title = String(deanTitle ?? '').trim();
    if (deanSurname !== undefined) deanPayload.surname = String(deanSurname ?? '').trim();
    if (deanFirstname !== undefined) deanPayload.firstname = String(deanFirstname ?? '').trim();
    if (deanMiddlename !== undefined) deanPayload.middlename = String(deanMiddlename ?? '').trim();
    if (deanDepartment !== undefined) deanPayload.department = String(deanDepartment ?? '').trim();
    if (deanCollege !== undefined) deanPayload.college = String(deanCollege ?? '').trim();
    if (isAdmin && ('approved' in deanPayload || 'flagged' in deanPayload)) {
      if (!('note' in deanPayload) || !deanPayload.note) {
        deanPayload.note = adminNote;
      }
    }

    const deanSet = {};
    if ('approved' in deanPayload) deanSet['deanApproval.approved'] = Boolean(deanPayload.approved);
    if ('flagged' in deanPayload) deanSet['deanApproval.flagged'] = Boolean(deanPayload.flagged);
    if ('name' in deanPayload) deanSet['deanApproval.name'] = String(deanPayload.name ?? '').trim();
    if ('note' in deanPayload) deanSet['deanApproval.note'] = String(deanPayload.note ?? '').trim();
    if ('title' in deanPayload) deanSet['deanApproval.title'] = String(deanPayload.title ?? '').trim();
    if ('surname' in deanPayload) deanSet['deanApproval.surname'] = String(deanPayload.surname ?? '').trim();
    if ('firstname' in deanPayload) deanSet['deanApproval.firstname'] = String(deanPayload.firstname ?? '').trim();
    if ('middlename' in deanPayload) deanSet['deanApproval.middlename'] = String(deanPayload.middlename ?? '').trim();
    if ('department' in deanPayload) deanSet['deanApproval.department'] = String(deanPayload.department ?? '').trim();
    if ('college' in deanPayload) deanSet['deanApproval.college'] = String(deanPayload.college ?? '').trim();
    if (Object.keys(deanSet).length) {
      deanSet['deanApproval.updatedAt'] = new Date();
      Object.assign($set, deanSet);
    }

    const currentCeoApproved = Boolean(existingDoc?.ceoApproval?.approved);
    const currentHodApproved = Boolean(existingDoc?.hodApproval?.approved);
    const currentDeanApproved = Boolean(existingDoc?.deanApproval?.approved);

    let targetCeoApproved = currentCeoApproved;
    if ('approved' in ceoPayload) targetCeoApproved = Boolean(ceoPayload.approved);

    let targetHodApproved = currentHodApproved;
    if ('approved' in hodPayload) targetHodApproved = Boolean(hodPayload.approved);

    let targetDeanApproved = currentDeanApproved;
    if ('approved' in deanPayload) targetDeanApproved = Boolean(deanPayload.approved);

    if (targetHodApproved && !targetCeoApproved) {
      return res.status(400).json({
        error: 'Head of Department cannot approve before the College Exam Officer has approved.',
      });
    }

    if (targetDeanApproved && (!targetCeoApproved || !targetHodApproved)) {
      return res.status(400).json({
        error: 'Dean cannot approve before both the College Exam Officer and Head of Department have approved.',
      });
    }

    const updated = await AcademicMetrics.findByIdAndUpdate(
      metricsId,
      { $set },
      { new: true, runValidators: true }
    ).populate({ path: 'student', select: 'surname firstname middlename regNo' });
    if (!updated) {
      return res.status(404).json({ error: 'Metrics not found' });
    }

    // Return in the same shape the table expects
    const fullName = updated.student
      ? `${updated.student.surname} ${updated.student.firstname} ${updated.student.middlename || ''}`.trim()
      : '';

    return res.status(200).json({
      message: 'Academic metrics updated successfully',
      updatedMetrics: {
        id: updated.student?._id || updated.student,
        fullName,
        regNo: updated.student?.regNo || '',
        session: updated.session,
        semester: Number(updated.semester ?? 0),
        level: Number(updated.level ?? 0),
        previousMetrics: updated.previousMetrics || { CCC: 0, CCE: 0, CPE: 0, CGPA: 0 },
        currentMetrics: {
          TCC: Number(updated.TCC || 0),
          TCE: Number(updated.TCE || 0),
          TPE: Number(updated.TPE || 0),
          GPA: Number(updated.GPA || 0),
        },
        metrics: {
          CCC: Number(updated.CCC || 0),
          CCE: Number(updated.CCE || 0),
          CPE: Number(updated.CPE || 0),
          CGPA: Number(updated.CGPA || 0),
          _id: updated._id,
        },
        ceoApproval: normalizeOfficerApproval(updated?.ceoApproval),
        hodApproval: normalizeOfficerApproval(updated?.hodApproval),
        deanApproval: normalizeOfficerApproval(updated?.deanApproval),
      },
    });
  } catch (error) {
    console.error('Error updating metrics:', error);
    res.status(500).json({ error: 'Failed to update metrics', details: error.message });
  }
};



// RECOMPUTE metrics for a term (session+semester+level) from scratch
export const recomputeTermMetrics = async (req, res) => {
  try {
    const { session = req.query.session, semester = req.query.semester, level = req.query.level } = {
      ...req.body,
      ...req.query,
    };
    if (!session || !semester || !level) {
      return res.status(400).json({ error: 'session, semester, level are required' });
    }

    const parseListParam = (raw) => {
      if (!raw) return [];
      const arr = Array.isArray(raw) ? raw : [raw];
      return arr
        .flatMap((value) => String(value).split(','))
        .map((value) => value.trim())
        .filter(Boolean);
    };

    const requestedStudentIds = new Set(parseListParam(req.body?.studentIds));
    const requestedRegNos = new Set(parseListParam(req.body?.studentRegNos || req.body?.regNos).map(normalizeRegNo));

    const sem = Number(semester);
    const lvlStr = String(level);  // for Result/CourseRegistration
    const lvlNum = Number(level);  // for AcademicMetrics

    const { departmentId, departmentObjectId } = resolveDepartmentScope(req.user);

    const resultFilter = { session, semester: sem, level: lvlStr };

    const resultStudents = await Result.distinct('student', resultFilter);

    const registrationMatch = { session, semester: sem, level: lvlStr };
    if (departmentObjectId) {
      registrationMatch.department = departmentObjectId;
    }

    const regAgg = await CourseRegistration.aggregate([
      { $match: registrationMatch },
      { $unwind: '$student' },
      { $group: { _id: null, students: { $addToSet: '$student' } } },
      { $project: { _id: 0, students: 1 } },
    ]);
    const regStudents = regAgg[0]?.students || [];
    const combinedStudents = [...new Set([...resultStudents.map(String), ...regStudents.map(String)])];

    let targetStudentIds = combinedStudents;
    if (requestedStudentIds.size || requestedRegNos.size) {
      const selected = new Set();

      combinedStudents.forEach((sid) => {
        if (requestedStudentIds.has(sid)) selected.add(sid);
      });

      if (requestedRegNos.size) {
      const studentFilter = { _id: { $in: combinedStudents } };
      if (departmentId) {
        studentFilter.department = departmentId;
      }

      const docs = await Student.find(studentFilter)
        .select('_id regNo')
        .lean();
        docs.forEach((doc) => {
          const regUpper = normalizeRegNo(doc.regNo);
          if (requestedRegNos.has(regUpper)) {
            selected.add(String(doc._id));
          }
        });
      }

      targetStudentIds = [...selected];
      if (!targetStudentIds.length) {
        return res.json({ ok: true, message: 'No matching students for the provided selection.', count: 0 });
      }
    }

    if (departmentId && targetStudentIds.length) {
      const allowedStudents = await Student.find({
        _id: { $in: targetStudentIds },
        department: departmentId,
      }).select('_id').lean();
      const allowedSet = new Set(allowedStudents.map((doc) => String(doc._id)));
      targetStudentIds = targetStudentIds.filter((sid) => allowedSet.has(String(sid)));
    }

    if (!targetStudentIds.length) {
      return res.json({ ok: true, message: 'No matching students for the provided selection.', count: 0 });
    }

    const studentDocsForMetrics = await Student.find({ _id: { $in: targetStudentIds } })
      .populate('department', 'name')
      .populate('college', 'name')
      .select('_id department college')
      .lean();
    const studentInfoById = new Map(
      studentDocsForMetrics.map((doc) => [String(doc._id), doc])
    );

    const regs = await CourseRegistration.aggregate([
      { $match: registrationMatch },
      { $unwind: '$student' },
      { $group: { _id: '$student', courses: { $addToSet: '$course' } } },
    ]);
    const regByStudent = new Map(regs.map(r => [String(r._id), new Set(r.courses.map(String))]));

    const allCourseIds = new Set();
    regs.forEach(r => r.courses.forEach(c => allCourseIds.add(String(c))));
    const courses = await Course.find({ _id: { $in: [...allCourseIds] } }).select('_id unit').lean();
    const courseUnitById = new Map(courses.map(c => [String(c._id), Number(c.unit) || 0]));

    async function attemptedFor(studentId) {
      const sid = new mongoose.Types.ObjectId(studentId);
      const results = await Result.find({ student: sid, session, semester: sem, level: lvlStr })
        .populate('course', 'unit')
        .lean();

      const byCourse = new Map(
        results.map(r => [String(r.course?._id), { unit: Number(r.course?.unit) || 0, grade: String(r.grade || 'F') }])
      );

      const regsSet = regByStudent.get(String(studentId)) || new Set();
      if (!regsSet.size) return [];

      const attempted = [];
      regsSet.forEach(cid => {
        if (byCourse.has(cid)) attempted.push(byCourse.get(cid));
        else attempted.push({ unit: courseUnitById.get(cid) || 0, grade: 'F' });
      });

      return attempted;
    }

    const targetFilter = targetStudentIds.length ? { student: { $in: targetStudentIds } } : {};

    if (targetStudentIds.length === combinedStudents.length && !requestedStudentIds.size && !requestedRegNos.size) {
      await AcademicMetrics.deleteMany({ session, semester: sem, level: lvlNum });
    } else if (targetStudentIds.length) {
      await AcademicMetrics.deleteMany({ session, semester: sem, level: lvlNum, ...targetFilter });
    }

    for (const sid of targetStudentIds) {
      const attempted = await attemptedFor(sid);
      const previousMetrics = await findPreviousMetrics(sid, session, sem);

      const studentInfo = studentInfoById.get(String(sid));
      const departmentName = studentInfo?.department?.name || '';
      const collegeName = studentInfo?.college?.name || '';
      const normalizedDepartmentName = departmentName || DEFAULT_DEPARTMENT_NAME;
      const normalizedCollegeName = collegeName || DEFAULT_COLLEGE_NAME;

      if (attempted.length) {
        const current = calculateAcademicMetrics(attempted, previousMetrics);
        await AcademicMetrics.findOneAndUpdate(
          { student: sid, session, semester: sem, level: lvlNum },
          {
            ...current,
            previousMetrics,
            lastUpdated: new Date(),
            department: normalizedDepartmentName,
            college: normalizedCollegeName,
          },
          { upsert: true, new: true }
        );
      } else {
        await AcademicMetrics.deleteOne({ student: sid, session, semester: sem, level: lvlNum });
      }
    }

    return res.json({
      ok: true,
      message: 'Metrics recomputed for selected students',
      count: targetStudentIds.length,
    });
  } catch (err) {
    console.error('recomputeTermMetrics error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

// COMPUTE metrics for a single student by RegNo (registered-only)
export const computeStudentTermMetrics = async (req, res) => {
  try {
    const { session, semester, level, regNo } = req.query;
    if (!session || !semester || !level || !regNo) {
      return res.status(400).json({ error: 'session, semester, level, regNo are required' });
    }

    const sem = Number(semester);
    const lvlStr = String(level);
    const lvlNum = Number(level);
    const regUpper = String(regNo).trim().toUpperCase();

    const student = await Student.findOne({ regNo: regUpper })
      .populate('department', 'name')
      .populate('college', 'name')
      .lean();
    if (!student) return res.status(404).json({ error: 'Student not found' });

    const { departmentId, departmentObjectId } = resolveDepartmentScope(req.user);
    const studentDepartmentId =
      student.department && typeof student.department === 'object'
        ? String(student.department._id || '')
        : String(student.department || '');
    if (departmentId && studentDepartmentId !== departmentId) {
      return res.status(403).json({ error: 'You are not authorized to compute metrics for this student.' });
    }

    const registrationMatchSingle = { session, semester: sem, level: lvlStr };
    if (departmentObjectId) {
      registrationMatchSingle.department = departmentObjectId;
    }

    const regsAgg = await CourseRegistration.aggregate([
      { $match: registrationMatchSingle },
      { $unwind: '$student' },
      { $match: { student: student._id } },
      { $group: { _id: '$student', courses: { $addToSet: '$course' } } },
      { $project: { _id: 0, courses: 1 } },
    ]);
    const registeredCourseIds = new Set((regsAgg[0]?.courses || []).map(id => String(id)));

    const results = await Result.find({
      student: student._id, session, semester: sem, level: lvlStr,
    }).populate('course', '_id unit code title').lean();

    const byCourse = new Map();
    results.forEach(r => {
      const cid = String(r.course?._id);
      byCourse.set(cid, { unit: Number(r.course?.unit) || 0, grade: String(r.grade || 'F') });
    });

    const allCourseIds = new Set([...registeredCourseIds, ...Array.from(byCourse.keys())]);
    const courseUnits = new Map();
    if (allCourseIds.size) {
      const courses = await Course.find({ _id: { $in: [...allCourseIds] } }).select('_id unit').lean();
      courses.forEach(c => courseUnits.set(String(c._id), Number(c.unit) || 0));
    }

    const attempted = [];
    registeredCourseIds.forEach(cid => {
      if (byCourse.has(cid)) attempted.push(byCourse.get(cid));
      else attempted.push({ unit: courseUnits.get(cid) || 0, grade: 'F' });
    });

    const previousMetrics = await findPreviousMetrics(student._id, session, sem);
    const current = calculateAcademicMetrics(attempted, previousMetrics);
    const departmentName =
      student.department && typeof student.department === 'object'
        ? student.department.name || ''
        : '';
    const collegeName =
      student.college && typeof student.college === 'object'
        ? student.college.name || ''
        : '';
    const normalizedDepartmentName = departmentName || DEFAULT_DEPARTMENT_NAME;
    const normalizedCollegeName = collegeName || DEFAULT_COLLEGE_NAME;

    // BEFORE (overwrites edited fields every time)
// const updated = await AcademicMetrics.findOneAndUpdate(
//   { student: stu.id, session, semester: semNum, level: lvlNum },
//   { $set: { ...current, previousMetrics, lastUpdated: new Date() } },
//   { new: true, upsert: true }
// );

// AFTER (only set metrics on first insert; preserve edits on subsequent runs)
const updated = await AcademicMetrics.findOneAndUpdate(
  { student: student._id, session, semester: sem, level: lvlNum },
  {
    $set: {
      previousMetrics,
      lastUpdated: new Date(),
      department: normalizedDepartmentName,
      college: normalizedCollegeName,
    },
    $setOnInsert: {
      TCC: current.TCC,
      TCE: current.TCE,
      TPE: current.TPE,
      GPA: current.GPA,
      CCC: current.CCC,
      CCE: current.CCE,
      CPE: current.CPE,
      CGPA: current.CGPA,
      session,
      semester: sem,
      level: lvlNum,
      student: student._id,
    },
  },
  { new: true, upsert: true }
);


    return res.json({
      id: String(student._id),
      fullName: `${student.surname} ${student.firstname} ${student.middlename || ''}`.trim(),
      regNo: student.regNo,
      previousMetrics,
      currentMetrics: { TCC: current.TCC, TCE: current.TCE, TPE: current.TPE, GPA: current.GPA },
      metrics: { CCC: updated.CCC, CCE: updated.CCE, CPE: updated.CPE, CGPA: updated.CGPA, _id: updated._id },
      department: normalizedDepartmentName,
      college: normalizedCollegeName,
    });
  } catch (err) {
    console.error('computeStudentTermMetrics error:', err);
    return res.status(500).json({ error: 'Failed to compute metrics', details: err.message });
  }
};
