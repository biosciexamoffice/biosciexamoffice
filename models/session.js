import mongoose, { Schema } from "mongoose";


const sessionSchema = new Schema({
    startDate: {
        type: Date,
        required: true
    },
    endDate: {
        type: Date,
        
    },
    dean: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Lecturer'
    },
    hod: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Lecturer'
    },
    eo: {
        type: mongoose.Schema.ObjectId,
        ref: 'Lecturer'
    },
    setSession: {
        type: String,
        required: true
    }
})

export default mongoose("Session", sessionSchema)