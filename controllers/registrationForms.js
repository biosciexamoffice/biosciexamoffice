// controllers/registrationForms.js
import mongoose from "mongoose";
import Student from "../models/student.js";
import Course from "../models/course.js";
import PassFail from "../models/passFailList.js";

/**
 * POST /api/registration-forms
 * Body: { level, session, semester }
 * Response: { meta, students: [ { _id, surname, firstname, middlename, regNo, failedCourses: [...] } ] }
 */
export const generateRegistrationData = async (req, res) => {
  try {
    const { level, session, semester } = req.body || {};

    // a) Input validation
    if (!level || !session || typeof semester === "undefined") {
      return res.status(400).json({ message: "level, session and semester are required" });
    }
    const semNum = Number(semester);
    if (![1, 2].includes(semNum)) {
      return res.status(400).json({ message: "semester must be 1 or 2" });
    }

    // b) Get students for the level
    const students = await Student.find({ level: String(level) })
      .select("_id surname firstname middlename regNo level")
      .lean();

    if (!students.length) {
      return res.status(200).json({
        meta: {
          level: String(level),
          session,
          semester: semNum,
          generatedAt: new Date().toISOString(),
        },
        students: [],
      });
    }

    // c) Find PassFail docs for the given term, populate minimal course info
    const passFailDocs = await PassFail.find({
      semester: semNum,
    })
      .populate({
        path: "course",
        select: "_id code title unit option level semester",
        model: Course,
      })
      .lean();

    // Build quick lookup of failed courses per student
    const failedByStudent = new Map(students.map((s) => [String(s._id), []]));

    for (const pf of passFailDocs) {
      const course = pf.course;
      if (!course) continue;

      // Optional: if you want to restrict by course.level === selected level
      // if (String(course.level) !== String(level)) continue;

      // For each failing student in this course, push the course summary
      for (const sid of pf.fail || []) {
        const key = String(sid);
        if (!failedByStudent.has(key)) continue; // only cohort students
        failedByStudent.get(key).push({
          courseId: String(course._id),
          code: course.code,
          title: course.title,
          unit: course.unit,
          option: course.option, // "C" or "E"
          semester: pf.semester, // 1 or 2
        });
      }
    }

    // d) Response payload
    const payloadStudents = students.map((s) => ({
      _id: String(s._id),
      surname: s.surname,
      firstname: s.firstname,
      middlename: s.middlename || "",
      regNo: s.regNo,
      level: s.level,
      failedCourses: failedByStudent.get(String(s._id)) || [],
    }));

    return res.status(200).json({
      meta: {
        level: String(level),
        session,
        semester: semNum,
        generatedAt: new Date().toISOString(),
        failedCoursesTableRows: 15, // helpful hint for the client
      },
      students: payloadStudents,
    });
  } catch (err) {
    console.error("Error in generateRegistrationData:", err);
    return res
      .status(500)
      .json({ message: "Operation failed", error: err.message });
  }
};
