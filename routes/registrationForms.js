// routes/registrationForms.js
import express from "express";
import { generateRegistrationData } from "../controllers/registrationForms.js";

const registrationFormsRouter = express.Router();

// POST /api/registration-forms
registrationFormsRouter.post("/", generateRegistrationData);

export default registrationFormsRouter;
