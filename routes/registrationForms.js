// routes/registrationForms.js
import express from "express";
import { generateRegistrationData } from "../controllers/registrationForms.js";
import { authenticate, requireRoles } from "../middlewares/authMiddleware.js";

const registrationFormsRouter = express.Router();

registrationFormsRouter.use(authenticate);

// POST /api/registration-forms
registrationFormsRouter.post(
  "/",
  requireRoles("EXAM_OFFICER", "HOD", "COLLEGE_OFFICER", "DEAN", "ADMIN"),
  generateRegistrationData
);

export default registrationFormsRouter;
