import AcademicMetrics from '../models/academicMetrics.js';
import Result from '../models/result.js';
import Student from '../models/student.js';
import calculateAcademicMetrics from '../utills/calculateAcademicMetrics.js';
import mongoose from 'mongoose';

export const getComprehensiveResults = async (req, res) => {
  try {
    const { session, semester, level } = req.query;

    // Validate required parameters
    if (!session || !semester || !level) {
      return res.status(400).json({
        error: 'Session, semester and level are required parameters'
      });
    }

    // 1. Get all results with populated student and course data
    const results = await Result.find({ session, semester, level })
      .populate('student')
      .populate('course')
      .lean();

    // Filter out invalid results
    const validResults = results.filter(result => result.student && result.course);

    const filteredCount = results.length - validResults.length;
    if (filteredCount > 0) {
      console.warn(`Filtered out ${filteredCount} invalid results with missing references`);
    }

    if (validResults.length === 0) {
      return res.json({ students: [], courses: [] });
    }

    // 2. Process student and course data using Maps
    const studentsMap = new Map();
    const coursesMap = new Map();

    validResults.forEach(result => {
      const studentId = result.student._id.toString();
      const courseId = result.course._id.toString();

      if (!studentsMap.has(studentId)) {
        studentsMap.set(studentId, {
          id: studentId,
          fullName: `${result.student.surname} ${result.student.firstname} ${result.student.middlename || ''}`.trim(),
          regNo: result.student.regNo,
          results: new Map(),
          studentCourses: []
        });
      }

      if (!coursesMap.has(courseId)) {
        coursesMap.set(courseId, {
          id: courseId,
          code: result.course.code,
          unit: result.course.unit,
          title: result.course.title
        });
      }

      const student = studentsMap.get(studentId);
      student.results.set(courseId, {
        grandtotal: result.grandtotal,
        grade: result.grade,
        unit: result.course.unit
      });
    });

    // 3. Build studentCourses arrays
    studentsMap.forEach(student => {
      student.studentCourses = Array.from(student.results.values()).map(res => ({
        unit: res.unit,
        grade: res.grade
      }));
    });

    // 4. Process metrics for each student
    const students = await Promise.all(
      Array.from(studentsMap.values()).map(async (student) => {
        const existingMetrics = await AcademicMetrics.findOne({
          student: student.id,
          session,
          semester,
          level
        }).lean();

        if (existingMetrics) {
          return {
            id: student.id,
            fullName: student.fullName,
            regNo: student.regNo,
            results: Object.fromEntries(student.results),
            previousMetrics: existingMetrics.previousMetrics || {
              CCC: 0, CCE: 0, CPE: 0, CGPA: 0
            },
            currentMetrics: {
              TCC: existingMetrics.TCC,
              TCE: existingMetrics.TCE,
              TPE: existingMetrics.TPE,
              GPA: existingMetrics.GPA
            },
            metrics: existingMetrics
          };
        }

        // 2. Find previous metrics document
        const previousMetricsDoc = await AcademicMetrics.findOne({
          student: student.id,
          $or: [
            { session: { $lt: session } },
            { session, semester: { $lt: semester } }
          ]
        })
        .sort({ session: -1, semester: -1, level: -1 })
        .lean();

        const previousMetrics = previousMetricsDoc ? {
          CCC: previousMetricsDoc.CCC,
          CCE: previousMetricsDoc.CCE,
          CPE: previousMetricsDoc.CPE,
          CGPA: previousMetricsDoc.CGPA
        } : { CCC: 0, CCE: 0, CPE: 0, CGPA: 0 };

        // 3. Calculate current metrics correctly
        const currentMetrics = calculateAcademicMetrics(student.studentCourses, previousMetrics);

        const updatedMetrics = await AcademicMetrics.findOneAndUpdate(
          { student: student.id, session, semester, level },
          {
            $set: {
              ...currentMetrics,
              previousMetrics
            }
          },
          { new: true, upsert: true }
        );

        return {
          id: student.id,
          fullName: student.fullName,
          regNo: student.regNo,
          results: Object.fromEntries(student.results),
          previousMetrics,
          currentMetrics: {
            TCC: currentMetrics.TCC,
            TCE: currentMetrics.TCE,
            TPE: currentMetrics.TPE,
            GPA: currentMetrics.GPA
          },
          metrics: updatedMetrics
        };
      })
    );

    // 5. Send response
    res.json({
      students,
      courses: Array.from(coursesMap.values())
    });

  } catch (error) {
    console.error('Error in getComprehensiveResults:', error);
    res.status(500).json({
      error: 'Failed to fetch comprehensive results',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};

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
      session,
      semester,
      level,
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
