import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User, { USER_ROLES } from '../models/user.js';
import Lecturer from '../models/lecturer.js';
import College from '../models/college.js';
import Department from '../models/department.js';

const ACCESS_TOKEN_TTL = process.env.JWT_TTL || '1h';
const ALLOWED_TITLES = ['Professor', 'Doctor', 'Mr', 'Mrs'];
const ROLES_REQUIRE_COLLEGE = new Set(['COLLEGE_OFFICER', 'DEAN', 'EXAM_OFFICER', 'HOD']);
const ROLES_REQUIRE_DEPARTMENT = new Set(['EXAM_OFFICER', 'HOD']);

const signToken = (payload, options = {}) =>
  jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL, ...options });

const httpError = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

const resolveInstitutionAssignments = async ({ collegeId, departmentId }) => {
  let collegeDoc = null;
  let departmentDoc = null;

  if (departmentId !== undefined) {
    if (!mongoose.Types.ObjectId.isValid(departmentId)) {
      throw httpError('Invalid departmentId supplied.');
    }
    departmentDoc = await Department.findById(departmentId).lean();
    if (!departmentDoc) {
      throw httpError('Department not found.', 404);
    }
    collegeDoc = await College.findById(departmentDoc.college).lean();
  }

  if (collegeId !== undefined) {
    if (!mongoose.Types.ObjectId.isValid(collegeId)) {
      throw httpError('Invalid collegeId supplied.');
    }
    const fetchedCollege = await College.findById(collegeId).lean();
    if (!fetchedCollege) {
      throw httpError('College not found.', 404);
    }
    if (collegeDoc && String(collegeDoc._id) !== String(fetchedCollege._id)) {
      throw httpError('Department does not belong to the specified college.');
    }
    collegeDoc = fetchedCollege;
  }

  return { collegeDoc, departmentDoc };
};

const buildUserPayload = (user) => ({
  id: user._id,
  email: user.email || null,
  pfNo: user.pfNo || null,
  roles: user.roles,
  title: user.title || null,
  surname: user.surname || null,
  firstname: user.firstname || null,
  middlename: user.middlename || null,
  departmentId: user.departmentId || null,
  department: user.department || null,
  collegeId: user.collegeId || null,
  college: user.college || null,
});

const buildAuthResponse = (user) => {
  const payload = buildUserPayload(user);
  const token = signToken(payload);
  return {
    success: true,
    token,
    user: payload,
  };
};

export const login = async (req, res) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) {
      return res.status(400).json({ success: false, message: 'Identifier and password are required.' });
    }

    const query = {
      $or: [
        { email: identifier.toLowerCase() },
        { pfNo: identifier.toUpperCase() },
      ],
    };

    const user = await User.findOne(query).select('+passwordHash');
    if (!user || user.status !== 'active') {
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    const passwordOk = await bcrypt.compare(password, user.passwordHash);
    if (!passwordOk) {
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    user.lastLoginAt = new Date();
    await user.save({ validateBeforeSave: false });

    const response = buildAuthResponse(user);
    res.status(200).json(response);
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Unable to login.' });
  }
};

export const bootstrapAdmin = async (req, res) => {
  try {
    const adminExists = await User.exists({ roles: 'ADMIN' });
    if (adminExists) {
      return res.status(400).json({ success: false, message: 'Admin already exists.' });
    }

    const { email, password, pfNo } = req.body || {};
    if (!password || password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({
      email: email?.toLowerCase() || undefined,
      pfNo: pfNo?.toUpperCase() || undefined,
      passwordHash,
      roles: ['ADMIN', 'EXAM_OFFICER'],
    });

    const token = signToken(buildUserPayload(user));
    res.status(201).json({
      success: true,
      message: 'Admin account created.',
      token,
      user: buildUserPayload(user),
    });
  } catch (err) {
    console.error('Bootstrap admin error:', err);
    res.status(500).json({ success: false, message: 'Unable to create admin.' });
  }
};

export const createUser = async (req, res) => {
  try {
    const {
      email,
      pfNo,
      password,
      roles = [],
      lecturerId,
      title,
      surname,
      firstname,
      middlename,
      collegeId,
      departmentId,
    } = req.body || {};
    if (!password || password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
    }
    if (!roles.length) {
      return res.status(400).json({ success: false, message: 'At least one role is required.' });
    }

    const roleSet = [...new Set(roles)];
    const invalidRoles = roleSet.filter((role) => !USER_ROLES.includes(role));
    if (invalidRoles.length) {
      return res.status(400).json({ success: false, message: `Invalid roles: ${invalidRoles.join(', ')}` });
    }

    const trimmedTitle = title ? String(title).trim() : '';
    const trimmedSurname = surname ? String(surname).trim() : '';
    const trimmedFirstname = firstname ? String(firstname).trim() : '';
    const trimmedMiddlename = middlename ? String(middlename).trim() : '';
    if (!trimmedTitle || !ALLOWED_TITLES.includes(trimmedTitle)) {
      return res.status(400).json({ success: false, message: 'Valid title is required (Professor, Doctor, Mr, Mrs).' });
    }
    if (!trimmedSurname) {
      return res.status(400).json({ success: false, message: 'Surname is required.' });
    }
    if (!trimmedFirstname) {
      return res.status(400).json({ success: false, message: 'Firstname is required.' });
    }

    const requiresCollege = roleSet.some((role) => ROLES_REQUIRE_COLLEGE.has(role));
    const requiresDepartment = roleSet.some((role) => ROLES_REQUIRE_DEPARTMENT.has(role));

    if (requiresDepartment && !departmentId) {
      return res.status(400).json({ success: false, message: 'Department assignment is required for this role.' });
    }

    let institution;
    try {
      institution = await resolveInstitutionAssignments({ collegeId, departmentId });
    } catch (err) {
      const status = err.statusCode || 400;
      return res.status(status).json({ success: false, message: err.message });
    }

    const resolvedCollege = institution.collegeDoc;
    const resolvedDepartment = institution.departmentDoc;

    if (requiresCollege && !resolvedCollege) {
      return res.status(400).json({ success: false, message: 'College assignment is required for this role.' });
    }

    const resolvedCollegeName = resolvedCollege?.name ? String(resolvedCollege.name).trim() : '';
    const resolvedDepartmentName = resolvedDepartment?.name ? String(resolvedDepartment.name).trim() : '';

    let lecturer = null;
    if (lecturerId) {
      lecturer = await Lecturer.findById(lecturerId);
      if (!lecturer) {
        return res.status(404).json({ success: false, message: 'Lecturer not found.' });
      }
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({
      email: email?.toLowerCase(),
      pfNo: pfNo?.toUpperCase(),
      passwordHash,
      roles: roleSet,
      lecturer: lecturer?._id || undefined,
      title: trimmedTitle,
      surname: trimmedSurname,
      firstname: trimmedFirstname,
      middlename: trimmedMiddlename,
      department: resolvedDepartmentName || undefined,
      departmentId: resolvedDepartment?._id || undefined,
      college: resolvedCollegeName || undefined,
      collegeId: resolvedCollege?._id || undefined,
    });

    res.status(201).json({
      success: true,
      user: buildUserPayload(user),
    });
  } catch (err) {
    console.error('Create user error:', err);
    const status = err.code === 11000 ? 409 : 500;
    const message = err.code === 11000 ? 'Email or PF Number already in use.' : 'Unable to create user.';
    res.status(status).json({ success: false, message });
  }
};

export const listUsers = async (_req, res) => {
  const users = await User.find()
    .populate('lecturer', 'surname firstname middlename pfNo department')
    .lean();

  res.status(200).json({
    success: true,
    users: users.map((user) => ({
      id: user._id,
      email: user.email,
      pfNo: user.pfNo,
      roles: user.roles,
      status: user.status,
      lecturer: user.lecturer || null,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      title: user.title || null,
      surname: user.surname || null,
      firstname: user.firstname || null,
      middlename: user.middlename || null,
      collegeId: user.collegeId || null,
      departmentId: user.departmentId || null,
      department: user.department || null,
      college: user.college || null,
    })),
  });
};

export const updateUserStatus = async (req, res) => {
  try {
    const {
      status,
      roles,
      password,
      title,
      surname,
      firstname,
      middlename,
      collegeId,
      departmentId,
    } = req.body || {};
    const updates = {};

    const existingUser = await User.findById(req.params.userId);
    if (!existingUser) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    if (status) {
      if (!['active', 'disabled'].includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid status.' });
      }
      updates.status = status;
    }

    let targetRoles = existingUser.roles;
    if (Array.isArray(roles)) {
      const roleSet = [...new Set(roles)];
      const invalid = roleSet.filter((role) => !USER_ROLES.includes(role));
      if (invalid.length) {
        return res.status(400).json({ success: false, message: `Invalid roles: ${invalid.join(', ')}` });
      }
      if (!roleSet.length) {
        return res.status(400).json({ success: false, message: 'User must have at least one role.' });
      }
      updates.roles = roleSet;
      targetRoles = roleSet;
    }

    if (password) {
      if (password.length < 8) {
        return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
      }
      updates.passwordHash = await bcrypt.hash(password, 10);
    }

    if (title !== undefined) {
      const trimmed = title ? String(title).trim() : '';
      if (trimmed && !ALLOWED_TITLES.includes(trimmed)) {
        return res.status(400).json({ success: false, message: 'Invalid title supplied.' });
      }
      updates.title = trimmed;
    }

    if (surname !== undefined) {
      const trimmed = surname ? String(surname).trim() : '';
      if (!trimmed) {
        return res.status(400).json({ success: false, message: 'Surname cannot be empty.' });
      }
      updates.surname = trimmed;
    }

    if (firstname !== undefined) {
      const trimmed = firstname ? String(firstname).trim() : '';
      if (!trimmed) {
        return res.status(400).json({ success: false, message: 'Firstname cannot be empty.' });
      }
      updates.firstname = trimmed;
    }

    if (middlename !== undefined) {
      updates.middlename = middlename ? String(middlename).trim() : '';
    }

    const desiredDepartmentId = departmentId !== undefined
      ? (departmentId === null ? null : departmentId)
      : existingUser.departmentId ? existingUser.departmentId.toString() : undefined;
    const desiredCollegeId = collegeId !== undefined
      ? (collegeId === null ? null : collegeId)
      : existingUser.collegeId ? existingUser.collegeId.toString() : undefined;

    const requiresCollege = targetRoles.some((role) => ROLES_REQUIRE_COLLEGE.has(role));
    const requiresDepartment = targetRoles.some((role) => ROLES_REQUIRE_DEPARTMENT.has(role));

    if (requiresDepartment && (desiredDepartmentId === undefined || desiredDepartmentId === null)) {
      return res.status(400).json({ success: false, message: 'Department assignment is required for this role.' });
    }

    let resolvedInstitution = null;
    try {
      resolvedInstitution = await resolveInstitutionAssignments({
        collegeId: desiredCollegeId === null ? undefined : desiredCollegeId,
        departmentId: desiredDepartmentId === null ? undefined : desiredDepartmentId,
      });
    } catch (err) {
      const status = err.statusCode || 400;
      return res.status(status).json({ success: false, message: err.message });
    }

    const resolvedDepartment = desiredDepartmentId === null ? null : resolvedInstitution.departmentDoc;
    let resolvedCollege = desiredCollegeId === null ? null : resolvedInstitution.collegeDoc;
    if (!resolvedCollege && resolvedDepartment) {
      resolvedCollege = await College.findById(resolvedDepartment.college).lean();
    }

    if (requiresCollege && !resolvedCollege) {
      return res.status(400).json({ success: false, message: 'College assignment is required for this role.' });
    }
    if (requiresDepartment && !resolvedDepartment) {
      return res.status(400).json({ success: false, message: 'Department assignment is required for this role.' });
    }

    if (departmentId !== undefined) {
      if (resolvedDepartment) {
        updates.department = resolvedDepartment.name;
        updates.departmentId = resolvedDepartment._id;
      } else if (departmentId === null) {
        updates.department = null;
        updates.departmentId = null;
      }
    }

    if (collegeId !== undefined || departmentId !== undefined) {
      const finalCollege = resolvedCollege;
      if (finalCollege) {
        updates.college = finalCollege.name;
        updates.collegeId = finalCollege._id;
      } else if (collegeId === null || (departmentId === null && collegeId === undefined)) {
        updates.college = null;
        updates.collegeId = null;
      }
    }

    const user = await User.findByIdAndUpdate(
      req.params.userId,
      { $set: updates },
      { new: true }
    );

    res.status(200).json({ success: true, user: buildUserPayload(user) });
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({ success: false, message: 'Unable to update user.' });
  }
};

export const deleteUser = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid user id.' });
    }

    if (String(req.user?.id || '') === userId) {
      return res.status(400).json({ success: false, message: 'You cannot delete your own account.' });
    }

    const deleted = await User.findByIdAndDelete(userId);
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ success: false, message: 'Unable to delete user.' });
  }
};

export const googleAuthSuccess = (req, res) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Authentication failed.' });
  }

  const response = buildAuthResponse(req.user);
  const acceptJson = req.accepts(['json', 'html']) === 'json' || req.query.format === 'json';

  if (acceptJson) {
    return res.json(response);
  }

  const redirectBase =
    process.env.GOOGLE_SUCCESS_REDIRECT ||
    (process.env.CLIENT_URL ? `${process.env.CLIENT_URL}/oauth/google-success` : null);

  if (redirectBase) {
    const redirectUrl = new URL(redirectBase);
    redirectUrl.searchParams.set('token', response.token);
    redirectUrl.searchParams.set('user', encodeURIComponent(Buffer.from(JSON.stringify(response.user)).toString('base64')));
    return res.redirect(redirectUrl.toString());
  }

  const scriptPayload = `
    <script>
      (function() {
        const payload = ${JSON.stringify(response)};
        if (window.opener) {
          window.opener.postMessage({ type: 'google-auth', payload }, '*');
          window.close();
        } else {
          document.body.innerText = 'Login successful. You can close this window.';
        }
      })();
    </script>
  `;
  return res.send(scriptPayload);
};

export const logoutSession = (req, res) => {
  if (typeof req.logout === 'function') {
    req.logout(() => {
      req.session?.destroy?.(() => {
        res.json({ success: true });
      });
    });
  } else {
    res.json({ success: true });
  }
};

export { buildAuthResponse };

export const getCurrentUser = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    res.status(200).json({ success: true, user: buildUserPayload(user) });
  } catch (err) {
    console.error('Fetch profile error:', err);
    res.status(500).json({ success: false, message: 'Unable to fetch profile.' });
  }
};

export const updateCurrentUserProfile = async (req, res) => {
  try {
    const {
      title,
      surname,
      firstname,
      middlename,
      department,
      college,
    } = req.body || {};

    if ([title, surname, firstname, department, college].some((field) => field === undefined)) {
      return res.status(400).json({
        success: false,
        message: 'Title, surname, firstname, department, and college are required.',
      });
    }

    const trimmedTitle = title ? String(title).trim() : '';
    if (!trimmedTitle || !ALLOWED_TITLES.includes(trimmedTitle)) {
      return res.status(400).json({ success: false, message: 'Valid title is required.' });
    }

    const trimmedSurname = surname ? String(surname).trim() : '';
    if (!trimmedSurname) {
      return res.status(400).json({ success: false, message: 'Surname is required.' });
    }

    const trimmedFirstname = firstname ? String(firstname).trim() : '';
    if (!trimmedFirstname) {
      return res.status(400).json({ success: false, message: 'Firstname is required.' });
    }

    const trimmedDepartment = department ? String(department).trim() : '';
    if (!trimmedDepartment) {
      return res.status(400).json({ success: false, message: 'Department is required.' });
    }

    const trimmedCollege = college ? String(college).trim() : '';
    if (!trimmedCollege) {
      return res.status(400).json({ success: false, message: 'College is required.' });
    }

    const trimmedMiddlename = middlename ? String(middlename).trim() : '';

    const user = await User.findByIdAndUpdate(
      req.user.id,
      {
        $set: {
          title: trimmedTitle,
          surname: trimmedSurname,
          firstname: trimmedFirstname,
          middlename: trimmedMiddlename,
          department: trimmedDepartment,
          college: trimmedCollege,
        },
      },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    res.status(200).json({ success: true, user: buildUserPayload(user) });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ success: false, message: 'Unable to update profile.' });
  }
};

export const updateCurrentUserPassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Current and new passwords are required.' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
    }

    const user = await User.findById(req.user.id).select('+passwordHash');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const matches = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!matches) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
    }

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    await user.save();

    res.status(200).json({ success: true, message: 'Password updated successfully.' });
  } catch (err) {
    console.error('Update password error:', err);
    res.status(500).json({ success: false, message: 'Unable to update password.' });
  }
};
