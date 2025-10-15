import express from 'express';
import { authenticate, requireRoles } from '../middlewares/authMiddleware.js';
import { listProgrammes, createProgramme } from '../controllers/programmeController.js';

const router = express.Router();

router.use(authenticate);

router.get('/', listProgrammes);
router.post('/', requireRoles('ADMIN'), createProgramme);

export default router;
