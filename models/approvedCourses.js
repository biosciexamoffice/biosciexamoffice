import mongoose, {Schema} from "mongoose";

const ApprovedCoursesSchema = new Schema({
  collegeName: {
    type: String,
    required: true,
    trim: true,
  },
  departmentName: {
    type: String,
    required: true,
    trim: true,
  },
  programmeName: {
    type: String,
    required: true,
    trim: true,
  },
  programmeType: {
    type: String,
    required: true,
    trim: true,
  },

  college: {
    type: Schema.Types.ObjectId,
    ref: 'College',
    required: true,
    index: true,
  },
  department: {
    type: Schema.Types.ObjectId,
    ref: 'Department',
    required: true,
    index: true,
  },
  programme: {
    type: Schema.Types.ObjectId,
    ref: 'Programme',
    required: true,
    index: true,
  },

  session: {
    type: String,
    required: true,
    trim: true
  },
  
  semester: {
    type: Number,
    required: true,
    enum: [1, 2],
    min: 1,
    max: 2,
  },
  
  level: {
    type: Number,
    required: true,
    enum: [100, 200, 300, 400, 500],
    validate: {
      validator: Number.isInteger,
      message: '{VALUE} is not an integer value'
    }
  },
  
  courses: [
    {
      type: Schema.Types.ObjectId,
      ref: "Course",
      required: true
    }
  ],
  registrationsByLevel: [{
  level: { type: String, required: true },            // '100' | '200' | ...
  students: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Student' }]
}],
  
  dateApproved: {
    type: Date,
    default: Date.now
  }, 
}, {
  timestamps: true
});

ApprovedCoursesSchema.index(
  { college: 1, programme: 1, session: 1, semester: 1, level: 1 }
);

// Removed the pre-save hook as it won't work with ObjectId references
// (course codes aren't available until after population)

export default mongoose.model('ApprovedCourses', ApprovedCoursesSchema);
