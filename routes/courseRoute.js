import express from 'express'

import {
    createCourse,
    getAllCourses,
    getCourseById,
    updateCourse,
    deleteCourse,
  } from "../controllers/courseController.js";
  
const courseRouter = express.Router()

courseRouter.get('/', getAllCourses)
courseRouter.post('/', createCourse)
courseRouter.get('/:id', getCourseById)
courseRouter.put('/:id', updateCourse)
courseRouter.delete('/:id', deleteCourse)


export default courseRouter;