import express from 'express';
import {
  createApprovedCourses,
  getApprovedCourses,
  getApprovedCourseById,
  updateApprovedCourses,
  deleteApprovedCourses
} from '../controllers/approvedCoursesController.js';

const approvedCoursesrouter = express.Router();

approvedCoursesrouter.route('/')
  .post(createApprovedCourses)  // Create approved courses
  .get(getApprovedCourses);     // Get all approved courses

approvedCoursesrouter.route('/:id')
  .get(getApprovedCourseById)    // Get single approved course
  .put(updateApprovedCourses)    // Update approved courses
  .delete(deleteApprovedCourses); // Delete approved courses

export default approvedCoursesrouter;