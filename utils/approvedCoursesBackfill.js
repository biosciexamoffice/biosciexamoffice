import ApprovedCourses from '../models/approvedCourses.js';
import { ensureDefaultProgrammeSetup } from '../services/institutionService.js';
import { DEFAULT_PROGRAMME } from '../constants/institutionDefaults.js';

export const backfillApprovedCoursesInstitution = async () => {
  const { college, department, programme } = await ensureDefaultProgrammeSetup();

  const update = {
    college: college._id,
    department: department._id,
    programme: programme._id,
    programmeType: programme.degreeType || DEFAULT_PROGRAMME.degreeType,
    collegeName: college.name,
    departmentName: department.name,
    programmeName: programme.name,
  };

  const result = await ApprovedCourses.updateMany({}, { $set: update });
  return result.modifiedCount || 0;
};
