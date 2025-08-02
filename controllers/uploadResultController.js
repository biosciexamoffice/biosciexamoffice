import multer from 'multer';
import csvParser from 'csv-parser';
import stream from 'stream';
import Student from "../models/student.js";
import Course from "../models/course.js";
import Lecturer from "../models/lecturer.js";
import Result from "../models/result.js";
import PassFail from "../models/passFailList.js";

function calculateGrade(score) {
  if (typeof score !== 'number') return 'F';
  if (score >= 70) return 'A';
  if (score >= 60) return 'B';
  if (score >= 50) return 'C';
  if (score >= 45) return 'D';
  if (score >= 40) return 'E';
  return 'F';
}

const storage = multer.memoryStorage();
export const upload = multer({ storage });

export const uploadResults = async (req, res) => {
  try {
    const { courseCode, lecturerStaffId, session, semester, date, department, level } = req.body;
    console.log(courseCode, lecturerStaffId, session, semester, date, department, level )
    if (!req.file) {
      return res.status(400).json({ message: 'No CSV file uploaded' });
    }
    if (!courseCode || !lecturerStaffId || !session || !semester || !date || !department || !level) {
      return res.status(400).json({ 
        message: 'Course, Lecturer, Session, Semester, Department, level, and Date are required.' 
      });
    }
    
    const buffer = req.file.buffer;
    const results = [];
    const bufferStream = new stream.PassThrough();
    bufferStream.end(buffer);

    // Parse CSV
    await new Promise((resolve, reject) => {
      bufferStream
        .pipe(csvParser({
          separator: ',',
          mapHeaders: ({ header }) => header.trim(),
          mapValues: ({ value }) => value.trim(),
        }))
        .on('data', (data) => results.push(data))
        .on('end', resolve)
        .on('error', reject);
    });

    // Fetch course and lecturer
    const course = await Course.findOne({ code: courseCode });
    const lecturer = await Lecturer.findOne({ pfNo: lecturerStaffId });

    if (!course) {
      return res.status(404).json({ message: `Course with code "${courseCode}" not found.` });
    }
    if (!lecturer) {
      return res.status(404).json({ message: `Lecturer with staff ID "${lecturerStaffId}" not found.` });
    }

    // Process data with error tracking
    const processingResults = await Promise.allSettled(results.map(async (row) => {
      try {
        const student = await Student.findOne({ regNo: row.regNo });
        if (!student) {
          throw new Error(`Student with registration number "${row.regNo}" not found.`);
        }

        const ca = row.ca ? Math.round(Number(row.ca)) : null;
        const totalexam = row.totalexam ? Math.round(Number(row.totalexam)) : null;

        // Validate scores
        if (ca !== null && ca > 30) {
          throw new Error(`CA score: ${ca} for ${row.regNo} cannot be greater than 30`);
        }
        if (totalexam !== null && totalexam > 70) {
          throw new Error(`Exam score: ${totalexam} for ${row.regNo} cannot exceed 70`);
        }

        // Calculate grandtotal and grade
        const grandtotal = row.grandTotal 
          ? Math.round(Number(row.grandTotal)) 
          : (totalexam || 0) + (ca || 0);
        const grade = calculateGrade(grandtotal);

        return {
          data: {
            student: student._id,
            course: course._id,
            lecturer: lecturer._id,
            session,
            semester,
            date,
            department,
            level,
            ...(row.q1 && { q1: Number(row.q1) }),
            ...(row.q2 && { q2: Number(row.q2) }),
            ...(row.q3 && { q3: Number(row.q3) }),
            ...(row.q4 && { q4: Number(row.q4) }),
            ...(row.q5 && { q5: Number(row.q5) }),
            ...(row.q6 && { q6: Number(row.q6) }),
            ...(row.q7 && { q7: Number(row.q7) }),
            ...(row.q8 && { q8: Number(row.q8) }),
            ...(totalexam !== null && { totalexam }),
            ...(ca !== null && { ca }),
            grandtotal,
            grade
          },
          studentId: student._id,
          passed: grade !== 'F',
          row,
          success: true
        };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          row
        };
      }
    }));

    // Separate successful and failed records
    const successfulRecords = processingResults
      .filter(result => result.status === 'fulfilled' && result.value.success)
      .map(result => result.value);

    const failedRecords = processingResults
      .filter(result => result.status === 'rejected' || !result.value?.success)
      .map(result => ({
        error: result.value?.error || 'Unknown error',
        rowData: result.value?.row || {},
      }));

    // Insert results and update PassFail records
    let createdResults = [];
    if (successfulRecords.length > 0) {
      // 1. Insert all results first
      createdResults = await Result.insertMany(
        successfulRecords.map(r => r.data)
      );

      // 2. Group students by pass/fail status
      const passingStudents = successfulRecords
        .filter(r => r.passed)
        .map(r => r.studentId);
      
      const failingStudents = successfulRecords
        .filter(r => !r.passed)
        .map(r => r.studentId);

      // 3. Update PassFail record for this course
     const response = await PassFail.findOneAndUpdate(
        {
          course: course._id,
          session,
          semester
        },
        {
          $addToSet: {
            pass: { $each: passingStudents },
            fail: { $each: failingStudents }
          }
        },
        { upsert: true, new: true }
      );
      console.log(response)
    }

    res.status(201).json({
      message: 'CSV processed with partial success',
      stats: {
        total: results.length,
        success: successfulRecords.length,
        failed: failedRecords.length
      },
      created: createdResults,
      failed: failedRecords.map(f => ({
        error: f.error,
        studentRegNo: f.rowData?.regNo || 'N/A',
      }))
    });

  } catch (error) {
    console.error('CSV processing error:', error);
    res.status(500).json({
      message: 'Error processing CSV',
      error: error.message
    });
  }
};