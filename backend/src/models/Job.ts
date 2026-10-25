import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';

const jobSchema = new Schema(
  {
    source: { type: String, required: true, index: true },
    sourceJobId: { type: String, required: true },
    sourceLabel: { type: String, default: '' },
    url: { type: String, required: true },
    canonicalUrl: { type: String, required: true, index: true },
    applicationUrl: { type: String, default: '' },

    employer: { type: String, required: true },
    title: { type: String, required: true },
    location: { type: String, default: '' },
    country: { type: String, default: '' },
    remote: { type: Boolean, default: false },
    workArrangement: {
      type: String,
      enum: ['remote', 'hybrid', 'onsite', 'unknown'],
      default: 'unknown',
      index: true,
    },
    employmentType: { type: String, default: '' },
    salary: { type: String, default: '' },
    tags: { type: [String], default: [] },
    description: { type: String, default: '' },
    descriptionHtml: { type: String, default: '', select: false },

    postedAt: { type: Date, default: null },
    // Sources do not always publish a date. Such listings pass the freshness filter but are
    // marked so the dashboard never presents their age as verified.
    postedAtUnknown: { type: Boolean, default: false },
    discoveredAt: { type: Date, default: Date.now, index: true },
    lastVerifiedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },

    status: {
      type: String,
      enum: ['active', 'expired', 'unavailable', 'duplicate'],
      default: 'active',
      index: true,
    },
    statusNote: { type: String, default: '' },
    fingerprint: { type: String, required: true, index: true },
    contentHash: { type: String, default: '' },
    languageRequirement: {
      type: String,
      enum: ['english_ok', 'german_required', 'german_preferred', 'unknown'],
      default: 'unknown',
    },
    seniority: {
      type: String,
      enum: ['junior', 'mid', 'senior', 'lead', 'unknown'],
      default: 'unknown',
    },
    searchRunId: { type: Schema.Types.ObjectId, ref: 'SearchRun', default: null },
    mergedSources: { type: [String], default: [] },
  },
  { timestamps: true },
);

jobSchema.index({ source: 1, sourceJobId: 1 }, { unique: true });
jobSchema.index({ employer: 1, title: 1 });
jobSchema.index({ status: 1, discoveredAt: -1 });

jobSchema.set('toJSON', {
  transform: (_doc, ret: Record<string, unknown>) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export type JobRecord = InferSchemaType<typeof jobSchema>;
export const JobModel: Model<JobRecord> = mongoose.models.Job ?? model<JobRecord>('Job', jobSchema);
