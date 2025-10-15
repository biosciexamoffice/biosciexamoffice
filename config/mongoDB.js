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
    cachedMode = (process.env.DB_MODE || 'PRIMARY').toUpperCase();
    const primaryUri = process.env.MONGO_PRIMARY_URL || process.env.MONGO_URL;
    if (!primaryUri) {
      throw new Error('Missing MONGO_PRIMARY_URL (or legacy MONGO_URL) environment variable.');
    }

    const commonOptions = {
      maxPoolSize: Number(process.env.MONGO_POOL_SIZE || 10),
    };

    const readPreference = isReadOnlyMode() ? 'secondaryPreferred' : 'primary';
    await mongoose.connect(primaryUri, { ...commonOptions, readPreference });
    console.log(
      `MongoDB connected (${getDbMode()} mode) -> ${redactConnectionString(primaryUri)}`
    );

    if (!isReadOnlyMode() && process.env.MONGO_ATLAS_URL) {
      atlasConnection = mongoose.createConnection(process.env.MONGO_ATLAS_URL, commonOptions);
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
