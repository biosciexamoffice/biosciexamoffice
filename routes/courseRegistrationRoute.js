import express from 'express';
import multer from 'multer';
import { uploadCourseRegistrations,searchCourseRegistrations,       // (your existing detailed-by-course endpoint; optional)
  listRegistrationCourses,         // NEW: list courses with counts
  getRegistrationStudents,         // NEW: list students in a course
  deleteRegisteredStudent,
   moveRegisteredStudents,
} from '../controllers/courseRegistrationUpload.controller.js';
//import { uploadCourseRegistrations, searchCourseRegistrations } from '../controllers/uploadCourseRegistrations.js';

const courseRegistrationRouter = express.Router();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit per file
    files: 30 // Maximum 30 files
  },
  fileFilter: (req, file, cb) => {
    // Accept CSV files and various MIME types that CSV files might have
    const allowedMimes = [
      'text/csv',
      'application/csv',
      'text/plain',
      'application/vnd.ms-excel',
      'application/pdf'
    ];
    
    const lowerName = file.originalname.toLowerCase();
    if (
      allowedMimes.includes(file.mimetype) ||
      lowerName.endsWith('.csv') ||
      lowerName.endsWith('.pdf')
    ) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV or PDF files are allowed'), false);
    }
  }
});

/**
 * POST /registrations/upload
 * Form fields:
 *  - session: "2020/2021"
 *  - semester: "First" or "Second"
 * Files:
 *  - field name: "files" (multiple CSVs)
 */
courseRegistrationRouter.post(
  '/registrations/upload',
  (req, res, next) => {
    // Use multer to handle file uploads
    upload.array('files', 30)(req, res, (err) => {
      if (err) {
        console.log('Multer error:', err.message);
        return res.status(400).json({
          ok: false,
          message: err.message
        });
      }
      next();
    });
  },
  uploadCourseRegistrations
);

courseRegistrationRouter.get('/registrations/search', searchCourseRegistrations);
courseRegistrationRouter.get('/registrations/courses', listRegistrationCourses);
courseRegistrationRouter.get('/registrations/students', getRegistrationStudents);
courseRegistrationRouter.delete('/registrations/student', deleteRegisteredStudent);
courseRegistrationRouter.post('/registrations/move', moveRegisteredStudents);
export default courseRegistrationRouter;
