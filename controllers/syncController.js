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

const normalizeName = (value) => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

const COLLECTION_SANITIZERS = {
  users: (doc) => {
    const clone = { ...doc };
    if (typeof clone.email === 'string') {
      const trimmed = clone.email.trim();
      if (!trimmed) {
        delete clone.email;
      } else {
        clone.email = trimmed.toLowerCase();
      }
    }
    return clone;
  },
  colleges: (doc) => {
    const clone = { ...doc };
    if (clone.name) clone.name = normalizeName(clone.name);
    if (clone.code) clone.code = normalizeName(clone.code);
    return clone;
  },
  departments: (doc) => {
    const clone = { ...doc };
    if (clone.name) clone.name = normalizeName(clone.name);
    if (clone.code) clone.code = normalizeName(clone.code);
    return clone;
  },
  programmes: (doc) => {
    const clone = { ...doc };
    if (clone.name) clone.name = normalizeName(clone.name);
    if (clone.code) clone.code = normalizeName(clone.code);
    return clone;
  },
};

const dedupeDocs = (collectionKey, docs, context = 'sync') => {
  if (collectionKey === 'users') {
    const seenEmails = new Set();
    const filtered = [];
    for (const doc of docs) {
      const emailKey = typeof doc.email === 'string' && doc.email.length
        ? `email:${doc.email}`
        : null;
      if (emailKey) {
        if (seenEmails.has(emailKey)) {
          console.warn(`${context} warning (${collectionKey}): skipping duplicate record for key ${emailKey}`);
          continue;
        }
        seenEmails.add(emailKey);
      }
      filtered.push(doc);
    }
    return filtered;
  }

  if (collectionKey === 'colleges') {
    const seenNames = new Set();
    return docs.filter((doc) => {
      const key = normalizeName(doc.name);
      if (!key) return false;
      if (seenNames.has(key)) {
        console.warn(`${context} warning (${collectionKey}): skipping duplicate college with name ${key}`);
        return false;
      }
      seenNames.add(key);
      return true;
    });
  }

  if (collectionKey === 'departments') {
    const seenKeys = new Set();
    const filtered = [];
    for (const doc of docs) {
      const nameKey = normalizeName(doc.name);
      const collegeKey = doc.college ? String(doc.college) : '';
      const composite = `${collegeKey}::${nameKey}`;
      if (!nameKey) continue;
      if (seenKeys.has(composite)) {
        console.warn(`${context} warning (${collectionKey}): skipping duplicate department ${nameKey} for college ${collegeKey}`);
        continue;
      }
      seenKeys.add(composite);
      filtered.push(doc);
    }
    return filtered;
  }

  const filtered = [];
  for (const doc of docs) {
    filtered.push(doc);
  }
  return filtered;
};

const sanitizeDoc = (collectionKey, doc) => {
  if (!doc) return doc;
  let clone = { ...doc };
  const sanitizer = COLLECTION_SANITIZERS[collectionKey];
  if (sanitizer) {
    clone = sanitizer(clone) || clone;
  }
  if (clone._id && typeof clone._id === 'object' && clone._id._bsontype === 'ObjectID') {
    clone._id = clone._id;
  }
  return clone;
};

const buildBulkOps = (collectionKey, docs, context = 'sync') => {
  const sanitizedDocs = dedupeDocs(
    collectionKey,
    docs.map((doc) => sanitizeDoc(collectionKey, doc)),
    context,
  );

  return sanitizedDocs.map((doc) => {
    const { _id, ...rest } = doc;
    if (collectionKey === 'users') {
      const filterOr = [];
      if (_id) filterOr.push({ _id });
      if (rest.email) filterOr.push({ email: rest.email });
      const filter = filterOr.length === 0
        ? { _id }
        : (filterOr.length === 1 ? filterOr[0] : { $or: filterOr });

      const update = { $set: rest };
      if (_id) {
        update.$setOnInsert = { _id };
      }

      return {
        updateOne: {
          filter,
          update,
          upsert: true,
        },
      };
    }

    return {
      updateOne: {
        filter: { _id },
        update: { $set: rest },
        upsert: true,
      },
    };
  });
};

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

    const ops = buildBulkOps(key, freshDocs, 'pull');
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

    const ops = buildBulkOps(key, freshDocs, 'push');
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
