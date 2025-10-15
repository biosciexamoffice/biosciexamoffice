import AcademicMetrics from '../models/academicMetrics.js';
import Result from '../models/result.js';
import CourseRegistration from '../models/courseRegistration.js';

const normalizeApproval = (approval = {}) => ({
  approved: Boolean(approval?.approved),
  flagged: Boolean(approval?.flagged),
  name: approval?.name || '',
  title: approval?.title || '',
  surname: approval?.surname || '',
  firstname: approval?.firstname || '',
  middlename: approval?.middlename || '',
  department: approval?.department || '',
  college: approval?.college || '',
  note: approval?.note || '',
  updatedAt: approval?.updatedAt || null,
});

const ROLE_CONFIG = {
  COLLEGE_OFFICER: {
    filter: { 'ceoApproval.approved': { $ne: true } },
  },
  HOD: {
    filter: {
      'ceoApproval.approved': true,
      'hodApproval.approved': { $ne: true },
    },
  },
  DEAN: {
    filter: {
      'ceoApproval.approved': true,
      'hodApproval.approved': true,
      'deanApproval.approved': { $ne: true },
    },
  },
};

const buildStudentPayload = (metricsDoc, studentDoc, courses = [], department = null, college = null) => ({
  metricsId: metricsDoc._id,
  session: metricsDoc.session,
  semester: metricsDoc.semester,
  level: metricsDoc.level,
  department: department || null,
  college: college || metricsDoc.college || null,
  currentMetrics: {
    TCC: metricsDoc.TCC,
    TCE: metricsDoc.TCE,
    TPE: metricsDoc.TPE,
    GPA: metricsDoc.GPA,
  },
  previousMetrics: {
    CCC: metricsDoc.previousMetrics?.CCC ?? 0,
    CCE: metricsDoc.previousMetrics?.CCE ?? 0,
    CPE: metricsDoc.previousMetrics?.CPE ?? 0,
    CGPA: metricsDoc.previousMetrics?.CGPA ?? 0,
  },
  cumulative: {
    CCC: metricsDoc.CCC,
    CCE: metricsDoc.CCE,
    CPE: metricsDoc.CPE,
    CGPA: metricsDoc.CGPA,
  },
  student: studentDoc
    ? {
        id: studentDoc._id,
        regNo: studentDoc.regNo,
        fullName: `${studentDoc.surname} ${studentDoc.firstname} ${studentDoc.middlename || ''}`.trim(),
        status: studentDoc.status,
        standing: studentDoc.standing,
      }
    : null,
  approvals: {
    ceo: normalizeApproval(metricsDoc.ceoApproval),
    hod: normalizeApproval(metricsDoc.hodApproval),
    dean: normalizeApproval(metricsDoc.deanApproval),
  },
  courses,
});

export const getPendingApprovals = async (req, res) => {
  try {
    const roleParam = String(req.query.role || '').toUpperCase();
    const config = ROLE_CONFIG[roleParam];
    if (!config) {
      return res.status(400).json({ success: false, message: 'Invalid role supplied.' });
    }

    const userRoles = req.user?.roles || [];
    const isAllowed = userRoles.includes(roleParam) || userRoles.includes('ADMIN');
    if (!isAllowed) {
      return res.status(403).json({ success: false, message: 'Forbidden.' });
    }

  const match = { ...config.filter };
  if (req.query.session) match.session = req.query.session;
  if (req.query.semester) match.semester = Number(req.query.semester);
  if (req.query.level) match.level = Number(req.query.level);

  const departmentScopeId = roleParam === 'HOD' && req.user?.departmentId
    ? String(req.user.departmentId)
    : '';
  const departmentScopeName = roleParam === 'HOD' && req.user?.department
    ? String(req.user.department).trim().toLowerCase()
    : '';

  if (roleParam === 'HOD' && !departmentScopeId && !departmentScopeName) {
    return res.status(403).json({ success: false, message: 'Department assignment required for HOD approvals.' });
  }

  let metricsQuery = AcademicMetrics.find(match)
    .populate({
      path: 'student',
        select: 'surname firstname middlename regNo status standing department college',
        populate: [
          { path: 'department', select: 'name' },
          { path: 'college', select: 'name' },
        ],
      })
      .sort({ updatedAt: -1 });

    if (roleParam !== 'COLLEGE_OFFICER') {
      metricsQuery = metricsQuery.limit(100);
    }

    const metricsDocs = await metricsQuery.lean();

    const normalizeDeptId = (value) => {
      if (!value) return null;
      if (value._id) return String(value._id);
      if (typeof value === 'object' && typeof value.toString === 'function') {
        return String(value.toString());
      }
      return String(value);
    };

    const normalizeDeptName = (value) => {
      if (!value) return '';
      if (typeof value === 'string') return value.trim().toLowerCase();
      if (value.name) return String(value.name).trim().toLowerCase();
      if (typeof value === 'object' && typeof value.toString === 'function') {
        return String(value.toString()).trim().toLowerCase();
      }
      return '';
    };

    const departmentFilter =
      roleParam === 'HOD'
        ? {
            id: departmentScopeId || null,
            name: departmentScopeName || '',
          }
        : null;

    const filteredMetrics = departmentFilter
      ? metricsDocs.filter((metrics) => {
          const candidateDepartments = [
            metrics.student?.department,
            metrics.department,
          ];

          return candidateDepartments.some((value) => {
            if (!value) return false;
            const deptId = normalizeDeptId(value);
            const deptName = normalizeDeptName(value);

            if (departmentFilter.id && deptId && deptId === departmentFilter.id) {
              return true;
            }

            if (departmentFilter.name && deptName && deptName === departmentFilter.name) {
              return true;
            }

            return false;
          });
        })
      : metricsDocs;

    const items = await Promise.all(
      filteredMetrics.map(async (metrics) => {
        const studentId = metrics.student?._id;
        const studentDeptDoc = metrics.student?.department;
        const studentCollegeDoc = metrics.student?.college;
        const studentDepartmentId = normalizeDeptId(studentDeptDoc);
        const metricsDepartmentName = normalizeDeptName(metrics.department);
        const departmentName =
          metrics.department ||
          studentDeptDoc?.name ||
          (typeof studentDeptDoc === 'string' ? studentDeptDoc : null);
        const collegeName =
          metrics.college ||
          studentCollegeDoc?.name ||
          (typeof studentCollegeDoc === 'string' ? studentCollegeDoc : null);
        const matchesDepartment = (deptValue) => {
          if (!departmentFilter) return true;
          const deptId = normalizeDeptId(deptValue);
          const deptName = normalizeDeptName(deptValue);
          if (departmentFilter.id && deptId && deptId === departmentFilter.id) {
            return true;
          }
          if (departmentFilter.name && deptName && deptName === departmentFilter.name) {
            return true;
          }
          if (
            departmentFilter.id &&
            studentDepartmentId &&
            studentDepartmentId === departmentFilter.id
          ) {
            return true;
          }
          if (
            departmentFilter.name &&
            studentDeptDoc &&
            normalizeDeptName(studentDeptDoc) === departmentFilter.name
          ) {
            return true;
          }
          if (departmentFilter.name && metricsDepartmentName && metricsDepartmentName === departmentFilter.name) {
            return true;
          }
          return false;
        };
        let courses = [];

      if (studentId) {
        const resultsRaw = await Result.find({
          student: studentId,
          session: metrics.session,
          semester: metrics.semester,
          level: String(metrics.level),
        })
          .populate('course', 'code title unit option department')
          .sort({ course: 1 })
          .lean();

        const results = departmentFilter
          ? resultsRaw.filter((result) => matchesDepartment(result.course?.department))
          : resultsRaw;

        const registrationsRaw = await CourseRegistration.find({
          session: metrics.session,
          semester: metrics.semester,
          level: String(metrics.level),
          student: studentId,
        })
          .populate('course', 'code title unit option department')
          .lean();

        const registrations = departmentFilter
          ? registrationsRaw.filter((registration) => matchesDepartment(registration.course?.department))
          : registrationsRaw;

        const resultMap = new Map();
        results.forEach((result) => {
          const courseId = String(result.course?._id || result.course || '');
          if (!courseId) return;
          resultMap.set(courseId, result);
        });

        const registeredCourseMap = new Map();
        registrations.forEach((registration) => {
          const courseDoc = registration.course;
          if (!courseDoc) return;
          const courseId = String(courseDoc._id || '');
          if (!courseId) return;
          if (!registeredCourseMap.has(courseId)) {
            registeredCourseMap.set(courseId, courseDoc);
          }
        });

        const combinedCourses = [];

        registeredCourseMap.forEach((courseDoc, courseId) => {
          const result = resultMap.get(courseId);
          if (result) {
            const numericScore = Number(result.grandtotal ?? 0);
            combinedCourses.push({
              id: result._id,
              courseId,
              code: courseDoc?.code || result.course?.code || '',
              title: courseDoc?.title || result.course?.title || '',
              unit: courseDoc?.unit ?? result.course?.unit ?? null,
              option: courseDoc?.option || result.course?.option || '',
              resultType: result.resultType,
              score: result.grandtotal ?? null,
              grade: result.grade || '',
              flagged: (result.grade || '').toUpperCase() === 'F' || numericScore < 40,
              date: result.date || null,
              registeredOnly: false,
            });
            resultMap.delete(courseId);
          } else {
            combinedCourses.push({
              id: `reg-${studentId}-${courseId}`,
              courseId,
              code: courseDoc?.code || '',
              title: courseDoc?.title || '',
              unit: courseDoc?.unit ?? null,
              option: courseDoc?.option || '',
              resultType: 'Registered',
              score: 0,
              grade: 'F',
              flagged: true,
              date: null,
              registeredOnly: true,
            });
          }
        });

        combinedCourses.sort((a, b) => String(a.code || '').localeCompare(String(b.code || '')));
        courses = combinedCourses;

      }

        if (!courses.length) {
          return null;
        }

        return buildStudentPayload(
          metrics,
          metrics.student,
          courses,
          departmentName,
          collegeName
        );
      })
    );

    res.status(200).json({ success: true, items: items.filter(Boolean) });
  } catch (err) {
    console.error('getPendingApprovals error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch pending approvals.' });
  }
};
