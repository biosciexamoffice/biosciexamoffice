import Course from "../models/course.js";
import { validateInstitutionHierarchy } from "../services/institutionService.js";
import { DEFAULT_PROGRAMME } from "../constants/institutionDefaults.js";
import {
  buildDepartmentScopeFilter,
  ensureResourceMatchesUserScope,
  ensureUserCanAccessDepartment,
} from "../services/accessControl.js";

const COURSE_POPULATE = [
  { path: 'college', select: 'name code' },
  { path: 'department', select: 'name code' },
  { path: 'programme', select: 'name degreeType description' },
];

const normalizeOption = (option) => {
  const value = String(option || '').trim().toUpperCase();
  return value === 'E' ? 'E' : 'C';
};

const normalizeLevel = (level) => String(level || '').trim();

const normalizeCode = (code) => String(code || '').trim().toUpperCase();

export const createCourse = async (req, res) => {
  try {
    const {
      title,
      code,
      unit,
      semester,
      option,
      level,
      host,
      collegeId,
      departmentId,
      programmeId,
    } = req.body || {};

    if (!title || !code || unit == null || semester == null || !option || !level) {
      return res.status(400).json({ message: "title, code, unit, semester, option, and level are required." });
    }

    const { college, department, programme } = await validateInstitutionHierarchy({
      collegeId,
      departmentId,
      programmeId,
    });
    ensureUserCanAccessDepartment(req.user, department._id, college._id);

    const payload = {
      title: String(title).trim(),
      code: normalizeCode(code),
      unit: Number(unit),
      semester: Number(semester),
      option: normalizeOption(option),
      level: normalizeLevel(level),
      host: host ? String(host).trim() : college.name,
      college: college._id,
      department: department._id,
      programme: programme._id,
      programmeType: programme.degreeType || DEFAULT_PROGRAMME.degreeType,
    };

    if (!Number.isFinite(payload.unit) || payload.unit <= 0) {
      return res.status(400).json({ message: "unit must be a positive number." });
    }

    if (![1, 2].includes(payload.semester)) {
      return res.status(400).json({ message: "semester must be 1 or 2." });
    }

    if (!payload.level) {
      return res.status(400).json({ message: "level is required." });
    }

    const newCourse = await Course.create(payload);

    const populated = await Course.findById(newCourse._id)
      .populate(COURSE_POPULATE)
      .lean();

    res.status(201).json(populated);
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
    const scopeFilter = buildDepartmentScopeFilter(req.user, 'department');
    const courses = await Course.find(scopeFilter)
      .populate("lecturer", "title surname firstname")
      .populate(COURSE_POPULATE)
      .lean();
    res.status(200).json(courses);
  } catch (error) {
    console.error("Error fetching courses:", error);
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

export const getCourseById = async (req, res) => {
  try {
    const course = await Course.findById(req.params.id)
      .populate("lecturer", "title surname firstname")
      .populate(COURSE_POPULATE)
      .lean();
    if (!course) {
      return res.status(404).json({ message: "Course not found" });
    }
    ensureResourceMatchesUserScope(req.user, course);
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
    const {
      collegeId,
      departmentId,
      programmeId,
      ...updates
    } = req.body || {};

    const existingCourse = await Course.findById(req.params.id).select('college department').lean();
    if (!existingCourse) {
      return res.status(404).json({ message: "Course not found" });
    }

    ensureUserCanAccessDepartment(req.user, existingCourse.department, existingCourse.college);

    delete updates.college;
    delete updates.department;
    delete updates.programme;
    delete updates.programmeType;

    if ([collegeId, departmentId, programmeId].some((value) => value !== undefined)) {
      if (![collegeId, departmentId, programmeId].every((value) => value)) {
        return res.status(400).json({
          message: "collegeId, departmentId, and programmeId must all be provided together.",
        });
      }

      const { college, department, programme } = await validateInstitutionHierarchy({
        collegeId,
        departmentId,
        programmeId,
      });
      ensureUserCanAccessDepartment(req.user, department._id, college._id);

      updates.college = college._id;
      updates.department = department._id;
      updates.programme = programme._id;
      updates.programmeType = programme.degreeType || DEFAULT_PROGRAMME.degreeType;
      if (!updates.host) {
        updates.host = college.name;
      }
    }

    if (updates.code) {
      updates.code = normalizeCode(updates.code);
    }
    if (updates.option) {
      updates.option = normalizeOption(updates.option);
    }
    if (updates.level !== undefined) {
      updates.level = normalizeLevel(updates.level);
    }
    if (updates.semester !== undefined) {
      updates.semester = Number(updates.semester);
    }
    if (updates.unit !== undefined) {
      updates.unit = Number(updates.unit);
    }
    if (updates.host) {
      updates.host = String(updates.host).trim();
    }

    const updatedCourse = await Course.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
    })
      .populate("lecturer", "title surname firstname")
      .populate(COURSE_POPULATE)
      .lean();
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
    const course = await Course.findById(req.params.id).select('college department').lean();
    if (!course) {
      return res.status(404).json({ message: "Course not found" });
    }
    ensureUserCanAccessDepartment(req.user, course.department, course.college);

    await Course.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: "Course deleted successfully" });
  } catch (error) {
    console.error("Error deleting course:", error);
    if (error.name === "CastError" && error.kind === "ObjectId") {
      return res.status(400).json({ message: "Invalid ID format" });
    }
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};
