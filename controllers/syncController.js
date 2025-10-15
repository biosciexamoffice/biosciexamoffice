import mongoose from 'mongoose';
import { getAtlasConnection, isReadOnlyMode } from '../config/mongoDB.js';
import SyncState from '../models/syncState.js';

const COLLECTION_KEYS = [
  'users',
  'students',
  'courses',
  'lecturers',
  'colleges',
  'departments',
  'programmes',
  'academicmetrics',
  'results',
  'approvedcourses',
  'courseregistrations',
  'sessions',
  'graduationrequests',
];

const PICK_UPDATED_QUERY = (since) => ({
  $or: [
    { updatedAt: { $gt: since } },
    { lastUpdated: { $gt: since } },
    { createdAt: { $gt: since } },
  ],
});

const sanitizeDoc = (doc) => {
  if (!doc) return doc;
  const clone = { ...doc };
  if (clone._id && typeof clone._id === 'object' && clone._id._bsontype === 'ObjectID') {
    clone._id = clone._id; // keep ObjectId
  }
  return clone;
};

const buildBulkOps = (docs) =>
  docs.map((doc) => {
    const { _id, ...rest } = sanitizeDoc(doc);
    return {
      updateOne: {
        filter: { _id },
        update: { $set: rest },
        upsert: true,
      },
    };
  });

const getCollection = (conn, name) => {
  if (!conn) return null;
  try {
    return conn.collection(name);
  } catch (err) {
    return null;
  }
};

const ensureSyncState = async () => {
  const key = 'atlas-sync';
  let state = await SyncState.findOne({ key });
  if (!state) {
    state = await SyncState.create({ key });
  }
  return state;
};

const validatePrimaryMode = (res) => {
  if (isReadOnlyMode()) {
    res.status(403).json({
      success: false,
      message: 'Sync operations can only run on the primary node.',
    });
    return false;
  }
  return true;
};

export const pullFromAtlas = async (_req, res) => {
  if (!validatePrimaryMode(res)) return;

  const atlas = getAtlasConnection();
  if (!atlas) {
    return res.status(503).json({
      success: false,
      message: 'Atlas connection not configured. Set MONGO_ATLAS_URL on the primary node.',
    });
  }

  const state = await ensureSyncState();
  const since = state.lastPulledAt || new Date(0);
  const startedAt = new Date();
  const primaryDb = mongoose.connection;
  const summary = [];

  for (const key of COLLECTION_KEYS) {
    const atlasCollection = getCollection(atlas, key);
    const primaryCollection = getCollection(primaryDb, key);
    if (!atlasCollection || !primaryCollection) {
      continue;
    }

    const freshDocs = await atlasCollection.find(PICK_UPDATED_QUERY(since)).toArray();
    if (!freshDocs.length) {
      continue;
    }

    const ops = buildBulkOps(freshDocs);
    if (!ops.length) continue;

    await primaryCollection.bulkWrite(ops, { ordered: false });
    summary.push({ collection: key, imported: ops.length });
  }

  state.lastPulledAt = startedAt;
  await state.save();

  res.json({
    success: true,
    pulledAt: startedAt,
    summary,
  });
};

export const pushToAtlas = async (_req, res) => {
  if (!validatePrimaryMode(res)) return;

  const atlas = getAtlasConnection();
  if (!atlas) {
    return res.status(503).json({
      success: false,
      message: 'Atlas connection not configured. Set MONGO_ATLAS_URL on the primary node.',
    });
  }

  const state = await ensureSyncState();
  const since = state.lastPushedAt || new Date(0);
  const startedAt = new Date();
  const primaryDb = mongoose.connection;
  const summary = [];

  for (const key of COLLECTION_KEYS) {
    const atlasCollection = getCollection(atlas, key);
    const primaryCollection = getCollection(primaryDb, key);
    if (!atlasCollection || !primaryCollection) {
      continue;
    }

    const freshDocs = await primaryCollection.find(PICK_UPDATED_QUERY(since)).toArray();
    if (!freshDocs.length) {
      continue;
    }

    const ops = buildBulkOps(freshDocs);
    if (!ops.length) continue;

    await atlasCollection.bulkWrite(ops, { ordered: false });
    summary.push({ collection: key, exported: ops.length });
  }

  state.lastPushedAt = startedAt;
  await state.save();

  res.json({
    success: true,
    pushedAt: startedAt,
    summary,
  });
};
