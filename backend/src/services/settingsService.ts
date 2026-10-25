import { AppSettingModel } from '../models/AppSetting.js';
import { defaultSettings, type AppSettings } from '../config/defaults.js';
import { settingsSchema, type SettingsPatch } from '../schemas.js';
import { env } from '../config/env.js';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch === undefined ? base : patch) as T;
  }
  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = output[key];
    output[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return output as T;
}

async function getOrCreateSetting() {
  return AppSettingModel.findOneAndUpdate(
    { key: 'global' },
    { $setOnInsert: { key: 'global', value: defaultSettings() } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

export async function getSettings(): Promise<AppSettings> {
  const doc = await getOrCreateSetting();
  const parsed = settingsSchema.safeParse(doc?.value);
  if (!parsed.success) {
    // Self-heal malformed legacy settings using defaults plus whatever is valid.
    const fallback = deepMerge(defaultSettings(), isPlainObject(doc?.value) ? doc?.value : {});
    const revalidated = settingsSchema.safeParse(fallback);
    const value = revalidated.success ? revalidated.data : defaultSettings();
    await AppSettingModel.updateOne({ key: 'global' }, { $set: { value } });
    return value;
  }
  return parsed.data as AppSettings;
}

export async function updateSettings(patch: SettingsPatch): Promise<AppSettings> {
  const current = await getSettings();
  const merged = deepMerge(current, patch);
  const value = settingsSchema.parse(merged);
  await AppSettingModel.updateOne({ key: 'global' }, { $set: { value } }, { upsert: true });
  return value as AppSettings;
}

export function resolveModel(settings: AppSettings): string {
  return (settings.ai.model || env.OPENROUTER_MODEL || '').trim();
}

/** Acquire a short-lived scheduler lock so only one run happens at a time. */
export async function acquireSchedulerLock(owner: string, ttlMs = 15 * 60_000): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  await getOrCreateSetting();
  const result = await AppSettingModel.findOneAndUpdate(
    {
      key: 'global',
      $or: [
        { 'schedulerLock.expiresAt': null },
        { 'schedulerLock.expiresAt': { $lt: now } },
        { 'schedulerLock.owner': owner },
      ],
    },
    { $set: { 'schedulerLock.owner': owner, 'schedulerLock.acquiredAt': now, 'schedulerLock.expiresAt': expiresAt } },
    { new: true },
  );
  return Boolean(result);
}

export async function releaseSchedulerLock(owner: string): Promise<void> {
  await AppSettingModel.updateOne(
    { key: 'global', 'schedulerLock.owner': owner },
    { $set: { 'schedulerLock.owner': '', 'schedulerLock.acquiredAt': null, 'schedulerLock.expiresAt': null } },
  );
}
