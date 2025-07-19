import express from "express";

import {
    createResult,
    getAllResults,
    getResultById,
    updateResult,
    deleteResult,
    deleteAllResultsForCourse
  } from "../controllers/resultController.js";

  import { uploadResults } from '../controllers/uploadResultController.js';

import { upload } from '../controllers/uploadResultController.js';
  

const resultRouter = express.Router();

resultRouter.post("/", createResult);
resultRouter.get("/", getAllResults);
resultRouter.get("/:id", getResultById);
resultRouter.patch("/:id", updateResult);
resultRouter.delete("/:id", deleteResult);
resultRouter.delete("/course/:id", deleteAllResultsForCourse)
resultRouter.post('/upload', upload.single('csvFile'), uploadResults);

export default resultRouter;