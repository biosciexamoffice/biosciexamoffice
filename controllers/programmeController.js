import mongoose from 'mongoose';
import Programme from '../models/programme.js';
import {
  ensureDefaultProgrammeSetup,
  validateCollegeAndDepartment,
} from '../services/institutionService.js';
import { buildDepartmentScopeFilter } from '../services/accessControl.js';

export const ensureDefaultProgramme = async () => {
  await ensureDefaultProgrammeSetup();
};

export const listProgrammes = async (req, res) => {
  await ensureDefaultProgramme();
  const { collegeId, departmentId } = req.query || {};
  const filter = {};

  if (collegeId) {
    if (!mongoose.Types.ObjectId.isValid(collegeId)) {
      return res.status(400).json({ success: false, message: 'Invalid collegeId.' });
    }
    filter.college = new mongoose.Types.ObjectId(collegeId);
  }

  if (departmentId) {
    if (!mongoose.Types.ObjectId.isValid(departmentId)) {
      return res.status(400).json({ success: false, message: 'Invalid departmentId.' });
    }
    filter.department = new mongoose.Types.ObjectId(departmentId);
  }

  const scopeFilter = buildDepartmentScopeFilter(req.user);
  if (scopeFilter.department) {
    if (departmentId && scopeFilter.department !== departmentId) {
      return res.status(403).json({ success: false, message: 'You are not authorized to view programmes for this department.' });
    }
    if (!mongoose.Types.ObjectId.isValid(scopeFilter.department)) {
      return res.status(400).json({ success: false, message: 'Invalid department scope.' });
    }
    filter.department = new mongoose.Types.ObjectId(scopeFilter.department);
  }

  const programmes = await Programme.find(filter)
    .populate('college', 'name code')
    .populate('department', 'name code')
    .sort({ name: 1 })
    .lean();

  res.status(200).json({
    success: true,
    programmes: programmes.map((programme) => ({
      id: programme._id,
      name: programme.name,
      degreeType: programme.degreeType,
      description: programme.description || null,
      collegeId: programme.college?._id || programme.college,
      collegeName: programme.college?.name || null,
      departmentId: programme.department?._id || programme.department,
      departmentName: programme.department?.name || null,
      createdAt: programme.createdAt,
      updatedAt: programme.updatedAt,
    })),
  });
};

export const createProgramme = async (req, res) => {
  try {
    const { name, degreeType, description, collegeId, departmentId } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: 'Programme name is required.' });
    }

    if (!degreeType || !String(degreeType).trim()) {
      return res.status(400).json({ success: false, message: 'Degree type is required.' });
    }

    const { college, department } = await validateCollegeAndDepartment({
      collegeId,
      departmentId,
    });

    const payload = {
      name: String(name).trim(),
      degreeType: String(degreeType).trim(),
      college: college._id,
      department: department._id,
      ...(description ? { description: String(description).trim() } : {}),
    };

    const programme = await Programme.create(payload);

    res.status(201).json({
      success: true,
      programme: {
        id: programme._id,
        name: programme.name,
        degreeType: programme.degreeType,
        description: programme.description || null,
        collegeId: programme.college,
        departmentId: programme.department,
        createdAt: programme.createdAt,
        updatedAt: programme.updatedAt,
      },
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: 'Programme already exists for this department.' });
    }
    console.error('createProgramme error:', err);
    res.status(500).json({ success: false, message: 'Unable to create programme.' });
  }
};
