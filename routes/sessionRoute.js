import express from 'express';
import { 
    createSession, 
    getSessions,
    getCurrentSession
} from '../controllers/sessionController.js';

const sessionRouter = express.Router();

// Create a new session
sessionRouter.post('/', createSession);

// Get all sessions
sessionRouter.get('/', getSessions);

// Get current active session
sessionRouter.get('/current', getCurrentSession);

export default sessionRouter;