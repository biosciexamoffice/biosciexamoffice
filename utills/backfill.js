// scripts/backfillStudentRegFields.js  (run with node, or wire as a protected route)
import mongoose from 'mongoose';
import Student from '../models/student.js';

const uri = "mongodb://localhost:27017/exam-office"

const parse = (reg) => {
  const clean = String(reg || '').trim().toUpperCase();
  const [yy, num, suffix] = clean.split('/');
  return {
    regNo: clean,
    regNoNumeric: Number(num) || undefined,
    regNoSuffix: (suffix === 'UE' || suffix === 'DE') ? suffix : undefined,
  };
};

(async () => {
  await mongoose.connect(uri);
  const cursor = Student.find({ $or: [{ regNoSuffix: { $exists: false } }, { regNoSuffix: null }, { regNoNumeric: { $exists: false } }] }).cursor();
  let n = 0;
  for await (const s of cursor) {
    const p = parse(s.regNo);
    if (p.regNoSuffix || p.regNoNumeric) {
      await Student.updateOne({ _id: s._id }, { $set: { regNoSuffix: p.regNoSuffix, regNoNumeric: p.regNoNumeric, regNo: p.regNo } });
      n++;
    }
  }
  console.log(`Backfilled ${n} students.`);
  await mongoose.disconnect();
  process.exit(0);
})();
