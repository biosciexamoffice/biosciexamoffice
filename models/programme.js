import mongoose from 'mongoose';

const programmeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    degreeType: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    college: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'College',
      required: true,
      index: true,
    },
    department: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

programmeSchema.index({ department: 1, name: 1 }, { unique: true });

export default mongoose.model('Programme', programmeSchema);
