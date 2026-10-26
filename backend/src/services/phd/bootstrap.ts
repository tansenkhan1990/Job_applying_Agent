import { PhdPositionModel } from '../../models/PhdPosition.js';
import { getSettings } from '../settingsService.js';
import { logger } from '../../utils/logger.js';
import { phdAdapters } from './adapters/index.js';
import { runPhdDiscovery } from './discovery.js';

/**
 * A fresh install has no doctoral positions stored, so the PhD page would stay empty until the
 * first manual search. Seed it once from the sources that are already enabled. A store that
 * already holds positions is never touched, and a failure is reported without stopping the API.
 */
export async function seedPhdPositionsIfEmpty(): Promise<number> {
  const settings = await getSettings();
  const sourceEnabled = phdAdapters.some(
    (adapter) => (settings.sources[adapter.id]?.enabled ?? false) && adapter.isConfigured(),
  );
  if (!sourceEnabled) return 0;

  const stored = await PhdPositionModel.estimatedDocumentCount();
  if (stored > 0) return 0;

  try {
    const result = await runPhdDiscovery({ trigger: 'startup' });
    logger.info(
      { discovered: result.discovered, created: result.created, filtered: result.filteredOut },
      'Initial PhD discovery complete',
    );
    return result.created;
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : 'unknown' },
      'Initial PhD discovery failed',
    );
    return 0;
  }
}
