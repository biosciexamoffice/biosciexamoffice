import mongoose from "mongoose";


const studentSchema = mongoose.Schema({
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
    regNo:{
        type: String,
        required: true,
        unique: true

    },
    level:{
        type: String,
        required: true
    },
    department:{
        type: String,
        required: true
    },
})

export default mongoose.model('Student', studentSchema);

