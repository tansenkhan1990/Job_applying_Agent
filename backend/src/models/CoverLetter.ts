import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';

const coverLetterSchema = new Schema(
  {
    job: { type: Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    profile: { type: Schema.Types.ObjectId, ref: 'CandidateProfile', required: true, index: true },
    application: { type: Schema.Types.ObjectId, ref: 'Application', default: null, index: true },
    version: { type: Number, required: true, default: 1 },
    subjectLine: { type: String, default: '' },
    letterText: { type: String, required: true },
    contentHash: { type: String, required: true },
    source: {
      type: String,
      enum: ['generated', 'template', 'edited', 'original'],
      required: true,
    },
    model: { type: String, default: '' },
    promptVersion: { type: String, default: '' },
    grounding: {
      passed: { type: Boolean, default: false },
      unsupportedTerms: { type: [String], default: [] },
      unsupportedNumbers: { type: [String], default: [] },
      notes: { type: [String], default: [] },
    },
    coverLetterDocument: { type: Schema.Types.ObjectId, ref: 'Document', default: null },
    cvDocument: { type: Schema.Types.ObjectId, ref: 'Document', default: null },
    claimsUsed: { type: [String], default: [] },
    uncertainties: { type: [String], default: [] },
    wordCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

coverLetterSchema.index({ job: 1, profile: 1, version: -1 });

coverLetterSchema.set('toJSON', {
  transform: (_doc, ret: Record<string, unknown>) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export type CoverLetterRecord = InferSchemaType<typeof coverLetterSchema>;
export const CoverLetterModel: Model<CoverLetterRecord> = mongoose.models.CoverLetter ?? model<CoverLetterRecord>('CoverLetter', coverLetterSchema);
