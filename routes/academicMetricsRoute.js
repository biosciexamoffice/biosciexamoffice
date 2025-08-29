import express from 'express';
import {
  
  getComprehensiveResults,
  getMetrics,
  deleteMetrics,
  searchMetrics,
  updateMetrics
} from '../controllers/academicMetricsController.js';

const academicMetricsRouter = express.Router();

// Get or create metrics for a student
academicMetricsRouter.get('/comprehensive', getComprehensiveResults);
academicMetricsRouter.get('/', getMetrics);
academicMetricsRouter.delete('/:metricsId', deleteMetrics)
academicMetricsRouter.get('/search', searchMetrics);
academicMetricsRouter.put('/:metricsId', updateMetrics);

export default academicMetricsRouter;