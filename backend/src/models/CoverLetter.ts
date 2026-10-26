import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';

const coverLetterSchema = new Schema(
  {
    // A letter belongs to either a job vacancy or a PhD position.
    job: { type: Schema.Types.ObjectId, ref: 'Job', default: null, index: true },
    phdPosition: { type: Schema.Types.ObjectId, ref: 'PhdPosition', default: null, index: true },
    letterType: { type: String, enum: ['job', 'phd'], default: 'job', index: true },
    profile: { type: Schema.Types.ObjectId, ref: 'CandidateProfile', required: true, index: true },
    version: { type: Number, required: true, default: 1 },
    subjectLine: { type: String, default: '' },
    letterText: { type: String, required: true },
    // Original model output; `letterText` may later contain user edits.
    generatedText: { type: String, default: '' },
    editedByUser: { type: Boolean, default: false },
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
    // Selected writing reference and its profile. `referenceLetterDocument` is the explicit
    // reference used for the latest generation; `coverLetterDocument` mirrors it for older
    // records.
    coverLetterDocument: { type: Schema.Types.ObjectId, ref: 'Document', default: null },
    referenceLetterDocument: { type: Schema.Types.ObjectId, ref: 'Document', default: null },
    referenceProfile: { type: Schema.Types.ObjectId, ref: 'CandidateProfile', default: null },
    cvDocument: { type: Schema.Types.ObjectId, ref: 'Document', default: null },
    // Hash of the job/PhD content used for generation, so material changes can be detected.
    jobContentHash: { type: String, default: '' },
    jobSnapshotAt: { type: Date, default: null },
    selectionRationale: { type: String, default: '' },
    sourceDocuments: {
      type: [
        {
          document: { type: Schema.Types.ObjectId, ref: 'Document' },
          profileKind: String,
          docType: String,
          role: String,
        },
      ],
      default: [],
    },
    // Previous edited texts, newest last. Generated output is kept in `generatedText`, so a
    // user edit never destroys the earlier draft.
    revisions: {
      type: [
        {
          _id: false,
          text: { type: String, required: true },
          savedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
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
