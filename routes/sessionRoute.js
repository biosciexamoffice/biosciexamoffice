import express from 'express';
import {
  createSession,
  getSessions,
  getCurrentSession,
  closeSession,
} from '../controllers/sessionController.js';
import { authenticate, requireRoles } from '../middlewares/authMiddleware.js';

const sessionRouter = express.Router();

sessionRouter.use(authenticate);
sessionRouter.use(requireRoles('ADMIN', 'EXAM_OFFICER', 'COLLEGE_OFFICER', 'HOD', 'DEAN'));

// Create a new session
sessionRouter.post('/', createSession);

// Get all sessions
sessionRouter.get('/', getSessions);

// Close an existing session
sessionRouter.post('/:id/close', closeSession);

// Get current active session
sessionRouter.get('/current', getCurrentSession);

export default sessionRouter;
