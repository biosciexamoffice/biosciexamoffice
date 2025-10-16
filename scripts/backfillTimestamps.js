import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import Course from '../models/course.js';
import Lecturer from '../models/lecturer.js';
import Result from '../models/result.js';
import StudentRegistration from '../models/studentResgistration.js';
import CourseRegistration from '../models/courseRegistration.js';
import ApprovedCourse from '../models/approvedCourses.js';
import Programme from '../models/programme.js';
import Department from '../models/department.js';
import College from '../models/college.js';
import StandingRecord from '../models/standingRecord.js';
import PassFailList from '../models/passFailList.js';
import Session from '../models/session.js';
import AcademicMetrics from '../models/academicMetrics.js';
import Student from '../models/student.js';
import User from '../models/user.js';

const MODELS = [
  { name: 'Course', model: Course },
  { name: 'Lecturer', model: Lecturer },
  { name: 'Result', model: Result },
  { name: 'StudentRegistration', model: StudentRegistration },
  { name: 'CourseRegistration', model: CourseRegistration },
  { name: 'ApprovedCourse', model: ApprovedCourse },
  { name: 'Programme', model: Programme },
  { name: 'Department', model: Department },
  { name: 'College', model: College },
  { name: 'StandingRecord', model: StandingRecord },
  { name: 'PassFailList', model: PassFailList },
  { name: 'Session', model: Session },
  { name: 'AcademicMetrics', model: AcademicMetrics },
  { name: 'Student', model: Student },
  { name: 'User', model: User },
];

const now = new Date();

const targetUri =
  process.env.MONGO_PRIMARY_URL ||
  process.env.MONGO_URL ||
  'mongodb://127.0.0.1:27017/examoffice';

async function run() {
  try {
    await mongoose.connect(targetUri, {
      serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 30000),
      connectTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS || 30000),
    });
    console.log(`Connected to MongoDB: ${targetUri}`);

    const summary = [];

    for (const { name, model } of MODELS) {
      const createdRes = await model.updateMany(
        { createdAt: { $exists: false } },
        { $set: { createdAt: now } }
      );
      const updatedRes = await model.updateMany(
        { updatedAt: { $exists: false } },
        { $set: { updatedAt: now } }
      );

      if (createdRes.modifiedCount || updatedRes.modifiedCount) {
        summary.push({
          collection: name,
          createdFilled: createdRes.modifiedCount || 0,
          updatedFilled: updatedRes.modifiedCount || 0,
        });
      }
    }

    if (summary.length) {
      console.table(summary);
    } else {
      console.log('All documents already have createdAt/updatedAt fields.');
    }
  } catch (error) {
    console.error('Backfill failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

run();
