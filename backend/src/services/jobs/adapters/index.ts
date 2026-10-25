import { getSettings } from '../../settingsService.js';
import { arbeitnowAdapter } from './arbeitnow.js';
import { mockAdapter } from './mock.js';
import { remotiveAdapter } from './remotive.js';
import type { JobSourceAdapter, SourceConfigStatus } from '../types.js';

export const adapters: JobSourceAdapter[] = [arbeitnowAdapter, remotiveAdapter, mockAdapter];

export function getAdapter(id: string): JobSourceAdapter | undefined {
  return adapters.find((adapter) => adapter.id === id);
}

export async function sourceStatuses(): Promise<SourceConfigStatus[]> {
  const settings = await getSettings();
  return adapters.map((adapter) => {
    const setting = settings.sources[adapter.id];
    return {
      id: adapter.id,
      label: adapter.label,
      description: adapter.description,
      enabled: setting?.enabled ?? false,
      configured: adapter.isConfigured(),
      requiresConfiguration: adapter.requiresConfiguration,
      note: adapter.isConfigured()
        ? 'No credentials required.'
        : 'Requires configuration before it can return jobs.',
    };
  });
}
