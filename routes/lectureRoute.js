import express from "express"
import {
    getAllLecturer,
    CreateLecturer,
    getLecturerById,
    updateLecturer,
    deleteLecturer,
  } from "../controllers/lecturerController.js";
import { authenticate, requireRoles } from "../middlewares/authMiddleware.js";


const lecturerController = express.Router()

lecturerController.use(authenticate);
lecturerController.use(requireRoles('ADMIN', 'EXAM_OFFICER', 'COLLEGE_OFFICER', 'HOD', 'DEAN'));

lecturerController.get('/', getAllLecturer)
lecturerController.post('/', CreateLecturer)
lecturerController.get('/:id', getLecturerById)
lecturerController.patch('/:id', updateLecturer)
lecturerController.delete('/:id', deleteLecturer)

export default lecturerController;
