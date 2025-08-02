import multer from 'multer';
import csvParser from 'csv-parser';
import stream from 'stream';
import Student from '../models/student.js';



const storage = multer.memoryStorage();

export const upload = multer({ storage });

const validLevels = ['100', '200', '300', '400']

export const uploadStudents = async (req, res) => {
  const { level } = req.body;

  if (!req.file) {
    return res.status(400).json({ message: 'No CSV file uploaded' });
  }

  if (!level) {
    return res.status(400).json({ message: "Level Required" });
  }

  if (!validLevels.includes(level)) {
    return res.status(400).json({ message: "Level must be 100, 200, 300, 400" });
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

    rows.forEach((row, index) => {
      // Normalize regNo by trimming and converting to lowercase
      const regNo = row.regNo?.trim().toUpperCase();
      
      if (!regNo || !row.surname || !row.firstname) {
        validationErrors.push({
          line: index + 1,
          regNo: regNo || 'N/A',
          error: 'Missing Required Field(s)',
          rowData: row
        });
        return;
      }

      // Check for duplicates within the CSV
      if (regNos.has(regNo)) {
        validationErrors.push({
          line: index + 1,
          regNo,
          error: 'Duplicate regNo within CSV file'
        });
        return;
      }

      regNos.add(regNo);

      studentDocs.push({
        surname: row.surname.trim(),
        firstname: row.firstname.trim(),
        middlename: row.middlename?.trim(),
        regNo,
        level
      });
    });

    

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