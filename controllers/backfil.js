import mongoose from 'mongoose';
import AcademicMetrics from '../models/academicMetrics.js';
import dotenv from 'dotenv';

dotenv.config();

const migrateMetrics = async () => {
  try {
    await mongoose.connect("mongodb://localhost:27017/exam-office");
    console.log('Connected to MongoDB');

    const allMetrics = await AcademicMetrics.find().sort({ session: 1, semester: 1, level: 1 });
    console.log(`Found ${allMetrics.length} metrics to process`);

    let processed = 0;
    
    for (const metric of allMetrics) {
      const previous = await AcademicMetrics.findOne({
        student: metric.student,
        $or: [
          { session: { $lt: metric.session } },
          { session: metric.session, semester: { $lt: metric.semester } }
        ]
      })
      .sort({ session: -1, semester: -1 })
      .lean();

      if (previous) {
        metric.previousMetrics = {
          CCC: previous.CCC,
          CCE: previous.CCE,
          CPE: previous.CPE,
          CGPA: previous.CGPA
        };
        await metric.save();
        processed++;
      }
    }

    console.log(`Migration complete. Updated ${processed} records`);
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
};

migrateMetrics();