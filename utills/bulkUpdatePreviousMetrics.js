import fs from 'fs';
import csv from 'csv-parser';
import mongoose from 'mongoose';
import Student from '../models/student.js';
import AcademicMetrics from '../models/academicMetrics.js'; 

// --- Configuration ---
const CSV_FILE_PATH = './Titled_Student_Records_400L_First_Semester.csv'; // Path to your CSV file

const bulkUpdatePreviousMetrics = async () => {
  try {
    // Connect directly to MongoDB using the known working connection string
    await mongoose.connect("mongodb://localhost:27017/exam-office");
    console.log('MongoDB Connected');

    const results = await new Promise((resolve, reject) => {
      const data = [];
      fs.createReadStream(CSV_FILE_PATH)
        .pipe(csv({ mapHeaders: ({ header }) => header.trim() }))
        .on('data', (row) => data.push(row))
        .on('end', () => resolve(data))
        .on('error', (error) => reject(error));
    });

    console.log(`Processing ${results.length} records from CSV...`);

    for (const row of results) {
      const { regNo, session, semester, level, CCC, CCE, CPE, CGPA, TCC, TCE, TPE, GPA, PrevCCC, PrevCCE, PrevCPE, PrevCGPA } = row;

      if (!regNo || !session || !semester || !level) {
        console.warn('Skipping row with missing required data:', row);
        continue;
      }

      const student = await Student.findOne({ regNo });
      if (!student) {
        console.warn(`Student with regNo ${regNo} not found.`);
        continue;
      }

      await AcademicMetrics.findOneAndUpdate(
        { student: student._id, session, semester, level },
        {
          $set: {
            'previousMetrics.CCC': Number(PrevCCC) || 0,
            'previousMetrics.CCE': Number(PrevCCE) || 0,
            'previousMetrics.CPE': Number(PrevCPE) || 0,
            'previousMetrics.CGPA': Number(PrevCGPA) || 0,
            'CCC': Number(CCC) || 0,
            'CCE': Number(CCE) || 0,
            'CPE': Number(CPE) || 0,
            'CGPA': Number(CGPA) || 0,
            'TCC': Number(TCC) || 0,
            'TCE': Number(TCE) || 0,
            'TPE': Number(TPE) || 0,
            'GPA': Number(GPA) || 0,
          },
        },
        { new: true, upsert: true } // Upsert will create the document if it doesn't exist
      );

      console.log(`Updated metrics for ${regNo} in ${session} ${semester} semester.`);
    }

    console.log('Bulk update complete.');
  } catch (error) {
    console.error('Error during bulk update:', error);
    process.exit(1);
  } finally {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
      console.log('MongoDB connection closed.');
    }
  }
};

bulkUpdatePreviousMetrics();
