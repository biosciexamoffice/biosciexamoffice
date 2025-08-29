// controllers/academicMetrics.controller.js
import AcademicMetrics from '../models/academicMetrics.js';
import Result from '../models/result.js';
import Student from '../models/student.js';
import Course from '../models/course.js';
import CourseRegistration from '../models/courseRegistration.js';
import calculateAcademicMetrics from '../utills/calculateAcademicMetrics.js';
import mongoose from 'mongoose';

// Preload registrations for the cohort once: studentId -> Set(courseId)
async function preloadRegistrations(session, semester, level) {
  const sem = Number(semester);
  const lvl = String(level);

  const regs = await CourseRegistration.aggregate([
    { $match: { session, semester: sem, level: lvl } },
    { $unwind: '$student' },
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

  // Basic course info for any registered course (unit/code/title)
  const courses = await Course.find({ _id: { $in: [...allCourseIds] } })
    .select('_id unit code title')
    .lean();

  const courseInfo = new Map(courses.map((c) => [String(c._id), c]));
  return { regByStudent, courseInfo };
}

export const getComprehensiveResults = async (req, res) => {
  try {
    const { session, semester, level } = req.query;

    if (!session || !semester || !level) {
      return res.status(400).json({ error: 'Session, semester and level are required parameters' });
    }

    // 1) Load actual result rows for this cohort
    const results = await Result.find({
      session,
      semester: Number(semester),
      level: String(level),
    })
      .populate('student')
      .populate('course')
      .lean();

    const validResults = results.filter((r) => r.student && r.course);
    if (!validResults.length) {
      return res.json({ students: [], courses: [] });
    }

    // 2) Build maps from results
    const studentsMap = new Map(); // studentId -> { id, fullName, regNo, results(Map), ... }
    const coursesMap = new Map();  // courseId  -> { id, code, unit, title }

    validResults.forEach((r) => {
      const sid = String(r.student._id);
      const cid = String(r.course._id);

      if (!studentsMap.has(sid)) {
        studentsMap.set(sid, {
          id: sid,
          fullName: `${r.student.surname} ${r.student.firstname} ${r.student.middlename || ''}`.trim(),
          regNo: r.student.regNo,
          results: new Map(), // ONLY real results go here (UI reads this)
        });
      }

      if (!coursesMap.has(cid)) {
        coursesMap.set(cid, { id: cid, code: r.course.code, unit: r.course.unit, title: r.course.title });
      }

      // store the real result (UI uses this map)
      studentsMap.get(sid).results.set(cid, {
        grandtotal: r.grandtotal,
        grade: r.grade,
        unit: r.course.unit,
      });
    });

    // 3) Bring in registrations (to count 00 as F for metrics)
    const { regByStudent, courseInfo } = await preloadRegistrations(session, semester, level);

    // include registered-only courses in the courses list so columns can appear if needed
    for (const info of courseInfo.values()) {
      const cid = String(info._id);
      if (!coursesMap.has(cid)) {
        coursesMap.set(cid, { id: cid, code: info.code, unit: info.unit, title: info.title });
      }
    }

    // 4) Build response students + compute/update metrics
    const students = await Promise.all(
      [...studentsMap.values()].map(async (stu) => {
        // Attempted courses for metrics = every registered course this term
        const regSet = regByStudent.get(stu.id) || new Set();
        const attempted = [];

        for (const cid of regSet) {
          const real = stu.results.get(cid); // real result, if any
          if (real) {
            attempted.push({ unit: Number(real.unit) || 0, grade: String(real.grade || 'F') });
          } else {
            // registered but no score -> treat as F for metrics
            const info = courseInfo.get(cid);
            attempted.push({ unit: Number(info?.unit) || 0, grade: 'F' });
          }
        }

        // If student somehow had results but no registration match, we still
        // want to count the result courses as attempted (edge-case protection).
        if (!regSet.size) {
          for (const [cid, real] of stu.results.entries()) {
            attempted.push({ unit: Number(real.unit) || 0, grade: String(real.grade || 'F') });
          }
        }

        // Get previous cumulative snapshot
        const previousDoc = await AcademicMetrics.findOne({
          student: stu.id,
          $or: [{ session: { $lt: session } }, { session, semester: { $lt: Number(semester) } }],
        })
          .sort({ session: -1, semester: -1, level: -1 })
          .lean();

        const previousMetrics = previousDoc
          ? {
              CCC: previousDoc.CCC,
              CCE: previousDoc.CCE,
              CPE: previousDoc.CPE,
              CGPA: previousDoc.CGPA,
            }
          : { CCC: 0, CCE: 0, CPE: 0, CGPA: 0 };

        // Compute this term + cumulative (attempted includes "00 -> F")
        const current = calculateAcademicMetrics(attempted, previousMetrics);

        // Persist/Upsert the per-term metrics doc
        const updated = await AcademicMetrics.findOneAndUpdate(
          {
            student: stu.id,
            session,
            semester: Number(semester),
            level: String(level),
          },
          {
            $set: {
              ...current,
              previousMetrics,
            },
          },
          { new: true, upsert: true }
        );

        return {
          id: stu.id,
          fullName: stu.fullName,
          regNo: stu.regNo,
          // IMPORTANT: Only real results go to the UI (so "00" still renders as just 00)
          results: Object.fromEntries(stu.results),
          previousMetrics,
          currentMetrics: {
            TCC: current.TCC,
            TCE: current.TCE,
            TPE: current.TPE,
            GPA: current.GPA,
          },
          metrics: updated,
        };
      })
    );

    res.json({
      students,
      courses: [...coursesMap.values()],
    });
  } catch (error) {
    console.error('Error in getComprehensiveResults:', error);
    res.status(500).json({
      error: 'Failed to fetch comprehensive results',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
};

// The rest of your metrics controller (getMetrics, deleteMetrics, searchMetrics, updateMetrics) stays unchanged.


// GET all metrics
export const getMetrics = async (req, res) => {
  try {
    const response = await AcademicMetrics.find();
    if (!response || response.length === 0) {
      return res.status(404).json({ message: "Metrics not found" });
    }
    res.status(200).json({ response });
  } catch (error) {
    res.status(500).json({
      message: "Internal server error",
      error
    });
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
    res.status(500).json({
      error: 'Failed to delete academic metrics',
      details: error.message
    });
  }
};

// SEARCH metrics by filters
export const searchMetrics = async (req, res) => {
  try {
    const { session, semester, level, regNo } = req.query;

    const query = {};
    if (session) query.session = session;
    if (semester) query.semester = semester;
    if (level) query.level = level;

    if (regNo) {
      const student = await Student.findOne({ regNo });
      if (!student) {
        return res.json({ students: [] });
      }
      query.student = student._id;
    }

    const metrics = await AcademicMetrics.find(query)
      .populate({
        path: 'student',
        select: 'surname firstname middlename regNo'
      })
      .sort({ session: -1, semester: -1, level: -1 });

    if (!metrics || metrics.length === 0) {
      return res.json({ students: [] });
    }

    const formattedResults = metrics.map(metric => ({
      id: metric.student._id,
      fullName: `${metric.student.surname} ${metric.student.firstname} ${metric.student.middlename || ''}`.trim(),
      regNo: metric.student.regNo,
      session: metric.session,
      semester: metric.semester,
      level: metric.level,
      previousMetrics: metric.previousMetrics,
      currentMetrics: {
        TCC: metric.TCC,
        TCE: metric.TCE,
        TPE: metric.TPE,
        GPA: metric.GPA
      },
      metrics: {
        CCC: metric.CCC,
        CCE: metric.CCE,
        CPE: metric.CPE,
        CGPA: metric.CGPA,
        _id: metric._id
      }
    }));

    res.json({ students: formattedResults });

  } catch (error) {
    console.error('Error in searchMetrics:', error);
    res.status(500).json({
      error: 'Failed to search metrics',
      details: error.message
    });
  }
};

// UPDATE academic metrics
export const updateMetrics = async (req, res) => {
  try {
    const { metricsId } = req.params;
    const updateData = req.body;

    if (!mongoose.Types.ObjectId.isValid(metricsId)) {
      return res.status(400).json({ error: 'Invalid metrics ID' });
    }

    const updatedMetrics = await AcademicMetrics.findByIdAndUpdate(
      metricsId,
      { $set: updateData },
      { new: true, runValidators: true }
    );

    if (!updatedMetrics) {
      return res.status(404).json({ error: 'Metrics not found' });
    }

    res.status(200).json({
      message: 'Academic metrics updated successfully',
      updatedMetrics
    });

  } catch (error) {
    console.error('Error updating academic metrics:', error);
    res.status(500).json({
      error: 'Failed to update academic metrics',
      details: error.message
    });
  }
};
