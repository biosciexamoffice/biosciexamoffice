import ApprovedCourses from '../models/approvedCourses.js';
import Course from '../models/course.js';

// Create approved courses
export const createApprovedCourses = async (req, res) => {
  try {
    const { college, session, semester, level, courses } = req.body;

    // Basic validation
    if (!college || !session || !semester || !level || !courses?.length) {
      return res.status(400).json({ message: 'All fields including courses array are required' });
    }

    // Check if courses exist
    const coursesExist = await Course.find({ _id: { $in: courses } });
    if (coursesExist.length !== courses.length) {
      return res.status(400).json({ message: 'One or more courses not found' });
    }

    const approvedCourse = await ApprovedCourses.create({
      college,
      session,
      semester,
      level,
      courses,
    });

    const populated = await ApprovedCourses.findById(approvedCourse._id)
      .populate('courses', 'code title unit');

    res.status(201).json(populated);
  } catch (error) {
    if (error.code === 11000) {
      res.status(400).json({ message: 'Approved courses already exist for this combination' });
    } else {
      res.status(500).json({ message: 'Server error', error: error.message });
    }
  }
};

// Get all approved courses
export const getApprovedCourses = async (req, res) => {
  try {
    const { college, session, semester, level } = req.query;
    const filter = {};
    
    if (college) filter.college = college;
    if (session) filter.session = session;
    if (semester) filter.semester = semester;
    if (level) filter.level = level;

    const approvedCourses = await ApprovedCourses.find(filter)
      .populate('courses', 'code title unit')
      .sort({ session: -1, semester: 1, level: 1 });

    res.json(approvedCourses);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};

// Get single approved course
export const getApprovedCourseById = async (req, res) => {
  try {
    const approvedCourse = await ApprovedCourses.findById(req.params.id)
      .populate('courses', 'code title unit');

    if (!approvedCourse) {
      return res.status(404).json({ message: 'Approved courses not found' });
    }

    res.json(approvedCourse);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};

// Update approved courses
export const updateApprovedCourses = async (req, res) => {
  try {
    const { courses } = req.body;

    if (!courses?.length) {
      return res.status(400).json({ message: 'Courses array is required' });
    }

    // Check if courses exist
    const coursesExist = await Course.find({ _id: { $in: courses } });
    if (coursesExist.length !== courses.length) {
      return res.status(400).json({ message: 'One or more courses not found' });
    }

    const approvedCourse = await ApprovedCourses.findByIdAndUpdate(
      req.params.id,
      { 
        courses,
      },
      { new: true }
    )
      .populate('courses', 'code title unit');

    if (!approvedCourse) {
      return res.status(404).json({ message: 'Approved courses not found' });
    }

    res.json(approvedCourse);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};

// Delete approved courses
export const deleteApprovedCourses = async (req, res) => {
  try {
    const approvedCourse = await ApprovedCourses.findByIdAndDelete(req.params.id);

    if (!approvedCourse) {
      return res.status(404).json({ message: 'Approved courses not found' });
    }

    res.json({ message: 'Approved courses removed' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};