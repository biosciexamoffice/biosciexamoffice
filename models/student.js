import mongoose, { Schema } from "mongoose";

const studentSchema = new Schema({
    surname: {
        type: String,
        required: [true, "Surname is required"],
        trim: true,
    },
    firstname: {
        type: String,
        required: [true, "First name is required"],
        trim: true,
    },
    middlename: {
        type: String,
        trim: true,
    },
    regNo: {
        type: String,
        required: [true, "Registration number is required"],
        unique: true,
        trim: true,
        uppercase: true,
    },
    level: {
        type: String,
        required: [true, "Level is required"],
        trim: true,
    },
}, { timestamps: true });

export default mongoose.model("Student", studentSchema);
