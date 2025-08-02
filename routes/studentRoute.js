import {
    getAllStudent,
    CreateStudent,
    getStudentById,
    updateStudent,
    deleteStudent,
  } from "../controllers/studentController.js";

  import {uploadStudents, upload} from "../controllers/uploadStudentController.js";


import express from "express";


const studentRoute = express.Router()

studentRoute.post("/", CreateStudent);
studentRoute.get("/", getAllStudent);
studentRoute.get("/:id", getStudentById);
studentRoute.patch("/:id",  updateStudent);
studentRoute.delete("/:id", deleteStudent);
studentRoute.post('/upload', upload.single('csvFile'), uploadStudents);


export default studentRoute