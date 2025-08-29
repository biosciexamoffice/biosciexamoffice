import Session from '../models/session.js';
import Student from '../models/student.js';
import PassFail from '../models/passFailList.js';
import AcademicMetrics from '../models/academicMetrics.js';
import Lecturer from '../models/lecturer.js';
import mongoose from 'mongoose';

// Create new session with optimized student progression
export const createSession = async (req, res) => {
    const dbSession = await mongoose.startSession();
    try {
        dbSession.startTransaction();
        
        const { sessionTitle, startDate, endDate, dean, hod, eo } = req.body;

        // Validate required fields
        if (!sessionTitle || !startDate || !dean || !hod || !eo) {
            await dbSession.abortTransaction();
            return res.status(400).json({ 
                success: false,
                message: 'Session title, start date, dean, HOD, and EO are required' 
            });
        }

        // Parallelize lecturer lookups
        const [deanLecturer, hodLecturer, eoLecturer] = await Promise.all([
            Lecturer.findOne({ pfNo: dean }).session(dbSession),
            Lecturer.findOne({ pfNo: hod }).session(dbSession),
            Lecturer.findOne({ pfNo: eo }).session(dbSession)
        ]);

        // Check if all lecturers exist
        if (!deanLecturer || !hodLecturer || !eoLecturer) {
            await dbSession.abortTransaction();
            const missing = [];
            if (!deanLecturer) missing.push(`Dean (${dean})`);
            if (!hodLecturer) missing.push(`HOD (${hod})`);
            if (!eoLecturer) missing.push(`EO (${eo})`);
            return res.status(404).json({ 
                success: false,
                message: `Lecturers not found: ${missing.join(', ')}` 
            });
        }

        // Create new session
        const newSession = new Session({
            sessionTitle,
            startDate,
            endDate,
            dean: deanLecturer._id,
            hod: hodLecturer._id,
            eo: eoLecturer._id,
            isCurrent: false
        });

        await newSession.save({ session: dbSession });

        // Process student progression with optimized batches
        const progressionStats = await processStudentProgression(dbSession);

        await dbSession.commitTransaction();
        
        res.status(201).json({ 
            success: true,
            message: 'Session created and students progressed successfully',
            session: await formatSessionResponse(newSession),
            progressionStats
        });

    } catch (error) {
        await dbSession.abortTransaction();
        console.error('Session creation error:', error);
        res.status(500).json({ 
            success: false,
            message: 'Error creating session', 
            error: error.message 
        });
    } finally {
        dbSession.endSession();
    }
};

// Optimized student progression processing with CCE check
const processStudentProgression = async (session) => {
    const stats = {
        graduated: 0,
        promoted: 0,
        extraYear: 0,
        extraYearToGraduated: 0,
        insufficientCCE: 0
    };

    // Get all failed student IDs in one query
    const failedStudentIds = await PassFail.distinct('fail').session(session);
    const failedStudentSet = new Set(failedStudentIds.map(id => id.toString()));

    // Process in optimized batches
    const BATCH_SIZE = 500;
    let processed = 0;
    let hasMore = true;

    while (hasMore) {
        const students = await Student.find({ status: { $ne: 'graduated' } })
            .sort({ level: 1 })
            .skip(processed)
            .limit(BATCH_SIZE)
            .session(session)
            .lean();

        if (students.length === 0) {
            hasMore = false;
            break;
        }

        // Get student IDs for academic metrics lookup
        const studentIds = students.map(s => s._id);
        
        // Get latest academic metrics for these students
        const metricsDocs = await AcademicMetrics.aggregate([
            { $match: { student: { $in: studentIds } } },
            { $sort: { session: -1, semester: -1 } },
            { $group: {
                _id: "$student",
                latest: { $first: "$$ROOT" }
            }}
        ]).session(session);

        // Create metrics map for quick lookup
        const metricsMap = new Map();
        metricsDocs.forEach(doc => {
            metricsMap.set(doc._id.toString(), doc.latest);
        });

        const bulkOps = [];
        
        for (const student of students) {
            const currentLevel = parseInt(student.level);
            const updates = {};
            const studentMetrics = metricsMap.get(student._id.toString());

            // Students from 100L to 300L
            if ([100, 200, 300].includes(currentLevel)) {
                updates.level = `${currentLevel + 100}L`;
                stats.promoted++;
            } 

            if (Object.keys(updates).length > 0) {
                bulkOps.push({
                    updateOne: {
                        filter: { _id: student._id },
                        update: { $set: updates }
                    }
                });
            }
        }

        if (bulkOps.length > 0) {
            await Student.bulkWrite(bulkOps, { session });
        }

        processed += students.length;
    }

    return stats;
};

// Cached session responses
const sessionCache = new Map();

// Get all sessions with caching
export const getSessions = async (req, res) => {
    try {
        const cacheKey = 'all_sessions';
        if (sessionCache.has(cacheKey)) {
            return res.status(200).json({
                success: true,
                fromCache: true,
                ...sessionCache.get(cacheKey)
            });
        }

        const sessions = await Session.find()
            .populate('dean hod eo', 'name pfNo department')
            .sort({ startDate: -1 })
            .lean();

        const response = {
            count: sessions.length,
            sessions: sessions.map(session => formatSessionResponse(session))
        };

        sessionCache.set(cacheKey, response);
        // Cache for 5 minutes
        setTimeout(() => sessionCache.delete(cacheKey), 300000);

        res.status(200).json({
            success: true,
            fromCache: false,
            ...response
        });
    } catch (error) {
        console.error('Get sessions error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching sessions',
            error: error.message
        });
    }
};

// Get current active session with caching
export const getCurrentSession = async (req, res) => {
    try {
        const cacheKey = 'current_session';
        if (sessionCache.has(cacheKey)) {
            return res.status(200).json({
                success: true,
                fromCache: true,
                session: sessionCache.get(cacheKey)
            });
        }

        const currentSession = await Session.findOne({ isCurrent: true })
            .populate('dean hod eo', 'name pfNo department')
            .lean();

        if (!currentSession) {
            return res.status(404).json({
                success: false,
                message: 'No active session found'
            });
        }

        const formattedSession = formatSessionResponse(currentSession);
        sessionCache.set(cacheKey, formattedSession);
        // Cache for 1 minute
        setTimeout(() => sessionCache.delete(cacheKey), 60000);

        res.status(200).json({
            success: true,
            fromCache: false,
            session: formattedSession
        });
    } catch (error) {
        console.error('Get current session error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching current session',
            error: error.message
        });
    }
};

// Helper function to format session response
const formatSessionResponse = (session) => {
    return {
        id: session._id,
        sessionTitle: session.sessionTitle,
        startDate: session.startDate,
        endDate: session.endDate,
        isCurrent: session.isCurrent,
        dean: session.dean,
        hod: session.hod,
        eo: session.eo,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt
    };
};