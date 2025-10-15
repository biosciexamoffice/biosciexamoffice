import express from 'express';
import { getPendingApprovals } from '../controllers/approvalController.js';
import { authenticate, requireRoles } from '../middlewares/authMiddleware.js';

const approvalRouter = express.Router();

approvalRouter.get(
  '/pending',
  authenticate,
  requireRoles('COLLEGE_OFFICER', 'HOD', 'DEAN', 'ADMIN'),
  getPendingApprovals
);

export default approvalRouter;
