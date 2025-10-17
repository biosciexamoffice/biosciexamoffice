import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';

let atlasConnection = null;
let cachedMode = (process.env.DB_MODE || 'PRIMARY').toUpperCase();

export const getDbMode = () => cachedMode;
export const isReadOnlyMode = () => getDbMode() === 'READONLY';
export const getAtlasConnection = () => atlasConnection;

const redactConnectionString = (uri = '') => {
  if (!uri) return '';
  return uri.replace(/\/\/[^@]+@/, '//****:****@');
};

const connectDB = async () => {
  try {
    if (String(process.env.SKIP_DB_CONNECTION || '').toLowerCase() === 'true') {
      console.warn('SKIP_DB_CONNECTION=true – skipping MongoDB connection initialization.');
      cachedMode = (process.env.DB_MODE || 'PRIMARY').toUpperCase();
      return;
    }

    cachedMode = (process.env.DB_MODE || 'PRIMARY').toUpperCase();
    const primaryUri = process.env.MONGO_PRIMARY_URL || process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/examoffice';
    if (!process.env.MONGO_PRIMARY_URL && !process.env.MONGO_URL) {
      console.warn('MONGO_PRIMARY_URL/MONGO_URL not set. Falling back to mongodb://127.0.0.1:27017/examoffice');
    }

    const dbName =
      typeof process.env.MONGO_DB_NAME === 'string' && process.env.MONGO_DB_NAME.trim()
        ? process.env.MONGO_DB_NAME.trim()
        : undefined;
    const atlasDbName =
      typeof process.env.MONGO_ATLAS_DB_NAME === 'string' && process.env.MONGO_ATLAS_DB_NAME.trim()
        ? process.env.MONGO_ATLAS_DB_NAME.trim()
        : dbName;

    const commonOptions = {
      maxPoolSize: Number(process.env.MONGO_POOL_SIZE || 10),
      serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 30000),
      connectTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS || 30000),
    };

    const readPreference = isReadOnlyMode() ? 'secondaryPreferred' : 'primary';
    const mongooseOptions = { ...commonOptions, readPreference };
    if (dbName) mongooseOptions.dbName = dbName;

    await mongoose.connect(primaryUri, mongooseOptions);
    console.log(
      `MongoDB connected (${getDbMode()} mode) -> ${redactConnectionString(primaryUri)}`
    );

    if (!isReadOnlyMode() && process.env.MONGO_ATLAS_URL) {
      const atlasOptions = { ...commonOptions };
      if (atlasDbName) atlasOptions.dbName = atlasDbName;

      atlasConnection = mongoose.createConnection(process.env.MONGO_ATLAS_URL, atlasOptions);
      await atlasConnection.asPromise();
      console.log(
        `MongoDB Atlas backup connection ready -> ${redactConnectionString(process.env.MONGO_ATLAS_URL)}`
      );
    }
  } catch (error) {
    console.error('Database Connection Failed:', error.message);
    process.exit(1);
  }
};

export default connectDB;
