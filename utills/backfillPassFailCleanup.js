// scripts/rebuildPassFailFromResults.js
// Usage:
//  node scripts/rebuildPassFailFromResults.js          # DRY-RUN (no writes)
//  node scripts/rebuildPassFailFromResults.js --apply  # APPLY changes

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import PassFail from '../models/passFailList.js';
import Result from '../models/result.js';

dotenv.config();

const MONGO_URI = "mongodb://localhost:27017/exam-office"
const APPLY = process.argv.includes('--apply');

// ---- helpers: term ordering ----
const sessionStart = (session) => {
  const n = Number(String(session || '').split('/')[0]);
  return Number.isFinite(n) ? n : -Infinity;
};

const termKey = ({ session, semester }) => ({
  y: sessionStart(session),
  s: Number(semester) || 0,
});
const cmpTerm = (a, b) => {
  const ak = termKey(a), bk = termKey(b);
  if (ak.y !== bk.y) return ak.y - bk.y;
  return ak.s - bk.s;
};
const isBefore = (a, b) => cmpTerm(a, b) < 0;
const isAtOrAfter = (a, b) => cmpTerm(a, b) >= 0;

// ---- main ----
(async () => {
  await mongoose.connect(MONGO_URI);
  console.log(`[rebuild-passfail] Connected: ${MONGO_URI}`);
  console.log(`[rebuild-passfail] Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  // 1) Read ALL results, group to: perTerm {course,session,semester} -> { pass:Set, fail:Set }
  //    and also perCourse map to know when each student first passed.
  const perTerm = new Map();   // key: `${course}|${session}|${semester}` -> { course, session, semester, pass:Set, fail:Set }
  const perCourse = new Map(); // key: `${course}` -> Map(studentId -> array of {session,semester,passed:boolean})

  const cursor = Result.find({}, { course:1, student:1, session:1, semester:1, grade:1 })
    .lean()
    .cursor();

  let rows = 0;
  for await (const r of cursor) {
    rows++;
    const course = String(r.course);
    const student = String(r.student);
    const session = r.session;
    const semester = Number(r.semester);
    const passed = r.grade !== 'F';

    // group per-term
    const tKey = `${course}|${session}|${semester}`;
    if (!perTerm.has(tKey)) {
      perTerm.set(tKey, {
        course, session, semester,
        pass: new Set(),
        fail: new Set(),
      });
    }
    const bucket = perTerm.get(tKey);
    if (passed) {
      bucket.pass.add(student);
      bucket.fail.delete(student); // in case duplicates
    } else {
      // only add to fail if not already marked pass in same term
      if (!bucket.pass.has(student)) bucket.fail.add(student);
    }

    // collect per-course term history
    if (!perCourse.has(course)) perCourse.set(course, new Map());
    const courseMap = perCourse.get(course);
    if (!courseMap.has(student)) courseMap.set(student, []);
    courseMap.get(student).push({ session, semester, passed });
  }

  console.log(`[rebuild-passfail] scanned results: ${rows}`);
  console.log(`[rebuild-passfail] distinct terms: ${perTerm.size}`);
  console.log(`[rebuild-passfail] distinct courses: ${perCourse.size}`);

  // 2) For each course, find each student's earliest **pass** term
  const earliestPassByCourse = new Map(); // course -> Map(student -> {session,semester})
  for (const [course, stuMap] of perCourse.entries()) {
    const map = new Map();
    for (const [student, terms] of stuMap.entries()) {
      const passTerms = terms.filter(t => t.passed).sort(cmpTerm);
      if (passTerms.length) map.set(student, passTerms[0]); // earliest pass
    }
    earliestPassByCourse.set(course, map);
  }

  // 3) Turn perTerm sets into arrays and scrub earlier fails if a later pass exists
  //    We'll also upsert PassFail docs.
  let upserts = 0, modifiedAfterScrub = 0;

  // First convert to array to iterate deterministically by course then term
  const snapshots = Array.from(perTerm.values()).sort((a,b) => {
    if (a.course !== b.course) return a.course.localeCompare(b.course);
    return cmpTerm(a, b);
  });

  for (const snap of snapshots) {
    const course = snap.course;
    const baseTerm = { session: snap.session, semester: snap.semester };

    // clone sets to arrays
    let passArr = Array.from(snap.pass);
    let failArr = Array.from(snap.fail);

    // scrub logic: if student has an earliest pass term that is at/after this snapshot,
    // and this snapshot is BEFORE that pass, remove them from fail here.
    const earliestMap = earliestPassByCourse.get(course) || new Map();
    const beforeLen = failArr.length;
    failArr = failArr.filter(sid => {
      const firstPass = earliestMap.get(sid);
      if (!firstPass) return true; // never passed later -> keep the fail
      return !isBefore(baseTerm, firstPass); // keep only if NOT before their pass
    });
    if (failArr.length !== beforeLen) modifiedAfterScrub++;

    // ensure no overlap and de-dup
    const passSet = new Set(passArr);
    const cleanFail = failArr.filter(sid => !passSet.has(sid));
    passArr = Array.from(passSet);

    // upsert
    const filter = { course, session: snap.session, semester: snap.semester };
    const update = { $set: { pass: passArr, fail: cleanFail } };
    if (APPLY) {
      await PassFail.updateOne(filter, update, { upsert: true });
    }
    upserts++;
    console.log(`[upsert] course:${course} term:${snap.session} S${snap.semester}  pass:${passArr.length} fail:${cleanFail.length}`);
  }

  console.log(`\n[rebuild-passfail] upserts: ${upserts}`);
  console.log(`[rebuild-passfail] snapshots with scrubbed fails: ${modifiedAfterScrub}`);
  console.log(`[rebuild-passfail] done (${APPLY ? 'APPLIED' : 'DRY-RUN'})`);

  await mongoose.disconnect();
  process.exit(0);
})();
