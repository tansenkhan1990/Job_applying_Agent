import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';

const jobMatchSchema = new Schema(
  {
    job: { type: Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    profile: { type: Schema.Types.ObjectId, ref: 'CandidateProfile', required: true, index: true },
    profileKind: { type: String, required: true, index: true },
    jobTitle: { type: String, default: '' },
    employer: { type: String, default: '' },

    score: { type: Number, required: true, min: 0, max: 100, index: true },
    deterministicScore: { type: Number, required: true, min: 0, max: 100 },
    aiScore: { type: Number, default: null },
    scoreBreakdown: {
      title: { type: Number, default: 0 },
      skills: { type: Number, default: 0 },
      seniority: { type: Number, default: 0 },
      location: { type: Number, default: 0 },
    },
    matchedSkills: { type: [String], default: [] },
    missingSkills: { type: [String], default: [] },
    strengths: { type: [String], default: [] },
    concerns: { type: [String], default: [] },
    explanation: { type: String, default: '' },
    mandatoryRequirements: {
      type: [
        {
          label: String,
          status: { type: String, enum: ['met', 'missing', 'unknown', 'preferred_missing'] },
          detail: String,
        },
      ],
      default: [],
    },
    mandatoryUnknown: { type: [String], default: [] },
    languageRequirement: {
      type: String,
      enum: ['english_ok', 'german_required', 'german_preferred', 'unknown'],
      default: 'unknown',
    },
    languageAssessment: {
      requiredLanguage: { type: String, default: '' },
      mandatory: { type: Boolean, default: false },
      candidateMeets: { type: String, enum: ['yes', 'no', 'unknown'], default: 'unknown' },
    },
    promptInjectionDetected: { type: Boolean, default: false },
    recommendedCvDocument: { type: Schema.Types.ObjectId, ref: 'Document', default: null },
    recommendedCoverLetterDocument: {
      type: Schema.Types.ObjectId,
      ref: 'Document',
      default: null,
    },
    recommendedProfileKind: { type: String, default: '' },
    eligibleForPreparation: { type: Boolean, default: false },
    reviewRequired: { type: Boolean, default: true },

    model: { type: String, default: 'deterministic' },
    promptVersion: { type: String, required: true },
    evaluationSource: {
      type: String,
      enum: ['openrouter', 'deterministic'],
      default: 'deterministic',
    },
    evaluatedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

jobMatchSchema.index({ job: 1, profile: 1 }, { unique: true });
jobMatchSchema.index({ profile: 1, score: -1 });
jobMatchSchema.index({ profile: 1, evaluatedAt: -1 });

jobMatchSchema.set('toJSON', {
  transform: (_doc, ret: Record<string, unknown>) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export type JobMatchRecord = InferSchemaType<typeof jobMatchSchema>;
export const JobMatchModel: Model<JobMatchRecord> = mongoose.models.JobMatch ?? model<JobMatchRecord>('JobMatch', jobMatchSchema);
