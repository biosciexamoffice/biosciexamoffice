import mongoose, { Schema } from "mongoose";

const VALID_STANDINGS = ["deferred", "withdrawn", "readmitted"];
const SEMESTER_OPTIONS = ["first", "second", "both"];

const standingRecordSchema = new Schema(
  {
    student: {
      type: Schema.Types.ObjectId,
      ref: "Student",
      required: true,
      index: true,
    },
    standing: {
      type: String,
      required: true,
      enum: VALID_STANDINGS,
      lowercase: true,
      trim: true,
      index: true,
    },
    session: {
      type: Schema.Types.ObjectId,
      ref: "Session",
      required: true,
      index: true,
    },
    sessionTitleSnapshot: {
      type: String,
      required: true,
      trim: true,
    },
    semester: {
      type: String,
      required: true,
      enum: SEMESTER_OPTIONS,
      lowercase: true,
      trim: true,
    },
    effectiveDate: {
      type: Date,
      default: Date.now,
    },
    remarks: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    updatedStandingEvidence: {
      documentPath: { type: String },
      documentName: { type: String },
      documentNumber: { type: String },
    },
  },
  {
    timestamps: true,
  }
);

standingRecordSchema.index({ student: 1, standing: 1, createdAt: -1 });

export default mongoose.model("StandingRecord", standingRecordSchema);
