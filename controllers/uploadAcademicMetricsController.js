// controllers/uploadAcademicMetricsController.js
import multer from 'multer';
import csvParser from 'csv-parser';
import stream from 'stream';
import AcademicMetrics from '../models/academicMetrics.js';
import Student from '../models/student.js';

const storage = multer.memoryStorage();
export const uploadOldMetricsMulter = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'text/csv' || /\.csv$/i.test(file.originalname);
    cb(ok ? null : new Error('Only CSV files are allowed!'), ok);
  },
  limits: { files: 20, fileSize: 5 * 1024 * 1024 },
}).array('files'); // <— MULTI-FILE, field name: "files"

/** Extract level (100|200|300|400) from filename */
function parseLevelFromName(name = '') {
  const m = String(name).match(/\b(100|200|300|400)\b/);
  return m ? Number(m[1]) : NaN;
}

export const uploadOldMetrics = async (req, res) => {
  try {
    const { session, semester } = req.body || {};
    if (!session || !semester) {
      return res.status(400).json({ message: 'session and semester are required' });
    }
    if (!req.files || !req.files.length) {
      return res.status(400).json({ message: 'No CSV files uploaded (field name: files)' });
    }

    // Header mapping (tolerant to case/spacing)
    const keyMap = {
      'reg no': 'regNo',
      'current tcc': 'TCC',
      'current tce': 'TCE',
      'current tpe': 'TPE',
      'current gpa': 'GPA',
      'previous ccc': 'p_CCC',
      'previous cce': 'p_CCE',
      'previous cpe': 'p_CPE',
      'previous cgpa': 'p_CGPA',
      'cumulative ccc': 'CCC',
      'cumulative cce': 'CCE',
      'cumulative cpe': 'CPE',
      'cumulative cgpa': 'CGPA',
    };
    const num = (v) => (v === '' || v == null ? 0 : (Number.isFinite(Number(v)) ? Number(v) : 0));

    const overall = { total: 0, success: 0, failed: 0 };
    const perFile = [];

    for (const file of req.files) {
      const fileLevel = parseLevelFromName(file.originalname);
      if (![100, 200, 300, 400].includes(fileLevel)) {
        perFile.push({
          file: file.originalname,
          level: null,
          stats: { total: 0, success: 0, failed: 0 },
          failures: [{ error: `Could not infer level from file name. Include 100/200/300/400 in: ${file.originalname}` }],
        });
        continue;
      }

      const bufferStream = new stream.PassThrough();
      bufferStream.end(file.buffer);

      const rows = [];
      await new Promise((resolve, reject) => {
        bufferStream
          .pipe(csvParser({
            separator: ',',
            mapHeaders: ({ header }) => String(header || '').toLowerCase().replace(/\s+/g, ' ').trim(),
            mapValues: ({ value }) => (typeof value === 'string' ? value.trim() : value),
          }))
          .on('data', (row) => rows.push(row))
          .on('end', resolve)
          .on('error', reject);
      });

      const successes = [];
      const failures = [];

      for (const r of rows) {
        try {
          // normalize row
          const rec = {};
          for (const [k, v] of Object.entries(r)) {
            const mKey = keyMap[k];
            if (mKey) rec[mKey] = v;
          }

          const regNo = String(rec.regNo || '').toUpperCase();
          if (!regNo) throw new Error('Missing "Reg No"');

        
          const student = await Student.findOne({ regNo });
          if (!student) throw new Error(`Student not found: ${regNo}`);

          ensureUserCanAccessDepartment(req.user, student.department, student.college);

          const previousMetrics = {
            CCC: num(rec.p_CCC),
            CCE: num(rec.p_CCE),
            CPE: num(rec.p_CPE),
            CGPA: num(rec.p_CGPA),
          };

          const set = {
            TCC: num(rec.TCC),
            TCE: num(rec.TCE),
            TPE: num(rec.TPE),
            GPA: num(rec.GPA),
            CCC: num(rec.CCC),
            CCE: num(rec.CCE),
            CPE: num(rec.CPE),
            CGPA: num(rec.CGPA),
            previousMetrics,
            lastUpdated: new Date(),
          };
console.log(set)
          const doc = await AcademicMetrics.findOneAndUpdate(
            { student: student._id, session, semester: Number(semester), level: fileLevel },
            { $set: set, $setOnInsert: { student: student._id, session, semester: Number(semester), level: fileLevel } },
            { upsert: true, new: true, runValidators: true }
          );
            
          successes.push({ regNo, metricsId: doc._id });
        } catch (e) {
          failures.push({ error: e.message, rowHint: r['reg no'] ?? r['Reg No'] ?? null });
        }
      }

      overall.total += rows.length;
      overall.success += successes.length;
      overall.failed += failures.length;

      perFile.push({
        file: file.originalname,
        level: fileLevel,
        stats: { total: rows.length, success: successes.length, failed: failures.length },
        successes,
        failures,
      });
    }

    return res.status(201).json({
      message: 'Old academic metrics processed',
      session,
      semester: Number(semester),
      summary: overall,
      perFile,
    });
  } catch (err) {
    console.error('uploadOldMetrics error:', err);
    return res.status(500).json({ message: 'Failed to upload metrics', error: err.message });
  }
};
