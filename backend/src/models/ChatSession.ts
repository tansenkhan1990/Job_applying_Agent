import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';

const messageSchema = new Schema(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    model: { type: String, default: '' },
    sources: { type: [String], default: [] },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const chatSessionSchema = new Schema(
  {
    targetType: { type: String, enum: ['job', 'phd'], required: true, index: true },
    // Exactly one of these is set; queries always include it so conversations cannot leak
    // between targets.
    job: { type: Schema.Types.ObjectId, ref: 'Job', default: null, index: true },
    phdPosition: { type: Schema.Types.ObjectId, ref: 'PhdPosition', default: null, index: true },
    title: { type: String, default: '' },
    aiModel: { type: String, default: '' },
    messages: { type: [messageSchema], default: [] },
    contextSnapshot: {
      targetContentHash: { type: String, default: '' },
      selectedProfile: { type: Schema.Types.ObjectId, ref: 'CandidateProfile', default: null },
      selectedLetter: { type: Schema.Types.ObjectId, ref: 'CoverLetter', default: null },
      documentIds: { type: [Schema.Types.ObjectId], default: [] },
      notes: { type: [String], default: [] },
    },
    lastMessageAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

chatSessionSchema.index({ job: 1, updatedAt: -1 });
chatSessionSchema.index({ phdPosition: 1, updatedAt: -1 });

chatSessionSchema.set('toJSON', {
  transform: (_doc, ret: Record<string, unknown>) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export type ChatSessionRecord = InferSchemaType<typeof chatSessionSchema>;
export const ChatSessionModel: Model<ChatSessionRecord> =
  mongoose.models.ChatSession ?? model<ChatSessionRecord>('ChatSession', chatSessionSchema);
