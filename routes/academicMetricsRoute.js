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


const academicMetricsRouter = express.Router();

// Get or create metrics for a student
academicMetricsRouter.get('/comprehensive', getComprehensiveResults);
academicMetricsRouter.get('/', getMetrics);
academicMetricsRouter.delete('/:metricsId', deleteMetrics)
academicMetricsRouter.get('/search', searchMetrics);
academicMetricsRouter.put('/:metricsId', updateMetrics);
academicMetricsRouter.post('/recompute', recomputeTermMetrics);
academicMetricsRouter.get('/compute-student', computeStudentTermMetrics);
academicMetricsRouter.post('/upload-old', uploadOldMetricsMulter, uploadOldMetrics);

export default academicMetricsRouter;