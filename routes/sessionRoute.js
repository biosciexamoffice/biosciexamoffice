import express from 'express';
import {
  createSession,
  getSessions,
  getCurrentSession,
  closeSession,
} from '../controllers/sessionController.js';

const sessionRouter = express.Router();

// Create a new session
sessionRouter.post('/', createSession);

// Get all sessions
sessionRouter.get('/', getSessions);

// Close an existing session
sessionRouter.post('/:id/close', closeSession);

// Get current active session
sessionRouter.get('/current', getCurrentSession);

export default sessionRouter;
