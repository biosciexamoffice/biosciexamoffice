import Course from "../models/course.js";

export const createCourse = async (req, res) => {
  try {
    // Note: The field in your schema is 'lecturer', not 'lecturerId'
    const { title, code, unit, session, semester, year, lecturer } = req.body;

    const newCourse = await Course.create({
      title,
      code,
      unit,
      session,
      semester,
      year,
      lecturer,
    });

    res.status(201).json(newCourse);
  } catch (error) {
    console.error("Error creating course:", error);
    if (error.name === "ValidationError") {
      return res
        .status(400)
        .json({ message: "Validation Error", errors: error.errors });
    }
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

export const getAllCourses = async (req, res) => {
  try {
    const courses = await Course.find().populate(
      "lecturer",
      "title surname firstname"
    );
    res.status(200).json(courses);
  } catch (error) {
    console.error("Error fetching courses:", error);
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

export const getCourseById = async (req, res) => {
  try {
    const course = await Course.findById(req.params.id).populate(
      "lecturer",
      "title surname firstname"
    );
    if (!course) {
      return res.status(404).json({ message: "Course not found" });
    }
    res.status(200).json(course);

  } catch (error){
    console.error("Error fetching course:", error);
    if (error.name === "CastError" && error.kind === "ObjectId") {
      return res.status(400).json({ message: "Invalid ID format" });
    }
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

export const updateCourse = async (req, res) => {
  try {
    const updatedCourse = await Course.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!updatedCourse) {
      return res.status(404).json({ message: "Course not found" });
    }
    res.status(200).json(updatedCourse);
  } catch (error) {
    console.error("Error updating course:", error);
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

export const deleteCourse = async (req, res) => {
  try {
    const deletedCourse = await Course.findByIdAndDelete(req.params.id);
    if (!deletedCourse) {
      return res.status(404).json({ message: "Course not found" });
    }
    res.status(200).json({ message: "Course deleted successfully" });
  } catch (error) {
    console.error("Error deleting course:", error);
    if (error.name === "CastError" && error.kind === "ObjectId") {
      return res.status(400).json({ message: "Invalid ID format" });
    }
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};