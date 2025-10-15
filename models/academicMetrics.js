import mongoose from 'mongoose';

const officerApprovalSchema = new mongoose.Schema({
  approved: {
    type: Boolean,
    default: false,
  },
  flagged: {
    type: Boolean,
    default: false,
  },
  name: {
    type: String,
    trim: true,
    default: '',
  },
  title: {
    type: String,
    trim: true,
    default: '',
  },
  surname: {
    type: String,
    trim: true,
    default: '',
  },
  firstname: {
    type: String,
    trim: true,
    default: '',
  },
  middlename: {
    type: String,
    trim: true,
    default: '',
  },
  department: {
    type: String,
    trim: true,
    default: '',
  },
  college: {
    type: String,
    trim: true,
    default: '',
  },
  note: {
    type: String,
    trim: true,
    default: '',
  },
  updatedAt: {
    type: Date,
  },
}, { _id: false });

const academicMetricsSchema = new mongoose.Schema({
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student',
    required: true,
    index: true
  },
  department: {
    type: String,
    trim: true,
    default: '',
  },
  college: {
    type: String,
    trim: true,
    default: '',
  },
  session: {
    type: String,
    required: true,
    match: [/^\d{4}\/\d{4}$/, 'Session must look like 2023/2024'],
  },
  semester: {
    type: Number,
    required: true,
    enum: [1, 2]
  },
  level: {
    type: Number,
    required: true,
    enum: [100, 200, 300, 400]
  },
  // Previous cumulative values
  CCC: {
    type: Number,
    required: true,
    min: 0,
    default: 0
  },
  CCE: {
    type: Number,
    required: true,
    min: 0,
    default: 0
  },
  CPE: {
    type: Number,
    required: true,
    min: 0,
    default: 0
  },
  CGPA: {
    type: Number,
    required: true,
    min: 0,
    max: 5.0,
    default: 0
  },
  // Current semester values
  TCC: {
    type: Number,
    required: true,
    min: 0,
    default: 0
  },
  TCE: {
    type: Number,
    required: true,
    min: 0,
    default: 0
  },
  TPE: {
    type: Number,
    required: true,
    min: 0,
    default: 0
  },
  GPA: {
    type: Number,
    required: true,
    min: 0,
    max: 5.0,
    default: 0
  },
  lastUpdated: {
    type: Date,
    default: Date.now
  },
  previousMetrics: {
    CCC: {
      type: Number,
      default: 0
    },
    CCE: {
      type: Number,
      default: 0
    },
    CPE: {
      type: Number,
      default: 0
    },
    CGPA: {
      type: Number,
      default: 0
    }
  },
  ceoApproval: {
    type: officerApprovalSchema,
    default: () => ({}),
  },
  hodApproval: {
    type: officerApprovalSchema,
    default: () => ({}),
  },
  deanApproval: {
    type: officerApprovalSchema,
    default: () => ({}),
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Compound index to ensure one record per student per session/semester/level
academicMetricsSchema.index(
  { student: 1, session: 1, semester: 1, level: 1 },
  { unique: true }
);

const AcademicMetrics = mongoose.model('AcademicMetrics', academicMetricsSchema);

export default AcademicMetrics;
