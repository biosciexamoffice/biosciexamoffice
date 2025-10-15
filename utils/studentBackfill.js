import Student from '../models/student.js';
import { ensureDefaultProgrammeSetup } from '../services/institutionService.js';

export const backfillStudentInstitution = async () => {
  const { college, department, programme } = await ensureDefaultProgrammeSetup();

  const update = {
    college: college._id,
    department: department._id,
    programme: programme._id,
  };

  const filter = {
    $or: [
      { college: { $exists: false } },
      { college: null },
      { department: { $exists: false } },
      { department: null },
      { programme: { $exists: false } },
      { programme: null },
    ],
  };

  const result = await Student.updateMany(filter, { $set: update });
  return result.modifiedCount || 0;
};
