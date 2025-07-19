import Result from "../models/result.js";
import Course from "../models/course.js";

// Create (C)
export const createResult = async (req, res) => {
  try {
    const newResult = await Result.create(req.body);
    res.status(201).json(newResult);
  } catch (error) {
    console.error("Error creating result:", error);
    if (error.name === "ValidationError") {
      return res
        .status(400)
        .json({ message: "Validation Error", errors: error.errors });
    }
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// Read (R) - Fetch All
export const getAllResults = async (req, res) => {
  try {
        const { regNo, courseCode, session, level, semester } = req.query;
    const pipeline = [];

    // Stage 1: Lookup students
    pipeline.push({
      $lookup: {
        from: 'students',
        localField: 'student',
        foreignField: '_id',
        as: 'studentInfo'
      }
    });
    pipeline.push({ $unwind: '$studentInfo' });

    // Stage 2: Lookup courses
    pipeline.push({
      $lookup: {
        from: 'courses',
        localField: 'course',
        foreignField: '_id',
        as: 'courseInfo'
      }
    });
    pipeline.push({ $unwind: '$courseInfo' });

    // Stage 3: Lookup lecturers
    pipeline.push({
      $lookup: {
        from: 'lecturers',
        localField: 'lecturer',
        foreignField: '_id',
        as: 'lecturerInfo'
      }
    });
    pipeline.push({ $unwind: { path: '$lecturerInfo', preserveNullAndEmptyArrays: true } });

    // Stage 4: Filtering (matching)
    const matchStage = {};
    if (regNo) {
      matchStage['studentInfo.regNo'] = { $regex: regNo, $options: 'i' };
    }
    if (courseCode) {
      matchStage['courseInfo.code'] = { $regex: courseCode, $options: 'i' };
    }
    if (session) {
      matchStage.session = session;
    }
    if (level) {
      matchStage.level = level;
    }
    if (semester) {
      matchStage.semester = parseInt(semester, 10);
    }
    if (Object.keys(matchStage).length > 0) {
      pipeline.push({ $match: matchStage });
    }

    // Stage 5: Project the final shape
    pipeline.push({ $project: { 
      _id: 1,
      department:1,
      session: 1,
      semester:1,
      level:1, 
      grade: 1, 
      totalexam: 1, 
      ca: 1, grandtotal: 1, 
      q1: 1, q2: 1, q3: 1, q4: 1, q5: 1, q6: 1, q7: 1, q8: 1, 
      student: { 
        _id: '$studentInfo._id', 
        surname: '$studentInfo.surname', 
        firstname: '$studentInfo.firstname', 
        middlename: '$studentInfo.middlename',
        regNo: '$studentInfo.regNo' }, 
      course: { 
        _id: '$courseInfo._id', 
        title: '$courseInfo.title', 
        code: '$courseInfo.code', 
        unit:'$courseInfo.unit' }, 
      lecturer: { 
        _id: '$lecturerInfo._id', 
        title: '$lecturerInfo.title', 
        surname: '$lecturerInfo.surname', 
        firstname: '$lecturerInfo.firstname' },
       } });

    const results = await Result.aggregate(pipeline);
    return res.status(200).json(results);
  } catch (error) {
    console.error("Error fetching results:", error);
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// Read (R) - Fetch One by ID
export const getResultById = async (req, res) => {
  try {
    const result = await Result.findById(req.params.id)
      .populate("student", "surname firstname regNo")
      .populate("course", "title code")
      .populate("lecturer", "title surname firstname");

    if (!result) {
      return res.status(404).json({ message: "Result not found" });
    }
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
    if (!updatedResult) {
      return res.status(404).json({ message: "Result not found" });
    }
    res.status(200).json(updatedResult);
  } catch (error) {
    console.error("Error updating result:", error);
    if (error.name === "ValidationError") {
      return res
        .status(400)
        .json({ message: "Validation Error", errors: error.errors });
    }
    if (error.name === "CastError" && error.kind === "ObjectId") {
      return res.status(400).json({ message: "Invalid ID format" });
    }
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// Delete (D)
export const deleteResult = async (req, res) => {
  try {
    const deletedResult = await Result.findByIdAndDelete(req.params.id);
    if (!deletedResult) {
      return res.status(404).json({ message: "Result not found" });
    }
    res.status(200).json({ message: "Result deleted successfully" });
  } catch (error) {
    console.error("Error deleting result:", error);
    if (error.name === "CastError" && error.kind === "ObjectId") {
      return res.status(400).json({ message: "Invalid ID format" });
    }
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

// Delete (D) - All Results for a Course
export const deleteAllResultsForCourse = async (req, res) => {
  try {
    const courseId = req.params.id;
    console.log(req.params.courseId)

   // First verify the course exists (optional but recommended)
    const courseExist = await Course.findById(courseId)
    if  (!courseExist){
      return res.status(404).json({
        message: "course not found"
      })
    }
    
    // You might want to add a check here if you have a Course model
    
    // Delete all results for this course
    const deleteResult = await Result.deleteMany({ course: courseId });
    console.log(deleteResult)
    if (deleteResult.deletedCount === 0) {
      return res.status(404).json({ 
        message: "No results found for this course",
        deletedCount: 0
      });
    }
    
    res.status(200).json({ 
      message: `Successfully deleted ${deleteResult.deletedCount} results for this course`,
      deletedCount: deleteResult.deletedCount
    });
    
  } catch (error) {
    console.error("Error deleting results for course:", error);
    if (error.name === "CastError" && error.kind === "ObjectId") {
      return res.status(400).json({ message: "Invalid course ID format" });
    }
    res.status(500).json({ 
      message: "Server Error while deleting course results", 
      error: error.message 
    });
  }
};

