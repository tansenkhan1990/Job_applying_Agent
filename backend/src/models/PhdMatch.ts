import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';

const phdMatchSchema = new Schema(
  {
    position: { type: Schema.Types.ObjectId, ref: 'PhdPosition', required: true, index: true },
    profile: { type: Schema.Types.ObjectId, ref: 'CandidateProfile', required: true, index: true },
    profileKind: { type: String, required: true },

    score: { type: Number, required: true, min: 0, max: 100, index: true },
    scoreCategories: {
      type: [
        {
          key: String,
          label: String,
          weight: Number,
          score: Number,
          detail: String,
        },
      ],
      default: [],
    },
    matchedTopics: { type: [String], default: [] },
    missingTopics: { type: [String], default: [] },
    matchedSkills: { type: [String], default: [] },
    missingSkills: { type: [String], default: [] },
    matchedPublications: { type: [String], default: [] },
    qualifications: { type: [String], default: [] },
    mandatoryMissing: { type: [String], default: [] },
    concerns: { type: [String], default: [] },
    strengths: { type: [String], default: [] },
    languageDecision: {
      type: String,
      enum: ['Eligible', 'Excluded', 'Needs Review'],
      default: 'Needs Review',
    },
    reviewRequired: { type: Boolean, default: true },

    recommendedCvDocument: { type: Schema.Types.ObjectId, ref: 'Document', default: null },
    explanation: { type: String, default: '' },
    model: { type: String, default: 'deterministic' },
    promptVersion: { type: String, default: 'phd-deterministic-v1' },
    evaluatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

phdMatchSchema.index({ position: 1, profile: 1 }, { unique: true });
phdMatchSchema.index({ profile: 1, score: -1 });

phdMatchSchema.set('toJSON', {
  transform: (_doc, ret: Record<string, unknown>) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export type PhdMatchRecord = InferSchemaType<typeof phdMatchSchema>;
export const PhdMatchModel: Model<PhdMatchRecord> =
  mongoose.models.PhdMatch ?? model<PhdMatchRecord>('PhdMatch', phdMatchSchema);
