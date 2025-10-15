import mongoose, { Schema } from 'mongoose';

const syncStateSchema = new Schema(
  {
    key: {
      type: String,
      unique: true,
      required: true,
    },
    lastPulledAt: {
      type: Date,
      default: new Date(0),
    },
    lastPushedAt: {
      type: Date,
      default: new Date(0),
    },
    meta: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

const SyncState = mongoose.model('SyncState', syncStateSchema);

export default SyncState;
