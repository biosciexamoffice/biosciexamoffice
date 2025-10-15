import express from "express";

import {
    createResult,
    getAllResults,
    getResultById,
    updateResult,
    deleteResult,
  deleteAllResultsForCourse,
    deleteMultipleResults
  } from "../controllers/resultController.js";

  import { uploadResults } from '../controllers/uploadResultController.js';

import { upload } from '../controllers/uploadResultController.js';
import { authenticate } from '../middlewares/authMiddleware.js';
  

const resultRouter = express.Router();

resultRouter.use(authenticate);

resultRouter.post("/", createResult);
resultRouter.get("/", getAllResults);

// 🔁 Place before `/:id`
resultRouter.delete("/bulk", deleteMultipleResults); // ← move this up
resultRouter.delete("/course/:id", deleteAllResultsForCourse);

resultRouter.get("/:id", getResultById);
resultRouter.patch("/:id", updateResult);
resultRouter.delete("/:id", deleteResult); // ← dynamic route LAST

resultRouter.post('/upload-results', upload, uploadResults);


export default resultRouter
