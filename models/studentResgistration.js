import mongoose, { Schema } from "mongoose";

const studentRegistrationSchema = new Schema({
    students: {
        type: [mongoose.Schema.Types.ObjectId],
        ref: 'Student',
        required: true
    },
    session: {
        type: String,
        required: true
    },  
    level: {
        type: Number,
        required: true
    },
    semester: {
        type: Number,
        required: true
    },
    courses: {
        type: [mongoose.Schema.Types.ObjectId],
        ref: 'Course',
        required: true
    }

})


export default mongoose.model("StudentRegistration", studentRegistrationSchema);