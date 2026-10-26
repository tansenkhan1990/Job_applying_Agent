import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';

const jobSchema = new Schema(
  {
    source: { type: String, required: true, index: true },
    sourceJobId: { type: String, required: true },
    sourceLabel: { type: String, default: '' },
    // Local fixtures only. The UI labels them so sample data can never look like a live listing.
    simulated: { type: Boolean, default: false, index: true },
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
    salaryMin: { type: Number, default: null, index: true },
    salaryMax: { type: Number, default: null, index: true },
    tags: { type: [String], default: [] },
    description: { type: String, default: '' },
    descriptionHtml: { type: String, default: '', select: false },

    postedAt: { type: Date, default: null },
    // Calendar date in the source's timezone (YYYY-MM-DD) when the source exposes one.
    postedLocalDate: { type: String, default: '' },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: null },
    ageEligibility: {
      type: String,
      enum: ['Eligible', 'Too Recent', 'Unknown', 'Expired'],
      default: 'Unknown',
      index: true,
    },
    eligibleAfter: { type: Date, default: null },
    ageCheckAt: { type: Date, default: Date.now },
    ageReason: { type: String, default: '' },
    // Sources do not always publish a date. Such listings pass the freshness filter but are
    // marked so the dashboard never presents their age as verified.
    postedAtUnknown: { type: Boolean, default: false },
    discoveredAt: { type: Date, default: Date.now, index: true },
    lastVerifiedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },

    // Personal dashboard state (single local user).
    saved: { type: Boolean, default: false, index: true },
    // Remembered per-job letter document choice. Auto-selection fills these when unset.
    letterPreferences: {
      cvProfile: { type: Schema.Types.ObjectId, ref: 'CandidateProfile', default: null },
      referenceProfile: { type: Schema.Types.ObjectId, ref: 'CandidateProfile', default: null },
      updatedAt: { type: Date, default: null },
    },
    reviewedAt: { type: Date, default: null, index: true },
    // True/false only when the source explicitly states remote eligibility from Germany.
    remoteEligibleFromGermany: { type: Boolean, default: null },

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
      enum: ['english_ok', 'german_not_required', 'german_required', 'german_preferred', 'unknown'],
      default: 'unknown',
    },
    jobLanguage: {
      type: String,
      enum: ['English', 'German', 'Mixed', 'Unknown'],
      default: 'Unknown',
    },
    englishRequired: { type: Boolean, default: null },
    germanRequired: { type: Boolean, default: null },
    germanOptional: { type: Boolean, default: null },
    languageEvidence: { type: String, default: '' },
    languageConfidence: { type: Number, default: 0, min: 0, max: 100 },
    languageDecision: {
      type: String,
      enum: ['Eligible', 'Excluded', 'Needs Review'],
      default: 'Needs Review',
      index: true,
    },
    languageReason: { type: String, default: '' },
    languageClassifiedAt: { type: Date, default: Date.now },
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
jobSchema.index({ ageEligibility: 1, status: 1 });

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
