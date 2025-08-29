// controllers/graduationController.js  (UPDATED)
import mongoose from 'mongoose';
import AcademicMetrics from '../models/academicMetrics.js';
import PassFail from '../models/passFailList.js';
import Student from '../models/student.js';
import Result from '../models/result.js';     // ← add
import Course from '../models/course.js'; 

export const isGraduationHookAvailable = async (req, res) => {
  try {
    const { level } = req.query;
    const available = String(level) === '400';
    return res.status(200).json({
      available,
      reason: available ? null : 'Graduation list is only available when computing 400 level.',
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to check availability', details: err.message });
  }
};

// controllers/graduationController.js  (ONLY the middle part is new)
    // ← add

export const getGraduatingList = async (req, res) => {
  try {
    const { session, semester, level } = req.query;

    if (!session || !semester || !level) {
      return res.status(400).json({ error: 'session, semester and level are required' });
    }
    if (String(level) !== '400') {
      return res.status(400).json({ error: 'Graduating list can only be computed for level 400' });
    }
    const semNum = Number(semester);
    if (![1, 2].includes(semNum)) {
      return res.status(400).json({ error: 'semester must be 1 or 2' });
    }

    // Current cumulative snapshot for 400L in given session/semester
    const metrics = await AcademicMetrics.find({
      session,
      semester: semNum,
      level: 400
    })
      .populate({
        path: 'student',
        select: 'surname firstname middlename regNo regNoSuffix regNoNumeric level status',
      })
      .lean();

    if (!metrics.length) {
      return res.status(200).json({
        session, semester: semNum, level: 400,
        total: 0, eligibleCount: 0, ineligibleCount: 0, students: []
      });
    }

    const studentIds = metrics.filter(m => m.student).map(m => m.student._id);

    // === Compute unresolved failed courses from Result directly ===
    // Pull all results for these students for all sessions/semesters (latest first)
    const allRes = await Result.find({ student: { $in: studentIds } })
      .populate('course', 'code unit')
      .select('student course session semester date grandtotal grade')
      .sort({ date: -1, session: -1, semester: -1 })
      .lean();

    // For each student+course, pick the latest attempt
    const latestAttempt = new Map(); // key `${sid}|${cid}` -> result row
    for (const r of allRes) {
      const sid = String(r.student);
      const cid = String(r.course?._id || r.course);
      const key = `${sid}|${cid}`;
      if (!latestAttempt.has(key)) {
        latestAttempt.set(key, r);
      }
    }

    // Student → list of unresolved failed course details
    const failedByStudent = new Map(); // sid -> [{code, unit, score, grade, session, semester}]
    for (const [key, row] of latestAttempt.entries()) {
      if ((row.grade || '').toUpperCase() === 'F') {
        const sid = String(row.student);
        if (!failedByStudent.has(sid)) failedByStudent.set(sid, []);
        failedByStudent.get(sid).push({
          code: row.course?.code || '',
          unit: row.course?.unit,
          score: row.grandtotal,
          grade: row.grade,
          session: row.session,
          semester: row.semester
        });
      }
    }

    // Previous level CGPAs (latest snapshot per level)
    const prevLevels = [100, 200, 300];
    const levelHistory = await AcademicMetrics.find({
      student: { $in: studentIds },
      level: { $in: prevLevels }
    })
      .sort({ level: 1, session: -1, semester: -1 })
      .select('student level CGPA')
      .lean();

    const latestCgpaByStudentLevel = new Map(); // `${sid}-${level}` -> CGPA
    for (const row of levelHistory) {
      const key = `${row.student}-${row.level}`;
      if (!latestCgpaByStudentLevel.has(key)) latestCgpaByStudentLevel.set(key, row.CGPA || 0);
    }

    const rows = metrics
      .filter(m => m.student)
      .map(m => {
        const s = m.student;
        const sid = String(s._id);

        const isStudentAt400 = String(s.level) === '400';
        const fails = failedByStudent.get(sid) || [];
        const noOutstandingFail = fails.length === 0;

        const isDE = s.regNoSuffix === 'DE';
        const minCCE = isDE ? 86 : 135;
        const meetsCCE = (m.CCE || 0) >= minCCE;

        const eligible = isStudentAt400 && noOutstandingFail && meetsCCE;

        const cgpa100 = latestCgpaByStudentLevel.get(`${sid}-100`) || 0;
        const cgpa200 = latestCgpaByStudentLevel.get(`${sid}-200`) || 0;
        const cgpa300 = latestCgpaByStudentLevel.get(`${sid}-300`) || 0;

        const reasons = [];
        if (!isStudentAt400) reasons.push('Not at 400 level');
        if (!noOutstandingFail) reasons.push('Outstanding failed course(s)');
        if (!meetsCCE) reasons.push(`CCE below minimum (${m.CCE || 0} < ${minCCE} for ${isDE ? 'DE' : 'UE'})`);

        // sort failed course details by code for stable display
        fails.sort((a, b) => (a.code || '').localeCompare(b.code || ''));

        return {
          id: sid,
          regNo: s.regNo,
          fullName: `${s.surname} ${s.firstname}${s.middlename ? ' ' + s.middlename : ''}`,
          regNoSuffix: s.regNoSuffix,
          levelLabel: s.level,
          status: s.status,
          cgpaByLevel: { L100: cgpa100, L200: cgpa200, L300: cgpa300 },
          cumulative: { CCC: m.CCC, CCE: m.CCE, CPE: m.CPE, CGPA: m.CGPA },
          current:     { TCC: m.TCC, TCE: m.TCE, TPE: m.TPE, GPA: m.GPA },
          failedCourseDetails: fails, // <<<<<< USED BY PDF
          eligibility: {
            eligible,
            rules: { is400Level: isStudentAt400, noOutstandingFail, meetsCCE, minCCERequired: minCCE },
            reasons
          },
        };
      })
      .sort((a, b) => {
        const nA = Number(a.regNo.split('/')[1]);
        const nB = Number(b.regNo.split('/')[1]);
        if (nA !== nB) return nA - nB;
        return (a.regNoSuffix || '').localeCompare(b.regNoSuffix || '');
      });

    const eligibleCount = rows.filter(r => r.eligibility.eligible).length;

    return res.status(200).json({
      session, semester: semNum, level: 400,
      total: rows.length, eligibleCount, ineligibleCount: rows.length - eligibleCount,
      students: rows,
      header: {
        college: 'Biological Sciences',
        department: 'Biochemistry',
        programme: 'B.Sc. Biochemistry',
        title: 'GRADUATING STUDENTS LIST'
      }
    });
  } catch (err) {
    console.error('Error in getGraduatingList:', err);
    return res.status(500).json({
      error: 'Failed to compute graduating list',
      details: err.message
    });
  }
};


export const finalizeGraduation = async (req, res) => {
  try {
    const { studentIds, session, semester } = req.body;
    if (!Array.isArray(studentIds) || studentIds.length === 0) {
      return res.status(400).json({ error: 'studentIds array is required' });
    }
    if (!session || !semester) {
      return res.status(400).json({ error: 'session and semester are required' });
    }
    const validIds = studentIds.filter(id => mongoose.Types.ObjectId.isValid(id));
    const { modifiedCount } = await Student.updateMany(
      { _id: { $in: validIds } },
      { $set: { status: 'graduated' } }
    );
    return res.status(200).json({ message: 'Graduation finalized', updated: modifiedCount });
  } catch (err) {
    console.error('Error finalizing graduation:', err);
    return res.status(500).json({ error: 'Failed to finalize graduation', details: err.message });
  }
};
