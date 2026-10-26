import type { HydratedDocument } from 'mongoose';
import { PhdPositionModel, type PhdPositionRecord } from '../../models/PhdPosition.js';
import { PhdMatchModel } from '../../models/PhdMatch.js';
import {
  CandidateProfileModel,
  type CandidateProfileRecord,
} from '../../models/CandidateProfile.js';
import { getSettings } from '../settingsService.js';
import { badRequest, notFound } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { scorePhdFit } from './scoring.js';

export interface PhdMatchOptions {
  profileIds?: string[];
  profileKinds?: string[];
}

async function scorePhdPair(
  position: HydratedDocument<PhdPositionRecord>,
  profile: HydratedDocument<CandidateProfileRecord>,
) {
  const fit = scorePhdFit(position, profile);
  return PhdMatchModel.findOneAndUpdate(
    { position: position._id, profile: profile._id },
    {
      $set: {
        profileKind: profile.kind,
        score: fit.score,
        scoreCategories: fit.categories,
        matchedTopics: fit.matchedTopics,
        missingTopics: fit.missingTopics,
        matchedSkills: fit.matchedSkills,
        missingSkills: fit.missingSkills,
        matchedPublications: fit.matchedPublications,
        qualifications: fit.qualifications,
        mandatoryMissing: fit.mandatoryMissing,
        concerns: fit.concerns,
        strengths: fit.strengths,
        languageDecision: position.languageDecision,
        reviewRequired: fit.reviewRequired,
        recommendedCvDocument: profile.cvDocument ?? null,
        explanation: fit.explanation,
        model: 'deterministic',
        promptVersion: 'phd-deterministic-v1',
        evaluatedAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

export async function matchPhdPosition(positionId: string, options: PhdMatchOptions = {}) {
  const position = await PhdPositionModel.findById(positionId);
  if (!position) throw notFound('PhD position');
  const settings = await getSettings();

  const filter: Record<string, unknown> = {};
  if (options.profileIds?.length) filter._id = { $in: options.profileIds };
  else if (options.profileKinds?.length) filter.kind = { $in: options.profileKinds };
  else filter.kind = { $in: settings.search.profileKinds };

  const profiles = await CandidateProfileModel.find(filter);
  if (profiles.length === 0) throw badRequest('No candidate profiles are available for PhD matching.');

  const results = [];
  for (const profile of profiles) {
    results.push(await scorePhdPair(position, profile));
  }

  return results;
}

/**
 * Scores positions that have no stored match yet with the deterministic model, so every
 * listed position shows an explainable estimate without an AI call or a manual action.
 */
export async function ensureDeterministicPhdMatches(positionIds: string[]): Promise<void> {
  if (positionIds.length === 0) return;
  const settings = await getSettings();
  const profiles = await CandidateProfileModel.find({
    kind: { $in: settings.search.profileKinds },
  });
  if (profiles.length === 0) return;

  const existing = await PhdMatchModel.find({ position: { $in: positionIds } })
    .select('position profile')
    .lean();
  const scored = new Set(existing.map((match) => `${match.position}:${match.profile}`));

  const positions = await PhdPositionModel.find({ _id: { $in: positionIds } });
  for (const position of positions) {
    const missing = profiles.filter(
      (profile) => !scored.has(`${position._id}:${profile._id}`),
    );
    for (const profile of missing) {
      try {
        await scorePhdPair(position, profile);
      } catch (error) {
        logger.warn(
          {
            positionId: String(position._id),
            error: error instanceof Error ? error.message : 'unknown',
          },
          'Deterministic PhD match backfill failed',
        );
      }
    }
  }
}
