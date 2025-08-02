import express from 'express';
import {
  createCourse,
  getAllCourses,
  getCourseById,
  updateCourse,
  deleteCourse,
} from "../controllers/courseController.js";
import { upload, uploadCourses } from '../controllers/uploadCourseController.js';

const courseRouter = express.Router();

courseRouter.get('/', getAllCourses);
courseRouter.post('/', createCourse);
courseRouter.get('/:id', getCourseById);
courseRouter.patch('/:id', updateCourse);
courseRouter.delete('/:id', deleteCourse);

// Fix: Changed 'csvFile' to 'file' to match frontend
courseRouter.post('/upload', upload.single('file'), uploadCourses);

export default courseRouter;