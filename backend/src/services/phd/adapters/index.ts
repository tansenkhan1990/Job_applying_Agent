import { getSettings } from '../../settingsService.js';
import { phdFeedAdapter } from './feed.js';
import { phdMockAdapter } from './mock.js';
import type { PhdSourceAdapter } from '../types.js';

export const phdAdapters: PhdSourceAdapter[] = [phdMockAdapter, phdFeedAdapter];

export async function phdSourceStatuses() {
  const settings = await getSettings();
  return phdAdapters.map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    description: adapter.description,
    simulated: adapter.simulated,
    enabled: settings.sources[adapter.id]?.enabled ?? false,
    configured: adapter.isConfigured(),
    note: adapter.isConfigured()
      ? adapter.simulated
        ? 'Simulated local fixtures — never real advertisements.'
        : 'Ready.'
      : 'Set PHD_FEED_URL to enable this source.',
  }));
}
