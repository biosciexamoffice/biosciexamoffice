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
    college: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'College',
        required: true,
        index: true,
      },
      department: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Department',
        required: true,
        index: true,
      },
}, { timestamps: true });

lecturerSchema.virtual('name').get(function() {
  const parts = [this.title, this.surname, this.firstname, this.middlename];
  return parts.filter(Boolean).join(' ');
});

lecturerSchema.set('toObject', { virtuals: true });
lecturerSchema.set('toJSON', { virtuals: true });

export default mongoose.model('Lecturer', lecturerSchema);
