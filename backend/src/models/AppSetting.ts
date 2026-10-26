import mongoose, { Schema, model } from 'mongoose';

const appSettingSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, default: 'global' },
    value: { type: Schema.Types.Mixed, required: true },
    schedulerLock: {
      owner: { type: String, default: '' },
      acquiredAt: { type: Date, default: null },
      expiresAt: { type: Date, default: null },
    },
  },
  { timestamps: true },
);

appSettingSchema.set('toJSON', {
  transform: (_doc, ret: Record<string, unknown>) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const AppSettingModel = mongoose.models.AppSetting ?? model('AppSetting', appSettingSchema);
