import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';

const sourceResultSchema = new Schema(
  {
    source: { type: String, required: true },
    status: { type: String, enum: ['ok', 'failed', 'skipped'], required: true },
    found: { type: Number, default: 0 },
    created: { type: Number, default: 0 },
    updated: { type: Number, default: 0 },
    duplicates: { type: Number, default: 0 },
    filtered: { type: Number, default: 0 },
    durationMs: { type: Number, default: 0 },
    error: { type: String, default: '' },
  },
  { _id: false },
);

const searchRunSchema = new Schema(
  {
    status: {
      type: String,
      enum: ['running', 'completed', 'failed'],
      default: 'running',
      index: true,
    },
    trigger: { type: String, enum: ['manual', 'scheduled', 'startup'], default: 'manual' },
    kind: { type: String, enum: ['jobs', 'phd'], default: 'jobs', index: true },
    criteriaSnapshot: { type: Schema.Types.Mixed, default: {} },
    sources: { type: [sourceResultSchema], default: [] },
    discovered: { type: Number, default: 0 },
    created: { type: Number, default: 0 },
    updatedJobs: { type: Number, default: 0 },
    duplicates: { type: Number, default: 0 },
    filteredOut: { type: Number, default: 0 },
    scored: { type: Number, default: 0 },
    errorMessages: { type: [String], default: [] },
    startedAt: { type: Date, default: Date.now, index: true },
    finishedAt: { type: Date, default: null },
    durationMs: { type: Number, default: 0 },
  },
  { timestamps: true },
);

searchRunSchema.set('toJSON', {
  transform: (_doc, ret: Record<string, unknown>) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export type SearchRunRecord = InferSchemaType<typeof searchRunSchema>;
export const SearchRunModel: Model<SearchRunRecord> = mongoose.models.SearchRun ?? model<SearchRunRecord>('SearchRun', searchRunSchema);
