import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { PROFILE_KINDS } from '../config/defaults.js';

const experienceSchema = new Schema(
  {
    title: { type: String, required: true },
    employer: { type: String, required: true },
    startDate: { type: String, default: '' },
    endDate: { type: String, default: '' },
    summary: { type: String, default: '' },
  },
  { _id: false },
);

const educationSchema = new Schema(
  {
    degree: { type: String, required: true },
    institution: { type: String, required: true },
    year: { type: String, default: '' },
  },
  { _id: false },
);

const projectSchema = new Schema(
  {
    name: { type: String, required: true },
    summary: { type: String, default: '' },
    technologies: { type: [String], default: [] },
  },
  { _id: false },
);

const languageSchema = new Schema(
  {
    language: { type: String, required: true },
    level: { type: String, default: 'unknown' },
  },
  { _id: false },
);

const profileSchema = new Schema(
  {
    kind: {
      type: String,
      enum: PROFILE_KINDS,
      required: true,
      unique: true,
      index: true,
    },
    label: { type: String, required: true },
    name: { type: String, default: '' },
    targetTitles: { type: [String], default: [] },
    skills: { type: [String], default: [] },
    experienceSummary: { type: String, default: '' },
    yearsExperience: { type: Number, default: null, min: 0, max: 60 },
    location: { type: String, default: '' },
    experience: { type: [experienceSchema], default: [] },
    education: { type: [educationSchema], default: [] },
    projects: { type: [projectSchema], default: [] },
    certifications: { type: [String], default: [] },
    languages: { type: [languageSchema], default: [] },
    publications: { type: [String], default: [] },
    workPreferences: {
      countries: { type: [String], default: ['Germany'] },
      remote: { type: Boolean, default: true },
      hybrid: { type: Boolean, default: true },
      onsite: { type: Boolean, default: true },
      languages: { type: [String], default: ['English'] },
    },
    cvDocument: { type: Schema.Types.ObjectId, ref: 'Document', default: null },
    coverLetterDocument: { type: Schema.Types.ObjectId, ref: 'Document', default: null },
    status: { type: String, enum: ['draft', 'approved'], default: 'draft', index: true },
    extractionSource: {
      type: String,
      enum: ['default', 'ai', 'heuristic', 'manual'],
      default: 'default',
    },
    extractedAt: { type: Date, default: null },
    extractionModel: { type: String, default: '' },
    reviewNotes: { type: String, default: '' },
  },
  { timestamps: true },
);

profileSchema.set('toJSON', {
  transform: (_doc, ret: Record<string, unknown>) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export type CandidateProfileRecord = InferSchemaType<typeof profileSchema>;
export const CandidateProfileModel: Model<CandidateProfileRecord> = mongoose.models.CandidateProfile ?? model<CandidateProfileRecord>('CandidateProfile', profileSchema);
