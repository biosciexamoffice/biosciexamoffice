import express from 'express';
import {
  getComprehensiveResults,
  getMetrics,
  deleteMetrics,
  searchMetrics,
  updateMetrics,
  recomputeTermMetrics,
  computeStudentTermMetrics,
} from '../controllers/academicMetricsController.js';
import { uploadOldMetricsMulter, uploadOldMetrics } from '../controllers/uploadAcademicMetricsController.js';
import { authenticate, requireRoles } from '../middlewares/authMiddleware.js';

const academicMetricsRouter = express.Router();

// Exam officer / admin compute endpoints
academicMetricsRouter.get(
  '/comprehensive',
  authenticate,
  requireRoles('EXAM_OFFICER', 'ADMIN'),
  getComprehensiveResults
);
academicMetricsRouter.post(
  '/recompute',
  authenticate,
  requireRoles('EXAM_OFFICER', 'ADMIN'),
  recomputeTermMetrics
);
academicMetricsRouter.get(
  '/compute-student',
  authenticate,
  requireRoles('EXAM_OFFICER', 'ADMIN'),
  computeStudentTermMetrics
);
academicMetricsRouter.post(
  '/upload-old',
  authenticate,
  requireRoles('ADMIN'),
  uploadOldMetricsMulter,
  uploadOldMetrics
);
academicMetricsRouter.delete(
  '/:metricsId',
  authenticate,
  requireRoles('ADMIN'),
  deleteMetrics
);

// Shared read endpoints (any authenticated role)
academicMetricsRouter.get('/', authenticate, getMetrics);
academicMetricsRouter.get('/search', authenticate, searchMetrics);

// Approval updates
academicMetricsRouter.put(
  '/:metricsId',
  authenticate,
  requireRoles('EXAM_OFFICER', 'COLLEGE_OFFICER', 'HOD', 'DEAN', 'ADMIN'),
  updateMetrics
);

export default academicMetricsRouter;
