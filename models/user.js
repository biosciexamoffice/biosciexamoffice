import mongoose, { Schema } from 'mongoose';

export const USER_ROLES = ['ADMIN', 'EXAM_OFFICER', 'COLLEGE_OFFICER', 'HOD', 'DEAN'];

const userSchema = new Schema({
  email: {
    type: String,
    trim: true,
    lowercase: true,
    unique: true,
    sparse: true,
  },
  pfNo: {
    type: String,
    trim: true,
    uppercase: true,
    unique: true,
    sparse: true,
  },
  title: {
    type: String,
    trim: true,
  },
  surname: {
    type: String,
    trim: true,
  },
  firstname: {
    type: String,
    trim: true,
  },
  middlename: {
    type: String,
    trim: true,
  },
  department: {
    type: String,
    trim: true,
  },
  college: {
    type: String,
    trim: true,
  },
  collegeId: {
    type: Schema.Types.ObjectId,
    ref: 'College',
  },
  departmentId: {
    type: Schema.Types.ObjectId,
    ref: 'Department',
  },
  passwordHash: {
    type: String,
    required: true,
    select: false,
  },
  lecturer: {
    type: Schema.Types.ObjectId,
    ref: 'Lecturer',
  },
  roles: [{
    type: String,
    enum: USER_ROLES,
    required: true,
  }],
  status: {
    type: String,
    enum: ['active', 'disabled'],
    default: 'active',
  },
  lastLoginAt: {
    type: Date,
  },
  audit: [{
    action: { type: String },
    note: { type: String },
    createdAt: { type: Date, default: Date.now },
  }],
}, {
  timestamps: true,
});

userSchema.index({ collegeId: 1 });
userSchema.index({ departmentId: 1 });
userSchema.path('roles').validate((value) => Array.isArray(value) && value.length > 0, 'User must have at least one role');

export default mongoose.model('User', userSchema);
