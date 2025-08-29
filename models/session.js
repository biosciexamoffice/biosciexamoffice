import mongoose, { Schema } from "mongoose";


const sessionSchema = new Schema({
    
    sessionTitle:{
        type: String,
        required: [true, "Sesssion Title is required!"]
    },
    startDate: {
        type: Date,
        required: [true, "Session Start date is required!"]
    },
    endDate: {
        type: Date,
        
    },
    dean: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Lecturer',
        required: [true, "Dean is required!"],
        
    },
    hod: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Lecturer',
        required: [true, "HOD is required!"]
    },
    eo: {
        type: mongoose.Schema.ObjectId,
        ref: 'Lecturer',
        required: [true, "EO is required!"]
    },
    
})

export default mongoose.model("Session", sessionSchema)