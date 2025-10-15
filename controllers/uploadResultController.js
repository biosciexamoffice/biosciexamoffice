import multer from 'multer';
import csvParser from 'csv-parser';
import stream from 'stream';
import Student from "../models/student.js";
import Course from "../models/course.js";
import Lecturer from "../models/lecturer.js";
import Result from "../models/result.js";
import PassFail from "../models/passFailList.js";
import { ensureUserCanAccessDepartment } from '../services/accessControl.js';

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
export const upload = multer({ 
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.match(/\.(csv)$/)) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed!'), false);
    }
  },
  limits: {
    files: 20,
    fileSize: 5 * 1024 * 1024
  }
}).array('csvFiles');

export const uploadResults = async (req, res) => {
  try {
    const { lecturerStaffId, session, semester, date, department, resultType } = req.body;
    // NOTE: level is intentionally NOT read from body anymore

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: 'No CSV files uploaded' });
    }
    
    if (!lecturerStaffId || !session || !semester || !date || !department || !resultType) {
      return res.status(400).json({ 
        message: 'Lecturer, Session, Semester, Department, Result Type, and Date are required.' 
      });
    }

    const lecturer = await Lecturer.findOne({ pfNo: lecturerStaffId });
    if (!lecturer) {
      return res.status(404).json({ message: `Lecturer with staff ID "${lecturerStaffId}" not found.` });
    }

    const allResults = [];
    const allFailedRecords = [];

    for (const file of req.files) {
      try {
        const fileName = file.originalname;
        const courseCode = fileName.split('.')[0].toUpperCase();
        
        const buffer = file.buffer;
        const bufferStream = new stream.PassThrough();
        bufferStream.end(buffer);

        const rows = [];
        await new Promise((resolve, reject) => {
          bufferStream
            .pipe(csvParser({
              separator: ',',
              mapHeaders: ({ header }) => header.trim(),
              mapValues: ({ value }) => (typeof value === 'string' ? value.trim() : value),
            }))
            .on('data', row => rows.push(row))
            .on('end', resolve)
            .on('error', reject);
        });

        const course = await Course.findOne({ code: courseCode })
          .select('_id code title department college programme programmeType');
        if (!course) {
          allFailedRecords.push(...rows.map(row => ({
            error: `Course with code "${courseCode}" not found.`,
            rowData: row,
            fileName
          })));
          continue;
        }

        ensureUserCanAccessDepartment(req.user, course.department, course.college);

        const processingResults = await Promise.allSettled(
          rows.map(async row => {
            try {
              const student = await Student.findOne({ regNo: row.regNo });
              if (!student) {
                throw new Error(`Student with registration number "${row.regNo}" not found.`);
              }
              if (!student.level) {
                throw new Error(`Student "${row.regNo}" has no level set on profile.`);
              }

              const ca = row.ca ? Math.round(Number(row.ca)) : null;
              const totalexam = row.totalexam ? Math.round(Number(row.totalexam)) : null;

              if (ca !== null && (isNaN(ca) || ca < 0 || ca > 30)) {
                throw new Error(`CA score ${row.ca} for ${row.regNo} must be between 0 and 30`);
              }
              if (totalexam !== null && (isNaN(totalexam) || totalexam < 0 || totalexam > 70)) {
                throw new Error(`Exam score ${row.totalexam} for ${row.regNo} must be between 0 and 70`);
              }

              let grandtotal;
              if (row.ca != null && row.totalexam != null) {
                grandtotal = Math.round(Number(row.ca) + Number(row.totalexam));
              } else if (row.grandTotal != null) {
                grandtotal = Math.round(Number(row.grandTotal));
              } else {
                grandtotal = 0; // fallback if nothing is provided
              }
              
              const grade = calculateGrade(grandtotal);

              return {
                success: true,
                data: {
                  student: student._id,
                  course: course._id,
                  lecturer: lecturer._id,
                  session,
                  semester,
                  date,
                  department,
                  level: student.level, // ← derive from student record
                  resultType,
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
                row
              };
            } catch (error) {
              return {
                success: false,
                error: error.message,
                row,
                fileName
              };
            }
          })
        );

        const successfulRecords = processingResults
          .filter(r => r.status === 'fulfilled' && r.value.success)
          .map(r => r.value);
        const failedRecords = processingResults
          .filter(r => r.status === 'fulfilled' && !r.value.success)
          .map(r => ({
            error: r.value.error,
            rowData: r.value.row,
            fileName
          }));

        const duplicates = [];
        const toInsertData = [];
        for (const rec of successfulRecords) {
          const exists = await Result.findOne({
            student: rec.studentId,
            course: course._id,
            session,
            semester
          });
          if (exists) {
            duplicates.push(rec.row.regNo);
          } else {
            toInsertData.push(rec.data);
          }
        }

        // ——— Persist results + update Pass/Fail from this batch ———
        let createdThisBatch = [];
        if (toInsertData.length) {
          createdThisBatch = await Result.insertMany(toInsertData);
          allResults.push(...createdThisBatch);

          const passingStudents = toInsertData
            .filter(d => d.grade !== 'F')
            .map(d => d.student);
          const failingStudents = toInsertData
            .filter(d => d.grade === 'F')
            .map(d => d.student);

          // Remove passing students from ALL fail lists for this course
          if (passingStudents.length) {
            await PassFail.updateMany(
              { course: course._id },
              { $pull: { fail: { $in: passingStudents } } }
            );
          }

          // Update current session/semester pass/fail lists
          await PassFail.findOneAndUpdate(
            { course: course._id, session, semester },
            {
              $addToSet: {
                pass: { $each: passingStudents },
                fail: { $each: failingStudents }
              }
            },
            { upsert: true, new: true }
          );
        }

        allFailedRecords.push(...failedRecords);
        if (duplicates.length) {
          allFailedRecords.push({
            error: `Duplicate result detected for regNos: ${duplicates.join(', ')}`,
            studentRegNos: duplicates,
            fileName
          });
        }

      } catch (fileError) {
        console.error(`Error processing file ${file.originalname}:`, fileError);
        allFailedRecords.push({
          error: `File processing error: ${fileError.message}`,
          fileName: file.originalname
        });
      }
    }

    const totalProcessed = allResults.length + allFailedRecords.length;
    res.status(201).json({
      message: 'CSV files processed with partial success',
      stats: {
        total: totalProcessed,
        success: allResults.length,
        failed: allFailedRecords.length
      },
      created: allResults,
      failed: allFailedRecords.map(f => ({
        error: f.error,
        studentRegNo: f.studentRegNos
          ? f.studentRegNos.join(', ')
          : (f.rowData?.regNo || 'N/A'),
        fileName: f.fileName
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
