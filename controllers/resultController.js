import Result from "../models/result.js";
import Course from "../models/course.js";
import calculateAcademicMetrics from '../utills/calculateAcademicMetrics.js';
import AcademicMetrics from '../models/academicMetrics.js';

// Create (C)
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

// Read All (R)
export const getAllResults = async (req, res) => {
  try {
    const { regNo, courseCode, session, level, semester } = req.query;
    const pipeline = [];

    pipeline.push({ $lookup: { from: 'students', localField: 'student', foreignField: '_id', as: 'studentInfo' }});
    pipeline.push({ $unwind: '$studentInfo' });
    pipeline.push({ $lookup: { from: 'courses', localField: 'course', foreignField: '_id', as: 'courseInfo' }});
    pipeline.push({ $unwind: '$courseInfo' });
    pipeline.push({ $lookup: { from: 'lecturers', localField: 'lecturer', foreignField: '_id', as: 'lecturerInfo' }});
    pipeline.push({ $unwind: { path: '$lecturerInfo', preserveNullAndEmptyArrays: true }});

    const matchStage = {};
    if (regNo) matchStage['studentInfo.regNo'] = { $regex: regNo, $options: 'i' };
    if (courseCode) matchStage['courseInfo.code'] = { $regex: courseCode, $options: 'i' };
    if (session) matchStage.session = session;
    if (level) matchStage.level = level;
    if (semester) matchStage.semester = parseInt(semester, 10);
    if (Object.keys(matchStage).length > 0) pipeline.push({ $match: matchStage });

    pipeline.push({
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

    const results = await Result.aggregate(pipeline);
    return res.status(200).json(results);
  } catch (error) {
    console.error("Error fetching results:", error);
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// Read One (R)
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

// Update (U)
export const updateResult = async (req, res) => {
  try {
    const updatedResult = await Result.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!updatedResult) return res.status(404).json({ message: "Result not found" });
    res.status(200).json(updatedResult);
  } catch (error) {
    console.error("Error updating result:", error);
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// Delete Single Result
export const deleteResult = async (req, res) => {
  try {
    const result = await Result.findById(req.params.id).populate('student').populate('course');
    if (!result) return res.status(404).json({ message: "Result not found" });

    await Result.findByIdAndDelete(result._id);

    const remainingResults = await Result.find({
      student: result.student._id,
      session: result.session,
      semester: result.semester,
      level: result.level
    }).populate('course');

    const studentCourses = remainingResults.map(res => ({
      unit: res.course.unit,
      grade: res.grade
    }));

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

    const currentMetrics = calculateAcademicMetrics(studentCourses, previousMetrics);

    if (remainingResults.length > 0) {
      await AcademicMetrics.findOneAndUpdate(
        {
          student: result.student._id,
          session: result.session,
          semester: result.semester,
          level: result.level
        },
        {
          ...currentMetrics,
          previousMetrics
        },
        { upsert: true }
      );
    } else {
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

// Delete All Results for a Course
export const deleteAllResultsForCourse = async (req, res) => {
  try {
    const courseId = req.params.id;
    const { level, session, semester } = req.query;

    const course = await Course.findById(courseId);
    if (!course) return res.status(404).json({ message: "Course not found" });

    const matchFilter = { course: courseId };

    if (level) matchFilter.level = level;
    if (session) matchFilter.session = session;
    if (semester) matchFilter.semester = parseInt(semester, 10);

    const resultsToDelete = await Result.find(matchFilter).populate('student').lean();
    if (resultsToDelete.length === 0) return res.status(404).json({ message: "No results found for the specified filters" });

    await Result.deleteMany(matchFilter);

    const grouped = resultsToDelete.reduce((acc, result) => {
      const key = `${result.student._id}-${result.session}-${result.semester}-${result.level}`;
      if (!acc[key]) {
        acc[key] = {
          student: result.student._id,
          session: result.session,
          semester: result.semester,
          level: result.level
        };
      }
      return acc;
    }, {});

    await Promise.all(Object.values(grouped).map(async (group) => {
      const remainingResults = await Result.find({
        student: group.student,
        session: group.session,
        semester: group.semester,
        level: group.level
      }).populate('course');

      const studentCourses = remainingResults.map(res => ({
        unit: res.course.unit,
        grade: res.grade
      }));

      const previousMetricsDoc = await AcademicMetrics.findOne({
        student: group.student,
        $or: [
          { session: { $lt: group.session } },
          { session: group.session, semester: { $lt: group.semester } }
        ]
      }).sort({ session: -1, semester: -1, level: -1 }).lean();

      const previousMetrics = previousMetricsDoc ? {
        CCC: previousMetricsDoc.CCC,
        CCE: previousMetricsDoc.CCE,
        CPE: previousMetricsDoc.CPE,
        CGPA: previousMetricsDoc.CGPA
      } : { CCC: 0, CCE: 0, CPE: 0, CGPA: 0 };

      const currentMetrics = calculateAcademicMetrics(studentCourses, previousMetrics);

      if (remainingResults.length > 0) {
        await AcademicMetrics.findOneAndUpdate(
          {
            student: group.student,
            session: group.session,
            semester: group.semester,
            level: group.level
          },
          {
            ...currentMetrics,
            previousMetrics
          },
          { upsert: true }
        );
      } else {
        await AcademicMetrics.deleteOne({
          student: group.student,
          session: group.session,
          semester: group.semester,
          level: group.level
        });
      }
    }));

    res.status(200).json({ message: "Filtered results deleted and metrics updated" });
  } catch (error) {
    console.error("Error deleting filtered results:", error);
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};


// Delete Multiple Results
export const deleteMultipleResults = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "No result IDs provided" });
    }

    const results = await Result.find({ _id: { $in: ids } }).populate('course student');

    const grouped = results.reduce((acc, result) => {
      const key = `${result.student._id}-${result.session}-${result.semester}-${result.level}`;
      if (!acc[key]) acc[key] = [];
      acc[key].push(result);
      return acc;
    }, {});

    await Result.deleteMany({ _id: { $in: ids } });

    for (const group of Object.values(grouped)) {
      const { student, session, semester, level } = group[0];

      const remainingResults = await Result.find({
        student,
        session,
        semester,
        level
      }).populate('course');

      const studentCourses = remainingResults.map(res => ({
        unit: res.course.unit,
        grade: res.grade
      }));

      const previousMetricsDoc = await AcademicMetrics.findOne({
        student,
        $or: [
          { session: { $lt: session } },
          { session, semester: { $lt: semester } }
        ]
      }).sort({ session: -1, semester: -1, level: -1 }).lean();

      const previousMetrics = previousMetricsDoc ? {
        CCC: previousMetricsDoc.CCC,
        CCE: previousMetricsDoc.CCE,
        CPE: previousMetricsDoc.CPE,
        CGPA: previousMetricsDoc.CGPA
      } : { CCC: 0, CCE: 0, CPE: 0, CGPA: 0 };

      const currentMetrics = calculateAcademicMetrics(studentCourses, previousMetrics);

      if (remainingResults.length > 0) {
        await AcademicMetrics.findOneAndUpdate(
          { student, session, semester, level },
          {
            ...currentMetrics,
            previousMetrics
          },
          { upsert: true }
        );
      } else {
        await AcademicMetrics.deleteOne({ student, session, semester, level });
      }
    }

    res.status(200).json({ message: "Multiple results deleted and metrics updated" });

  } catch (error) {
    console.error("Bulk delete error:", error);
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};
