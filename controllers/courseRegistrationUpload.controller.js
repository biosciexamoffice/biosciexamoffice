// controllers/uploadCourseRegistrations.js
import csv from 'csv-parser';
import mongoose from 'mongoose';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
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

const COURSE_TOKEN_REGEX = /\b([A-Z]{3})\s*(\d{3}[A-Z]?)\b/g;
const CURRICULUM_PREFIX = {
  BMASS: 'B-',
  CCMASS: 'C-'
};
const REG_NO_CLEAN = /^\d{2}\/\d{5}\/[A-Z0-9]{2,3}$/i;

function normalizeCourseCode(raw = '') {
  return raw.replace(/\s+/g, ' ').trim().toUpperCase();
}

function extractCourseTokens(section = '') {
  const tokens = new Set();
  if (!section) return [];

  const upper = section.toUpperCase();
  let match;
  while ((match = COURSE_TOKEN_REGEX.exec(upper)) !== null) {
    const dept = match[1];
    const num = match[2];
    tokens.add(`${dept} ${num}`);
  }
  return [...tokens];
}

async function parseExamCardPdf(buffer) {
  const parsed = await pdfParse(buffer);
  const text = String(parsed.text || '').replace(/\f/g, '\n');
  if (!text.trim()) return [];

  const entryRegex = /Reg\. Number:\s*([^\n]+)\s*Full Name:\s*([^\n]+)([\s\S]*?)(?=Reg\. Number:|$)/gi;
  const entries = [];
  let match;
  while ((match = entryRegex.exec(text)) !== null) {
    const regRaw = String(match[1] || '').replace(/\s+/g, '').toUpperCase();
    if (!REG_NO_CLEAN.test(regRaw)) continue;

    const blockRemainder = match[3] || '';
    const coursesMatch = blockRemainder.match(
      /Courses\s*:\s*([\s\S]*?)(?=Semester\s*:|Session\s*:|Level\s*:|Student's Signature|Provide HOD|JOSEPH\s+SARWUAN|$)/i
    );
    if (!coursesMatch) continue;

    const courseTokens = extractCourseTokens(coursesMatch[1]);
    if (!courseTokens.length) continue;

    entries.push({
      regNo: regRaw.toUpperCase(),
      courses: courseTokens
    });
  }

  return entries;
}

/** Per-request cache key (course|session|semester|level). */
const keyOf = (courseId, session, semesterNum, levelStr) =>
  `${courseId}|${session}|${semesterNum}|${levelStr}`;

export async function uploadCourseRegistrations(req, res) {
  try {
    const { session, semester, curriculumType: rawCurriculumType } = req.body;

    if (!session || !semester) {
      return res.status(400).json({
        ok: false,
        message: 'Fields "session" and "semester" are required.',
      });
    }
    if (!req.files?.length) {
      return res.status(400).json({ ok: false, message: 'No registration files uploaded.' });
    }

    const semesterNum = Number(semester);
    if (![1, 2].includes(semesterNum)) {
      return res.status(400).json({ ok: false, message: '"semester" must be 1 or 2.' });
    }

    const curriculumType = String(rawCurriculumType || '').trim().toUpperCase();
    const curriculumPrefix = curriculumType ? CURRICULUM_PREFIX[curriculumType] : null;
    const hasPdfUpload = req.files.some((file) => {
      const lower = (file.originalname || '').toLowerCase();
      return file.mimetype === 'application/pdf' || lower.endsWith('.pdf');
    });

    if (hasPdfUpload && !curriculumPrefix) {
      return res.status(400).json({
        ok: false,
        message: '"curriculumType" is required and must be either BMASS or CCMASS when uploading PDF documents.'
      });
    }
    if (curriculumType && !curriculumPrefix) {
      return res.status(400).json({
        ok: false,
        message: '"curriculumType" must be either BMASS or CCMASS.'
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
        const originalName = String(file.originalname || '');
        const lowerName = originalName.toLowerCase();
        const isPdf = file.mimetype === 'application/pdf' || lowerName.endsWith('.pdf');

        if (isPdf) {
          // --- PDF EXAM CARD WORKFLOW ---------------------------------------
          let entries;
          try {
            entries = await parseExamCardPdf(file.buffer);
          } catch (err) {
            report.errors.push('PDF_PARSE_ERROR');
            report.details.parseError = err.message;
            continue;
          }

          if (!entries.length) {
            report.errors.push('NO_VALID_ENTRIES');
            report.details.hint = 'Ensure the PDF contains exam cards with course listings.';
            continue;
          }

          const uniqueRegNos = [...new Set(entries.map((e) => e.regNo))];
          const studentDocs = await Student.find({ regNo: { $in: uniqueRegNos } })
            .select('_id regNo surname firstname middlename level');
          const studentByRegNo = new Map(studentDocs.map((s) => [s.regNo, s]));
          const missingStudents = uniqueRegNos.filter((regNo) => !studentByRegNo.has(regNo));
          const studentsMissingLevel = [];
          const validEntries = entries.filter((entry) => {
            const studentDoc = studentByRegNo.get(entry.regNo);
            if (!studentDoc) return false;
            const lvl = String(studentDoc.level || '').trim();
            if (!lvl) {
              studentsMissingLevel.push(entry.regNo);
              return false;
            }
            return true;
          });

          if (!validEntries.length) {
            report.errors.push('MISSING_STUDENTS');
            report.details.missingStudents = missingStudents;
            continue;
          }

          const uniqueCourseTokens = new Set();
          validEntries.forEach((entry) => entry.courses.forEach((code) => uniqueCourseTokens.add(code)));

          const prefixedLookup = new Map();
          uniqueCourseTokens.forEach((code) => {
            const normalized = normalizeCourseCode(code);
            prefixedLookup.set(normalized, `${curriculumPrefix}${normalized}`);
          });

          const prefixedCodes = [...new Set([...prefixedLookup.values()].map((c) => c.toUpperCase()))];
          const courseDocs = prefixedCodes.length
            ? await Course.find({ code: { $in: prefixedCodes } }).select('_id code title level semester unit')
            : [];
          const courseByCode = new Map(courseDocs.map((c) => [c.code.toUpperCase(), c]));

          const missingCourseSummaries = [];
          prefixedLookup.forEach((prefixedCode, rawCode) => {
            if (!courseByCode.has(prefixedCode.toUpperCase())) {
              missingCourseSummaries.push({
                rawCode,
                expectedCode: prefixedCode
              });
            }
          });

          const courseBuckets = new Map(); // key => `${courseId}|${level}`
          const studentsWithoutValidCourses = new Set();
          const missingCourseInstances = [];

          for (const entry of validEntries) {
            const studentDoc = studentByRegNo.get(entry.regNo);
            const studentIdStr = String(studentDoc._id);
             const levelStr = String(studentDoc.level || '').trim();
            let matchedCourse = false;

            for (const courseRaw of entry.courses) {
              const normalizedRaw = normalizeCourseCode(courseRaw);
              const prefixedCode = `${curriculumPrefix}${normalizedRaw}`;
              const courseDoc = courseByCode.get(prefixedCode.toUpperCase());

              if (!courseDoc) {
                missingCourseInstances.push({ regNo: entry.regNo, courseCode: normalizedRaw, expectedCode: prefixedCode });
                continue;
              }

              const bucketKey = `${String(courseDoc._id)}|${levelStr}`;
              let bucket = courseBuckets.get(bucketKey);
              if (!bucket) {
                bucket = {
                  course: courseDoc,
                  level: levelStr,
                  students: new Map()
                };
                courseBuckets.set(bucketKey, bucket);
              }

              if (!bucket.students.has(studentIdStr)) {
                bucket.students.set(studentIdStr, { studentId: studentDoc._id, regNo: entry.regNo });
              }
              matchedCourse = true;
            }

            if (!matchedCourse) {
              studentsWithoutValidCourses.add(entry.regNo);
            }
          }

          const courseStats = [];
          let totalAttempted = 0;
          let totalCreated = 0;
          let totalDuplicates = 0;
          const levelSummaryMap = new Map();

          for (const bucket of courseBuckets.values()) {
            const courseDoc = bucket.course;
            const attempted = bucket.students.size;
            const levelStr = bucket.level;
            totalAttempted += attempted;

            const cacheKey = keyOf(courseDoc._id, session, semesterNum, levelStr);
            if (!alreadySetByKey.has(cacheKey)) {
              alreadySetByKey.set(
                cacheKey,
                await getExistingStudentIdSet(courseDoc._id, session, semesterNum, levelStr)
              );
            }
            const seen = alreadySetByKey.get(cacheKey);

            const freshIds = [];
            const duplicateRegNos = [];
            for (const record of bucket.students.values()) {
              const idStr = String(record.studentId);
              if (seen.has(idStr)) {
                duplicateRegNos.push(record.regNo);
              } else {
                freshIds.push(record.studentId);
                seen.add(idStr);
              }
            }

            let levelSummary = levelSummaryMap.get(levelStr);
            if (!levelSummary) {
              levelSummary = {
                level: levelStr,
                attemptedRegistrations: 0,
                successfulRegistrations: 0,
                duplicateRegistrations: 0,
                coursesWithRegistrations: 0
              };
              levelSummaryMap.set(levelStr, levelSummary);
            }
            levelSummary.attemptedRegistrations += attempted;
            levelSummary.duplicateRegistrations += duplicateRegNos.length;
            if (attempted > 0) levelSummary.coursesWithRegistrations += 1;

            let docId = null;
            if (freshIds.length) {
              const newDoc = await CourseRegistration.create({
                course: courseDoc._id,
                session,
                semester: semesterNum,
                level: levelStr,
                student: freshIds
              });
              docId = newDoc._id;
              totalCreated += freshIds.length;
              levelSummary.successfulRegistrations += freshIds.length;
            }

            totalDuplicates += duplicateRegNos.length;

            courseStats.push({
              course: {
                id: courseDoc._id,
                code: courseDoc.code,
                title: courseDoc.title,
                level: courseDoc.level,
                semester: courseDoc.semester,
                unit: courseDoc.unit,
                docId
              },
              level: levelStr,
              attempted,
              createdCount: freshIds.length,
              duplicateCount: duplicateRegNos.length,
              duplicates: duplicateRegNos
            });
          }

          courseStats.sort((a, b) => {
            if (b.createdCount !== a.createdCount) return b.createdCount - a.createdCount;
            if (b.attempted !== a.attempted) return b.attempted - a.attempted;
            return a.course.code.localeCompare(b.course.code);
          });

          report.savedCount = totalAttempted;
          report.createdCount = totalCreated;
          const levelSummaries = [...levelSummaryMap.values()].sort((a, b) =>
            a.level.localeCompare(b.level)
          );
          report.details = {
            type: 'PDF_EXAM_CARD',
            curriculumType,
            curriculumPrefix,
            session,
            semester: semesterNum,
            totalCards: entries.length,
            uniqueStudents: uniqueRegNos.length,
            levels: levelSummaries.map((summary) => summary.level),
            levelSummaries,
            totalCoursesMatched: courseStats.length,
            totals: {
              attemptedRegistrations: totalAttempted,
              successfulRegistrations: totalCreated,
              duplicateRegistrations: totalDuplicates,
              coursesWithRegistrations: courseStats.filter((c) => c.createdCount > 0).length
            },
            courseStats,
            missingStudents,
            missingCourses: missingCourseSummaries,
            missingCourseInstances,
            studentsWithoutValidCourses: [...studentsWithoutValidCourses],
            missingStudentsCount: missingStudents.length,
            missingCourseCount: missingCourseSummaries.length,
            missingLevelCount: studentsMissingLevel.length,
            studentsMissingLevel,
            duplicateSummary: courseStats
              .filter((c) => c.duplicateCount > 0)
              .map((c) => ({
                courseCode: c.course.code,
                level: c.level,
                regNos: c.duplicates
              }))
          };

          if (missingStudents.length) {
            report.errors.push('MISSING_STUDENTS');
          }
          if (missingCourseSummaries.length) {
            report.errors.push('COURSE_NOT_FOUND');
          }
          if (studentsWithoutValidCourses.size) {
            report.errors.push('NO_VALID_COURSES_FOR_STUDENT');
          }
          if (studentsMissingLevel.length) {
            report.errors.push('MISSING_STUDENT_LEVEL');
          }

          if (courseStats.length === 0) {
            report.errors.push('NO_REGISTRATIONS_CREATED');
            report.status = 'failed';
          } else {
            report.status = 'succeeded';
            results.summary.succeeded += 1;
          }

          continue;
        }

        // --- CSV WORKFLOW ---------------------------------------------------
        const courseCode = originalName.replace(/\.csv$/i, '').trim();
        if (!courseCode) {
          report.errors.push('UNRECOGNIZED_FILE_NAME');
          report.details.hint = 'Expected something like "PHY101.csv".';
          continue;
        }

        const course = await Course.findOne({ code: courseCode }).select('_id code title');
        if (!course) {
          report.errors.push('COURSE_NOT_FOUND');
          report.details.courseCode = courseCode;
          continue;
        }

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
          continue;
        }
        if (!regNos.length) {
          report.errors.push('NO_STUDENTS_FOUND');
          continue;
        }

        const students = await Student.find({ regNo: { $in: regNos } }).select('_id regNo level');
        const foundByRegNo = new Map(students.map((s) => [s.regNo, s]));
        const missing = regNos.filter((r) => !foundByRegNo.has(r));
        if (missing.length) {
          report.errors.push('MISSING_STUDENTS');
          report.details.missingRegNos = missing;
          report.details.missingCount = missing.length;
          report.details.totalExpected = regNos.length;
          continue;
        }

        report.savedCount = regNos.length;

        const studentsMissingLevel = [];
        const studentsByLevel = new Map();

        for (const reg of regNos) {
          const studentDoc = foundByRegNo.get(reg);
          if (!studentDoc) continue;
          const levelStr = String(studentDoc.level || '').trim();
          if (!levelStr) {
            studentsMissingLevel.push(reg);
            continue;
          }
          if (!studentsByLevel.has(levelStr)) {
            studentsByLevel.set(levelStr, []);
          }
          studentsByLevel.get(levelStr).push({ regNo: reg, student: studentDoc });
        }

        if (!studentsByLevel.size) {
          report.errors.push('MISSING_STUDENT_LEVEL');
          report.details.studentsMissingLevel = studentsMissingLevel;
          report.status = 'failed';
          continue;
        }

        let totalCreatedForCsv = 0;
        const insertedRegNos = [];
        const duplicateRegNos = [];
        const perLevelResults = [];

        for (const [levelStr, records] of studentsByLevel.entries()) {
          const cacheKey = keyOf(course._id, session, semesterNum, levelStr);
          if (!alreadySetByKey.has(cacheKey)) {
            alreadySetByKey.set(
              cacheKey,
              await getExistingStudentIdSet(course._id, session, semesterNum, levelStr)
            );
          }
          const seen = alreadySetByKey.get(cacheKey);

          const freshIds = [];
          const freshRegNos = [];
          const levelDuplicates = [];

          for (const { regNo, student } of records) {
            const idStr = String(student._id);
            if (seen.has(idStr)) {
              levelDuplicates.push(regNo);
            } else {
              freshIds.push(student._id);
              freshRegNos.push(regNo);
            }
          }

          let docId = null;
          if (freshIds.length) {
            const doc = await CourseRegistration.create({
              course: course._id,
              session,
              semester: semesterNum,
              level: levelStr,
              student: freshIds
            });
            docId = doc._id;
            freshIds.forEach((id) => seen.add(String(id)));
            totalCreatedForCsv += freshIds.length;
            insertedRegNos.push(...freshRegNos);
          }

          duplicateRegNos.push(...levelDuplicates);
          perLevelResults.push({
            level: levelStr,
            attempted: records.length,
            createdCount: freshIds.length,
            duplicateCount: levelDuplicates.length,
            insertedRegNos: freshRegNos,
            duplicateRegNos: levelDuplicates,
            docId
          });
        }

        perLevelResults.sort((a, b) => a.level.localeCompare(b.level));

        report.status = 'succeeded';
        report.createdCount = totalCreatedForCsv;
        report.details.course = {
          code: course.code,
          title: course.title,
          session,
          semester: semesterNum
        };
        report.details.levels = perLevelResults.map((r) => r.level);
        report.details.perLevel = perLevelResults;
        report.details.insertedRegNos = insertedRegNos;
        report.details.duplicates = duplicateRegNos;
        report.details.studentsMissingLevel = studentsMissingLevel;
        report.details.totals = {
          attemptedRegistrations: perLevelResults.reduce((sum, r) => sum + r.attempted, 0),
          successfulRegistrations: totalCreatedForCsv,
          duplicateRegistrations: duplicateRegNos.length
        };

        if (studentsMissingLevel.length) {
          report.errors.push('MISSING_STUDENT_LEVEL');
        }

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

export async function listRegistrationCourses(req, res) {
  try {
    const { session, semester, level, q = '' } = req.query;
    let { page = '1', limit = '20' } = req.query;

    if (!session || !semester || !level) {
      return res.status(400).json({ ok: false, message: 'session, semester, and level are required.' });
    }
    const semesterNum = Number(semester);
    if (![1, 2].includes(semesterNum)) {
      return res.status(400).json({ ok: false, message: '"semester" must be 1 or 2.' });
    }
    const allowedLevels = new Set(['100','200','300','400']);
    const levelStr = String(level);
    if (!allowedLevels.has(levelStr)) {
      return res.status(400).json({ ok: false, message: '"level" must be one of 100, 200, 300, 400.' });
    }

    page  = Math.max(1, parseInt(page, 10) || 1);
    limit = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    const skip = (page - 1) * limit;

    const codeRx = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;

    // Pipeline: term filter → explode students → dedupe per course+student → group per course (unique count)
    // → join course → optional q filter → sort → paginate
    const pipeline = [
      { $match: { session, semester: semesterNum, level: levelStr } },
      { $project: { course: 1, student: 1 } },
      { $unwind: '$student' },
      { $group: { _id: { course: '$course', student: '$student' } } }, // unique student per course
      { $group: { _id: '$_id.course', uniqueCount: { $sum: 1 } } },
      {
        $lookup: {
          from: 'courses',
          localField: '_id',
          foreignField: '_id',
          as: 'course'
        }
      },
      { $unwind: '$course' },
      ...(codeRx ? [{ $match: { $or: [{ 'course.code': codeRx }, { 'course.title': codeRx }] } }] : []),
      { $sort: { 'course.code': 1 } },
      {
        $facet: {
          data: [{ $skip: skip }, { $limit: limit }],
          total: [{ $count: 'count' }]
        }
      },
      {
        $project: {
          courses: {
            $map: {
              input: '$data',
              as: 'd',
              in: {
                _id: '$$d._id',
                count: '$$d.uniqueCount',
                code: '$$d.course.code',
                title: '$$d.course.title',
                unit: '$$d.course.unit',
                semester: '$$d.course.semester',
                level: '$$d.course.level'
              }
            }
          },
          total: { $ifNull: [{ $arrayElemAt: ['$total.count', 0] }, 0] }
        }
      }
    ];

    const agg = await CourseRegistration.aggregate(pipeline);
    const payload = agg[0] || { courses: [], total: 0 };

    return res.json({
      ok: true,
      filters: { session, semester: semesterNum, level: levelStr, q },
      pagination: {
        page,
        limit,
        returned: payload.courses.length,
        total: payload.total,
        totalPages: Math.max(1, Math.ceil(payload.total / limit))
      },
      courses: payload.courses
    });
  } catch (error) {
    console.error('listRegistrationCourses error:', error);
    return res.status(500).json({ ok: false, message: 'Server error', error: error.message });
  }
}

/**
 * GET /api/course-registration/registrations/students
 * List unique students for a course in a term; supports regNo search + pagination.
 *
 * Query:
 *  - session, semester, level (all required)
 *  - course (required: code or ObjectId)
 *  - regNo (optional fuzzy search)
 *  - page, limit
 */
export async function getRegistrationStudents(req, res) {
  try {
    const { session, semester, level, course, regNo = '' } = req.query;
    let { page = '1', limit = '50' } = req.query;

    if (!session || !semester || !level || !course) {
      return res.status(400).json({ ok: false, message: 'session, semester, level, and course are required.' });
    }
    const semesterNum = Number(semester);
    if (![1, 2].includes(semesterNum)) {
      return res.status(400).json({ ok: false, message: '"semester" must be 1 or 2.' });
    }
    const allowedLevels = new Set(['100','200','300','400']);
    const levelStr = String(level);
    if (!allowedLevels.has(levelStr)) {
      return res.status(400).json({ ok: false, message: '"level" must be one of 100, 200, 300, 400.' });
    }

    // resolve course id
    let courseDoc = null;
    if (mongoose.isValidObjectId(course)) {
      courseDoc = await Course.findById(course).select('_id code title');
    } else {
      courseDoc = await Course.findOne({ code: String(course).trim() }).select('_id code title');
    }
    if (!courseDoc) return res.status(404).json({ ok: false, message: 'Course not found' });

    page  = Math.max(1, parseInt(page, 10) || 1);
    limit = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
    const skip = (page - 1) * limit;

    const regRx = regNo ? new RegExp(regNo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;

    const pipeline = [
      { $match: { course: courseDoc._id, session, semester: semesterNum, level: levelStr } },
      { $project: { student: 1 } },
      { $unwind: '$student' },
      { $group: { _id: '$student' } }, // unique
      {
        $lookup: {
          from: 'students',
          localField: '_id',
          foreignField: '_id',
          as: 'stu'
        }
      },
      { $unwind: '$stu' },
      ...(regRx ? [{ $match: { 'stu.regNo': regRx } }] : []),
      {
        $project: {
          _id: 0,
          studentId: '$_id',
          regNo: '$stu.regNo',
          surname: '$stu.surname',
          firstname: '$stu.firstname',
          middlename: '$stu.middlename'
        }
      },
      { $sort: { regNo: 1 } },
      {
        $facet: {
          data: [{ $skip: skip }, { $limit: limit }],
          total: [{ $count: 'count' }]
        }
      },
      {
        $project: {
          students: '$data',
          total: { $ifNull: [{ $arrayElemAt: ['$total.count', 0] }, 0] }
        }
      }
    ];

    const agg = await CourseRegistration.aggregate(pipeline);
    const payload = agg[0] || { students: [], total: 0 };

    return res.json({
      ok: true,
      course: { id: courseDoc._id, code: courseDoc.code, title: courseDoc.title },
      filters: { session, semester: semesterNum, level: levelStr, regNo },
      pagination: {
        page,
        limit,
        returned: payload.students.length,
        total: payload.total,
        totalPages: Math.max(1, Math.ceil(payload.total / limit))
      },
      students: payload.students
    });
  } catch (error) {
    console.error('getRegistrationStudents error:', error);
    return res.status(500).json({ ok: false, message: 'Server error', error: error.message });
  }
}

/**
 * DELETE /api/course-registration/registrations/student
 * Remove a student (by regNo) from registration for a given course/term.
 *
 * Body:
 *  - session, semester, level (required)
 *  - course (required: code or ObjectId)
 *  - regNo (required)
 */
export async function deleteRegisteredStudent(req, res) {
  try {
    const { session, semester, level, course, regNo } = req.body;
    if (!session || !semester || !level || !course || !regNo) {
      return res.status(400).json({ ok: false, message: 'session, semester, level, course and regNo are required.' });
    }

    const semesterNum = Number(semester);
    const levelStr = String(level);

    // resolve course id
    let courseDoc = null;
    if (mongoose.isValidObjectId(course)) {
      courseDoc = await Course.findById(course).select('_id');
    } else {
      courseDoc = await Course.findOne({ code: String(course).trim() }).select('_id');
    }
    if (!courseDoc) return res.status(404).json({ ok: false, message: 'Course not found' });

    const student = await Student.findOne({ regNo: String(regNo).toUpperCase() }).select('_id regNo');
    if (!student) return res.status(404).json({ ok: false, message: 'Student not found' });

    const result = await CourseRegistration.updateMany(
      { course: courseDoc._id, session, semester: semesterNum, level: levelStr },
      { $pull: { student: student._id } }
    );

    return res.json({
      ok: true,
      modifiedDocs: result.modifiedCount || 0,
      matchedDocs: result.matchedCount || 0,
      removedStudent: student.regNo
    });
  } catch (error) {
    console.error('deleteRegisteredStudent error:', error);
    return res.status(500).json({ ok: false, message: 'Server error', error: error.message });
  }
}


export async function moveRegisteredStudents(req, res) {
  try {
    const { session, semester, level, fromCourse, toCourse, regNos } = req.body;

    if (!session || !semester || !level || !fromCourse || !toCourse || !regNos) {
      return res.status(400).json({ ok: false, message: 'session, semester, level, fromCourse, toCourse and regNos are required.' });
    }

    const semesterNum = Number(semester);
    if (![1, 2].includes(semesterNum)) {
      return res.status(400).json({ ok: false, message: '"semester" must be 1 or 2.' });
    }

    const allowedLevels = new Set(['100','200','300','400']);
    const levelStr = String(level);
    if (!allowedLevels.has(levelStr)) {
      return res.status(400).json({ ok: false, message: '"level" must be one of 100, 200, 300, 400.' });
    }

    // Resolve courses (accept ObjectId or code)
    async function resolveCourse(v) {
      if (mongoose.isValidObjectId(v)) return Course.findById(v).select('_id code title').lean();
      return Course.findOne({ code: String(v).trim() }).select('_id code title').lean();
    }
    const from = await resolveCourse(fromCourse);
    const to   = await resolveCourse(toCourse);

    if (!from) return res.status(404).json({ ok: false, message: 'fromCourse not found' });
    if (!to)   return res.status(404).json({ ok: false, message: 'toCourse not found' });
    if (String(from._id) === String(to._id)) {
      return res.status(400).json({ ok: false, message: 'fromCourse and toCourse must be different.' });
    }

    // Normalize regNos
    const regArr = Array.isArray(regNos) ? regNos : [regNos];
    const regUpper = regArr.map(r => String(r).toUpperCase().trim()).filter(Boolean);
    if (!regUpper.length) {
      return res.status(400).json({ ok: false, message: 'No valid regNos provided.' });
    }

    // Fetch students
    const students = await Student.find({ regNo: { $in: regUpper } }).select('_id regNo').lean();
    const foundByReg = new Map(students.map(s => [s.regNo, s]));
    const missing = regUpper.filter(r => !foundByReg.has(r));
    if (missing.length) {
      return res.status(404).json({ ok: false, message: 'Some regNos were not found', missing });
    }
    const studentIds = students.map(s => s._id);

    // 1) Ensure target doc (upsert)
    await CourseRegistration.updateOne(
      { course: to._id, session, semester: semesterNum, level: levelStr },
      { $setOnInsert: { course: to._id, session, semester: semesterNum, level: levelStr, student: [] } },
      { upsert: true }
    );

    // 2) Add to target without duplicates
    const pushRes = await CourseRegistration.updateOne(
      { course: to._id, session, semester: semesterNum, level: levelStr },
      { $addToSet: { student: { $each: studentIds } } }
    );

    // 3) Pull from source (can affect many docs in same term)
    const pullRes = await CourseRegistration.updateMany(
      { course: from._id, session, semester: semesterNum, level: levelStr },
      { $pull: { student: { $in: studentIds } } }
    );

    return res.json({
      ok: true,
      movedCount: studentIds.length,
      fromCourse: { id: from._id, code: from.code, title: from.title },
      toCourse:   { id: to._id,   code: to.code,   title: to.title },
      details: {
        addedToTarget: (pushRes.modifiedCount || 0) > 0,
        pulledFromDocs: pullRes.modifiedCount || 0
      }
    });
  } catch (error) {
    console.error('moveRegisteredStudents (no-txn) error:', error);
    return res.status(500).json({ ok: false, message: 'Server error', error: error.message });
  }
}
