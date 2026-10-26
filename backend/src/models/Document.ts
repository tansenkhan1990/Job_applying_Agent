import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { PROFILE_KINDS } from '../config/defaults.js';

const documentSchema = new Schema(
  {
    filename: { type: String, required: true },
    relativePath: { type: String, required: true, unique: true },
    extension: { type: String, required: true, enum: ['.pdf', '.docx', '.txt'] },
    docType: {
      type: String,
      enum: ['cv', 'cover_letter', 'unknown'],
      default: 'unknown',
      index: true,
    },
    profileKind: {
      type: String,
      enum: [...PROFILE_KINDS, 'unassigned'],
      default: 'unassigned',
      index: true,
    },
    mappingSource: {
      type: String,
      enum: ['auto', 'manual', 'none'],
      default: 'none',
    },
    mappingReviewed: { type: Boolean, default: false },

    sizeBytes: { type: Number, required: true },
    contentHash: { type: String, required: true, index: true },
    lastModifiedAt: { type: Date },
    lastScannedAt: { type: Date, default: Date.now },
    changedAt: { type: Date },

    // Full extracted text is excluded by default and only loaded explicitly.
    text: { type: String, select: false },
    textPreview: { type: String, default: '' },
    pageCount: { type: Number, default: 0 },
    wordCount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['pending', 'processed', 'needs_ocr', 'failed', 'unsupported', 'missing'],
      default: 'pending',
      index: true,
    },
    error: { type: String, default: '' },
    missing: { type: Boolean, default: false, index: true },
    parsedWith: { type: String, default: '' },
  },
  { timestamps: true },
);

documentSchema.index({ profileKind: 1, docType: 1 });

documentSchema.set('toJSON', {
  transform: (_doc, ret: Record<string, unknown>) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export type DocumentRecord = InferSchemaType<typeof documentSchema>;
export const DocumentModel: Model<DocumentRecord> = mongoose.models.Document ?? model<DocumentRecord>('Document', documentSchema);
