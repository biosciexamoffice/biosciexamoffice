import express from 'express';
import {
  listColleges,
  createCollege,
  updateCollege,
  deleteCollege,
} from '../controllers/collegeController.js';
import { authenticate, requireRoles } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.use(authenticate);

// College routes
router.route('/')
  .get(listColleges)
  .post(requireRoles('ADMIN'), createCollege);

router.route('/:collegeId')
  .patch(requireRoles('ADMIN'), updateCollege)
  .delete(requireRoles('ADMIN'), deleteCollege);

export default router;
