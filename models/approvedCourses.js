import mongoose, {Schema} from "mongoose";

const ApprovedCoursesSchema = new Schema({
  college: {
    type: String,
    required: true,
    trim: true
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
    validate: {
      validator: Number.isInteger,
      message: '{VALUE} is not an integer value'
    }
  },
  
  level: {
    type: Number,
    required: true,
    enum: [100, 200, 300, 400],
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

// Corrected compound index
ApprovedCoursesSchema.index(
  { college: 1, session: 1, semester: 1, level: 1 }
);

// Removed the pre-save hook as it won't work with ObjectId references
// (course codes aren't available until after population)

export default mongoose.model('ApprovedCourses', ApprovedCoursesSchema);