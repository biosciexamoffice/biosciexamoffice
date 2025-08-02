import express from "express"
import {
    getAllLecturer,
    CreateLecturer,
    getLecturerById,
    updateLecturer,
    deleteLecturer,
  } from "../controllers/lecturerController.js";


const lecturerController = express.Router()

lecturerController.get('/', getAllLecturer)
lecturerController.post('/', CreateLecturer)
lecturerController.get('/:id', getLecturerById)
lecturerController.patch('/:id', updateLecturer)
lecturerController.delete('/:id', deleteLecturer)

export default lecturerController;