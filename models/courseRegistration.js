// models/courseRegistration.js
import mongoose, { Schema } from 'mongoose';

const CourseRegistrationSchema = new Schema({
  course:   { type: Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
  session:  { type: String, required: true, trim: true, index: true },
  semester: { type: Number, required: true, enum: [1, 2], index: true },

  // explicitly stored level
  level:    { type: String, required: true, enum: ['100','200','300','400','500'], index: true },

  college: { type: Schema.Types.ObjectId, ref: 'College', required: true, index: true },
  department: { type: Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
  programme: { type: Schema.Types.ObjectId, ref: 'Programme', required: true, index: true },
  programmeType: { type: String, required: true, trim: true },

  // all registered students for this document
  student: [{ type: Schema.Types.ObjectId, ref: 'Student' }],

  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

// ensure NO unique index on (course,session,semester) so multiple docs are allowed
// CourseRegistrationSchema.index({ course: 1, session: 1, semester: 1 }, { unique: true });
CourseRegistrationSchema.index({ student: 1, session: 1, semester: 1, level: 1 });

export default mongoose.model('CourseRegistration', CourseRegistrationSchema);
