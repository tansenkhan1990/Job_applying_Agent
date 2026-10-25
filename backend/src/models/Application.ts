import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { APPLICATION_STATUSES } from '../config/defaults.js';

const questionSchema = new Schema(
  {
    questionId: { type: String, required: true },
    question: { type: String, required: true },
    required: { type: Boolean, default: true },
    answer: { type: String, default: '' },
    status: {
      type: String,
      enum: ['answered', 'requires_user', 'unknown'],
      default: 'unknown',
    },
    source: { type: String, enum: ['job_description', 'manual'], default: 'job_description' },
  },
  { _id: false },
);

const historySchema = new Schema(
  {
    from: { type: String, enum: [...APPLICATION_STATUSES, ''], default: '' },
    to: { type: String, enum: APPLICATION_STATUSES, required: true },
    at: { type: Date, default: Date.now },
    reason: { type: String, default: '' },
  },
  { _id: false },
);

const applicationSchema = new Schema(
  {
    job: { type: Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    profile: { type: Schema.Types.ObjectId, ref: 'CandidateProfile', required: true, index: true },
    match: { type: Schema.Types.ObjectId, ref: 'JobMatch', default: null },

    employer: { type: String, default: '' },
    jobTitle: { type: String, default: '' },
    jobUrl: { type: String, default: '' },
    applicationUrl: { type: String, default: '' },
    source: { type: String, default: '' },

    status: {
      type: String,
      enum: APPLICATION_STATUSES,
      default: 'DISCOVERED',
      index: true,
    },
    version: { type: Number, default: 1 },

    selectedCvDocument: { type: Schema.Types.ObjectId, ref: 'Document', default: null },
    selectedCoverLetterDocument: {
      type: Schema.Types.ObjectId,
      ref: 'Document',
      default: null,
    },
    cvHash: { type: String, default: '' },
    coverLetterHash: { type: String, default: '' },
    currentLetter: { type: Schema.Types.ObjectId, ref: 'CoverLetter', default: null },

    screeningQuestions: { type: [questionSchema], default: [] },

    approval: {
      approvedAt: { type: Date, default: null },
      approvedBy: { type: String, default: '' },
      applicationVersion: { type: Number, default: null },
      cvHash: { type: String, default: '' },
      coverLetterHash: { type: String, default: '' },
      confirmedAnswersHash: { type: String, default: '' },
      note: { type: String, default: '' },
    },

    submission: {
      attemptedAt: { type: Date, default: null },
      adapter: { type: String, default: '' },
      confirmed: { type: Boolean, default: false },
      confirmationId: { type: String, default: '' },
      message: { type: String, default: '' },
      evidence: { type: String, default: '' },
      simulated: { type: Boolean, default: false },
      manualInstructions: { type: String, default: '' },
      attempts: { type: Number, default: 0 },
      lastAttemptAt: { type: Date, default: null },
    },

    idempotencyKey: { type: String, required: true, unique: true },
    duplicateOf: { type: Schema.Types.ObjectId, ref: 'Application', default: null },
    duplicateKey: { type: String, default: '', index: true },
    statusHistory: { type: [historySchema], default: [] },
    notes: { type: String, default: '' },
  },
  { timestamps: true },
);

applicationSchema.index({ status: 1, createdAt: -1 });
applicationSchema.index({ job: 1, profile: 1 });

applicationSchema.set('toJSON', {
  transform: (_doc, ret: Record<string, unknown>) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export type ApplicationRecord = InferSchemaType<typeof applicationSchema>;
export const ApplicationModel: Model<ApplicationRecord> = mongoose.models.Application ?? model<ApplicationRecord>('Application', applicationSchema);
