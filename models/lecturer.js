import mongoose from "mongoose";


const lecturerSchema = new mongoose.Schema({
    title:{
        type: String,
        required: true
    },
    surname:{
        type: String,
        required: true
    },
    firstname:{
        type: String,
        required: true
    },
    middlename:{
        type: String,
    },
    pfNo:{
        type: String,
        required: true,
        unique: true
    },
    rank:{
        type: String,
        required: true
    },
    department:{
        type: String,
        required: true
    },
}, { timestamps: true });

export default mongoose.model('Lecturer', lecturerSchema);
