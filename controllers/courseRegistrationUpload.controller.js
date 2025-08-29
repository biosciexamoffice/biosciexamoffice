// controllers/uploadCourseRegistrations.js
import csv from 'csv-parser';
import mongoose from 'mongoose';
import { Readable } from 'stream';

import Student from '../models/student.js';
import Course from '../models/course.js';
import CourseRegistration from '../models/courseRegistration.js';

/** Stream-parse a CSV buffer and return unique regNos (uppercased). */
function readRegNosFromCsv(buffer) {
  return new Promise((resolve, reject) => {
    const set = new Set();
    let headerValidated = false;

    const parser = csv({
      mapHeaders: ({ header }) => String(header || '').trim().toLowerCase()
    });

    parser.on('headers', (headers) => {
      const valid = new Set(['regno', 'registration number', 'regnumber', 'matric number', 'matric no']);
      if (!(headers.length === 1 && valid.has(headers[0]))) {
        return reject(new Error('CSV_BAD_HEADER'));
      }
      headerValidated = true;
    });

    parser.on('data', (row) => {
      const v =
        row['regno'] ||
        row['regnumber'] ||
        row['registration number'] ||
        row['matric number'] ||
        row['matric no'] || '';
      const reg = String(v).trim();
      if (reg) set.add(reg.toUpperCase());
    });

    parser.on('error', (err) => reject(err));
    parser.on('end', () => {
      if (!headerValidated) return reject(new Error('CSV_BAD_HEADER'));
      resolve([...set]);
    });

    Readable.from(buffer).pipe(parser);
  });
}

/** Get a Set<string(ObjectId)> of students already registered for (course, session, semester, level). */
async function getExistingStudentIdSet(courseId, session, semesterNum, levelStr) {
  const agg = await CourseRegistration.aggregate([
    {
      $match: {
        course: new mongoose.Types.ObjectId(courseId),
        session,
        semester: semesterNum,
        level: levelStr
      }
    },
    { $project: { student: 1 } },
    { $unwind: { path: '$student', preserveNullAndEmptyArrays: false } },
    { $group: { _id: null, all: { $addToSet: '$student' } } }
  ]);
  return new Set((agg[0]?.all || []).map(String));
}

/** Per-request cache key (course|session|semester|level). */
const keyOf = (courseId, session, semesterNum, levelStr) =>
  `${courseId}|${session}|${semesterNum}|${levelStr}`;

export async function uploadCourseRegistrations(req, res) {
  try {
    const { session, semester, level } = req.body;

    if (!session || !semester || !level) {
      return res.status(400).json({
        ok: false,
        message: 'Fields "session", "semester", and "level" are required.',
      });
    }
    if (!req.files?.length) {
      return res.status(400).json({ ok: false, message: 'No CSV files uploaded.' });
    }

    const semesterNum = Number(semester);
    if (![1, 2].includes(semesterNum)) {
      return res.status(400).json({ ok: false, message: '"semester" must be 1 or 2.' });
    }

    const allowedLevels = new Set(['100', '200', '300', '400']);
    const levelStr = String(level);
    if (!allowedLevels.has(levelStr)) {
      return res.status(400).json({
        ok: false,
        message: '"level" must be one of 100, 200, 300, 400.'
      });
    }

    const results = {
      ok: true,
      summary: { totalFiles: req.files.length, succeeded: 0, failed: 0 },
      files: [],
    };

    // request-level cache of already-registered ids per (course, session, semester, level)
    const alreadySetByKey = new Map();

    for (const file of req.files) {
      const report = {
        fileName: file.originalname,
        status: 'failed',
        savedCount: 0,
        createdCount: 0,
        errors: [],
        details: {},
      };

      try {
        // 1) course code = filename minus ".csv"
        const courseCode = String(file.originalname).replace(/\.csv$/i, '').trim();
        if (!courseCode) {
          report.errors.push('UNRECOGNIZED_FILE_NAME');
          report.details.hint = 'Expected something like "PHY101.csv".';
          results.files.push(report);
          continue;
        }

        // 2) ensure course exists
        const course = await Course.findOne({ code: courseCode }).select('_id code title');
        if (!course) {
          report.errors.push('COURSE_NOT_FOUND');
          report.details.courseCode = courseCode;
          results.files.push(report);
          continue;
        }

        // 3) parse CSV
        let regNos;
        try {
          regNos = await readRegNosFromCsv(file.buffer);
        } catch (e) {
          if (e.message === 'CSV_BAD_HEADER') {
            report.errors.push('CSV_BAD_HEADER');
            report.details.expectedHeader =
              'regNo / RegNumber / Registration Number / Matric Number / Matric No';
          } else {
            report.errors.push('CSV_PARSE_ERROR');
            report.details.parseError = e.message;
          }
          results.files.push(report);
          continue;
        }
        if (!regNos.length) {
          report.errors.push('NO_STUDENTS_FOUND');
          results.files.push(report);
          continue;
        }

        // 4) validate all students exist
        const students = await Student.find({ regNo: { $in: regNos } }).select('_id regNo');
        const foundByRegNo = new Map(students.map(s => [s.regNo, s]));
        const missing = regNos.filter(r => !foundByRegNo.has(r));
        if (missing.length) {
          report.errors.push('MISSING_STUDENTS');
          report.details.missingRegNos = missing;
          report.details.missingCount = missing.length;
          report.details.totalExpected = regNos.length;
          results.files.push(report);
          continue;
        }

        // 5) level-aware cross-doc dedupe
        const k = keyOf(course._id, session, semesterNum, levelStr);
        if (!alreadySetByKey.has(k)) {
          alreadySetByKey.set(
            k,
            await getExistingStudentIdSet(course._id, session, semesterNum, levelStr)
          );
        }
        const seen = alreadySetByKey.get(k);

        const thisCsvStudentIds = students.map(s => s._id);
        report.savedCount = thisCsvStudentIds.length;

        const freshIds = thisCsvStudentIds.filter(id => !seen.has(String(id)));

        if (freshIds.length === 0) {
          report.status = 'succeeded';
          report.createdCount = 0;
          report.details.course = { code: course.code, title: course.title, session, semester: semesterNum };
          report.details.level = levelStr;
          results.summary.succeeded += 1;
          results.files.push(report);
          continue;
        }

        // 6) create a new document for this CSV (no per-level buckets)
        const doc = await CourseRegistration.create({
          course: course._id,
          session,
          semester: semesterNum,
          level: levelStr,
          student: freshIds
        });

        // update cache so subsequent files in this request dedupe correctly
        freshIds.forEach(id => seen.add(String(id)));

        report.status = 'succeeded';
        report.createdCount = freshIds.length;
        report.details.course = {
          code: course.code, title: course.title, session, semester: semesterNum, docId: doc._id
        };
        report.details.level = levelStr;

        results.summary.succeeded += 1;
      } catch (e) {
        report.errors.push('SAVE_ERROR');
        report.details.mongooseError = e.message;
      } finally {
        results.files.push(report);
      }
    }

    results.summary.failed = results.files.filter(f => f.status === 'failed').length;
    return res.status(207).json(results);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: 'Internal server error during upload',
      error: error.message
    });
  }
}

export async function searchCourseRegistrations(req, res) {
  try {
    const { session, semester, level, course } = req.query;
    console.log(session, semester, level, course)
    let { page = '1', limit = '1000' } = req.query;

    // ---- validations
    if (!session || !semester || !level || !course) {
      return res.status(400).json({
        ok: false,
        message: 'Query params "session", "semester", "level", and "course" are required.'
      });
    }

    const semesterNum = Number(semester);
    if (![1, 2].includes(semesterNum)) {
      return res.status(400).json({ ok: false, message: '"semester" must be 1 or 2.' });
    }

    const allowedLevels = new Set(['100', '200', '300', '400']);
    const levelStr = String(level);
    if (!allowedLevels.has(levelStr)) {
      return res.status(400).json({ ok: false, message: '"level" must be one of 100, 200, 300, 400.' });
    }

    // page/limit
    page = Math.max(1, parseInt(page, 10) || 1);
    limit = Math.max(1, Math.min(5000, parseInt(limit, 10) || 1000)); // hard cap to keep things safe
    const skip = (page - 1) * limit;

    // ---- resolve course id (accepts code or ObjectId)
    let courseDoc = null;
    if (mongoose.isValidObjectId(course)) {
      courseDoc = await Course.findById(course).select('_id code title');
    } else {
      courseDoc = await Course.findOne({ code: String(course).trim() }).select('_id code title');
    }
    if (!courseDoc) {
      return res.status(404).json({ ok: false, message: 'Course not found for provided "course" value.' });
    }

    // ---- aggregation: dedupe across ALL docs for (course, session, semester, level)
    const pipeline = [
      { $match: { course: courseDoc._id, session, semester: semesterNum, level: levelStr } },
      { $project: { student: 1 } },
      { $unwind: { path: '$student', preserveNullAndEmptyArrays: false } },
      // unique student ids
      { $group: { _id: '$student' } },
      // get regNo from Student
      {
        $lookup: {
          from: 'students',
          localField: '_id',
          foreignField: '_id',
          as: 'stu'
        }
      },
      { $unwind: '$stu' },
      { $project: { _id: 0, regNo: '$stu.regNo' } },
      { $sort: { regNo: 1 } },
      // pagination + total
      {
        $facet: {
          data: [{ $skip: skip }, { $limit: limit }],
          total: [{ $count: 'count' }]
        }
      },
      {
        $project: {
          regNos: '$data.regNo',
          total: { $ifNull: [{ $arrayElemAt: ['$total.count', 0] }, 0] }
        }
      }
    ];

    const agg = await CourseRegistration.aggregate(pipeline);
    const payload = agg[0] || { regNos: [], total: 0 };

    return res.json({
      ok: true,
      filters: {
        course: { id: courseDoc._id, code: courseDoc.code, title: courseDoc.title },
        session,
        semester: semesterNum,
        level: levelStr
      },
      pagination: {
        page,
        limit,
        returned: payload.regNos.length,
        total: payload.total,
        totalPages: Math.max(1, Math.ceil(payload.total / limit))
      },
      regNos: payload.regNos
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: 'Internal server error during search',
      error: error.message
    });
  }
}