// controllers/approvedCourses.controller.js
import ApprovedCourses from '../models/approvedCourses.js';
import Course from '../models/course.js';

const COURSE_PROJECTION = 'code title unit level semester option';

// Create approved courses
export const createApprovedCourses = async (req, res) => {
  try {
    let { college, session, semester, level, courses } = req.body;

    // Basic validation
    if (!college || !session || semester == null || level == null || !Array.isArray(courses) || courses.length === 0) {
      return res.status(400).json({ message: 'All fields including non-empty courses[] are required' });
    }

    // Normalize numeric fields
    semester = Number(semester);
    level = Number(level);

    // Check courses exist
    const courseDocs = await Course.find({ _id: { $in: courses } })
      .select(COURSE_PROJECTION)
      .lean();
    if (courseDocs.length !== courses.length) {
      return res.status(400).json({ message: 'One or more courses not found' });
    }

    // (Optional) Enforce courses belong to same level/semester as approval
    // const bad = courseDocs.filter(c => Number(c.semester) !== semester || Number(c.level) !== level);
    // if (bad.length) {
    //   return res.status(400).json({
    //     message: 'Some courses do not match the selected level/semester',
    //     details: bad.map(c => ({ code: c.code, level: c.level, semester: c.semester }))
    //   });
    // }

    const approved = await ApprovedCourses.create({
      college,
      session,
      semester,
      level,
      courses,
    });

    const populated = await ApprovedCourses.findById(approved._id)
      .populate('courses', COURSE_PROJECTION)
      .lean();

    return res.status(201).json(populated);
  } catch (error) {
    // NOTE: Your schema index is not unique; if you want to block duplicates, set { unique: true } on (college, session, semester, level)
    if (error.code === 11000) {
      return res.status(400).json({ message: 'Approved courses already exist for this combination' });
    }
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
};

// Get all approved courses
export const getApprovedCourses = async (req, res) => {
  try {
    const filter = {};
    if (req.query.college)  filter.college = req.query.college;
    if (req.query.session)  filter.session = req.query.session;
    if (req.query.semester != null) filter.semester = Number(req.query.semester);
    if (req.query.level != null)    filter.level = Number(req.query.level);

    const docs = await ApprovedCourses.find(filter)
      .populate('courses', COURSE_PROJECTION)
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
      .populate('courses', COURSE_PROJECTION)
      .lean();

    if (!doc) {
      return res.status(404).json({ message: 'Approved courses not found' });
    }
    return res.json(doc);
  } catch (error) {
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
};

// Update approved courses (and optionally other fields)
export const updateApprovedCourses = async (req, res) => {
  try {
    let { college, session, semester, level, courses } = req.body;

    // If courses is present, validate it
    if (courses) {
      if (!Array.isArray(courses) || courses.length === 0) {
        return res.status(400).json({ message: 'Courses array must be non-empty when provided' });
      }
      const courseDocs = await Course.find({ _id: { $in: courses } })
        .select(COURSE_PROJECTION)
        .lean();
      if (courseDocs.length !== courses.length) {
        return res.status(400).json({ message: 'One or more courses not found' });
      }

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
    if (college != null)  $set.college = college;
    if (session != null)  $set.session = session;
    if (semester != null) $set.semester = Number(semester);
    if (level != null)    $set.level = Number(level);
    if (courses != null)  $set.courses = courses;

    const updated = await ApprovedCourses.findByIdAndUpdate(
      req.params.id,
      { $set },
      { new: true }
    )
      .populate('courses', COURSE_PROJECTION)
      .lean();

    if (!updated) {
      return res.status(404).json({ message: 'Approved courses not found' });
    }
    return res.json(updated);
  } catch (error) {
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
};

// Delete approved courses document
export const deleteApprovedCourses = async (req, res) => {
  try {
    const deleted = await ApprovedCourses.findByIdAndDelete(req.params.id).lean();
    if (!deleted) {
      return res.status(404).json({ message: 'Approved courses not found' });
    }
    return res.json({ message: 'Approved courses removed' });
  } catch (error) {
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
};
