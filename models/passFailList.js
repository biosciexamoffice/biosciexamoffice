import mongoose, {Schema} from "mongoose";

const passFailSchema = new Schema({
    
    course: {
        type: Schema.ObjectId,
        ref:"Course"
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
    pass: [{
        type: Schema.Types.ObjectId,
        ref: "Student",
        required: true
    }],
    fail: [{
        type: Schema.Types.ObjectId,
        ref: "Student",
        required: true
    }]
});

export default mongoose.model("PassFail", passFailSchema); 