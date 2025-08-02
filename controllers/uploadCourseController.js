import multer from 'multer';
import csvParser from 'csv-parser';
import stream from 'stream';
import Course from '../models/course.js';

const storage = multer.memoryStorage();
export const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv') {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'), false);
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});
 // This must match your frontend field name

export const uploadCourses = async (req, res) => {
  // 1. Validate input parameters
  const { level, semester } = req.body;
  
  if (!req.file) {
    return res.status(400).json({ message: 'No CSV file uploaded' });
  }

  if (!level || !semester) {
    return res.status(400).json({ message: 'Semester and Level are required.' });
  }

  // 2. Validate semester and level values
  const validSemesters = [1, 2];
  const validLevels = ['100', '200', '300', '400'];

  if (!validSemesters.includes(Number(semester))) {
    return res.status(400).json({ message: 'Semester must be 1 or 2' });
  }

  if (!validLevels.includes(level)) {
    return res.status(400).json({ message: 'Level must be 100, 200, 300, or 400' });
  }

  // 3. Process CSV
  const rows = [];
  const bufferStream = new stream.PassThrough();
  bufferStream.end(req.file.buffer);

  try {
    await new Promise((resolve, reject) => {
      bufferStream
        .pipe(csvParser({
          separator: '\,',
          mapHeaders: ({ header }) => header.trim(),
          mapValues: ({ value }) => value.trim(), // Trim all values
        }))
        .on('data', (data) => rows.push(data))
        .on('end', resolve)
        .on('error', reject);
    });

    if (rows.length === 0) {
      return res.status(400).json({ message: 'CSV file is empty or invalid' });
    }

    // 4. Validate CSV data and prepare documents
    const courseDocs = [];
    const validationErrors = [];

    rows.forEach((row, index) => {
      // Validate required fields
      if (!row.title || !row.code || !row.unit || !row.option) {
        validationErrors.push({
          line: index + 1,
          code: row.code || 'N/A',
          error: 'Missing required field(s)'
        });
        return;
      }

      // Validate option field
      if (!['C', 'E'].includes(row.option.toUpperCase())) {
        validationErrors.push({
          line: index + 1,
          code: row.code,
          error: 'Option must be either C (Compulsory) or E (Elective)'
        });
        return;
      }

      // Validate unit is a number
      if (isNaN(row.unit) || !Number.isInteger(Number(row.unit))) {
        validationErrors.push({
          line: index + 1,
          code: row.code,
          error: 'Unit must be a whole number'
        });
        return;
      }

      courseDocs.push({
        title: row.title.trim(),
        code: row.code.trim().toUpperCase(), // Standardize course codes
        unit: Number(row.unit),
        option: row.option.toUpperCase(),
        semester: Number(semester),
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

    // 5. Insert into database
    let successfulRecords = [];
    let failedRecords = [];

    try {
      const result = await Course.insertMany(courseDocs, { ordered: false });
      successfulRecords = result;
    } catch (e) {
      if (e.writeErrors) {
        successfulRecords = e.insertedDocs || [];
        const successfulCodes = new Set(successfulRecords.map(doc => doc.code));

        failedRecords = courseDocs
          .filter(doc => !successfulCodes.has(doc.code))
          .map(doc => {
            const writeError = e.writeErrors.find(err => err.err.op.code === doc.code);
            let errorMessage = "Failed to insert due to a validation error.";
            if (writeError && writeError.err.code === 11000) {
              errorMessage = `Duplicate course code: ${doc.code}`;
            } else if (writeError) {
              errorMessage = writeError.err.errmsg;
            }
            return { 
              code: doc.code, 
              title: doc.title, 
              error: errorMessage 
            };
          });
      } else {
        return res.status(500).json({ 
          message: 'Error processing courses', 
          error: e.message 
        });
      }
    }

    // 6. Return response
    res.status(201).json({
      message: 'CSV processed successfully',
      stats: {
        total: rows.length,
        success: successfulRecords.length,
        failed: failedRecords.length + validationErrors.length,
      },
      failed: [...validationErrors, ...failedRecords],
    });

  } catch (error) {
    console.error('CSV processing error:', error);
    res.status(500).json({ 
      message: 'Error processing CSV file', 
      error: error.message 
    });
  }
};