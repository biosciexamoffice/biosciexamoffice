import mongoose from "mongoose";
import Session from "../models/session.js";
import Student from "../models/student.js";
import Lecturer from "../models/lecturer.js";
import Result from "../models/result.js";

const sessionCache = new Map();

const invalidateSessionCache = () => {
  sessionCache.clear();
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
      session: formatSessionResponse(createdSession),
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
      session: formatSessionResponse(sessionDoc.toObject()),
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
      .populate("dean hod eo", "title surname firstname middlename pfNo department rank")
      .sort({ startDate: -1 })
      .lean();

    const formatted = sessions.map((session) => formatSessionResponse(session));

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
      .populate("dean hod eo", "title surname firstname middlename pfNo department rank")
      .lean();

    if (!currentSession) {
      return res.status(404).json({
        success: false,
        message: "No active session found",
      });
    }

    const formatted = formatSessionResponse(currentSession);
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

const formatSessionResponse = (session) => {
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

  return {
    id: session._id,
    sessionTitle: session.sessionTitle,
    startDate: session.startDate,
    endDate: session.endDate,
    status: session.status || (session.isCurrent ? "active" : "completed"),
    isCurrent: session.isCurrent ?? session.status !== "completed",
    closedAt: session.closedAt || null,
    officers,
    dean: officers.dean,
    hod: officers.hod,
    eo: officers.examOfficer,
    promotionStats,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
};

export default {
  createSession,
  closeSession,
  getSessions,
  getCurrentSession,
};
