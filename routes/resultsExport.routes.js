// routes/resultsExportRouter.js
import express from 'express';
import {
  listForExport,
  exportHealth
} from '../controllers/resultsExport.controller.js';

const resultsExportRouter = express.Router();

// List results for CSV export (only rows with valid uamId)
resultsExportRouter.get('/', listForExport);

// Health check for missing uamId in related courses
resultsExportRouter.get('/health', exportHealth);

export default resultsExportRouter;
