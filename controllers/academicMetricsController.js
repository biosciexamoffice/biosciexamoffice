// controllers/academicMetrics.controller.js
import AcademicMetrics from '../models/academicMetrics.js';
import Result from '../models/result.js';
import Student from '../models/student.js';
import Course from '../models/course.js';
import CourseRegistration from '../models/courseRegistration.js';
import calculateAcademicMetrics from '../utills/calculateAcademicMetrics.js';
import mongoose from 'mongoose';

const normalizeRegNo = (value) => String(value || '').trim().toUpperCase();

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
    let regs = await CourseRegistration.aggregate([
      { $match: { session, semester: semNum, level: lvlStr } },
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
    const studentDocs = await Student.find({ _id: { $in: [...allStudentIds] } })
      .select('_id surname firstname middlename regNo standing status')
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
      .select('student TCC TCE TPE GPA CCC CCE CPE CGPA previousMetrics')
      .lean();

    const metricsByStudent = new Map(
      (existingMetricsDocs || []).map((m) => [String(m.student), m])
    );

    for (const sid of regByStudent.keys()) {
      if (metricsByStudent.has(sid)) continue; // reuse existing metrics

      const attempted = makeAttemptedFor(sid);
      if (!attempted.length) {
        // No registrations -> ensure no stale doc exists
        await AcademicMetrics.deleteOne({ student: sid, session, semester: semNum, level: lvlNum });
        continue;
      }

      // Use your robust previous-term helper (session/semester ordering is correct)
      const previousMetrics = await findPreviousMetrics(sid, session, semNum);
      const current = calculateAcademicMetrics(attempted, previousMetrics);

      // Create-once: set computed fields on insert only (preserve later manual edits)
      const created = await AcademicMetrics.findOneAndUpdate(
        { student: sid, session, semester: semNum, level: lvlNum },
        {
          $set: { previousMetrics, lastUpdated: new Date() },
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
        { new: true, upsert: true }
      ).lean();

      metricsByStudent.set(sid, created);
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

      const ceoApproval = {
        approved: Boolean(m?.ceoApproval?.approved),
        flagged: Boolean(m?.ceoApproval?.flagged),
        name: m?.ceoApproval?.name || '',
        note: m?.ceoApproval?.note || '',
        updatedAt: m?.ceoApproval?.updatedAt || null,
      };

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
export const getMetrics = async (_req, res) => {
  try {
    const response = await AcademicMetrics.find();
    if (!response || response.length === 0) {
      return res.status(404).json({ message: "Metrics not found" });
    }
    res.status(200).json({ response });
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

    // Session is stored as a string like "2023/2024"
    if (session) query.session = String(session).trim();

    // Some historical docs might have level/semester saved as strings.
    // Be liberal in matching: allow number or string.
    if (semester) {
      
      query.semester = Number(semester)
    }

    if (level) {
      
      query.level = Number(level);
    }

    // If regNo provided, resolve student id and filter by it
    if (regNo) {
      const student = await Student.findOne({
        regNo: String(regNo).trim().toUpperCase(),
      }).select('_id');
      if (!student) return res.json({ students: [] });
      query.student = student._id;
    }

    // Fetch raw stored metrics only
    console.log(query)
    const docs = await AcademicMetrics.find(query)
      .populate({ path: 'student', select: 'surname firstname middlename regNo' })
      .sort({ createdAt: -1, semester: -1 })
      .lean();
    
    //console.log(docs)

    const rows = (docs || []).map((m) => {
      const fullName = m.student
        ? `${m.student.surname} ${m.student.firstname} ${m.student.middlename || ''}`.trim()
        : '';

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
        ceoApproval: {
          approved: Boolean(m?.ceoApproval?.approved),
          flagged: Boolean(m?.ceoApproval?.flagged),
          name: m?.ceoApproval?.name || '',
          note: m?.ceoApproval?.note || '',
          updatedAt: m?.ceoApproval?.updatedAt || null,
        },
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
    } = req.body || {};

    const $set = { lastUpdated: new Date() };

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

    const ceoSet = {};
    if ('approved' in ceoPayload) ceoSet['ceoApproval.approved'] = Boolean(ceoPayload.approved);
    if ('flagged' in ceoPayload) ceoSet['ceoApproval.flagged'] = Boolean(ceoPayload.flagged);
    if ('name' in ceoPayload) ceoSet['ceoApproval.name'] = String(ceoPayload.name ?? '').trim();
    if ('note' in ceoPayload) ceoSet['ceoApproval.note'] = String(ceoPayload.note ?? '').trim();
    if (Object.keys(ceoSet).length) {
      ceoSet['ceoApproval.updatedAt'] = new Date();
      Object.assign($set, ceoSet);
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
        ceoApproval: {
          approved: Boolean(updated?.ceoApproval?.approved),
          flagged: Boolean(updated?.ceoApproval?.flagged),
          name: updated?.ceoApproval?.name || '',
          note: updated?.ceoApproval?.note || '',
          updatedAt: updated?.ceoApproval?.updatedAt || null,
        },
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

    const resultStudents = await Result.distinct('student', { session, semester: sem, level: lvlStr });
    const regAgg = await CourseRegistration.aggregate([
      { $match: { session, semester: sem, level: lvlStr } },
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
        const docs = await Student.find({ _id: { $in: combinedStudents } })
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

    const regs = await CourseRegistration.aggregate([
      { $match: { session, semester: sem, level: lvlStr } },
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

      if (attempted.length) {
        const current = calculateAcademicMetrics(attempted, previousMetrics);
        await AcademicMetrics.findOneAndUpdate(
          { student: sid, session, semester: sem, level: lvlNum },
          { ...current, previousMetrics, lastUpdated: new Date() },
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

    const student = await Student.findOne({ regNo: regUpper }).lean();
    if (!student) return res.status(404).json({ error: 'Student not found' });

    const regsAgg = await CourseRegistration.aggregate([
      { $match: { session, semester: sem, level: lvlStr } },
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

    // BEFORE (overwrites edited fields every time)
// const updated = await AcademicMetrics.findOneAndUpdate(
//   { student: stu.id, session, semester: semNum, level: lvlNum },
//   { $set: { ...current, previousMetrics, lastUpdated: new Date() } },
//   { new: true, upsert: true }
// );

// AFTER (only set metrics on first insert; preserve edits on subsequent runs)
const updated = await AcademicMetrics.findOneAndUpdate(
  { student: stu.id, session, semester: semNum, level: lvlNum },
  {
    // always keep these fresh
    $set: { previousMetrics, lastUpdated: new Date() },
    // only write computed metrics when creating the doc for the first time
    $setOnInsert: {
      TCC: current.TCC,
      TCE: current.TCE,
      TPE: current.TPE,
      GPA: current.GPA,
      CCC: current.CCC,
      CCE: current.CCE,
      CPE: current.CPE,
      CGPA: current.CGPA,
      // also persist session/semester/level/student on insert for completeness
      session,
      semester: semNum,
      level: lvlNum,
      student: stu.id,
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
    });
  } catch (err) {
    console.error('computeStudentTermMetrics error:', err);
    return res.status(500).json({ error: 'Failed to compute metrics', details: err.message });
  }
};
