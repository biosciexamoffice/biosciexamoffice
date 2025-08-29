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
    level:{
        type: String,
        required: true
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

})

export default mongoose.model('Course', courseSchema);