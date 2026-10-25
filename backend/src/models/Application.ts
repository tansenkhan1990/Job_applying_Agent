import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { APPLICATION_STATUSES, WORKFLOW_STATUSES } from '../config/defaults.js';

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
    source: { type: String, enum: ['AI', 'user', 'system'], default: 'system' },
    reference: { type: String, default: '' },
  },
  { _id: false },
);

const languageSnapshotSchema = new Schema(
  {
    jobLanguage: { type: String, default: 'Unknown' },
    englishRequired: { type: Boolean, default: null },
    germanRequired: { type: Boolean, default: null },
    germanOptional: { type: Boolean, default: null },
    languageDecision: { type: String, default: 'Needs Review' },
    languageConfidence: { type: Number, default: 0 },
    languageEvidence: { type: String, default: '' },
    languageReason: { type: String, default: '' },
  },
  { _id: false },
);

const workflowEventSchema = new Schema(
  {
    at: { type: Date, default: Date.now },
    type: { type: String, default: '' },
    from: { type: String, default: '' },
    to: { type: String, default: '' },
    source: { type: String, enum: ['AI', 'user', 'system', ''], default: 'system' },
    message: { type: String, default: '' },
  },
  { _id: false },
);

const reviewFieldSchema = new Schema(
  {
    label: { type: String, default: '' },
    reason: { type: String, default: '' },
    fieldType: { type: String, default: '' },
  },
  { _id: false },
);

const workflowSchema = new Schema(
  {
    status: {
      type: String,
      enum: WORKFLOW_STATUSES,
      default: 'DISCOVERED',
      index: true,
    },
    startedAt: { type: Date, default: null },
    updatedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    startRequestedAt: { type: Date, default: null },
    runnerId: { type: String, default: '' },
    runnerSeenAt: { type: Date, default: null },
    pauseRequested: { type: Boolean, default: false },
    stopRequested: { type: Boolean, default: false },
    fieldsDetected: { type: Number, default: 0 },
    fieldsFilled: { type: Number, default: 0 },
    filesUploaded: { type: Number, default: 0 },
    unanswered: { type: [String], default: [] },
    reviewFields: { type: [reviewFieldSchema], default: [] },
    validationErrors: { type: [String], default: [] },
    lastError: { type: String, default: '' },
    pageUrl: { type: String, default: '' },
    pageTitle: { type: String, default: '' },
    events: { type: [workflowEventSchema], default: [] },
    confirmation: {
      confirmedAt: { type: Date, default: null },
      method: { type: String, default: '' },
      evidence: { type: String, default: '' },
      confirmationId: { type: String, default: '' },
    },
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
    jobLocation: { type: String, default: '' },
    workArrangement: { type: String, default: '' },
    postedAt: { type: Date, default: null },
    ageEligibility: {
      type: String,
      enum: ['Eligible', 'Too Recent', 'Unknown', 'Expired'],
      default: 'Unknown',
      index: true,
    },
    eligibleAfter: { type: Date, default: null },
    ageReason: { type: String, default: '' },
    discoveredAt: { type: Date, default: null },
    jobDescriptionSnapshot: { type: String, default: '' },
    languageSnapshot: { type: languageSnapshotSchema, default: () => ({}) },
    matchScore: { type: Number, default: null },
    matchExplanation: { type: String, default: '' },
    profileKind: { type: String, default: '' },
    selectedCvFilename: { type: String, default: '' },
    selectedCoverLetterFilename: { type: String, default: '' },
    preparationStartedAt: { type: Date, default: null },
    formFilledAt: { type: Date, default: null },

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

    // Set once a submission is confirmed. Applications are kept forever so a vacancy can
    // never be applied to twice, even months later or after the employer reposts it.
    appliedAt: { type: Date, default: null, index: true },

    // Human-supervised browser assistant state. This is separate from `status`, which
    // remains the local approval/record state machine.
    workflow: { type: workflowSchema, default: () => ({}) },

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
applicationSchema.index({ ageEligibility: 1, 'workflow.status': 1 });
applicationSchema.index({ duplicateKey: 1, appliedAt: -1 });
applicationSchema.index({ 'workflow.status': 1, 'workflow.startRequestedAt': 1 });

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
