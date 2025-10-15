import multer from 'multer';
import csvParser from 'csv-parser';
import stream from 'stream';
import Student from '../models/student.js';
import {
  buildInstitutionLookups,
  resolveInstitutionByNames,
} from '../services/institutionService.js';
import { ensureUserCanAccessDepartment } from '../services/accessControl.js';

const storage = multer.memoryStorage();

export const upload = multer({ storage });

const validLevels = ['100', '200', '300', '400', '500'];

export const uploadStudents = async (req, res) => {
  const { level } = req.body;

  if (!req.file) {
    return res.status(400).json({ message: 'No CSV file uploaded' });
  }

  if (!level) {
    return res.status(400).json({ message: "Level Required" });
  }

  if (!validLevels.includes(level)) {
    return res.status(400).json({ message: "Level must be 100, 200, 300, 400, or 500" });
  }

  const rows = [];
  const bufferStream = new stream.PassThrough();
  bufferStream.end(req.file.buffer);

  try {
    await new Promise((resolve, reject) => {
      bufferStream
        .pipe(csvParser({
          separator: ',',
          mapHeaders: ({ header }) => header.trim(),
          mapValues: ({ value }) => value.trim(),
        }))
        .on('data', (data) => rows.push(data))
        .on('end', resolve)
        .on('error', reject);
    });

    if (rows.length === 0) {
      return res.status(400).json({ message: 'CSV file is empty or invalid' });
    }
     
    // Process rows with case-insensitive regNo checking
    const studentDocs = [];
    const validationErrors = [];
    const regNos = new Set(); // Track regNos for duplicates
    const lookups = await buildInstitutionLookups();

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      // Normalize regNo by trimming and converting to lowercase
      const regNo = row.regNo?.trim().toUpperCase();
      const surname = row.surname?.trim();
      const firstname = row.firstname?.trim();
      const middlename = row.middlename?.trim();
      const collegeValue = row.college?.trim() || row.collegeName?.trim() || row.collegeCode?.trim();
      const departmentValue =
        row.department?.trim() || row.departmentName?.trim() || row.departmentCode?.trim();
      const programmeValue = row.programme?.trim() || row.programmeName?.trim();
      const degreeTypeValue = row.degreeType?.trim() || row.programmeType?.trim() || '';
      
      if (!regNo || !surname || !firstname) {
        validationErrors.push({
          line: index + 1,
          regNo: regNo || 'N/A',
          error: 'Missing Required Field(s)',
          rowData: row
        });
        continue;
      }

      if (!collegeValue || !departmentValue || !programmeValue) {
        validationErrors.push({
          line: index + 1,
          regNo,
          error: 'College, department, and programme are required for each row.',
          rowData: row,
        });
        continue;
      }

      // Check for duplicates within the CSV
      if (regNos.has(regNo)) {
        validationErrors.push({
          line: index + 1,
          regNo,
          error: 'Duplicate regNo within CSV file'
        });
        continue;
      }

      let institution;
      try {
        institution = await resolveInstitutionByNames(
          {
            collegeNameOrCode: collegeValue,
            departmentNameOrCode: departmentValue,
            programmeName: programmeValue,
            degreeType: degreeTypeValue,
          },
          lookups,
        );
      } catch (err) {
        validationErrors.push({
          line: index + 1,
          regNo,
          error: err.message || 'Invalid institution details provided.',
          rowData: row,
        });
        continue;
      }

      try {
        ensureUserCanAccessDepartment(req.user, institution.department._id, institution.college._id);
      } catch (err) {
        validationErrors.push({
          line: index + 1,
          regNo,
          error: err.message || 'You are not authorized to manage the specified department.',
          rowData: row,
        });
        continue;
      }

      regNos.add(regNo);

      studentDocs.push({
        surname,
        firstname,
        middlename,
        regNo,
        level,
        college: institution.college._id,
        department: institution.department._id,
        programme: institution.programme._id,
      });
    }

    

    if (validationErrors.length > 0) {
      return res.status(400).json({
        message: 'CSV validation failed',
        validationErrors,
        stats: {
          total: rows.length,
          failed: validationErrors.length
        }
      });
    }

    let successfulRecords = [];
    let failedRecords = [];

    try {
    
  const result = await Student.insertMany(studentDocs);
  successfulRecords = result; // This now contains all successfully inserted docs
} catch (e) {
  if (e.writeErrors || e.insertedDocs) {
    // Handle partial success case
    successfulRecords = e.insertedDocs
      ? await Student.find({ _id: { $in: e.insertedDocs } })
      : [];
    
    const successfulRegNos = new Set(successfulRecords.map(doc => doc.regNo));

    failedRecords = studentDocs
      .filter(doc => !successfulRegNos.has(doc.regNo))
      .map(doc => {
        const writeError = e.writeErrors?.find(err => 
          err.err.op.regNo.toUpperCase() === doc.regNo.toUpperCase()
        );
        
        return {
          regNo: doc.regNo,
          error: writeError?.err.code === 11000 
            ? `Duplicate registration number: ${doc.regNo}`
            : writeError?.err.errmsg || 'Database validation error'
        };
      });
  } else {
    // Complete failure case
    failedRecords = studentDocs.map(doc => ({
      regNo: doc.regNo,
      error: e.message
    }));
    return res.status(400).json({ 
      message: 'Error processing students', 
      error: e.message,
      failed: failedRecords
    });
  }
}

// Calculate actual counts
const successCount = successfulRecords.length;
const failureCount = failedRecords.length;

res.status(201).json({
  message: 'CSV processed.',
  stats: {
    total: rows.length,
    success: successCount,
    failed: failureCount,
  },
  failed: failedRecords,
});


  } catch (error) {
    console.error('CSV processing error:', error);
    res.status(500).json({ 
      message: 'Error processing CSV file', 
      error: error.message 
    });
  }
};
