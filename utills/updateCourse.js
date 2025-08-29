import fs from 'fs'
import csv from 'csv-parser'
import mongoose from 'mongoose'
import Course from '../models/course.js'

const CSV_FILE_PATH = './update_Course.csv'

const bulkUpdateCourse = async () => {
    try {
        await mongoose.connect("mongodb://localhost:27017/exam-office");
        console.log('MongoDB Connected');

        const results = await new Promise((resolve, reject) => {
            const data = []
            fs.createReadStream(CSV_FILE_PATH)
                .pipe(csv({ mapHeaders: ({ header }) => header.trim() }))
                .on('data', (row) => data.push(row))
                .on('end', () => resolve(data))
                .on('error', (error) => reject(error));
        })

        console.log(`Processing ${results.length} records from CSV...`);

        for (const row of results) {
            const { code, uamId } = row
            
            if (!code || !uamId) {
                console.warn('Skipping row with missing data:', row);
                continue
            }

            const course = await Course.findOne({ code })
            if (!course) {
                console.warn(`Course with code ${code} not found`)
                continue
            }

            await Course.findOneAndUpdate(
                { code },
                {
                    $set: {
                        'uamId': uamId
                    },
                },
                { new: true, upsert: true }
            );
            console.log(`Updated uam ID for course ${code}`);
        }
        console.log('Bulk update completed successfully');
    } catch (error) {
        console.error('Error during bulk update:', error);
        process.exit(1);
    } finally {
        if (mongoose.connection.readyState === 1) {
            await mongoose.connection.close();
            console.log('MongoDB connection closed.');
        }
    }
};

bulkUpdateCourse();