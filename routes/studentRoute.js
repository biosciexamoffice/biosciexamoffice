import {
    getAllStudent,
    CreateStudent,
    getStudentById,
    updateStudent,
    deleteStudent,
  } from "../controllers/studentController.js";

import express from "express";


const studentRoute = express.Router()

studentRoute.post("/", CreateStudent);
studentRoute.get("/", getAllStudent);
studentRoute.get("/:id", getStudentById);
studentRoute.put("/:id",  updateStudent);
studentRoute.delete("/:id", deleteStudent);

export default studentRoute