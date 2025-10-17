import mongoose from "mongoose";
import Result from "../models/result.js";
import Course from "../models/course.js";
import Student from "../models/student.js";
import { buildDepartmentScopeFilter } from "../services/accessControl.js";

/**
 * One-time (or on-boot) helper to ensure indexes that make export queries fast.
 * Call this from your server bootstrap (e.g., after DB connects).
 */
export async function ensureExportIndexes() {
  // Result: common filters used for export
  await Result.collection.createIndex({ session: 1, semester: 1, level: 1, resultType: 1 });
  await Result.collection.createIndex({ course: 1, session: 1, semester: 1 });
  await Result.collection.createIndex({ student: 1, session: 1, semester: 1, level: 1 });

  // Course: lookups & health checks
  await Course.collection.createIndex({ code: 1 });
  await Course.collection.createIndex({ uamId: 1 });

  // Student: already has some, but make sure regNo is indexed
  await Student.collection.createIndex({ regNo: 1 });
}

/**
 * GET /api/results-export
 * Query params: regNo?, courseCode?, session?, level?, semester?, resultType?
 * Returns export-friendly rows with the minimal fields the frontend needs to build CSV.
 * Health guard: excludes results whose course.uamId is missing/empty.
 */
// controllers/resultsExport.controller.js
// controllers/resultsExport.controller.js
// controllers/resultsExport.controller.js
export async function listForExport(req, res) {
  try {
    const { regNo, courseCode, session, level, semester, resultType } = req.query;

    const pipeline = [
      { $lookup: { from: 'students', localField: 'student', foreignField: '_id', as: 'studentInfo' } },
      { $unwind: '$studentInfo' },
      { $lookup: { from: 'courses', localField: 'course', foreignField: '_id', as: 'courseInfo' } },
      { $unwind: '$courseInfo' },
      { $lookup: { from: 'lecturers', localField: 'lecturer', foreignField: '_id', as: 'lecturerInfo' } },
      { $unwind: { path: '$lecturerInfo', preserveNullAndEmptyArrays: true } },

      {
        $addFields: {
          regNoNumeric: {
            $toInt: { $arrayElemAt: [{ $split: ['$studentInfo.regNo', '/'] }, 1] }
          },
          courseCodeNoSpace: {
            $replaceAll: { input: '$courseInfo.code', find: ' ', replacement: '' }
          }
        }
      }
    ];

    let scopeFilter = {};
    try {
      scopeFilter = buildDepartmentScopeFilter(req.user);
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ message: error.message });
      }
      throw error;
    }

    if (scopeFilter.department) {
      pipeline.push({
        $match: {
          'courseInfo.department': new mongoose.Types.ObjectId(scopeFilter.department),
        },
      });
    }

    const matchStage = {};
    if (session) matchStage.session = session;
    if (level) matchStage.level = level;
    if (semester) matchStage.semester = parseInt(semester, 10);
    if (resultType) matchStage.resultType = resultType;
    if (regNo) matchStage['studentInfo.regNo'] = { $regex: regNo, $options: 'i' };

    if (courseCode) {
      const patternSpaces = courseCode.replace(/\s+/g, '\\s*');
      const normalized = courseCode.replace(/\s+/g, '');
      matchStage.$or = [
        { 'courseInfo.code': { $regex: patternSpaces, $options: 'i' } },
        { courseCodeNoSpace: { $regex: normalized, $options: 'i' } }
      ];
    }

    // exclude missing/blank/null uamId
    matchStage['courseInfo.uamId'] = { $nin: ['', null] };

    if (Object.keys(matchStage).length) pipeline.push({ $match: matchStage });

    pipeline.push({
      $project: {
        _id: 1,
        department: 1,
        session: 1,
        semester: 1,
        level: 1,
        resultType: 1,
        grandtotal: 1,
        student: {
          _id: '$studentInfo._id',
          surname: '$studentInfo.surname',
          firstname: '$studentInfo.firstname',
          middlename: '$studentInfo.middlename',
          regNo: '$studentInfo.regNo'
        },
        course: {
          _id: '$courseInfo._id',
          title: '$courseInfo.title',
          code: '$courseInfo.code',
          unit: '$courseInfo.unit',
          uamId: '$courseInfo.uamId'
        },
        regNoNumeric: 1
      }
    });

    pipeline.push({ $sort: { regNoNumeric: 1 } });

    let rows = await Result.aggregate(pipeline).allowDiskUse(true);

    // ✅ Clean course code in JS (remove leading B-/C-, trim)
    rows = rows.map(r => {
      const cleanedCode = r.course.code.replace(/^\s*(?:B|C)-\s*/i, '').trim();
      return {
        ...r,
        courseCodeCleaned: cleanedCode,
        portalId: `${r.student.regNo}${cleanedCode}${r.semester}${r.session}${String(r.resultType).toUpperCase()}`
      };
    });

    res.status(200).json(rows);
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ message: err.message });
    }
    console.error('listForExport error:', err);
    res.status(500).json({ message: 'Server Error', error: err.message });
  }
}



/**
 * GET /api/results-export/health
 * Same filters as listForExport, but *only* returns problem groups:
 * results whose related course has missing/empty uamId.
 */
export async function exportHealth(req, res) {
  try {
    const { regNo, courseCode, session, level, semester, resultType } = req.query;

    const pipeline = [
      { $lookup: { from: 'students', localField: 'student', foreignField: '_id', as: 'studentInfo' } },
      { $unwind: '$studentInfo' },
      { $lookup: { from: 'courses', localField: 'course', foreignField: '_id', as: 'courseInfo' } },
      { $unwind: '$courseInfo' },
      {
        $addFields: {
          courseCodeNoSpace: { $replaceAll: { input: '$courseInfo.code', find: ' ', replacement: '' } }
        }
      }
    ];

    let scopeFilter = {};
    try {
      scopeFilter = buildDepartmentScopeFilter(req.user);
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ message: error.message });
      }
      throw error;
    }

    if (scopeFilter.department) {
      pipeline.push({
        $match: {
          'courseInfo.department': new mongoose.Types.ObjectId(scopeFilter.department),
        },
      });
    }

    // Build as AND conditions so we can include OR groups without clobbering
    const andConds = [];

    if (session)   andConds.push({ session });
    if (level)     andConds.push({ level });
    if (semester)  andConds.push({ semester: parseInt(semester, 10) });
    if (resultType) andConds.push({ resultType });
    if (regNo)     andConds.push({ 'studentInfo.regNo': { $regex: regNo, $options: 'i' } });

    if (courseCode) {
      const normalized = courseCode.replace(/\s+/g, '');
      andConds.push({
        $or: [
          { 'courseInfo.code': { $regex: courseCode.replace(/\s+/g, '\\s*'), $options: 'i' } },
          { courseCodeNoSpace: { $regex: normalized, $options: 'i' } }
        ]
      });
    }

    // Only BAD ones: uamId missing/blank/null
    andConds.push({
      $or: [
        { 'courseInfo.uamId': { $exists: false } },
        { 'courseInfo.uamId': '' },
        { 'courseInfo.uamId': null }
      ]
    });

    if (andConds.length) pipeline.push({ $match: { $and: andConds } });

    // Group by course to show a concise summary
    pipeline.push({
      $group: {
        _id: {
          courseId: '$courseInfo._id',
          courseCode: '$courseInfo.code',
          courseTitle: '$courseInfo.title'
        },
        count: { $sum: 1 },
        sessions:  { $addToSet: '$session' },
        semesters: { $addToSet: '$semester' },
        levels:    { $addToSet: '$level' }
      }
    });

    pipeline.push({ $sort: { count: -1 } });

    const issues = await Result.aggregate(pipeline).allowDiskUse(true);
    res.status(200).json({
      missingUamIdCount: issues.reduce((a, b) => a + b.count, 0),
      coursesWithIssues: issues
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ message: err.message });
    }
    console.error('exportHealth error:', err);
    res.status(500).json({ message: 'Server Error', error: err.message });
  }
}
