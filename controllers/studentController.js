import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import Student from "../models/student.js";
import Session from "../models/session.js";
import StandingRecord from "../models/standingRecord.js";
import { validateInstitutionHierarchy } from "../services/institutionService.js";
import {
  buildDepartmentScopeFilter,
  ensureResourceMatchesUserScope,
  ensureUserCanAccessDepartment,
} from "../services/accessControl.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STANDING_OPTIONS = ["goodstanding", "deferred", "withdrawn", "readmitted"];
const STANDING_DETAILS_REQUIRED = new Set(["deferred", "withdrawn", "readmitted"]);
const EVIDENCE_REQUIRED = new Set(["deferred", "withdrawn", "readmitted"]);
const SEMESTER_OPTIONS = new Set(["first", "second", "both"]);
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/jpg", "image/webp"]);

const resolveStoredPath = (storedPath) => {
  if (!storedPath) return null;
  const sanitized = storedPath.startsWith("/") ? storedPath.slice(1) : storedPath;
  return path.resolve(__dirname, "..", sanitized);
};

const removeExistingFile = async (storedPath) => {
  const absolutePath = resolveStoredPath(storedPath);
  if (!absolutePath) return;

  try {
    await fs.promises.access(absolutePath, fs.constants.F_OK);
    await fs.promises.unlink(absolutePath);
  } catch {
    // Ignore missing file errors
  }
};

const normalizeInstitutionField = (value, fields = []) => {
  if (!value) return null;

  // Handle ObjectId
  if (value instanceof mongoose.Types.ObjectId) {
    return { id: value.toString() };
  }

  // Handle populated document or plain object
  if (typeof value === 'object') {
    const id = value._id || value.id || value.toString?.();
    const normalized = { id: id ? id.toString() : null };
    fields.forEach((field) => {
      if (value[field] !== undefined) {
        normalized[field] = value[field] ?? null;
      }
    });
    return normalized;
  }

  // Fallback for string/number
  return { id: String(value) };
};

const serializeStudent = (studentDoc, includePassportData = false) => {
  if (!studentDoc) return null;
  const student = studentDoc.toObject({ versionKey: false });

  const passportFromDoc = studentDoc.passport || {};
  const passportPlain = student.passport || {};
  const hasPassport = Boolean(
    (passportFromDoc.data && passportFromDoc.data.length) ||
    passportPlain.contentType ||
    passportPlain.updatedAt
  );

  if (includePassportData && hasPassport) {
    student.passport = {
      contentType: passportFromDoc.contentType || passportPlain.contentType,
      data: passportFromDoc.data ? passportFromDoc.data.toString("base64") : null,
      updatedAt: passportFromDoc.updatedAt || passportPlain.updatedAt,
    };
    if (!student.passport.data) {
      student.passport = null;
    }
  } else if (hasPassport) {
    student.passport = {
      contentType: passportPlain.contentType || passportFromDoc.contentType,
      updatedAt: passportPlain.updatedAt || passportFromDoc.updatedAt,
      hasPassport: true,
    };
  } else {
    student.passport = null;
  }

  if (student.standingEvidence && !Object.keys(student.standingEvidence).length) {
    student.standingEvidence = null;
  }

  const college = normalizeInstitutionField(studentDoc.college || student.college, ['name', 'code']);
  const department = normalizeInstitutionField(studentDoc.department || student.department, ['name', 'code']);
  const programme = normalizeInstitutionField(studentDoc.programme || student.programme, [
    'name',
    'degreeType',
    'description',
  ]);

  student.college = college;
  student.department = department;
  student.programme = programme;
  student.collegeId = college?.id || null;
  student.departmentId = department?.id || null;
  student.programmeId = programme?.id || null;

  return student;
};

export const CreateStudent = async (req, res) => {
  try {
    const {
      collegeId,
      departmentId,
      programmeId,
      ...studentPayload
    } = req.body || {}; // This destructuring is correct for the incoming payload
console.log(req.body)
    // Add validation to ensure IDs are present before proceeding
    if (
      !collegeId || collegeId === '' || !mongoose.Types.ObjectId.isValid(collegeId) ||
      !departmentId || departmentId === '' || !mongoose.Types.ObjectId.isValid(departmentId) ||
      !programmeId || programmeId === '' || !mongoose.Types.ObjectId.isValid(programmeId)
    ) {
      return res.status(400).json({
        error: "Validation Error",
        details: "A valid College, Department, and Programme must be selected.",
      });
    }

    // Re-fetch the documents to pass to the access control function.
    const { college, department, programme } = await validateInstitutionHierarchy({
      collegeId,
      departmentId,
      programmeId,
    });
    ensureUserCanAccessDepartment(req.user, department._id, college._id);
console.log(req.user)
    const newStudent = await Student.create({
      ...studentPayload,
      college: college._id,
      department: department._id,
      programme: programme._id,
    });

    const populated = await Student.findById(newStudent._id)
      .populate('college', 'name code')
      .populate('department', 'name code')
      .populate('programme', 'name degreeType description');

    res.status(201).json(serializeStudent(populated, false));
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    if (error.name === "ValidationError") {
      return res.status(400).json({
        error: "Validation Error",
        details: error.message,
      });
    } else {
      console.error("CreateStudent error:", error);
      return res.status(500).json({
        error: "Internal Server Error",
      });
    }
  }
};

export const getAllStudent = async (req, res) => {
  try {
    const regNoQuery = req.query.regNo?.toString().trim().toUpperCase();
    const baseQuery = regNoQuery ? { regNo: regNoQuery } : {};
    const scopeFilter = buildDepartmentScopeFilter(req.user, 'department');
    const query = { ...baseQuery, ...scopeFilter };
    const allStudent = await Student.find(query)
      .select("-passport.data")
      .sort({ regNoNumeric: 1, regNoSuffix: 1 })
      .populate('college', 'name code')
      .populate('department', 'name code')
      .populate('programme', 'name degreeType description');

    res.status(200).json(allStudent.map((student) => serializeStudent(student, false)));
  } catch (error) {
    console.error("error fetching doc", error);
    res.status(500).json({
      error: "Internal Server Error",
    });
  }
};

export const searchStudentByRegNo = async (req, res) => {
  try {
    const regNo = req.query.regNo?.toString().trim().toUpperCase();
    if (!regNo) {
      return res.status(400).json({ error: "Registration number is required" });
    }

    const student = await Student.findOne({ regNo })
      .select("+passport.data")
      .populate('college', 'name code')
      .populate('department', 'name code')
      .populate('programme', 'name degreeType description');
    if (!student) {
      return res.status(404).json({ error: "Student not found" });
    }

    ensureResourceMatchesUserScope(req.user, student);

    res.status(200).json(serializeStudent(student, true));
  } catch (error) {
    console.error("Error searching student", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

export const getStudentById = async (req, res) => {
  try {
    const foundStudent = await Student.findById(req.params.id)
      .select("+passport.data")
      .populate('college', 'name code')
      .populate('department', 'name code')
      .populate('programme', 'name degreeType description');

    if (!foundStudent) {
      return res.status(404).json({
        error: "Student not found",
      });
    }
    ensureResourceMatchesUserScope(req.user, foundStudent);
    res.status(200).json(serializeStudent(foundStudent, true));
  } catch (error) {
    console.error("Student not found", error);
    res.status(404).json({
      error: "Student not found",
    });
  }
};

export const updateStudent = async (req, res) => {
  try {
    const {
      collegeId,
      departmentId,
      programmeId,
      ...updates
    } = req.body || {};

    const existingStudent = await Student.findById(req.params.id).select('college department');
    if (!existingStudent) {
      return res.status(404).json({
        error: "failed to update student",
      });
    }

    ensureUserCanAccessDepartment(req.user, existingStudent.department, existingStudent.college);

    delete updates.college;
    delete updates.department;
    delete updates.programme;

    if ([collegeId, departmentId, programmeId].some((value) => value !== undefined)) {
      if (![collegeId, departmentId, programmeId].every((value) => value)) {
        return res.status(400).json({
          error: "collegeId, departmentId, and programmeId are all required when updating institutional details.",
        });
      }
      const { college, department, programme } = await validateInstitutionHierarchy({
        collegeId,
        departmentId,
        programmeId,
      });
      ensureUserCanAccessDepartment(req.user, department._id, college._id);
      updates.college = college._id;
      updates.department = department._id;
      updates.programme = programme._id;
    }

    const updatedStudent = await Student.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true, runValidators: true }
    )
      .select("-passport.data")
      .populate('college', 'name code')
      .populate('department', 'name code')
      .populate('programme', 'name degreeType description');

    if (!updatedStudent) {
      return res.status(404).json({
        error: "failed to update student",
      });
    }

    res.status(200).json(serializeStudent(updatedStudent, false));
  } catch (error) {
    console.error("error updating student", error);
    if (error.name === "ValidationError") {
      res.status(400).json({
        error: "Validation Error",
      });
    } else if (error.name === "CastError" && error.kind === "ObjectId") {
      res.status(400).json({
        error: "Invalid Student ID",
      });
    } else if (error.code === 11000) {
      res.status(400).json({ error: `Duplicate Matric Number Detected! with ${error.keyValue.regNo}` });
    } else {
      res.status(500).json({
        error: "Internal Server Error",
      });
    }
  }
};

export const updateStudentStanding = async (req, res) => {
  const { id } = req.params;
  const { standing, documentNumber } = req.body;
  const uploadedFile = req.file;

  try {
    const normalizedStanding = standing?.toString().trim().toLowerCase();
    if (!normalizedStanding || !STANDING_OPTIONS.includes(normalizedStanding)) {
      if (uploadedFile?.path) {
        await fs.promises.unlink(uploadedFile.path).catch(() => {});
      }
      return res.status(400).json({ error: "Invalid standing supplied" });
    }

    if (EVIDENCE_REQUIRED.has(normalizedStanding)) {
      const hasEvidence = Boolean(
        uploadedFile || (documentNumber && documentNumber.toString().trim().length > 0)
      );
      if (!hasEvidence) {
        return res.status(400).json({
          error: "Document upload or reference number is required for the selected standing",
        });
      }
    }

    let sessionDoc = null;
    let normalizedSemester = null;
    let trimmedRemarks = "";
    let effectiveDateValue;

    if (STANDING_DETAILS_REQUIRED.has(normalizedStanding)) {
      const sessionIdRaw = req.body.sessionId?.toString().trim();
      const semesterRaw = req.body.semester?.toString().trim().toLowerCase();
      const remarksRaw = req.body.remarks?.toString().trim();
      const effectiveDateRaw = req.body.effectiveDate?.toString().trim();

      if (!sessionIdRaw || !mongoose.isValidObjectId(sessionIdRaw)) {
        if (uploadedFile?.path) {
          await fs.promises.unlink(uploadedFile.path).catch(() => {});
        }
        return res.status(400).json({ error: "A valid session is required for the selected standing" });
      }

      sessionDoc = await Session.findById(sessionIdRaw).select("sessionTitle");
      if (!sessionDoc) {
        if (uploadedFile?.path) {
          await fs.promises.unlink(uploadedFile.path).catch(() => {});
        }
        return res.status(404).json({ error: "Selected session could not be found" });
      }

      if (!semesterRaw || !SEMESTER_OPTIONS.has(semesterRaw)) {
        if (uploadedFile?.path) {
          await fs.promises.unlink(uploadedFile.path).catch(() => {});
        }
        return res.status(400).json({ error: "A valid semester (first, second or both) is required" });
      }

      normalizedSemester = semesterRaw;
      trimmedRemarks = remarksRaw || "";

      if (effectiveDateRaw) {
        const parsedDate = new Date(effectiveDateRaw);
        if (Number.isNaN(parsedDate.getTime())) {
          if (uploadedFile?.path) {
            await fs.promises.unlink(uploadedFile.path).catch(() => {});
          }
          return res.status(400).json({ error: "Effective date is invalid" });
        }
        effectiveDateValue = parsedDate;
      }
    }

    const student = await Student.findById(id).select("+passport.data");
    if (!student) {
      if (uploadedFile?.path) {
        await fs.promises.unlink(uploadedFile.path).catch(() => {});
      }
      return res.status(404).json({ error: "Student not found" });
    }

    ensureUserCanAccessDepartment(req.user, student.department, student.college);

    let documentPath = student.standingEvidence?.documentPath || null;
    let documentName = student.standingEvidence?.documentName || null;

    if (uploadedFile) {
      if (documentPath) {
        await removeExistingFile(documentPath);
      }
      documentPath = `uploads/student-standing/${uploadedFile.filename}`;
      documentName = uploadedFile.originalname;
    } else if (normalizedStanding === "goodstanding" && documentPath) {
      await removeExistingFile(documentPath);
      documentPath = null;
      documentName = null;
    }

    const trimmedDocumentNumber = documentNumber?.toString().trim() || "";

    const evidencePayload = {};
    if (documentPath) evidencePayload.documentPath = documentPath;
    if (documentName) evidencePayload.documentName = documentName;
    if (trimmedDocumentNumber) evidencePayload.documentNumber = trimmedDocumentNumber;

    if (Object.keys(evidencePayload).length > 0) {
      evidencePayload.updatedAt = new Date();
      student.standingEvidence = evidencePayload;
    } else {
      student.standingEvidence = undefined;
    }

    student.standing = normalizedStanding;
    await student.save();

    if (sessionDoc) {
      const recordPayload = {
        student: student._id,
        standing: normalizedStanding,
        session: sessionDoc._id,
        sessionTitleSnapshot: sessionDoc.sessionTitle,
        semester: normalizedSemester,
      };

      if (effectiveDateValue) {
        recordPayload.effectiveDate = effectiveDateValue;
      }
      if (trimmedRemarks) {
        recordPayload.remarks = trimmedRemarks;
      }

      const evidenceSnapshot = {};
      if (documentPath) evidenceSnapshot.documentPath = documentPath;
      if (documentName) evidenceSnapshot.documentName = documentName;
      if (trimmedDocumentNumber) evidenceSnapshot.documentNumber = trimmedDocumentNumber;

      if (Object.keys(evidenceSnapshot).length > 0) {
        recordPayload.updatedStandingEvidence = evidenceSnapshot;
      }

      await StandingRecord.create(recordPayload);
    }

    res.status(200).json(serializeStudent(student, true));
  } catch (error) {
    console.error("Error updating standing", error);
    res.status(500).json({
      error: "Internal Server Error",
    });
  }
};

export const updateStudentPassport = async (req, res) => {
  const { id } = req.params;
  const file = req.file;

  try {
    if (!file) {
      return res.status(400).json({ error: "Passport image is required" });
    }

    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      return res.status(400).json({ error: "Unsupported file type. Use JPG, PNG or WEBP images." });
    }

    const student = await Student.findById(id).select("+passport.data");
    if (!student) {
      return res.status(404).json({ error: "Student not found" });
    }

    ensureUserCanAccessDepartment(req.user, student.department, student.college);

    student.passport = {
      data: file.buffer,
      contentType: file.mimetype,
      updatedAt: new Date(),
    };

    await student.save();
    res.status(200).json(serializeStudent(student, true));
  } catch (error) {
    console.error("Error updating passport", error);
    res.status(500).json({
      error: "Internal Server Error",
    });
  }
};

export const deleteStudentPassport = async (req, res) => {
  const { id } = req.params;

  try {
    const student = await Student.findById(id).select("+passport.data");
    if (!student) {
      return res.status(404).json({ error: "Student not found" });
    }

    ensureUserCanAccessDepartment(req.user, student.department, student.college);

    const hasPassport =
      Boolean(student.passport?.data && student.passport.data.length) ||
      Boolean(student.passport?.contentType) ||
      Boolean(student.passport?.updatedAt);

    if (!hasPassport) {
      return res.status(200).json({
        message: "Passport already removed",
        student: serializeStudent(student, true),
      });
    }

    student.passport = undefined;
    await student.save();

    res.status(200).json({
      message: "Passport removed successfully",
      student: serializeStudent(student, true),
    });
  } catch (error) {
    console.error("Error deleting passport", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

export const deleteStudent = async (req, res) => {
  try {
    const student = await Student.findById(req.params.id);
    if (!student) {
      return res.status(404).json({
        error: "Student not found",
      });
    }

    ensureUserCanAccessDepartment(req.user, student.department, student.college);

    const deleteStudent = await Student.findByIdAndDelete(req.params.id);
    if (deleteStudent?.standingEvidence?.documentPath) {
      await removeExistingFile(deleteStudent.standingEvidence.documentPath);
    }
    res.status(200).json({ message: "Student profile deleted successfully" });
  } catch (error) {
    console.error("Error Deleting Student", error);
    if (error.name === "CastError" && error.kind === "ObjectId") {
      res.status(400).json({
        error: "Invalid Student ID",
      });
    } else {
      res.status(500).json({
        error: "Internal Server Error",
      });
    }
  }
};

export const listStandingRecords = async (req, res) => {
  try {
    const standingFilter = req.query.standing?.toString().trim().toLowerCase();
    const sessionFilter = req.query.sessionId?.toString().trim();
    const regNoFilter = req.query.regNo?.toString().trim().toUpperCase();
    const scopeFilter = buildDepartmentScopeFilter(req.user);

    const query = {};
    if (standingFilter) {
      if (!STANDING_DETAILS_REQUIRED.has(standingFilter)) {
        return res.status(400).json({ error: "Unsupported standing filter" });
      }
      query.standing = standingFilter;
    }

    if (sessionFilter) {
      if (!mongoose.isValidObjectId(sessionFilter)) {
        return res.status(400).json({ error: "Invalid session filter" });
      }
      query.session = sessionFilter;
    }

    const studentMatch = regNoFilter ? { regNo: regNoFilter } : {};
    if (scopeFilter.department) {
      studentMatch.department = scopeFilter.department;
    }

    const records = await StandingRecord.find(query)
      .populate({
        path: "student",
        select: "surname firstname middlename regNo level standing status department",
        match: studentMatch,
      })
      .populate({
        path: "session",
        select: "sessionTitle startDate endDate",
      })
      .sort({ createdAt: -1 })
      .lean();

    const filteredRecords = records.filter((record) => Boolean(record.student));

    res.status(200).json({
      count: filteredRecords.length,
      records: filteredRecords.map((record) => ({
        ...record,
        sessionTitle: record.sessionTitleSnapshot,
      })),
    });
  } catch (error) {
    console.error("Error listing standing records", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};
