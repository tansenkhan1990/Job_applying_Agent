import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';

const phdPositionSchema = new Schema(
  {
    source: { type: String, required: true, index: true },
    sourceJobId: { type: String, required: true },
    sourceLabel: { type: String, default: '' },
    simulated: { type: Boolean, default: false, index: true },
    url: { type: String, required: true },
    canonicalUrl: { type: String, required: true, index: true },
    applicationUrl: { type: String, default: '' },

    institution: { type: String, required: true },
    title: { type: String, required: true },
    researchGroup: { type: String, default: '' },
    supervisor: { type: String, default: '' },
    department: { type: String, default: '' },

    location: { type: String, default: '' },
    country: { type: String, default: '', index: true },
    workArrangement: {
      type: String,
      enum: ['remote', 'hybrid', 'onsite', 'unknown'],
      default: 'unknown',
    },
    // Only set when the advertisement explicitly states whether remote work from Germany is
    // possible. "Flexible working" alone is not treated as remote eligibility.
    remoteEligibleFromGermany: { type: Boolean, default: null, index: true },

    researchTopic: { type: String, default: '' },
    researchArea: {
      type: String,
      enum: ['ai', 'cybersecurity', 'software_engineering', 'other'],
      default: 'other',
      index: true,
    },
    researchAreaEvidence: { type: String, default: '' },
    description: { type: String, default: '' },
    requiredQualifications: { type: [String], default: [] },
    requiredSkills: { type: [String], default: [] },
    preferredSkills: { type: [String], default: [] },
    requiredMethods: { type: [String], default: [] },
    requiredLanguages: { type: [String], default: [] },
    funding: { type: String, default: '' },
    salary: { type: String, default: '' },
    employmentRequirements: { type: [String], default: [] },

    languageRequirement: {
      type: String,
      enum: ['english_ok', 'german_not_required', 'german_required', 'german_preferred', 'unknown'],
      default: 'unknown',
    },
    languageDecision: {
      type: String,
      enum: ['Eligible', 'Excluded', 'Needs Review'],
      default: 'Needs Review',
      index: true,
    },
    languageEvidence: { type: String, default: '' },
    languageReason: { type: String, default: '' },
    languageConfidence: { type: Number, default: 0, min: 0, max: 100 },

    postedAt: { type: Date, default: null, index: true },
    postedAtUnknown: { type: Boolean, default: true },
    applicationDeadline: { type: Date, default: null, index: true },
    // Timezone and clock-time precision are stored so a deadline on the current local day is
    // not incorrectly treated as passed.
    deadlineTimezone: { type: String, default: '' },
    deadlineHasTime: { type: Boolean, default: false },
    // True only when the advertisement states rolling/continuous admission.
    rollingAdmissions: { type: Boolean, default: false },
    deadlineStatus: {
      type: String,
      enum: ['open', 'expired', 'unknown', 'closed'],
      default: 'unknown',
      index: true,
    },
    deadlineNote: { type: String, default: '' },
    expectedStartDate: { type: String, default: '' },

    discoveredAt: { type: Date, default: Date.now, index: true },
    lastSeenAt: { type: Date, default: null },
    lastVerifiedAt: { type: Date, default: null },

    // Personal dashboard state.
    saved: { type: Boolean, default: false, index: true },
    letterPreferences: {
      cvProfile: { type: Schema.Types.ObjectId, ref: 'CandidateProfile', default: null },
      referenceProfile: { type: Schema.Types.ObjectId, ref: 'CandidateProfile', default: null },
      updatedAt: { type: Date, default: null },
    },
    reviewedAt: { type: Date, default: null, index: true },

    status: {
      type: String,
      enum: ['active', 'expired', 'closed', 'duplicate'],
      default: 'active',
      index: true,
    },
    statusNote: { type: String, default: '' },

    fingerprint: { type: String, required: true, index: true },
    contentHash: { type: String, default: '' },
    mergedSources: { type: [String], default: [] },
    searchRunId: { type: Schema.Types.ObjectId, ref: 'SearchRun', default: null },
  },
  { timestamps: true },
);

phdPositionSchema.index({ source: 1, sourceJobId: 1 }, { unique: true });
phdPositionSchema.index({ institution: 1, title: 1 });
phdPositionSchema.index({ status: 1, discoveredAt: -1 });
phdPositionSchema.index({ status: 1, applicationDeadline: 1 });
phdPositionSchema.index({ status: 1, deadlineStatus: 1 });
phdPositionSchema.index({ researchArea: 1, status: 1 });

phdPositionSchema.set('toJSON', {
  transform: (_doc, ret: Record<string, unknown>) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export type PhdPositionRecord = InferSchemaType<typeof phdPositionSchema>;
export const PhdPositionModel: Model<PhdPositionRecord> =
  mongoose.models.PhdPosition ?? model<PhdPositionRecord>('PhdPosition', phdPositionSchema);
