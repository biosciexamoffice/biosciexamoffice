import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import {
  getAllStudent,
  CreateStudent,
  getStudentById,
  updateStudent,
  deleteStudent,
  searchStudentByRegNo,
  updateStudentStanding,
  updateStudentPassport,
  deleteStudentPassport,
  listStandingRecords,
} from "../controllers/studentController.js";
import { uploadStudents, upload } from "../controllers/uploadStudentController.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const standingUploadsDir = path.resolve(__dirname, "..", "uploads", "student-standing");

if (!fs.existsSync(standingUploadsDir)) {
  fs.mkdirSync(standingUploadsDir, { recursive: true });
}

const standingStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, standingUploadsDir),
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const safeName = file.originalname.replace(/\s+/g, "_").replace(/[^\w.-]/g, "");
    cb(null, `${uniqueSuffix}-${safeName}`);
  },
});

const standingUpload = multer({
  storage: standingStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      const error = new Error("Only PDF files are allowed");
      error.statusCode = 400;
      return cb(error);
    }
    cb(null, true);
  },
});

const passportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!["image/jpeg", "image/png", "image/jpg", "image/webp"].includes(file.mimetype)) {
      const error = new Error("Only JPG, PNG or WEBP images are allowed");
      error.statusCode = 400;
      return cb(error);
    }
    cb(null, true);
  },
});

const studentRoute = express.Router();

studentRoute.post("/", CreateStudent);
studentRoute.get("/", getAllStudent);
studentRoute.get("/search", searchStudentByRegNo);
studentRoute.get("/standing-records", listStandingRecords);
studentRoute.get("/:id", getStudentById);
studentRoute.patch("/:id", updateStudent);
studentRoute.patch("/:id/standing", standingUpload.single("evidence"), updateStudentStanding);
studentRoute.patch("/:id/passport", passportUpload.single("passport"), updateStudentPassport);
studentRoute.delete("/:id/passport", deleteStudentPassport);
studentRoute.delete("/:id", deleteStudent);
studentRoute.post("/upload", upload.single("csvFile"), uploadStudents);

export default studentRoute;
