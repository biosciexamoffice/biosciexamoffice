// models/passFailList.js
import mongoose, {Schema} from "mongoose";

const passFailSchema = new Schema({
  course: { type: Schema.ObjectId, ref:"Course", required: true, index: true },
  session: { type: String, required: true, index: true },
  semester: { type: Number, enum: [1, 2], required: true, index: true },
  pass: [{ type: Schema.Types.ObjectId, ref: "Student", required: true }],
  fail: [{ type: Schema.Types.ObjectId, ref: "Student", required: true }]
}, { timestamps: true });

+ // one doc per course+session+semester
+ passFailSchema.index({ course: 1, session: 1, semester: 1 }, { unique: true });

export default mongoose.model("PassFail", passFailSchema);
