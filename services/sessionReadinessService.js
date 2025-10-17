import AcademicMetrics from '../models/academicMetrics.js';
import Student from '../models/student.js';
import Result from '../models/result.js';

/**
 * Checks if a session is ready to be closed by verifying all academic metrics are approved.
 * @param {object} session - The session document to check.
 * @returns {Promise<object>} A summary of the session's readiness status.
 */
export const getSessionReadiness = async (session) => {
  if (!session || !session.sessionTitle) {
    return {
      canClose: false,
      blockingReasons: ['Invalid session provided.'],
      summary: { metrics: { total: 0, approved: 0, pending: 0, bySemester: {} } },
      checkedAt: new Date(),
    };
  }

  const departmentId = session.department?._id || session.department;
  const departmentName = session.department?.name;

  const departmentIdFilter = departmentId ? { department: departmentId } : {};
  // AcademicMetrics uses department name, not ID.
  const departmentNameFilter = departmentName ? { department: departmentName } : {};

  // Find all academic metrics for the given session.
  const metrics = await AcademicMetrics.find({
    session: session.sessionTitle,
    ...departmentNameFilter,
  })
    .select('semester level ceoApproval hodApproval deanApproval')
    .lean();

  const results = await Result.find({ session: session.sessionTitle, ...departmentIdFilter })
    .select('student')
    .lean();

  const finalYearStudents = await Student.countDocuments({ level: '400', status: 'undergraduate', ...departmentIdFilter, });
  const finalYearWithMetrics = await AcademicMetrics.countDocuments({ session: session.sessionTitle, level: 400, ...departmentNameFilter, });

  let pendingCount = 0;
  let approvedCount = 0;
  const bySemester = {};

  metrics.forEach((metric) => {
    const sem = metric.semester;
    if (!bySemester[sem]) {
      bySemester[sem] = { total: 0, approved: 0, pending: 0 };
    }
    bySemester[sem].total += 1;

    // A metric is considered fully approved only when the Dean has approved it.
    if (metric.deanApproval?.approved) {
      approvedCount++;
      bySemester[sem].approved += 1;
    } else {
      pendingCount++;
      bySemester[sem].pending += 1;
    }
  });

  const blockingReasons = [];
  if (pendingCount > 0) {
    blockingReasons.push(`${pendingCount} result(s) are pending final approval from the Dean.`);
  }

  // A session can only close if there are metrics to process and all of them are approved.
  // If there are no metrics for this department, it's not "ready", but it also has no "pending" tasks.
  const hasMetricsToProcess = metrics.length > 0;
  const canClose = hasMetricsToProcess && pendingCount === 0;

  return {
    canClose,
    blockingReasons,
    summary: {
      metrics: {
        total: metrics.length,
        approved: approvedCount,
        pending: pendingCount,
        bySemester,
      },
      results: {
        total: results.length,
        students: new Set(results.map(r => String(r.student))).size,
      },
      students: { finalYearActive: finalYearStudents, withMetrics: finalYearWithMetrics },
    },
    checkedAt: new Date(),
  };
};