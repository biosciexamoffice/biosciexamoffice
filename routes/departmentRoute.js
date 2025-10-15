import express from 'express';
import {
  createDepartment,
  deleteDepartment,
  listDepartments,
  updateDepartment,
} from '../controllers/collegeController.js';
import { authenticate, requireRoles } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.use(authenticate);

router.route('/').get(listDepartments).post(requireRoles('ADMIN'), createDepartment);
router.route('/:departmentId')
  .patch(requireRoles('ADMIN'), updateDepartment)
  .delete(requireRoles('ADMIN'), deleteDepartment);

export default router;
