import mongoose, { Schema } from "mongoose";


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
    lecturer:{
        type: Schema.Types.ObjectId,
        ref: 'Lecturer',
    
    },
    session:{
        type: String,
        required: true
    
    },
    semester:{
        type: Number,
        enum: [1,2],
        required: true
    },
    year:{
        type: Number,
        required: true
    }

})

export default mongoose.model('Course', courseSchema);