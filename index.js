import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import mongoose from 'mongoose';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import passport from 'passport';
import helmet from 'helmet';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { upload } from './controllers/uploadCourseController.js'; // Import your multer config

import connectDB, { getDbMode, isReadOnlyMode } from "./config/mongoDB.js";
import configurePassport from './config/passport.js';
import studentRoute from "./routes/studentRoute.js";
import courseRouter from "./routes/courseRoute.js";
import lecturerController from "./routes/lectureRoute.js";
import collegeRouter from './routes/collegeRoute.js';
import departmentRouter from './routes/departmentRoute.js';
import resultRouter from "./routes/resultRoute.js";
import academicMetricsRouter from './routes/academicMetricsRoute.js'
import approvedCoursesrouter from './routes/approvedCoursesRoute.js'
import resultsExportRouter from './routes/resultsExport.routes.js';
import sessionRouter from './routes/sessionRoute.js';
import graduationRouter from './routes/graduationRoutes.js';
import courseRegistrationRouter from './routes/courseRegistrationRoute.js';
import registrationFormsRouter from './routes/registrationForms.js';
import authRouter from './routes/authRoute.js';
import approvalRouter from './routes/approvalRoute.js';
import programmeRouter from './routes/programmeRoute.js';
import syncRouter from './routes/syncRoute.js';
import { backfillStudentInstitution } from './utils/studentBackfill.js';
import { backfillCourseInstitution } from './utils/courseBackfill.js';
import { backfillApprovedCoursesInstitution } from './utils/approvedCoursesBackfill.js';
import { backfillCourseRegistrationInstitution } from './utils/courseRegistrationBackfill.js';
import readOnlyGuard from './middlewares/readOnlyGuard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const app = express();

// Enhanced body parsing
app.use(express.json({ limit: '10mb' })); // Add reasonable JSON limit
app.use(express.urlencoded({ extended: true, limit: '10mb' })); // For form data

// CORS Configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175'
  // Add production URL when needed
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Content-Disposition'] // Added for file downloads
}));

// Security Headers
app.use(helmet());

// Apply more specific CSP if needed
app.use(helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'"],
    // Add other directives as needed
  }
}));

// Session configuration
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: process.env.MONGO_SESSION_URL || process.env.MONGO_PRIMARY_URL || process.env.MONGO_URL,
      collectionName: 'sessions',
      ttl: 24 * 60 * 60 // 24 hours
    }),
    cookie: {
      maxAge: 1000 * 60 * 60 * 24, // 24 hours
      secure: process.env.NODE_ENV === 'production', // Auto-adjust based on environment
      httpOnly: true,
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
    }
  })
);

// Initialize passport
configurePassport(passport);
app.use(passport.initialize());
app.use(passport.session());

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Database Connection
connectDB();

// Lightweight environment probe
app.get('/api/env', (_req, res) => {
  res.json({
    mode: getDbMode(),
    readOnly: isReadOnlyMode(),
  });
});

// Apply read-only guard after lightweight routes/health checks
app.use(readOnlyGuard);

// Routes
app.get('/', (req, res) => res.json({ status: "healthy" }));
app.use('/api/students', studentRoute);
app.use('/api/courses', courseRouter);
app.use('/api/departments', departmentRouter);
app.use('/api/colleges', collegeRouter);
app.use('/api/lecturers', lecturerController);
app.use('/api/results', resultRouter);
app.use('/api/academic-metrics', academicMetricsRouter)
app.use('/api/approvedCourses', approvedCoursesrouter)
app.use('/api/results-export', resultsExportRouter);
app.use('/api/sessions', sessionRouter);
app.use('/api/graduation', graduationRouter);
app.use('/api/course-registration', courseRegistrationRouter);
app.use('/api/programmes', programmeRouter);
app.use('/api/registration-forms', registrationFormsRouter);
app.use('/api/auth', authRouter);
app.use('/api/approvals', approvalRouter);
app.use('/api/sync', syncRouter);

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not Found'
  });
});

// Error handling Middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  
  // Special handling for Multer errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      error: 'File too large. Maximum size is 10MB'
    });
  }
  
  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,
      error: 'File upload error: ' + err.message
    });
  }

  const status = err.statusCode || 500;
  res.status(status).json({
    success: false, 
    error: err.message || 'Internal Server Error'
  });
});

// Start Server
mongoose.connection.once('open', async () => {
  if (String(process.env.RUN_BACKFILL || '').toLowerCase() === 'true') {
    try {
      const updated = await backfillStudentInstitution();
      if (updated > 0) {
        console.log(`Backfilled ${updated} student record(s) with default institution data.`);
      }
      const coursesUpdated = await backfillCourseInstitution();
      if (coursesUpdated > 0) {
        console.log(`Backfilled ${coursesUpdated} course record(s) with default institution data.`);
      }
      const approvedUpdated = await backfillApprovedCoursesInstitution();
      if (approvedUpdated > 0) {
        console.log(`Backfilled ${approvedUpdated} approved course document(s) with default institution data.`);
      }
      const registrationsUpdated = await backfillCourseRegistrationInstitution();
      if (registrationsUpdated > 0) {
        console.log(`Backfilled ${registrationsUpdated} course registration document(s) with default institution data.`);
      }
    } catch (err) {
      console.error('Failed to backfill institution data:', err);
    }
  }

  app.listen(PORT, () =>
    console.log(`Server running on port ${PORT} in ${process.env.NODE_ENV || 'development'}`)
  );
});
