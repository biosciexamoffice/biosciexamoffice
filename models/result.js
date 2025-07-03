
import mongoose, {Schema} from "mongoose";

const resultSchema = new Schema({
    course:{
        type: Schema.Types.ObjectId,
        ref: 'Course',
        required: true,

    },
    student:{
        type: Schema.Types.ObjectId,
        ref: "Student",
        required: true
    },
    lecturer:{
        type: Schema.Types.ObjectId,
        ref: "Lecturer",
        required: true
    },
    q1:{
        type: Number,
    },
    q2:{
        type: Number,
    },
    q3:{
        type: Number,
    },
    q4:{
        type: Number,
    },
    q5:{
        type: Number,
    },
    q6:{
        type: Number,
    },
    q7:{
        type: Number,
    },
    q8:{
        type: Number,
    },
    grade: {
        type: String,
        enum: ['A', 'B', 'C', 'D', 'F'],
        required: true
    }
});

export default mongoose.model("Result", resultSchema);
