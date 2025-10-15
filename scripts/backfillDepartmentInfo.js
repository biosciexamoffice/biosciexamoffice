import 'dotenv/config';
import mongoose from 'mongoose';
import Result from '../models/result.js';
import AcademicMetrics from '../models/academicMetrics.js';

const DEFAULT_DEPARTMENT = 'Biochemistry';
const DEFAULT_COLLEGE = 'Biological Science';

const buildFilter = (fields) => {
  const conditions = [];
  fields.forEach((field) => {
    conditions.push({ [field]: { $exists: false } });
    conditions.push({ [field]: '' });
    conditions.push({ [field]: null });
  });
  return { $or: conditions };
};

async function run() {
  try {
    const mongoUrl = process.env.MONGO_URL || process.env.DATABASE_URL;
    if (!mongoUrl) {
      throw new Error('MONGO_URL (or DATABASE_URL) environment variable is required.');
    }

    await mongoose.connect(mongoUrl);
    console.log('Connected to MongoDB for backfill...');

    const resultFilter = buildFilter(['department', 'college']);
    const resultUpdate = await Result.updateMany(
      resultFilter,
      {
        $set: {
          department: DEFAULT_DEPARTMENT,
          college: DEFAULT_COLLEGE,
        },
      }
    );

    const metricsFilter = buildFilter(['department', 'college']);
    const metricsUpdate = await AcademicMetrics.updateMany(
      metricsFilter,
      {
        $set: {
          department: DEFAULT_DEPARTMENT,
          college: DEFAULT_COLLEGE,
        },
      }
    );

    console.log(`Results updated: matched=${resultUpdate.matchedCount}, modified=${resultUpdate.modifiedCount}`);
    console.log(`Academic metrics updated: matched=${metricsUpdate.matchedCount}, modified=${metricsUpdate.modifiedCount}`);
  } catch (err) {
    console.error('Backfill failed:', err);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
}

run();
