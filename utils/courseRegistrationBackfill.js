import CourseRegistration from '../models/courseRegistration.js';
import { ensureDefaultProgrammeSetup } from '../services/institutionService.js';
import { DEFAULT_PROGRAMME } from '../constants/institutionDefaults.js';

export const backfillCourseRegistrationInstitution = async () => {
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
    ],
  };

  const update = {
    college: college._id,
    department: department._id,
    programme: programme._id,
    programmeType: programme.degreeType || DEFAULT_PROGRAMME.degreeType,
  };

  const result = await CourseRegistration.updateMany(filter, { $set: update });
  return result.modifiedCount || 0;
};
