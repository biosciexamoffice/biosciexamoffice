import express from 'express';
import {
  createCourse,
  getAllCourses,
  getCourseById,
  updateCourse,
  deleteCourse,
} from "../controllers/courseController.js";
import { upload, uploadCourses } from '../controllers/uploadCourseController.js';
import { authenticate } from '../middlewares/authMiddleware.js';

const courseRouter = express.Router();

courseRouter.use(authenticate);

courseRouter.get('/', getAllCourses);
courseRouter.post('/', createCourse);
courseRouter.get('/:id', getCourseById);
courseRouter.patch('/:id', updateCourse);
courseRouter.delete('/:id', deleteCourse);

// Fix: Changed 'csvFile' to 'file' to match frontend
courseRouter.post('/upload', upload.single('file'), uploadCourses);

export default courseRouter;
