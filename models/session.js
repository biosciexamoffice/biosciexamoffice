import mongoose, { Schema } from "mongoose";

const officerSnapshotSchema = new Schema(
  {
    lecturer: { type: Schema.Types.ObjectId, ref: "Lecturer", required: true },
    name: { type: String, required: true, trim: true },
    pfNo: { type: String, required: true, trim: true },
    department: { type: String, required: true, trim: true },
    title: { type: String, trim: true },
    rank: { type: String, trim: true },
  },
  { _id: false }
);

const promotionStatsSchema = new Schema(
  {
    promoted: { type: Number, default: 0 },
    promotedBreakdown: {
      hundredToTwo: { type: Number, default: 0 },
      twoToThree: { type: Number, default: 0 },
      threeToFour: { type: Number, default: 0 },
    },
    graduated: { type: Number, default: 0 },
    extraYear: { type: Number, default: 0 },
    totalProcessed: { type: Number, default: 0 },
  },
  { _id: false }
);

const sessionSchema = new Schema(
  {
    sessionTitle: {
      type: String,
      required: [true, "Sesssion Title is required!"],
      trim: true,
    },
    startDate: {
      type: Date,
      required: [true, "Session Start date is required!"],
    },
    endDate: {
      type: Date,
    },
    status: {
      type: String,
      enum: ["active", "completed"],
      default: "active",
      index: true,
    },
    isCurrent: {
      type: Boolean,
      default: true,
      index: true,
    },
    dean: {
      type: Schema.Types.ObjectId,
      ref: "Lecturer",
      required: [true, "Dean is required!"],
    },
    hod: {
      type: Schema.Types.ObjectId,
      ref: "Lecturer",
      required: [true, "HOD is required!"],
    },
    eo: {
      type: Schema.Types.ObjectId,
      ref: "Lecturer",
      required: [true, "EO is required!"],
    },
    principalOfficers: {
      dean: { type: officerSnapshotSchema, required: true },
      hod: { type: officerSnapshotSchema, required: true },
      examOfficer: { type: officerSnapshotSchema, required: true },
    },
    promotionStats: { type: promotionStatsSchema, default: () => ({}) },
    closedAt: { type: Date },
  },
  { timestamps: true }
);

export default mongoose.model("Session", sessionSchema);
