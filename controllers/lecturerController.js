import Lecturer from "../models/lecturer.js"

export const CreateLecturer=async(req, res)=>{

    try {
        const newLecturer = await Lecturer.create(req.body)
        newLecturer.save()
        res.status(201).json(newLecturer)
    } catch (error) {
        if(error.name === 'validationError'){
            res.status(400).json({
                error: "validation Error"
            })
        }else{
            res.status(500).json({
                error: "Internal Server Error"
            })
        }
    }
}


export const getAllLecturer=async(req, res)=>{
    try {
        const allLecturer = await Lecturer.find()
        res.status(200).json(allLecturer)
    } catch (error) {
        console.error("error fecthing doc", error)
        res.status(500).json({
            error: "Internal Server Error"
        })
    }
}


export const getLecturerById=async(req, res)=>{
    try {
       const foundLecturer = await Lecturer.findById(req.params.id) 
       res.status(200).json(foundLecturer)
    } catch (error) {
        console.error("Lecturer not found", error)
        res.status(404).json({
            error: "Lecturer not found"
        })
    }
}



export const updateLecturer = async(req, res)=>{
    try {
        const toUpdate = req.body
        
        const updatedLecturer = await Lecturer.findByIdAndUpdate(
            req.params.id, 
            toUpdate, 
            {new: true, runValidators: true})
            
            if(!updatedLecturer){
            res.status(404).json({
                error: "failed to update Lecturer"
            })
        }
        
            res.status(200).json(updatedLecturer)

    } catch (error) {

      console.error("error updating Lecturer", error)
      if (error.name === 'ValidationError'){
        res.status(400).json({
            error: "Validation Error"
        })
      }else if (error.name === 'CastError' && error.kind === 'ObjectId'){
        res.status(400).json({
            error: "Invalid Lecturer ID"
        })
      } else{
        res.status(500).json({
            error: "Internal Server Error"
        })
      } 
    }
}
export const deleteLecturer = async(req, res)=>{
    try {
        const deleteLecturer = await Lecturer.findByIdAndDelete(req.params.id)
        if(!deleteLecturer){
            res.status(404).json({
                error: "Lecture not found"
            })
        }
        res.status(200).json({ message: "Lecturer deleted successfully" });
    } catch (error) {
        console.error('Error Deleting Lecturer', error)
        if(error.name === 'CastError' && error.kind === 'ObjectId'){
            res.status(400).json({
                error: "Invalid Lecturer ID"
            })
        }else{
            res.status(500).json({
                error: "Internal Server Error"
            })
        }
        
    }
}

