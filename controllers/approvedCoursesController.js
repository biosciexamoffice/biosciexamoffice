// controllers/approvedCourses.controller.js
import ApprovedCourses from '../models/approvedCourses.js';
import Course from '../models/course.js';
import { validateInstitutionHierarchy } from '../services/institutionService.js';
import { DEFAULT_PROGRAMME } from '../constants/institutionDefaults.js';
import {
  buildDepartmentScopeFilter,
  ensureResourceMatchesUserScope,
  ensureUserCanAccessDepartment,
} from '../services/accessControl.js';

const COURSE_PROJECTION = 'code title unit level semester option';
const APPROVED_COURSE_POPULATE = [
  { path: 'courses', select: COURSE_PROJECTION },
  { path: 'college', select: 'name code' },
  { path: 'department', select: 'name code' },
  { path: 'programme', select: 'name degreeType description' },
];

// Create approved courses
export const createApprovedCourses = async (req, res) => {
  try {
    let { collegeId, departmentId, programmeId, session, semester, level, courses } = req.body || {};

    // Basic validation
    if (
      !collegeId ||
      !departmentId ||
      !programmeId ||
      !session ||
      semester == null ||
      level == null ||
      !Array.isArray(courses) ||
      courses.length === 0
    ) {
      return res.status(400).json({
        message:
          'collegeId, departmentId, programmeId, session, semester, level, and a non-empty courses[] are required.',
      });
    }

    // Normalize numeric fields
    semester = Number(semester);
    level = Number(level);

    if (![1, 2].includes(semester)) {
      return res.status(400).json({ message: 'semester must be 1 or 2.' });
    }
    if (![100, 200, 300, 400, 500].includes(level)) {
      return res.status(400).json({ message: 'level must be one of 100, 200, 300, 400, or 500.' });
    }

    // Check courses exist
    const courseDocs = await Course.find({ _id: { $in: courses } })
      .select(`${COURSE_PROJECTION} college department`)
      .lean();
    if (courseDocs.length !== courses.length) {
      return res.status(400).json({ message: 'One or more courses not found' });
    }

    courseDocs.forEach((courseDoc) => {
      ensureUserCanAccessDepartment(req.user, courseDoc.department, courseDoc.college);
    });

    // (Optional) Enforce courses belong to same level/semester as approval
    // const bad = courseDocs.filter(c => Number(c.semester) !== semester || Number(c.level) !== level);
    // if (bad.length) {
    //   return res.status(400).json({
    //     message: 'Some courses do not match the selected level/semester',
    //     details: bad.map(c => ({ code: c.code, level: c.level, semester: c.semester }))
    //   });
    // }

    const { college, department, programme } = await validateInstitutionHierarchy({
      collegeId,
      departmentId,
      programmeId,
    });

    ensureUserCanAccessDepartment(req.user, department._id, college._id);

    const approved = await ApprovedCourses.create({
      college: college._id,
      department: department._id,
      programme: programme._id,
      programmeType: programme.degreeType || DEFAULT_PROGRAMME.degreeType,
      collegeName: college.name,
      departmentName: department.name,
      programmeName: programme.name,
      session,
      semester,
      level,
      courses,
    });

    const populated = await ApprovedCourses.findById(approved._id)
      .populate(APPROVED_COURSE_POPULATE)
      .lean();

    return res.status(201).json(populated);
  } catch (error) {
    // NOTE: To block exact duplicates while allowing same session in same department with different programme/semester/level,
    // add a compound unique index on (college, department, programme, session, semester, level) in the ApprovedCourses model.
    if (error.code === 11000) {
      return res.status(400).json({
        message:
          'Approved courses already exist for this college/department/programme in the same session, semester, and level.',
      });
    }
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
};

// Get all approved courses
export const getApprovedCourses = async (req, res) => {
  try {
    const filter = {};
    const collegeFilter = req.query.collegeId || req.query.college;
    const departmentFilter = req.query.departmentId || req.query.department;
    const programmeFilter = req.query.programmeId || req.query.programme;
    if (collegeFilter) filter.college = collegeFilter;
    if (departmentFilter) filter.department = departmentFilter;
    if (programmeFilter) filter.programme = programmeFilter;
    if (req.query.session) filter.session = req.query.session;
    if (req.query.semester != null) filter.semester = Number(req.query.semester);
    if (req.query.level != null) filter.level = Number(req.query.level);

    const scopeFilter = buildDepartmentScopeFilter(req.user);
    Object.assign(filter, scopeFilter);

    const docs = await ApprovedCourses.find(filter)
      .populate(APPROVED_COURSE_POPULATE)
      .sort({ session: -1, semester: 1, level: 1 })
      .lean();

    return res.json(docs);
  } catch (error) {
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
};

// Get a single approved course document
export const getApprovedCourseById = async (req, res) => {
  try {
    const doc = await ApprovedCourses.findById(req.params.id)
      .populate(APPROVED_COURSE_POPULATE)
      .lean();

    if (!doc) {
      return res.status(404).json({ message: 'Approved courses not found' });
    }
    ensureResourceMatchesUserScope(req.user, doc);
    return res.json(doc);
  } catch (error) {
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
};

// Update approved courses (and optionally other fields)
export const updateApprovedCourses = async (req, res) => {
  try {
    const existing = await ApprovedCourses.findById(req.params.id).lean();
    if (!existing) {
      return res.status(404).json({ message: 'Approved courses not found' });
    }
    ensureUserCanAccessDepartment(req.user, existing.department, existing.college);

    let { collegeId, departmentId, programmeId, session, semester, level, courses } = req.body || {};

    // If courses is present, validate it
    if (courses) {
      if (!Array.isArray(courses) || courses.length === 0) {
        return res.status(400).json({ message: 'Courses array must be non-empty when provided' });
      }
      const courseDocs = await Course.find({ _id: { $in: courses } })
        .select(`${COURSE_PROJECTION} college department`)
        .lean();
      if (courseDocs.length !== courses.length) {
        return res.status(400).json({ message: 'One or more courses not found' });
      }

      courseDocs.forEach((courseDoc) => {
        ensureUserCanAccessDepartment(req.user, courseDoc.department, courseDoc.college);
      });

      // (Optional) Enforce courses belong to same level/semester as approval (if level/semester provided or stored)
      // const nextSemester = semester != null ? Number(semester) : undefined;
      // const nextLevel = level != null ? Number(level) : undefined;
      // const targetSem = nextSemester ?? (await ApprovedCourses.findById(req.params.id).lean())?.semester;
      // const targetLvl = nextLevel ?? (await ApprovedCourses.findById(req.params.id).lean())?.level;
      // const bad = courseDocs.filter(c => Number(c.semester) !== Number(targetSem) || Number(c.level) !== Number(targetLvl));
      // if (bad.length) {
      //   return res.status(400).json({
      //     message: 'Some courses do not match the selected level/semester',
      //     details: bad.map(c => ({ code: c.code, level: c.level, semester: c.semester }))
      //   });
      // }
    }

    // Build update payload (only set provided fields)
    const $set = {};
    if ([collegeId, departmentId, programmeId].some((value) => value !== undefined)) {
      if (![collegeId, departmentId, programmeId].every((value) => value)) {
        return res.status(400).json({ message: 'collegeId, departmentId and programmeId must be provided together.' });
      }

      const { college, department, programme } = await validateInstitutionHierarchy({
        collegeId,
        departmentId,
        programmeId,
      });

      ensureUserCanAccessDepartment(req.user, department._id, college._id);

      $set.college = college._id;
      $set.department = department._id;
      $set.programme = programme._id;
      $set.programmeType = programme.degreeType || DEFAULT_PROGRAMME.degreeType;
      $set.collegeName = college.name;
      $set.departmentName = department.name;
      $set.programmeName = programme.name;
    }

    if (session != null) $set.session = session;
    if (semester != null) {
      const semNum = Number(semester);
      if (![1, 2].includes(semNum)) {
        return res.status(400).json({ message: 'semester must be 1 or 2.' });
      }
      $set.semester = semNum;
    }
    if (level != null) {
      const lvlNum = Number(level);
      if (![100, 200, 300, 400, 500].includes(lvlNum)) {
        return res.status(400).json({ message: 'level must be one of 100, 200, 300, 400, or 500.' });
      }
      $set.level = lvlNum;
    }
    if (courses != null) $set.courses = courses;

    const updated = await ApprovedCourses.findByIdAndUpdate(req.params.id, { $set }, { new: true })
      .populate(APPROVED_COURSE_POPULATE)
      .lean();

    ensureResourceMatchesUserScope(req.user, updated);
    return res.json(updated);
  } catch (error) {
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
};

// Delete approved courses document
export const deleteApprovedCourses = async (req, res) => {
  try {
    const doc = await ApprovedCourses.findById(req.params.id).lean();
    if (!doc) {
      return res.status(404).json({ message: 'Approved courses not found' });
    }
    ensureUserCanAccessDepartment(req.user, doc.department, doc.college);

    await ApprovedCourses.findByIdAndDelete(req.params.id);
    return res.json({ message: 'Approved courses removed' });
  } catch (error) {
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
};
