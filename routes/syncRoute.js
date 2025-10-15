import express from 'express';
import { authenticate, requireRoles } from '../middlewares/authMiddleware.js';
import { pullFromAtlas, pushToAtlas } from '../controllers/syncController.js';

const syncRouter = express.Router();

syncRouter.use(authenticate);
syncRouter.use(requireRoles('ADMIN', 'EXAM_OFFICER', 'COLLEGE_OFFICER', 'HOD', 'DEAN'));

syncRouter.post('/pull', pullFromAtlas);
syncRouter.post('/push', pushToAtlas);

export default syncRouter;
