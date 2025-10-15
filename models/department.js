import mongoose from 'mongoose';

const departmentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    code: {
      type: String,
      trim: true,
      sparse: true,
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
    programmes: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Programme',
    }],
  },
  {
    timestamps: true,
  }
);

departmentSchema.index({ college: 1, name: 1 }, { unique: true });

export default mongoose.model('Department', departmentSchema);
