import mongoose, { Schema } from "mongoose";
import { DEFAULT_COLLEGE } from "../constants/institutionDefaults.js";

const courseSchema = Schema({
    title:{
        type: String,
        required: true
    },
    code: {
        type: String,
        required: true
    },
    unit:{
        type: Number,
        required: true
    },
    level:{
        type: String,
        required: true
    },
    host: {
        type: String,
        required: true,
        default: DEFAULT_COLLEGE.name,
        trim: true,
    },
    lecturer:{
        type: Schema.Types.ObjectId,
        ref: 'Lecturer',
    
    },
    option:{
        type: String,
        enum:["C", "E"],
        required: true
    },
    semester:{
        type: Number,
        enum: [1,2],
        required: true
    },
    uamId: {
        type: String,
    }
    ,
    college: {
        type: Schema.Types.ObjectId,
        ref: 'College',
        required: true,
        index: true,
    },
    department: {
        type: Schema.Types.ObjectId,
        ref: 'Department',
        required: true,
        index: true,
    },
    programme: {
        type: Schema.Types.ObjectId,
        ref: 'Programme',
        required: true,
        index: true,
    },
    programmeType: {
        type: String,
        required: true,
        trim: true,
    }

})

courseSchema.index({ programme: 1, level: 1, semester: 1 });

export default mongoose.model('Course', courseSchema);
