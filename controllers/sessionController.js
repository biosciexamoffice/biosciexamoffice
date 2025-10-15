import mongoose from "mongoose";
import Session from "../models/session.js";
import Student from "../models/student.js";
import Lecturer from "../models/lecturer.js";
import Result from "../models/result.js";
import AcademicMetrics from "../models/academicMetrics.js";

const sessionCache = new Map();

const invalidateSessionCache = () => {
  sessionCache.clear();
};

const createEmptyCloseSummary = () => ({
  canClose: false,
  blockingReasons: [],
  summary: {
    metrics: { total: 0, approved: 0, pending: 0, bySemester: {} },
    results: { total: 0, students: 0 },
    students: { finalYearActive: 0, withMetrics: 0 },
  },
  checkedAt: new Date().toISOString(),
});

const computeSessionCloseSummary = async (
  sessionDoc,
  { mongooseSession } = {}
) => {
  const base = createEmptyCloseSummary();

  if (!sessionDoc) {
    base.blockingReasons.push("Session not found.");
    return base;
  }

  const sessionTitle = sessionDoc.sessionTitle;
  base.sessionTitle = sessionTitle || "";

  if (!sessionTitle) {
    base.blockingReasons.push("Session title is missing.");
    return base;
  }

  try {
    const resultCountQuery = Result.countDocuments({ session: sessionTitle });
    if (mongooseSession) resultCountQuery.session(mongooseSession);
    const totalResults = await resultCountQuery.exec();

    let resultStudentQuery = Result.distinct("student", {
      session: sessionTitle,
    });
    if (mongooseSession) resultStudentQuery = resultStudentQuery.session(mongooseSession);
    const resultStudentIds = await resultStudentQuery.exec();

    const metricsPipeline = [
      { $match: { session: sessionTitle, level: 400 } },
      {
        $group: {
          _id: "$semester",
          total: { $sum: 1 },
          approved: {
            $sum: {
              $cond: [{ $eq: ["$ceoApproval.approved", true] }, 1, 0],
            },
          },
        },
      },
    ];

    let metricsAggregate = AcademicMetrics.aggregate(metricsPipeline);
    if (mongooseSession) metricsAggregate = metricsAggregate.session(mongooseSession);
    const metricsAgg = await metricsAggregate.exec();

    const metricsSummary = {
      total: 0,
      approved: 0,
      pending: 0,
      bySemester: {},
    };
    metricsAgg.forEach(({ _id: semester, total, approved }) => {
      const pending = total - approved;
      metricsSummary.total += total;
      metricsSummary.approved += approved;
      metricsSummary.pending += pending;
      metricsSummary.bySemester[String(semester)] = {
        total,
        approved,
        pending,
      };
    });

    let metricStudentsQuery = AcademicMetrics.distinct("student", {
      session: sessionTitle,
      level: 400,
    });
    if (mongooseSession)
      metricStudentsQuery = metricStudentsQuery.session(mongooseSession);
    const metricsStudentIds = await metricStudentsQuery.exec();

    const finalYearQuery = Student.countDocuments({
      level: { $in: ["400", "400L"] },
      status: { $in: ["undergraduate", "extraYear"] },
    });
    if (mongooseSession) finalYearQuery.session(mongooseSession);
    const finalYearActive = await finalYearQuery.exec();

    base.summary.results = {
      total: totalResults,
      students: resultStudentIds.length,
    };
    base.summary.metrics = metricsSummary;
    base.summary.students = {
      finalYearActive,
      withMetrics: metricsStudentIds.length,
    };

    if (!totalResults) {
      base.blockingReasons.push(
        "No results recorded for this session."
      );
    }
    if (!metricsSummary.total) {
      base.blockingReasons.push(
        "Academic metrics have not been computed for 400 level."
      );
    } else if (metricsSummary.pending > 0) {
      base.blockingReasons.push(
        `${metricsSummary.pending} academic metric record(s) pending approval for 400 level.`
      );
    }
  } catch (error) {
    base.blockingReasons.push(
      "Unable to evaluate session closing prerequisites."
    );
    base.error = error.message;
  }

  const alreadyCompleted = sessionDoc.status === "completed";
  if (alreadyCompleted) {
    base.blockingReasons.unshift("Session already marked as completed.");
  }

  base.canClose = base.blockingReasons.length === 0 && !alreadyCompleted;
  base.checkedAt = new Date().toISOString();
  return base;
};

const formatLecturerName = (lecturerDoc) => {
  if (!lecturerDoc) return "";
  const parts = [
    lecturerDoc.title,
    lecturerDoc.surname,
    lecturerDoc.firstname,
    lecturerDoc.middlename,
  ]
    .filter(Boolean)
    .map((part) => part.trim());
  return parts.join(" ");
};

const buildOfficerSnapshot = (lecturerDoc) => ({
  lecturer: lecturerDoc._id,
  name: formatLecturerName(lecturerDoc),
  pfNo: lecturerDoc.pfNo,
  department: lecturerDoc.department,
  title: lecturerDoc.title || "",
  rank: lecturerDoc.rank || "",
});

const promoteLowerLevels = async (dbSession) => {
  const promotionMap = [
    { from: "100", to: "200", key: "hundredToTwo" },
    { from: "200", to: "300", key: "twoToThree" },
    { from: "300", to: "400", key: "threeToFour" },
  ];

  const breakdown = {
    hundredToTwo: 0,
    twoToThree: 0,
    threeToFour: 0,
  };

  for (const { from, to, key } of promotionMap) {
    const { modifiedCount } = await Student.updateMany(
      {
        level: { $in: [from, `${from}L`] },
        status: { $ne: "graduated" },
      },
      { $set: { level: to } }
    )
      .session(dbSession)
      .exec();

    breakdown[key] = modifiedCount;
  }

  const promoted =
    breakdown.hundredToTwo + breakdown.twoToThree + breakdown.threeToFour;
  return { promoted, promotedBreakdown: breakdown };
};

const computeFinalYearOutcomes = async (finalYearStudents, dbSession) => {
  if (!finalYearStudents.length) {
    return { graduates: [], extraYear: [] };
  }

  const finalYearIds = finalYearStudents.map((student) => student._id);

  const outstandingFails = await Result.aggregate([
    { $match: { student: { $in: finalYearIds } } },
    {
      $sort: {
        student: 1,
        course: 1,
        date: -1,
        session: -1,
        semester: -1,
      },
    },
    {
      $group: {
        _id: { student: "$student", course: "$course" },
        latestGrade: { $first: "$grade" },
      },
    },
    { $match: { latestGrade: "F" } },
    { $group: { _id: "$_id.student" } },
  ])
    .session(dbSession)
    .exec();

  const failingSet = new Set(outstandingFails.map((doc) => doc._id.toString()));

  const graduates = [];
  const extraYear = [];

  finalYearStudents.forEach((student) => {
    const id = student._id.toString();
    if (failingSet.has(id)) {
      extraYear.push(student._id);
    } else {
      graduates.push(student._id);
    }
  });

  return { graduates, extraYear };
};

export const createSession = async (req, res) => {
  const dbSession = await mongoose.startSession();
  try {
    dbSession.startTransaction();

    const { sessionTitle, startDate, endDate, dean, hod, eo } = req.body;

    if (!sessionTitle || !startDate || !dean || !hod || !eo) {
      await dbSession.abortTransaction();
      return res.status(400).json({
        success: false,
        message: "Session title, start date, dean, HOD, and EO are required",
      });
    }

    const [deanLecturer, hodLecturer, eoLecturer] = await Promise.all([
      Lecturer.findOne({ pfNo: dean }).session(dbSession),
      Lecturer.findOne({ pfNo: hod }).session(dbSession),
      Lecturer.findOne({ pfNo: eo }).session(dbSession),
    ]);

    const missing = [];
    if (!deanLecturer) missing.push(`Dean (${dean})`);
    if (!hodLecturer) missing.push(`HOD (${hod})`);
    if (!eoLecturer) missing.push(`EO (${eo})`);

    if (missing.length) {
      await dbSession.abortTransaction();
      return res.status(404).json({
        success: false,
        message: `Lecturers not found: ${missing.join(", ")}`,
      });
    }

    await Session.updateMany(
      { isCurrent: true },
      { $set: { isCurrent: false } }
    )
      .session(dbSession)
      .exec();

    const [createdSession] = await Session.create(
      [
        {
          sessionTitle,
          startDate,
          endDate: endDate || undefined,
          status: "active",
          isCurrent: true,
          dean: deanLecturer._id,
          hod: hodLecturer._id,
          eo: eoLecturer._id,
          principalOfficers: {
            dean: buildOfficerSnapshot(deanLecturer),
            hod: buildOfficerSnapshot(hodLecturer),
            examOfficer: buildOfficerSnapshot(eoLecturer),
          },
          promotionStats: {
            promoted: 0,
            promotedBreakdown: {
              hundredToTwo: 0,
              twoToThree: 0,
              threeToFour: 0,
            },
            graduated: 0,
            extraYear: 0,
            totalProcessed: 0,
          },
        },
      ],
      { session: dbSession }
    );

    await dbSession.commitTransaction();
    invalidateSessionCache();

    res.status(201).json({
      success: true,
      message: "Session created successfully",
      session: formatSessionResponse(createdSession, {
        closeSummary: createEmptyCloseSummary(),
      }),
    });
  } catch (error) {
    await dbSession.abortTransaction();
    console.error("Session creation error:", error);
    res.status(500).json({
      success: false,
      message: "Error creating session",
      error: error.message,
    });
  } finally {
    dbSession.endSession();
  }
};

export const closeSession = async (req, res) => {
  const dbSession = await mongoose.startSession();
  try {
    dbSession.startTransaction();

    const { id } = req.params;
    const { endDate } = req.body || {};

    const sessionDoc = await Session.findById(id).session(dbSession);
    if (!sessionDoc) {
      await dbSession.abortTransaction();
      return res.status(404).json({
        success: false,
        message: "Session not found",
      });
    }

    if (sessionDoc.status === "completed") {
      await dbSession.abortTransaction();
      return res.status(400).json({
        success: false,
        message: "Session has already been closed",
      });
    }

    const closeSummary = await computeSessionCloseSummary(sessionDoc, {
      mongooseSession: dbSession,
    });

    if (!closeSummary.canClose) {
      await dbSession.abortTransaction();
      return res.status(400).json({
        success: false,
        message:
          "Session cannot be closed yet. Complete outstanding result processing tasks first.",
        blockers: closeSummary.blockingReasons,
        closeSummary,
      });
    }

    const finalYearStudents = await Student.find({
      level: { $in: ["400", "400L"] },
      status: { $ne: "graduated" },
    })
      .session(dbSession)
      .select("_id status");

    const { graduates, extraYear } = await computeFinalYearOutcomes(
      finalYearStudents,
      dbSession
    );

    let graduatedCount = 0;
    let extraYearCount = 0;

    if (graduates.length) {
      const { modifiedCount } = await Student.updateMany(
        { _id: { $in: graduates } },
        { $set: { status: "graduated" } }
      )
        .session(dbSession)
        .exec();
      graduatedCount = modifiedCount;
    }

    if (extraYear.length) {
      const { modifiedCount } = await Student.updateMany(
        { _id: { $in: extraYear } },
        { $set: { status: "extraYear" } }
      )
        .session(dbSession)
        .exec();
      extraYearCount = modifiedCount;
    }

    const promotionOutcome = await promoteLowerLevels(dbSession);

    sessionDoc.status = "completed";
    sessionDoc.isCurrent = false;
    sessionDoc.endDate = endDate ? new Date(endDate) : sessionDoc.endDate || new Date();
    sessionDoc.closedAt = new Date();
    sessionDoc.promotionStats = {
      promoted: promotionOutcome.promoted,
      promotedBreakdown: promotionOutcome.promotedBreakdown,
      graduated: graduatedCount,
      extraYear: extraYearCount,
      totalProcessed:
        promotionOutcome.promoted + finalYearStudents.length,
    };

    await sessionDoc.save({ session: dbSession });

    await dbSession.commitTransaction();
    invalidateSessionCache();

    res.status(200).json({
      success: true,
      message: "Session closed successfully",
      session: formatSessionResponse(sessionDoc.toObject(), {
        closeSummary: {
          ...closeSummary,
          canClose: false,
          blockingReasons: ["Session already marked as completed."],
          checkedAt: new Date().toISOString(),
        },
      }),
    });
  } catch (error) {
    await dbSession.abortTransaction();
    console.error("Session closing error:", error);
    res.status(500).json({
      success: false,
      message: "Error closing session",
      error: error.message,
    });
  } finally {
    dbSession.endSession();
  }
};

export const getSessions = async (_req, res) => {
  try {
    const cacheKey = "all_sessions";
    if (sessionCache.has(cacheKey)) {
      return res.status(200).json({
        success: true,
        fromCache: true,
        ...sessionCache.get(cacheKey),
      });
    }

    const sessions = await Session.find()
      .populate(
        "dean hod eo",
        "title surname firstname middlename pfNo department rank"
      )
      .sort({ startDate: -1 })
      .lean();

    const formatted = await Promise.all(
      sessions.map(async (session) => {
        const normalizedStatus =
          typeof session.status === "string"
            ? session.status.toLowerCase()
            : "";
        const isCurrent =
          typeof session.isCurrent === "boolean"
            ? session.isCurrent
            : normalizedStatus !== "completed";

        let closeSummary = null;
        if (isCurrent && normalizedStatus !== "completed") {
          closeSummary = await computeSessionCloseSummary(session);
        }

        return formatSessionResponse(session, { closeSummary });
      })
    );

    const payload = { count: formatted.length, sessions: formatted };
    sessionCache.set(cacheKey, payload);
    setTimeout(() => sessionCache.delete(cacheKey), 300000);

    res.status(200).json({
      success: true,
      fromCache: false,
      ...payload,
    });
  } catch (error) {
    console.error("Get sessions error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching sessions",
      error: error.message,
    });
  }
};

export const getCurrentSession = async (_req, res) => {
  try {
    const cacheKey = "current_session";
    if (sessionCache.has(cacheKey)) {
      return res.status(200).json({
        success: true,
        fromCache: true,
        session: sessionCache.get(cacheKey),
      });
    }

    const currentSession = await Session.findOne({ isCurrent: true })
      .populate(
        "dean hod eo",
        "title surname firstname middlename pfNo department rank"
      )
      .lean();

    if (!currentSession) {
      return res.status(404).json({
        success: false,
        message: "No active session found",
      });
    }

    const closeSummary = await computeSessionCloseSummary(currentSession);
    const formatted = formatSessionResponse(currentSession, { closeSummary });
    sessionCache.set(cacheKey, formatted);
    setTimeout(() => sessionCache.delete(cacheKey), 60000);

    res.status(200).json({
      success: true,
      fromCache: false,
      session: formatted,
    });
  } catch (error) {
    console.error("Get current session error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching current session",
      error: error.message,
    });
  }
};

const officerFromSnapshot = (snapshot, fallback) => {
  if (snapshot && snapshot.name) {
    return {
      ...snapshot,
      lecturerId: snapshot.lecturer,
    };
  }

  if (!fallback) return null;

  const doc =
    typeof fallback === "object" && "_id" in fallback ? fallback : null;
  if (!doc) return null;

  return {
    lecturerId: doc._id,
    name: formatLecturerName(doc),
    pfNo: doc.pfNo,
    department: doc.department,
    title: doc.title || "",
    rank: doc.rank || "",
  };
};

const formatSessionResponse = (session, options = {}) => {
  if (!session) return null;

  const officers = {
    dean: officerFromSnapshot(
      session.principalOfficers?.dean,
      session.dean
    ),
    hod: officerFromSnapshot(
      session.principalOfficers?.hod,
      session.hod
    ),
    examOfficer: officerFromSnapshot(
      session.principalOfficers?.examOfficer,
      session.eo
    ),
  };

  const promotionStats = session.promotionStats || {
    promoted: 0,
    promotedBreakdown: {
      hundredToTwo: 0,
      twoToThree: 0,
      threeToFour: 0,
    },
    graduated: 0,
    extraYear: 0,
      totalProcessed: 0,
  };

  const normalizedStatus =
    typeof session.status === "string" ? session.status.toLowerCase() : "";
  const inferredIsCurrent =
    typeof session.isCurrent === "boolean"
      ? session.isCurrent
      : normalizedStatus !== "completed";
  const status = inferredIsCurrent ? "active" : "completed";

  return {
    id: session._id,
    sessionTitle: session.sessionTitle,
    startDate: session.startDate,
    endDate: session.endDate,
    status,
    isCurrent: inferredIsCurrent,
    closedAt: session.closedAt || null,
    officers,
    dean: officers.dean,
    hod: officers.hod,
    eo: officers.examOfficer,
    promotionStats,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    closeSummary: options.closeSummary ?? null,
  };
};

export default {
  createSession,
  closeSession,
  getSessions,
  getCurrentSession,
};
