import Course from '../models/course.js';
import { ensureDefaultProgrammeSetup } from '../services/institutionService.js';
import { DEFAULT_PROGRAMME } from '../constants/institutionDefaults.js';

export const backfillCourseInstitution = async () => {
  const { college, department, programme } = await ensureDefaultProgrammeSetup();

  const filter = {
    $or: [
      { college: { $exists: false } },
      { college: null },
      { department: { $exists: false } },
      { department: null },
      { programme: { $exists: false } },
      { programme: null },
      { programmeType: { $exists: false } },
      { programmeType: null },
      { host: { $exists: false } },
      { host: null },
    ],
  };

  const update = {
    college: college._id,
    department: department._id,
    programme: programme._id,
    programmeType: programme.degreeType || DEFAULT_PROGRAMME.degreeType,
    host: college.name,
  };

  const result = await Course.updateMany(filter, { $set: update });
  return result.modifiedCount || 0;
};
