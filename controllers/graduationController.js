// controllers/graduationController.js  (UPDATED)
import mongoose from 'mongoose';
import AcademicMetrics from '../models/academicMetrics.js';
import Student from '../models/student.js';
import Result from '../models/result.js';
import CourseRegistration from '../models/courseRegistration.js';
import ApprovedCourses from '../models/approvedCourses.js';

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

    const approvedDocs = await ApprovedCourses.find({
      session,
      level: 400,
      semester: { $in: [1, 2] },
    })
      .populate('courses', 'code title unit option')
      .lean();

    const approvedCourseMeta = new Map(); // courseId -> details
    const approvedCourseIds = new Set();

    approvedDocs.forEach((doc) => {
      const sem = Number(doc.semester);
      (doc.courses || []).forEach((course) => {
        const cid = String(course?._id || course);
        if (!cid) return;
        approvedCourseIds.add(cid);
        if (!approvedCourseMeta.has(cid)) {
          approvedCourseMeta.set(cid, {
            code: course.code || '',
            title: course.title || '',
            option: course.option || '',
            unit: Number(course.unit) || 0,
            semester: sem,
          });
        }
      });
    });

    const approvedCourseList = Array.from(approvedCourseIds);

    const registrationAgg = approvedCourseIds.size
      ? await CourseRegistration.aggregate([
          {
            $match: {
              session,
              level: '400',
              semester: { $in: [1, 2] },
            },
          },
          { $unwind: '$student' },
          { $match: { student: { $in: studentIds } } },
          {
            $group: {
              _id: '$student',
              courses: { $addToSet: '$course' },
            },
          },
        ])
      : [];

    const registrationsByStudent = new Map(); // sid -> Set(courseId)
    registrationAgg.forEach((row) => {
      const sid = String(row._id);
      const courses = new Set(
        (row.courses || []).map((courseId) => String(courseId))
      );
      registrationsByStudent.set(sid, courses);
    });

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

    const resultsByStudent = new Map(); // sid -> Map(courseId -> result)
    for (const [key, row] of latestAttempt.entries()) {
      const [sid, cid] = key.split('|');
      if (!resultsByStudent.has(sid)) {
        resultsByStudent.set(sid, new Map());
      }
      if (!resultsByStudent.get(sid).has(cid)) {
        resultsByStudent.get(sid).set(cid, row);
      }
    }

    // Student → list of unresolved failed course details
    const failedByStudent = new Map(); // sid -> [{code, unit, score, grade, session, semester}]
    for (const [key, row] of latestAttempt.entries()) {
      if ((row.grade || '').toUpperCase() === 'F') {
        const sid = String(row.student);
        const cid = key.split('|')[1];
        if (!failedByStudent.has(sid)) failedByStudent.set(sid, []);
        failedByStudent.get(sid).push({
          code: row.course?.code || '',
          unit: row.course?.unit,
          score: row.grandtotal,
          grade: row.grade,
          courseId: cid,
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
        const failDetails = (failedByStudent.get(sid) || []).map((fail) => ({
          ...fail,
          isApprovedCourse: approvedCourseIds.has(fail.courseId || ''),
        }));
        failDetails.sort((a, b) => (a.code || '').localeCompare(b.code || ''));

        const registeredCourses = registrationsByStudent.get(sid) || new Set();
        const studentResults = resultsByStudent.get(sid) || new Map();

        const missingRegistrationIds = approvedCourseList.filter(
          (cid) => !registeredCourses.has(cid)
        );
        const missingResultIds = approvedCourseList.filter(
          (cid) => !studentResults.has(cid)
        );

        const missingRegistrationCodes = missingRegistrationIds
          .map((cid) => approvedCourseMeta.get(cid)?.code || '')
          .filter(Boolean);
        const missingResultCodes = missingResultIds
          .map((cid) => approvedCourseMeta.get(cid)?.code || '')
          .filter(Boolean);

        const registeredAllApproved = missingRegistrationIds.length === 0;
        const attemptedAllApproved = missingResultIds.length === 0;

        const approvedFails = failDetails.filter(
          (fail) => approvedCourseIds.has(fail.courseId || '')
        );
        const passedAllApproved = approvedFails.length === 0;

        const fails = failDetails;
        const noOutstandingFail = fails.length === 0;

        const isDE = s.regNoSuffix === 'DE';
        const minCCE = isDE ? 86 : 135;
        const meetsCCE = (m.CCE || 0) >= minCCE;

        const eligible =
          isStudentAt400 &&
          registeredAllApproved &&
          attemptedAllApproved &&
          passedAllApproved &&
          noOutstandingFail &&
          meetsCCE;

        const cgpa100 = latestCgpaByStudentLevel.get(`${sid}-100`) || 0;
        const cgpa200 = latestCgpaByStudentLevel.get(`${sid}-200`) || 0;
        const cgpa300 = latestCgpaByStudentLevel.get(`${sid}-300`) || 0;

        const reasons = [];
        if (!isStudentAt400) reasons.push('Not at 400 level');
        if (!registeredAllApproved && missingRegistrationCodes.length) {
          reasons.push(
            `Missing registration for approved course(s): ${missingRegistrationCodes.join(', ')}`
          );
        }
        if (!attemptedAllApproved && missingResultCodes.length) {
          reasons.push(
            `No final result recorded for approved course(s): ${missingResultCodes.join(', ')}`
          );
        }
        if (!passedAllApproved && approvedFails.length) {
          const codes = approvedFails
            .map((fail) => fail.code || '')
            .filter(Boolean);
          reasons.push(
            `Failed approved course(s): ${codes.join(', ')}`
          );
        }
        if (!noOutstandingFail && fails.length) {
          const codes = fails
            .map((fail) => fail.code || '')
            .filter(Boolean);
          reasons.push(
            `Outstanding failed course(s): ${codes.join(', ')}`
          );
        }
        if (!meetsCCE) reasons.push(`CCE below minimum (${m.CCE || 0} < ${minCCE} for ${isDE ? 'DE' : 'UE'})`);

        // sort failed course details by code for stable display
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
          failedCourseDetails: fails,
          compliance: {
            registeredAllApproved,
            attemptedAllApproved,
            passedAllApproved,
            missingRegistrations: missingRegistrationCodes,
            missingResults: missingResultCodes,
            outstandingApprovedFails: approvedFails.map((fail) => fail.code || ''),
            totalApprovedCourses: approvedCourseList.length,
          },
          eligibility: {
            eligible,
            rules: {
              is400Level: isStudentAt400,
              registeredAllApproved,
              attemptedAllApproved,
              passedAllApproved,
              noOutstandingFail,
              meetsCCE,
              minCCERequired: minCCE,
            },
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
      },
      requirements: {
        minimumCCE: { UE: 135, DE: 86 },
        approvedCourseCount: approvedCourseList.length,
        approvedCourses: approvedCourseList.map((cid) => ({
          id: cid,
          ...(approvedCourseMeta.get(cid) || {}),
        })),
      },
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
