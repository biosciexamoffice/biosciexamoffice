import mongoose from 'mongoose';
import Session from '../models/session.js';
import Lecturer from '../models/lecturer.js';
import Student from '../models/student.js';
import {
  buildDepartmentScopeFilter,
  ensureUserCanAccessDepartment,
} from '../services/accessControl.js';
import { getSessionReadiness } from '../services/sessionReadinessService.js';

const fetchOfficerDetails = async (pfNo) => {
  if (!pfNo) return null;
  const lecturer = await Lecturer.findOne({ pfNo }).lean({ virtuals: true });
  if (!lecturer) return null;
  // Manually construct the name to ensure it's always present, even if virtuals fail.
  const fullName = lecturer.name || [lecturer.title, lecturer.surname, lecturer.firstname, lecturer.middlename].filter(Boolean).join(' ');
  return {
    lecturer: lecturer._id,
    name: fullName,
    pfNo: lecturer.pfNo,
    department: lecturer.department,
    college: lecturer.college,
    title: lecturer.title,
    rank: lecturer.rank,
  };
};

export const createSession = async (req, res) => {
  const { sessionTitle, startDate, endDate, dean, hod, eo } = req.body;

  try {
    // 1. Deactivate any existing "current" session
    await Session.updateMany({ isCurrent: true }, { $set: { isCurrent: false } });

    // 2. Fetch officer details to create snapshots
    const [deanDetails, hodDetails, eoDetails] = await Promise.all([
      fetchOfficerDetails(dean),
      fetchOfficerDetails(hod),
      fetchOfficerDetails(eo),
    ]);

    if (!deanDetails || !hodDetails || !eoDetails) {
      return res.status(400).json({
        success: false,
        message: 'One or more principal officers could not be found. Please check the PF numbers.',
      });
    }

    // 3. Create the new session
    const newSession = new Session({
      sessionTitle,
      startDate,
      endDate: endDate || null,
      isCurrent: true,
      status: 'active',
      dean: deanDetails.lecturer,
      hod: hodDetails.lecturer,
      eo: eoDetails.lecturer,
      college: deanDetails.college, // Assuming Dean's college is the session's college
      department: hodDetails.department, // Assuming HOD's department is the session's department
      principalOfficers: {
        dean: deanDetails,
        hod: hodDetails,
        examOfficer: eoDetails,
      },
    });

    await newSession.save();

    res.status(201).json({
      success: true,
      message: 'Academic session created successfully.',
      session: newSession,
    });
  } catch (error) {
    console.error('Session creation error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'An unexpected error occurred during session creation.',
    });
  }
};

export const getSessions = async (req, res) => {
  try {
    const scopeFilter = buildDepartmentScopeFilter(req.user);
    if (scopeFilter.department && !mongoose.Types.ObjectId.isValid(scopeFilter.department)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid department scope for user.',
      });
    }
    const sessions = await Session.find(scopeFilter)
      .sort({ startDate: -1 })
      .populate({
        path: 'principalOfficers.dean.department principalOfficers.hod.department principalOfficers.examOfficer.department',
        select: 'name'
      })
      .populate('department', 'name')
      .lean();

    const sessionsWithReadiness = await Promise.all(
      sessions.map(async (session) => {
        if (session.status === 'active') {
          const closeSummary = await getSessionReadiness(session);
          return { ...session, closeSummary };
        }
        return session;
      })
    );

    res.status(200).json({ success: true, sessions: sessionsWithReadiness });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getCurrentSession = async (req, res) => {
  try {
    const scopeFilter = buildDepartmentScopeFilter(req.user);
    if (scopeFilter.department && !mongoose.Types.ObjectId.isValid(scopeFilter.department)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid department scope for user.',
      });
    }

    const currentSession = await Session.findOne({ isCurrent: true, ...scopeFilter })
      .populate({
        path: 'principalOfficers.dean.department principalOfficers.hod.department principalOfficers.examOfficer.department',
        select: 'name'
      })
      .populate('department', 'name')
      .lean();

    if (!currentSession) {
      return res.status(200).json({ success: true, session: null });
    }

    const closeSummary = await getSessionReadiness(currentSession);
    res.status(200).json({ success: true, session: { ...currentSession, closeSummary } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const closeSession = async (req, res) => {
  const { id } = req.params;
  const { endDate } = req.body;

  // Ensure user has access before proceeding
  try {
    const sessionToClose = await Session.findById(id).select('department college').lean();
    ensureUserCanAccessDepartment(req.user, sessionToClose.department, sessionToClose.college);
  } catch (accessError) {
    return res.status(accessError.statusCode || 403).json({ success: false, message: accessError.message });
  }
  try {
    const session = await Session.findById(id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found.' });
    }

    if (session.status === 'completed') {
      return res.status(400).json({ success: false, message: 'Session is already closed.' });
    }

    // Re-verify readiness within the transaction
    const readiness = await getSessionReadiness(session);
    if (!readiness.canClose) {
      return res.status(400).json({
        success: false,
        message: 'Session is not ready to be closed.',
        blockingReasons: readiness.blockingReasons,
      });
    }

    // 1. Promote lower-level students
    const promotionMap = [
      { from: '100', to: '200', key: 'hundredToTwo' },
      { from: '200', to: '300', key: 'twoToThree' },
      { from: '300', to: '400', key: 'threeToFour' },
    ];
    const promotedBreakdown = {};
    let totalPromoted = 0;

    for (const { from, to, key } of promotionMap) {
      const { modifiedCount } = await Student.updateMany(
        { level: from, status: 'undergraduate' },
        { $set: { level: to } },
      );
      promotedBreakdown[key] = modifiedCount;
      totalPromoted += modifiedCount;
    }

    // 2. Handle final year students (this is a simplified logic)
    // A more robust implementation would check for outstanding courses.
    const { modifiedCount: graduatedCount } = await Student.updateMany(
      { level: '400', status: 'undergraduate' },
      { $set: { status: 'graduated' } },
    );

    // 3. Update the session document
    session.status = 'completed';
    session.isCurrent = false;
    session.endDate = endDate ? new Date(endDate) : new Date();
    session.closedAt = new Date();
    session.promotionStats = {
      promoted: totalPromoted,
      promotedBreakdown,
      graduated: graduatedCount,
      extraYear: 0, // Simplified for now
      totalProcessed: totalPromoted + graduatedCount,
    };
    await session.save();

    res.status(200).json({ success: true, message: 'Session closed and students promoted.', session });
  } catch (error) {
    console.error('Error closing session:', error);
    res.status(500).json({ success: false, message: 'An error occurred while closing the session.' });
  }
};