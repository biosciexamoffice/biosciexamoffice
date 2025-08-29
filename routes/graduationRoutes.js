// routes/graduationRoutes.js
import express from 'express';
import {
  isGraduationHookAvailable,
  getGraduatingList,
  finalizeGraduation,
} from '../controllers/graduationController.js';

const graduationRouter = express.Router();

// Hook availability (rule #4)
graduationRouter.get('/available', isGraduationHookAvailable);

// Main graduating list (rules #1–#3 enforced)
graduationRouter.get('/list', getGraduatingList);

// Optional: flip status to "graduated" for approved candidates
graduationRouter.post('/finalize', finalizeGraduation);

export default graduationRouter;
