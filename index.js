import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import mongoose from 'mongoose';
import session from 'express-session'; // Added missing import
import MongoStore from 'connect-mongo';
import passport from 'passport';
import helmet from 'helmet';
import cors from 'cors';


import connectDB from "./config/mongoDB.js";
import studentRoute from "./routes/studentRoute.js";
import courseRouter from "./routes/courseRoute.js";
import lecturerController from "./routes/lectureRoute.js";
import resultRouter from "./routes/resultRoute.js";


const PORT = process.env.PORT || 3000;
const app = express();

app.use(express.json());
const allowedOrigins = process.env.ALLOWED_ORIGINS.split(',') || [
'http://localhost:5173'
  //Add production URL when needed: 'https://your-production-domain.com'
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
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));


app.use(helmet());

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
      secure: false, // Set to true in production && false in dev
      httpOnly: true, // Prevent client-side JS access
      sameSite:'lax' // Use 'none' in production with secure: true && lax in dev
    }
  })
);

connectDB();

app.get('/', (req, res)=>res.json({staus: "healthy"}))
app.use('/api/students', studentRoute)
app.use('/api/courses', courseRouter)
app.use('/api/lecturers', lecturerController)
app.use('/api/results', resultRouter)

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not Found'
  });
});

// Error handling Middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false, 
    error: err.message || 'Internal Server Error' // Show actual error message
  });
});

// Start Server after DB Connection
mongoose.connection.once('open', () => {
  app.listen(PORT, () => 
    console.log(`Server running on port ${PORT} in ${process.env.NODE_ENV || 'development'}`)
  );
});
