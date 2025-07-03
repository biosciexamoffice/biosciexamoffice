import Student from "../models/student.js"

export const CreateStudent=async(req, res)=>{

    try {
        const newStudent = await Student.create(req.body)
        newStudent.save()
        res.status(201).json(newStudent)
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


export const getAllStudent= async(req, res)=>{
    try {
        const allStudent = await Student.find()
        res.status(200).json(allStudent)
    } catch (error) {
        console.error("error fecthing doc", error)
        res.status(500).json({
            error: "Internal Server Error"
        })
    }
}
export const getStudentById= async(req, res)=>{
    try {
       const foundStudent = await Student.findById(req.params.id)
       
       if(!foundStudent){
        res.status(404).json({
            error: "Student not found"})
       }
       res.status(200).json(foundStudent)
    } catch (error) {
        console.error("Student not found", error)
        res.status(404).json({
            error: "Student not found"
        })
    }
}



export const updateStudent = async(req, res)=>{
    try {
        const toUpdate = req.body
        
        const updatedStudent = await Student.findByIdAndUpdate(
            req.params.id, 
            toUpdate, 
            {new: true, runValidators: true})
            
            if(!updatedStudent){
            res.status(404).json({
                error: "failed to update student"
            })
        }
        
            res.status(200).json(updatedStudent)

    } catch (error) {

      console.error("error updating student", error)
      if (error.name === 'ValidationError'){
        res.status(400).json({
            error: "Validation Error"
        })
      }else if (error.name === 'CastError' && error.kind === 'ObjectId'){
        res.status(400).json({
            error: "Invalid Student ID"
        })
      } else{
        res.status(500).json({
            error: "Internal Server Error"
        })
      } 
    }
}
export const deleteStudent = async(req, res)=>{
    try {
        const deleteStudent = await Student.findByIdAndDelete(req.params.id)
        if(!deleteStudent){
            res.status(404).json({
                error: "Student not found"
            })
        }
        res.status(200).json({ message: "Student profile deleted successfully" });
    } catch (error) {
        console.error('Error Deleting Student', error)
        if(error.name === 'CastError' && error.kind === 'ObjectId'){
            res.status(400).json({
                error: "Invalid Student ID"
            })
        }else{
            res.status(500).json({
                error: "Internal Server Error"
            })
        }
        
    }
}

