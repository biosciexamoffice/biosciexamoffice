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
import { upload } from './controllers/uploadCourseController.js'; // Import your multer config

import connectDB from "./config/mongoDB.js";
import studentRoute from "./routes/studentRoute.js";
import courseRouter from "./routes/courseRoute.js";
import lecturerController from "./routes/lectureRoute.js";
import resultRouter from "./routes/resultRoute.js";
import academicMetricsRouter from './routes/academicMetricsRoute.js'
import approvedCoursesrouter from '././routes/approvedCoursesRoute.js'

const PORT = process.env.PORT || 3000;
const app = express();

// Enhanced body parsing
app.use(express.json({ limit: '10mb' })); // Add reasonable JSON limit
app.use(express.urlencoded({ extended: true, limit: '10mb' })); // For form data

// CORS Configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
  'http://localhost:5173'
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
      mongoUrl: process.env.MONGO_URL,
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
app.use(passport.initialize());
app.use(passport.session());

// Database Connection
connectDB();

// Routes
app.get('/', (req, res) => res.json({ status: "healthy" }));
app.use('/api/students', studentRoute);
app.use('/api/courses', courseRouter);
app.use('/api/lecturers', lecturerController);
app.use('/api/results', resultRouter);
app.use('/api/academic-metrics', academicMetricsRouter)
app.use('/api/approvedCourses', approvedCoursesrouter )

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

  res.status(500).json({
    success: false, 
    error: err.message || 'Internal Server Error'
  });
});

// Start Server
mongoose.connection.once('open', () => {
  app.listen(PORT, () => 
    console.log(`Server running on port ${PORT} in ${process.env.NODE_ENV || 'development'}`)
  );
});