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

        const regNoSet = new Set();
        rows.forEach((row) => {
          const reg = String(row.regNo || '').trim().toUpperCase();
          if (reg) regNoSet.add(reg);
        });
        const uniqueRegNos = Array.from(regNoSet);

        const students = uniqueRegNos.length
          ? await Student.find({ regNo: { $in: uniqueRegNos } }).select('_id regNo level')
          : [];
        const studentByReg = new Map(students.map((stu) => [String(stu.regNo).toUpperCase(), stu]));

        const perRowPayload = [];

        for (const row of rows) {
          const regNo = String(row.regNo || '').trim().toUpperCase();
          if (!regNo) {
            allFailedRecords.push({
              error: 'Missing registration number in row',
              rowData: row,
              fileName,
            });
            continue;
          }

          const student = studentByReg.get(regNo);
          if (!student) {
            allFailedRecords.push({
              error: `Student with registration number "${regNo}" not found.`,
              rowData: row,
              fileName,
            });
            continue;
          }
          if (!student.level) {
            allFailedRecords.push({
              error: `Student "${regNo}" has no level set on profile.`,
              rowData: row,
              fileName,
            });
            continue;
          }

          const parseScore = (value) => {
            if (value === undefined || value === null || value === '') return null;
            const parsed = Math.round(Number(value));
            return Number.isFinite(parsed) ? parsed : null;
          };

          const ca = parseScore(row.ca);
          const totalexam = parseScore(row.totalexam);

          if (ca !== null && (ca < 0 || ca > 30)) {
            allFailedRecords.push({
              error: `CA score ${row.ca} for ${regNo} must be between 0 and 30`,
              rowData: row,
              fileName,
            });
            continue;
          }
          if (totalexam !== null && (totalexam < 0 || totalexam > 70)) {
            allFailedRecords.push({
              error: `Exam score ${row.totalexam} for ${regNo} must be between 0 and 70`,
              rowData: row,
              fileName,
            });
            continue;
          }

          let grandtotal = null;
          if (ca !== null && totalexam !== null) {
            grandtotal = ca + totalexam;
          } else if (row.grandTotal != null && row.grandTotal !== '') {
            const parsedGrand = Math.round(Number(row.grandTotal));
            grandtotal = Number.isFinite(parsedGrand) ? parsedGrand : null;
          }
          if (grandtotal === null) grandtotal = 0;

          const grade = calculateGrade(grandtotal);

          perRowPayload.push({
            data: {
              student: student._id,
              course: course._id,
              lecturer: lecturer._id,
              session,
              semester,
              date,
              department,
              level: student.level,
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
              grade,
            },
            studentId: student._id,
            regNo,
          });
        }

        if (!perRowPayload.length) {
          continue;
        }

        const studentIds = perRowPayload.map((item) => item.studentId);
        const existing = await Result.find({
          student: { $in: studentIds },
          course: course._id,
          session,
          semester,
        }).select('student');

        const existingSet = new Set(existing.map((doc) => String(doc.student)));

        const duplicates = [];
        const toInsertData = [];
        perRowPayload.forEach((item) => {
          if (existingSet.has(String(item.studentId))) {
            duplicates.push(item.regNo);
          } else {
            toInsertData.push(item.data);
          }
        });

        let createdThisBatch = [];
        if (toInsertData.length) {
          createdThisBatch = await Result.insertMany(toInsertData, { ordered: false });
          allResults.push(...createdThisBatch);

          const passingStudents = toInsertData
            .filter((d) => d.grade !== 'F')
            .map((d) => d.student);
          const failingStudents = toInsertData
            .filter((d) => d.grade === 'F')
            .map((d) => d.student);

          if (passingStudents.length) {
            await PassFail.updateMany(
              { course: course._id },
              { $pull: { fail: { $in: passingStudents } } }
            );
          }

          await PassFail.findOneAndUpdate(
            { course: course._id, session, semester },
            {
              $addToSet: {
                pass: { $each: passingStudents },
                fail: { $each: failingStudents },
              },
            },
            { upsert: true, new: true }
          );
        }

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
