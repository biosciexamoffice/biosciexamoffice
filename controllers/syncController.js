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

  if (typeof atlas.asPromise === 'function' && atlas.readyState !== 1) {
    try {
      await atlas.asPromise();
    } catch (err) {
      console.error('Atlas connection not ready:', err);
    }
  }

  if (atlas.readyState !== 1) {
    return res.status(503).json({
      success: false,
      message: 'Unable to reach Atlas cluster. Check network connectivity.',
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

  if (typeof atlas.asPromise === 'function' && atlas.readyState !== 1) {
    try {
      await atlas.asPromise();
    } catch (err) {
      console.error('Atlas connection not ready:', err);
    }
  }

  if (atlas.readyState !== 1) {
    return res.status(503).json({
      success: false,
      message: 'Unable to reach Atlas cluster. Check network connectivity.',
    });
  }

  const state = await ensureSyncState();
  const since = state.lastPushedAt || new Date(0);
  const isFullExport = !state.lastPushedAt || state.lastPushedAt.getTime() === new Date(0).getTime();
  const startedAt = new Date();
  const primaryDb = mongoose.connection;
  const summary = [];

  for (const key of COLLECTION_KEYS) {
    const atlasCollection = getCollection(atlas, key);
    const primaryCollection = getCollection(primaryDb, key);
    if (!atlasCollection || !primaryCollection) {
      continue;
    }

    let shouldRunFull = isFullExport;
    let fullReason = isFullExport ? 'bootstrap' : undefined;

    if (!shouldRunFull) {
      try {
        const [localCount, atlasCount] = await Promise.all([
          primaryCollection.estimatedDocumentCount(),
          atlasCollection.estimatedDocumentCount(),
        ]);
        if (localCount !== atlasCount) {
          shouldRunFull = true;
          if (atlasCount === 0 && localCount > 0) {
            fullReason = 'atlas-empty';
          } else if (atlasCount < localCount) {
            fullReason = 'atlas-missing-docs';
          } else if (atlasCount > localCount) {
            fullReason = 'atlas-extra-docs';
          } else {
            fullReason = 'count-mismatch';
          }
        }
      } catch (countError) {
        console.warn(`Sync warning (${key}): unable to compare counts before push`, countError);
        shouldRunFull = true;
        fullReason = 'atlas-missing-collection';
      }
    }

    if (shouldRunFull) {
      const allDocs = await primaryCollection.find({}).toArray();
      await atlasCollection.deleteMany({});
      if (allDocs.length) {
        await atlasCollection.insertMany(allDocs, { ordered: false });
      }
      summary.push({
        collection: key,
        exported: allDocs.length,
        mode: 'full',
        ...(fullReason ? { reason: fullReason } : {}),
      });
      continue;
    }

    const freshDocs = await primaryCollection.find(PICK_UPDATED_QUERY(since)).toArray();
    if (!freshDocs.length) {
      continue;
    }

    const ops = buildBulkOps(freshDocs);
    if (!ops.length) continue;

    try {
      await atlasCollection.bulkWrite(ops, { ordered: false });
      summary.push({ collection: key, exported: ops.length });
    } catch (error) {
      if (error?.code === 11000) {
        console.warn(`Sync warning (${key}): duplicate key encountered. Consider running a full export to align records.`);
        summary.push({ collection: key, exported: ops.length, warning: 'duplicate-key' });
        continue;
      }
      throw error;
    }
  }

  state.lastPushedAt = startedAt;
  await state.save();

  res.json({
    success: true,
    pushedAt: startedAt,
    summary,
  });
};
