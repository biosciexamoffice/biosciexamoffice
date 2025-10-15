import mongoose from 'mongoose';
import College from '../models/college.js';
import Department from '../models/department.js';
import Programme from '../models/programme.js';
import {
  DEFAULT_COLLEGE,
  DEFAULT_DEPARTMENT,
  DEFAULT_PROGRAMME,
  LEGACY_COLLEGE_NAMES,
} from '../constants/institutionDefaults.js';

const toKey = (value) => String(value || '').trim().toLowerCase();

export const ensureDefaultCollegeAndDepartment = async () => {
  const candidateCollegeNames = [DEFAULT_COLLEGE.name, ...LEGACY_COLLEGE_NAMES];

  let college = await College.findOne({ name: { $in: candidateCollegeNames } });
  if (!college) {
    college = await College.create(DEFAULT_COLLEGE);
  } else {
    let collegeNeedsSave = false;
    if (college.name !== DEFAULT_COLLEGE.name) {
      college.name = DEFAULT_COLLEGE.name;
      collegeNeedsSave = true;
    }
    if (DEFAULT_COLLEGE.code && college.code !== DEFAULT_COLLEGE.code) {
      college.code = DEFAULT_COLLEGE.code;
      collegeNeedsSave = true;
    }
    if (DEFAULT_COLLEGE.description && college.description !== DEFAULT_COLLEGE.description) {
      college.description = DEFAULT_COLLEGE.description;
      collegeNeedsSave = true;
    }
    if (collegeNeedsSave) {
      await college.save();
    }
  }

  let department = await Department.findOne({
    college: college._id,
    name: DEFAULT_DEPARTMENT.name,
  });

  if (!department) {
    department = await Department.create({
      ...DEFAULT_DEPARTMENT,
      college: college._id,
    });
  } else {
    let shouldSave = false;
    if (department.name !== DEFAULT_DEPARTMENT.name) {
      department.name = DEFAULT_DEPARTMENT.name;
      shouldSave = true;
    }
    if (DEFAULT_DEPARTMENT.code && department.code !== DEFAULT_DEPARTMENT.code) {
      department.code = DEFAULT_DEPARTMENT.code;
      shouldSave = true;
    }
    if (DEFAULT_DEPARTMENT.description && department.description !== DEFAULT_DEPARTMENT.description) {
      department.description = DEFAULT_DEPARTMENT.description;
      shouldSave = true;
    }
    if (String(department.college) !== String(college._id)) {
      department.college = college._id;
      shouldSave = true;
    }
    if (shouldSave) {
      await department.save();
    }
  }

  return { college, department };
};

export const ensureDefaultProgrammeSetup = async () => {
  const { college, department } = await ensureDefaultCollegeAndDepartment();

  const candidateNames = [DEFAULT_PROGRAMME.name, 'Biochemistry'];
  let programme = await Programme.findOne({
    department: department._id,
    name: { $in: candidateNames },
  });

  if (!programme) {
    programme = await Programme.create({
      ...DEFAULT_PROGRAMME,
      college: college._id,
      department: department._id,
    });
  } else {
    const needsUpdate =
      programme.name !== DEFAULT_PROGRAMME.name ||
      programme.degreeType !== DEFAULT_PROGRAMME.degreeType ||
      String(programme.college) !== String(college._id);

    if (needsUpdate) {
      programme.name = DEFAULT_PROGRAMME.name;
      programme.degreeType = DEFAULT_PROGRAMME.degreeType;
      programme.college = college._id;
      programme.department = department._id;
      if (!programme.description) {
        programme.description = DEFAULT_PROGRAMME.description;
      }
      await programme.save();
    }
  }

  return { college, department, programme };
};

export const validateInstitutionHierarchy = async ({
  collegeId,
  departmentId,
  programmeId,
}) => {
  if (!collegeId || !mongoose.Types.ObjectId.isValid(collegeId)) {
    const error = new Error('Valid collegeId is required.');
    error.statusCode = 400;
    throw error;
  }
  if (!departmentId || !mongoose.Types.ObjectId.isValid(departmentId)) {
    const error = new Error('Valid departmentId is required.');
    error.statusCode = 400;
    throw error;
  }
  if (!programmeId || !mongoose.Types.ObjectId.isValid(programmeId)) {
    const error = new Error('Valid programmeId is required.');
    error.statusCode = 400;
    throw error;
  }

  const [college, department, programme] = await Promise.all([
    College.findById(collegeId),
    Department.findById(departmentId),
    Programme.findById(programmeId),
  ]);

  if (!college) {
    const error = new Error('College not found.');
    error.statusCode = 404;
    throw error;
  }

  if (!department) {
    const error = new Error('Department not found.');
    error.statusCode = 404;
    throw error;
  }

  if (String(department.college) !== String(college._id)) {
    const error = new Error('Department does not belong to the specified college.');
    error.statusCode = 400;
    throw error;
  }

  if (!programme) {
    const error = new Error('Programme not found.');
    error.statusCode = 404;
    throw error;
  }

  if (String(programme.department) !== String(department._id)) {
    const error = new Error('Programme does not belong to the specified department.');
    error.statusCode = 400;
    throw error;
  }

  return { college, department, programme };
};

export const validateCollegeAndDepartment = async ({ collegeId, departmentId }) => {
  if (!collegeId || !mongoose.Types.ObjectId.isValid(collegeId)) {
    const error = new Error('Valid collegeId is required.');
    error.statusCode = 400;
    throw error;
  }
  if (!departmentId || !mongoose.Types.ObjectId.isValid(departmentId)) {
    const error = new Error('Valid departmentId is required.');
    error.statusCode = 400;
    throw error;
  }

  const [college, department] = await Promise.all([
    College.findById(collegeId),
    Department.findById(departmentId),
  ]);

  if (!college) {
    const error = new Error('College not found.');
    error.statusCode = 404;
    throw error;
  }

  if (!department) {
    const error = new Error('Department not found.');
    error.statusCode = 404;
    throw error;
  }

  if (String(department.college) !== String(college._id)) {
    const error = new Error('Department does not belong to the specified college.');
    error.statusCode = 400;
    throw error;
  }

  return { college, department };
};

export const buildInstitutionLookups = async () => {
  const [colleges, departments, programmes] = await Promise.all([
    College.find().lean(),
    Department.find().lean(),
    Programme.find().lean(),
  ]);

  const collegeMap = new Map();
  colleges.forEach((college) => {
    collegeMap.set(toKey(college.name), college);
    if (college.code) {
      collegeMap.set(toKey(college.code), college);
    }
  });

  const departmentMap = new Map();
  departments.forEach((department) => {
    const collegeKey = String(department.college);
    const key = `${collegeKey}:${toKey(department.name)}`;
    departmentMap.set(key, department);
    if (department.code) {
      departmentMap.set(`${collegeKey}:${toKey(department.code)}`, department);
    }
  });

  const programmeMap = new Map();
  programmes.forEach((programme) => {
    const departmentKey = String(programme.department);
    const key = `${departmentKey}:${toKey(programme.name)}`;
    programmeMap.set(key, programme);
    const degreeKey = `${departmentKey}:${toKey(programme.name)}:${toKey(programme.degreeType)}`;
    programmeMap.set(degreeKey, programme);
  });

  return { collegeMap, departmentMap, programmeMap };
};

export const resolveInstitutionByNames = async (
  {
    collegeNameOrCode,
    departmentNameOrCode,
    programmeName,
    degreeType,
  },
  lookups = null,
) => {
  const { collegeMap, departmentMap, programmeMap } = lookups || await buildInstitutionLookups();

  const collegeKey = toKey(collegeNameOrCode);
  const college = collegeMap.get(collegeKey);
  if (!college) {
    const error = new Error(`College "${collegeNameOrCode}" not found.`);
    error.statusCode = 404;
    throw error;
  }

  const departmentKey = `${String(college._id)}:${toKey(departmentNameOrCode)}`;
  const department = departmentMap.get(departmentKey);
  if (!department) {
    const error = new Error(
      `Department "${departmentNameOrCode}" not found under ${college.name}.`,
    );
    error.statusCode = 404;
    throw error;
  }

  const programmeKey = `${String(department._id)}:${toKey(programmeName)}`;
  const programmeDegreeKey = `${String(department._id)}:${toKey(programmeName)}:${toKey(degreeType)}`;
  const programme =
    programmeMap.get(programmeDegreeKey) ||
    programmeMap.get(programmeKey);

  if (!programme) {
    const error = new Error(
      `Programme "${programmeName}" not found under ${department.name}.`,
    );
    error.statusCode = 404;
    throw error;
  }

  return { college, department, programme };
};
