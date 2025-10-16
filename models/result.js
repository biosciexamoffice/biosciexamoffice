import mongoose, {Schema} from "mongoose";

const resultSchema = new Schema({
    course: {
        type: Schema.Types.ObjectId,
        ref: 'Course',
        required: true,
    },
    student: {
        type: Schema.Types.ObjectId,
        ref: "Student",
        required: true
    },
    lecturer: {
        type: Schema.Types.ObjectId,
        ref: "Lecturer",
        required: true
    },
    college: {
        type: String,
        default: ''
    },
    department:{
        type: String,
        required: true
    },
    session: {
        type: String,
        required: true
    },
    semester: {
        type: Number,
        enum: [1, 2],
        required: true
    },
    date: {
        type: Date,
        required: true
    },
    level: {
        type: String,
        required: true
    },
    resultType: {
        type: String,
        enum: ["CORE", "CARRYOVER"],
        required: true
    },
    q1: {
        type: Number,
    },
    q2: {
        type: Number,
    },
    q3: {
        type: Number,
    },
    q4: {
        type: Number,
    },
    q5: {
        type: Number,
    },
    q6: {
        type: Number,
    },
    q7: {
        type: Number,
    },
    q8: {
        type: Number,
    },
    totalexam: {
        type: Number,
    },
    ca: {
        type: Number,
    },
    grandtotal: {
        type: Number,
        required: true
    },
    grade: {
        type: String,
        enum: ['A', 'B', 'C', 'D', 'E', 'F'],
        required: true
        
    },
    moderated:{
        type: Boolean,
        default: false
    },
    moderationStatus: {
        type: String,
        enum: ['none', 'pending', 'approved'],
        default: 'none'
    },
    moderationPendingGrandtotal: {
        type: Number,
    },
    moderationOriginalGrandtotal: {
        type: Number,
    },
    moderationApprovedAt: {
        type: Date,
    },
    moderationProof: {
        type: String,
        default: ""
    },
    moderationAuthorizedPfNo: {
        type: String,
        default: ""
    }
}, { timestamps: true });

resultSchema.index({ session: 1, semester: 1, level: 1 });
resultSchema.index({ student: 1, session: 1, semester: 1, level: 1 });
resultSchema.index({ course: 1, session: 1, semester: 1, level: 1 });
resultSchema.index({ department: 1, session: 1, semester: 1, level: 1 });
resultSchema.index({ createdAt: -1 });

export default mongoose.model("Result", resultSchema);
