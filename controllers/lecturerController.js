import Lecturer from "../models/lecturer.js";
import {
  buildDepartmentScopeFilter,
  ensureResourceMatchesUserScope,
  ensureUserCanAccessDepartment,
} from "../services/accessControl.js";

export const CreateLecturer=async(req, res)=>{

    try {
        const { college, department } = req.body || {};
        if (!college || !department) {
            return res.status(400).json({ error: "college and department are required" });
        }

        ensureUserCanAccessDepartment(req.user, department, college);

        // .create() already saves the document. .save() is redundant.
        const newLecturer = await Lecturer.create(req.body);
        res.status(201).json(newLecturer);
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        // Handle duplicate key error for pfNo
        if (error.code === 11000 && error.keyPattern.pfNo) {
            return res.status(409).json({ error: `Lecturer with PF Number '${error.keyValue.pfNo}' already exists.` });
        }
        if(error.name === 'ValidationError'){
            return res.status(400).json({ error: "Validation Error: Please check your input fields." });
        }else{
            console.error("Error creating lecturer:", error);
            return res.status(500).json({ error: "Internal Server Error" });
        }
    }
}


export const getAllLecturer=async(req, res)=>{
    try {
        const scopeFilter = buildDepartmentScopeFilter(req.user, 'department');
        const allLecturer = await Lecturer.find(scopeFilter)
            .populate('college')
            .populate('department');
        res.status(200).json(allLecturer);

    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        console.error("error fetching docs", error)
        res.status(500).json({
            error: "Internal Server Error"
        })
    }
}


export const getLecturerById=async(req, res)=>{
    try {
       const foundLecturer = await Lecturer.findById(req.params.id).populate('college').populate('department') 
       if (!foundLecturer) {
           return res.status(404).json({ error: "Lecturer not found" });
       }
       ensureResourceMatchesUserScope(req.user, foundLecturer);
       res.status(200).json(foundLecturer)
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        console.error("Lecturer not found", error)
        res.status(404).json({
            error: "Lecturer not found"
        })
    }
}



export const updateLecturer = async(req, res)=>{
    try {
        const toUpdate = req.body || {};

        const existingLecturer = await Lecturer.findById(req.params.id);
        if (!existingLecturer) {
            return res.status(404).json({
                error: "Lecturer not found"
            });
        }

        ensureUserCanAccessDepartment(
            req.user,
            existingLecturer.department,
            existingLecturer.college
        );

        const targetDepartment = toUpdate.department ?? existingLecturer.department;
        const targetCollege = toUpdate.college ?? existingLecturer.college;
        ensureUserCanAccessDepartment(req.user, targetDepartment, targetCollege);

        const updatedLecturer = await Lecturer.findByIdAndUpdate(
            req.params.id,
            toUpdate,
            { new: true, runValidators: true }
        )
            .populate('college')
            .populate('department');

        if(!updatedLecturer){
            return res.status(404).json({
                error: "failed to update Lecturer"
            })
        }

        res.status(200).json(updatedLecturer)

    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ error: error.message });
        }

        console.error("error updating Lecturer", error)
        if (error.code === 11000 && error.keyPattern.pfNo) {
            return res.status(409).json({ error: `Lecturer with PF Number '${error.keyValue.pfNo}' already exists.` });
        }
        if (error.name === 'ValidationError'){
            return res.status(400).json({
                error: "Validation Error"
            })
        }else if (error.name === 'CastError' && error.kind === 'ObjectId'){
            return res.status(400).json({
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
        const lecturer = await Lecturer.findById(req.params.id);
        if (!lecturer) {
            return res.status(404).json({
                error: "Lecture not found"
            })
        }
        ensureUserCanAccessDepartment(req.user, lecturer.department, lecturer.college);
        await lecturer.deleteOne();
        res.status(200).json({ message: "Lecturer deleted successfully" });
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        console.error('Error Deleting Lecturer', error)
        if(error.name === 'CastError' && error.kind === 'ObjectId'){
            return res.status(400).json({
                error: "Invalid Lecturer ID"
            })
        }else{
            return res.status(500).json({
                error: "Internal Server Error"
            })
        }
        
    }
}
