import mongoose from 'mongoose';
import College from '../models/college.js';
import Department from '../models/department.js';
import { ensureDefaultCollegeAndDepartment } from '../services/institutionService.js';
import { buildDepartmentScopeFilter } from '../services/accessControl.js';

const mapDepartmentsByCollege = (departments) => {
  const grouped = new Map();
  departments.forEach((dept) => {
    const key = String(dept.college);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({
      id: dept._id,
      name: dept.name,
      code: dept.code || null,
      description: dept.description || null,
      collegeId: dept.college,
      createdAt: dept.createdAt,
      updatedAt: dept.updatedAt,
    });
  });
  return grouped;
};

export const listColleges = async (req, res) => {
  await ensureDefaultCollegeAndDepartment();

  const colleges = await College.find()
    .sort({ name: 1 })
    .lean();

  const collegeIds = colleges.map((college) => college._id);
  const departments = await Department.find({ college: { $in: collegeIds } })
    .sort({ name: 1 })
    .lean();

  const deptMap = mapDepartmentsByCollege(departments);

  const response = colleges.map((college) => ({
    id: college._id,
    name: college.name,
    code: college.code || null,
    description: college.description || null,
    createdAt: college.createdAt,
    updatedAt: college.updatedAt,
    departments: deptMap.get(String(college._id)) || [],
  }));

  const scopeFilter = buildDepartmentScopeFilter(req.user);
  const departmentId = scopeFilter.department || null;

  const scopedColleges = departmentId
    ? response
        .map((college) => {
          const filteredDepartments = (college.departments || []).filter(
            (dept) => String(dept.id) === departmentId
          );
          if (!filteredDepartments.length) {
            return null;
          }
          return { ...college, departments: filteredDepartments };
        })
        .filter(Boolean)
    : response;

  res.status(200).json({
    success: true,
    colleges: scopedColleges,
  });
};

export const createCollege = async (req, res) => {
  const { name, code, description } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ success: false, message: 'College name is required.' });
  }

  const payload = {
    name: String(name).trim(),
    ...(code ? { code: String(code).trim() } : {}),
    ...(description ? { description: String(description).trim() } : {}),
  };

  try {
    const college = await College.create(payload);
    res.status(201).json({
      success: true,
      college: {
        id: college._id,
        name: college.name,
        code: college.code || null,
        description: college.description || null,
        createdAt: college.createdAt,
        updatedAt: college.updatedAt,
      },
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: 'College with this name or code already exists.' });
    }
    console.error('createCollege error:', err);
    res.status(500).json({ success: false, message: 'Unable to create college.' });
  }
};

export const updateCollege = async (req, res) => {
  const { collegeId } = req.params;
  if (!collegeId || !mongoose.Types.ObjectId.isValid(collegeId)) {
    return res.status(400).json({ success: false, message: 'Valid collegeId is required.' });
  }

  const { name, code, description } = req.body || {};
  const updates = {};

  if (name !== undefined) {
    const trimmedName = String(name).trim();
    if (!trimmedName) {
      return res.status(400).json({ success: false, message: 'College name cannot be empty.' });
    }
    updates.name = trimmedName;
  }

  if (code !== undefined) {
    const trimmedCode = String(code).trim();
    updates.code = trimmedCode || null;
  }

  if (description !== undefined) {
    const trimmedDescription = String(description).trim();
    updates.description = trimmedDescription || null;
  }

  if (!Object.keys(updates).length) {
    return res.status(400).json({ success: false, message: 'No updates provided.' });
  }

  try {
    const college = await College.findByIdAndUpdate(collegeId, updates, {
      new: true,
      runValidators: true,
    });

    if (!college) {
      return res.status(404).json({ success: false, message: 'College not found.' });
    }

    res.status(200).json({
      success: true,
      college: {
        id: college._id,
        name: college.name,
        code: college.code || null,
        description: college.description || null,
        createdAt: college.createdAt,
        updatedAt: college.updatedAt,
      },
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: 'College with this name or code already exists.' });
    }
    console.error('updateCollege error:', err);
    res.status(500).json({ success: false, message: 'Unable to update college.' });
  }
};

export const deleteCollege = async (req, res) => {
  const { collegeId } = req.params;
  if (!collegeId || !mongoose.Types.ObjectId.isValid(collegeId)) {
    return res.status(400).json({ success: false, message: 'Valid collegeId is required.' });
  }

  try {
    // First, delete all departments associated with the college
    await Department.deleteMany({ college: collegeId });

    // Then, delete the college itself
    const college = await College.findByIdAndDelete(collegeId);

    if (!college) {
      return res.status(404).json({ success: false, message: 'College not found.' });
    }

    res.status(200).json({ success: true, message: 'College and its departments deleted successfully.' });
  } catch (err) {
    console.error('deleteCollege error:', err);
    res.status(500).json({ success: false, message: err.message || 'Unable to delete college.' });
  }
};

export const createDepartment = async (req, res) => {
  const { name, code, description, collegeId } = req.body || {};
  if (!collegeId || !mongoose.Types.ObjectId.isValid(collegeId)) {
    return res.status(400).json({ success: false, message: 'Valid collegeId is required.' });
  }
  if (!name || !String(name).trim()) {
    return res.status(400).json({ success: false, message: 'Department name is required.' });
  }

  const college = await College.findById(collegeId);
  if (!college) {
    return res.status(404).json({ success: false, message: 'College not found.' });
  }

  const payload = {
    name: String(name).trim(),
    college: college._id,
    ...(code ? { code: String(code).trim() } : {}),
    ...(description ? { description: String(description).trim() } : {}),
  };

  try {
    const department = await Department.create(payload);
    res.status(201).json({
      success: true,
      department: {
        id: department._id,
        name: department.name,
        code: department.code || null,
        description: department.description || null,
        collegeId: department.college,
        createdAt: department.createdAt,
        updatedAt: department.updatedAt,
      },
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: 'Department already exists for this college.' });
    }
    console.error('createDepartment error:', err);
    res.status(500).json({ success: false, message: 'Unable to create department.' });
  }
};

export const deleteDepartment = async (req, res) => {
  const { departmentId } = req.params;
  if (!departmentId || !mongoose.Types.ObjectId.isValid(departmentId)) {
    return res.status(400).json({ success: false, message: 'Valid departmentId is required.' });
  }

  try {
    const department = await Department.findByIdAndDelete(departmentId);
    if (!department) {
      return res.status(404).json({ success: false, message: 'Department not found.' });
    }
    res.status(200).json({ success: true, message: 'Department deleted successfully.' });
  } catch (err) {
    console.error('deleteDepartment error:', err);
    res.status(500).json({ success: false, message: 'Unable to delete department.' });
  }
};

export const listDepartments = async (req, res) => {
  await ensureDefaultCollegeAndDepartment();

  const { collegeId } = req.query;
  const filter = {};
  if (collegeId) {
    if (!mongoose.Types.ObjectId.isValid(collegeId)) {
      return res.status(400).json({ success: false, message: 'Invalid collegeId.' });
    }
    filter.college = new mongoose.Types.ObjectId(collegeId);
  }

  const scopeFilter = buildDepartmentScopeFilter(req.user);
  if (scopeFilter.department) {
    if (!mongoose.Types.ObjectId.isValid(scopeFilter.department)) {
      return res.status(400).json({ success: false, message: 'Invalid department scope.' });
    }
    filter._id = new mongoose.Types.ObjectId(scopeFilter.department);
  }

  const departments = await Department.find(filter)
    .sort({ name: 1 })
    .populate('college', 'name code')
    .lean();

  res.status(200).json({
    success: true,
    departments: departments.map((dept) => ({
      id: dept._id,
      name: dept.name,
      code: dept.code || null,
      description: dept.description || null,
      collegeId: dept.college?._id || dept.college,
      collegeName: dept.college?.name || null,
      collegeCode: dept.college?.code || null,
      createdAt: dept.createdAt,
      updatedAt: dept.updatedAt,
    })),
  });
};

export const updateDepartment = async (req, res) => {
  const { departmentId } = req.params;
  if (!departmentId || !mongoose.Types.ObjectId.isValid(departmentId)) {
    return res.status(400).json({ success: false, message: 'Valid departmentId is required.' });
  }

  const { name, code, description, collegeId } = req.body || {};
  const updates = {};

  if (name !== undefined) {
    const trimmedName = String(name).trim();
    if (!trimmedName) {
      return res.status(400).json({ success: false, message: 'Department name cannot be empty.' });
    }
    updates.name = trimmedName;
  }

  if (code !== undefined) {
    const trimmedCode = String(code).trim();
    updates.code = trimmedCode || null;
  }

  if (description !== undefined) {
    const trimmedDescription = String(description).trim();
    updates.description = trimmedDescription || null;
  }

  if (collegeId !== undefined) {
    if (!collegeId || !mongoose.Types.ObjectId.isValid(collegeId)) {
      return res.status(400).json({ success: false, message: 'Valid collegeId is required.' });
    }

    const college = await College.findById(collegeId);
    if (!college) {
      return res.status(404).json({ success: false, message: 'College not found.' });
    }
    updates.college = college._id;
  }

  if (!Object.keys(updates).length) {
    return res.status(400).json({ success: false, message: 'No updates provided.' });
  }

  try {
    const department = await Department.findByIdAndUpdate(departmentId, updates, {
      new: true,
      runValidators: true,
    });

    if (!department) {
      return res.status(404).json({ success: false, message: 'Department not found.' });
    }

    res.status(200).json({
      success: true,
      department: {
        id: department._id,
        name: department.name,
        code: department.code || null,
        description: department.description || null,
        collegeId: department.college,
        createdAt: department.createdAt,
        updatedAt: department.updatedAt,
      },
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: 'Department already exists for this college.' });
    }
    console.error('updateDepartment error:', err);
    res.status(500).json({ success: false, message: 'Unable to update department.' });
  }
};
