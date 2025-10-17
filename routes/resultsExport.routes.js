// routes/resultsExportRouter.js
import express from 'express';
import {
  listForExport,
  exportHealth
} from '../controllers/resultsExport.controller.js';
import { authenticate, requireRoles } from '../middlewares/authMiddleware.js';

const resultsExportRouter = express.Router();

resultsExportRouter.use(authenticate);
resultsExportRouter.use(requireRoles('ADMIN', 'EXAM_OFFICER', 'COLLEGE_OFFICER', 'HOD', 'DEAN'));

// List results for CSV export (only rows with valid uamId)
resultsExportRouter.get('/', listForExport);

// Health check for missing uamId in related courses
resultsExportRouter.get('/health', exportHealth);

export default resultsExportRouter;
