import { PhdPositionModel } from '../../models/PhdPosition.js';
import { PhdMatchModel } from '../../models/PhdMatch.js';
import { CandidateProfileModel } from '../../models/CandidateProfile.js';
import { getSettings } from '../settingsService.js';
import { badRequest, notFound } from '../../utils/errors.js';
import { scorePhdFit } from './scoring.js';

export interface PhdMatchOptions {
  profileIds?: string[];
  profileKinds?: string[];
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
    const fit = scorePhdFit(position, profile);
    const doc = await PhdMatchModel.findOneAndUpdate(
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
    results.push(doc);
  }

  return results;
}
