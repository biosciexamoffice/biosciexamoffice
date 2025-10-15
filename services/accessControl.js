import mongoose from 'mongoose';

const GLOBAL_ACCESS_ROLES = new Set(['ADMIN', 'DEAN', 'COLLEGE_OFFICER']);
const DEPARTMENT_SCOPED_ROLES = new Set(['EXAM_OFFICER', 'HOD']);

const toIdString = (value) => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof mongoose.Types.ObjectId) {
    return value.toString();
  }
  if (typeof value === 'object') {
    if (value._id) {
      return value._id.toString();
    }
    if (value.id) {
      return value.id.toString();
    }
    if (typeof value.toString === 'function') {
      return value.toString();
    }
  }
  try {
    return String(value);
  } catch {
    return null;
  }
};

export const userHasGlobalInstitutionAccess = (user) =>
  Boolean(user?.roles?.some((role) => GLOBAL_ACCESS_ROLES.has(role)));

export const userRequiresDepartmentScope = (user) =>
  !userHasGlobalInstitutionAccess(user) &&
  Boolean(user?.roles?.some((role) => DEPARTMENT_SCOPED_ROLES.has(role)));

const requireDepartmentAssignment = (user) => {
  const departmentId = toIdString(user?.departmentId);
  if (!departmentId) {
    const error = new Error('Your account is not assigned to a department.');
    error.statusCode = 403;
    throw error;
  }
  return departmentId;
};

export const buildDepartmentScopeFilter = (user, field = 'department') => {
  if (!userRequiresDepartmentScope(user)) {
    return {};
  }
  const departmentId = requireDepartmentAssignment(user);
  return { [field]: departmentId };
};

export const ensureUserCanAccessDepartment = (user, departmentId, collegeId = null) => {
  if (!userRequiresDepartmentScope(user)) {
    return;
  }

  const userDepartmentId = requireDepartmentAssignment(user);
  const targetDepartmentId = toIdString(departmentId);

  if (targetDepartmentId && targetDepartmentId !== userDepartmentId) {
    const error = new Error('You are not authorized to manage this department.');
    error.statusCode = 403;
    throw error;
  }

  const targetCollegeId = toIdString(collegeId);
  const userCollegeId = toIdString(user?.collegeId);
  if (targetCollegeId && userCollegeId && targetCollegeId !== userCollegeId) {
    const error = new Error('You are not authorized to manage this college.');
    error.statusCode = 403;
    throw error;
  }
};

export const ensureResourceMatchesUserScope = (user, resource) => {
  if (!userRequiresDepartmentScope(user) || !resource) {
    return;
  }
  ensureUserCanAccessDepartment(user, resource.department || resource.departmentId, resource.college || resource.collegeId);
};

