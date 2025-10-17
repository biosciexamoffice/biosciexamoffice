// models/approvedCourses.js
import mongoose from 'mongoose';

const ApprovedCoursesSchema = new mongoose.Schema({
  college: { type: mongoose.Schema.Types.ObjectId, ref: 'College', required: true },
  department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true },
  programme: { type: mongoose.Schema.Types.ObjectId, ref: 'Programme', required: true },
  programmeType: { type: String },
  collegeName: String,
  departmentName: String,
  programmeName: String,
  session: { type: String, required: true },      // e.g. "2020/2021"
  semester: { type: Number, required: true },     // 1 or 2
  level: { type: Number, required: true },        // 100/200/...
  courses: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true }],
}, { timestamps: true });

// 👇 This is the important line
ApprovedCoursesSchema.index(
  { college: 1, department: 1, programme: 1, session: 1, semester: 1, level: 1 },
  { unique: true, name: 'uniq_approved_per_programme_session_sem_level' }
);

export default mongoose.model('ApprovedCourses', ApprovedCoursesSchema);
