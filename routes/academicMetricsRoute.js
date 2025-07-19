import express from 'express';
import {
  
  getComprehensiveResults,
  getMetrics,
  deleteMetrics,
  searchMetrics
} from '../controllers/academicMetricsController.js';

const academicMetricsRouter = express.Router();

// Get or create metrics for a student
academicMetricsRouter.get('/comprehensive', getComprehensiveResults);
academicMetricsRouter.get('/', getMetrics);
academicMetricsRouter.delete('/:metricsId', deleteMetrics)
academicMetricsRouter.get('/search', searchMetrics);

export default academicMetricsRouter;