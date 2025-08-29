import mongoose from 'mongoose';
import Student from '../models/student.js' // Adjust path to your Student model
import dotenv from 'dotenv';

dotenv.config();

const migrateStudents = async () => {
  try {
    // 1. Connect to MongoDB
    await mongoose.connect("mongodb+srv://examofficebch:snhWv6x1VdXLMulR@bchexamoffice.gcccvqx.mongodb.net/?retryWrites=true&w=majority&appName=BCHEXAMOFFICE")

    console.log('Connected to MongoDB...');

    // 2. Find all students needing migration
    const students = await Student.find({
      $or: [
        { regNoNumeric: { $exists: false } },
        { regNoSuffix: { $exists: false } }
      ]
    });

    console.log(`Found ${students.length} students to migrate...`);

    // 3. Process each student
    let migratedCount = 0;
    for (const student of students) {
      try {
        const parts = student.regNo.split('/');
        
        // Validate format first
        if (parts.length !== 3 || !/^\d{5}$/.test(parts[1]) || !['UE','DE'].includes(parts[2])) {
          console.warn(`Skipping invalid regNo format: ${student.regNo}`);
          continue;
        }

        student.regNoNumeric = parseInt(parts[1], 10);
        student.regNoSuffix = parts[2];
        
        await student.save();
        migratedCount++;
        
        if (migratedCount % 100 === 0) {
          console.log(`Migrated ${migratedCount} records...`);
        }
      } catch (err) {
        console.error(`Error migrating student ${student._id}:`, err.message);
      }
    }

    console.log(`Migration complete! Successfully migrated ${migratedCount} students.`);
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
};

migrateStudents();