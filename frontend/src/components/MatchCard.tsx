import type { JobMatch } from '../api/types';
import { titleCase } from '../lib/format';
import { Badge, Button, Card, LanguageBadge, ScoreBadge, ScoreBar } from './ui';

const requirementTone = {
  met: 'success',
  missing: 'danger',
  unknown: 'warning',
  preferred_missing: 'neutral',
} as const;

export function MatchCard({
  match,
  onPrepare,
  preparing = false,
  compact = false,
}: {
  match: JobMatch;
  onPrepare?: (profileId: string) => void;
  preparing?: boolean;
  compact?: boolean;
}) {
  const profile = typeof match.profile === 'string' ? null : match.profile;
  const profileId = typeof match.profile === 'string' ? match.profile : match.profile.id;
  const profileLabel = profile?.label ?? titleCase(match.profileKind);

  return (
    <Card
      className={match.reviewRequired ? 'border-amber-500/25' : undefined}
      title={
        <span className="flex flex-wrap items-center gap-2">
          {profileLabel}
          {profile?.status === 'draft' ? <Badge tone="warning">Profile not approved</Badge> : null}
        </span>
      }
      subtitle={
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge tone="neutral">{match.evaluationSource === 'openrouter' ? 'AI-ranked' : 'Rule-based'}</Badge>
          {match.aiScore !== null ? (
            <span className="text-[11px]">AI {Math.round(match.aiScore)} · rules {match.deterministicScore}</span>
          ) : (
            <span className="text-[11px]">Deterministic score {match.deterministicScore}</span>
          )}
          <LanguageBadge requirement={match.languageRequirement} />
          {match.promptInjectionDetected ? <Badge tone="danger">Untrusted instructions ignored</Badge> : null}
          {match.reviewRequired ? <Badge tone="warning">Review required</Badge> : null}
        </span>
      }
      action={
        <div className="flex items-center gap-2">
          <ScoreBadge score={match.score} />
          {onPrepare ? (
            <Button
              size="sm"
              variant={match.eligibleForPreparation ? 'primary' : 'secondary'}
              onClick={() => onPrepare(profileId)}
              loading={preparing}
            >
              Prepare
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="space-y-3">
        <ScoreBar score={match.score} />
        <p className="text-sm leading-relaxed text-slate-300">{match.explanation}</p>

        {!compact ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                  Matched skills
                </p>
                <div className="flex flex-wrap gap-1">
                  {match.matchedSkills.length > 0 ? (
                    match.matchedSkills.map((skill) => (
                      <Badge key={skill} tone="success">
                        {skill}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-xs text-slate-500">None detected</span>
                  )}
                </div>
              </div>
              <div>
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                  Not evidenced
                </p>
                <div className="flex flex-wrap gap-1">
                  {match.missingSkills.length > 0 ? (
                    match.missingSkills.slice(0, 8).map((skill) => (
                      <Badge key={skill} tone="neutral">
                        {skill}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-xs text-slate-500">None</span>
                  )}
                </div>
              </div>
            </div>

            {match.strengths.length > 0 ? (
              <div>
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">Strengths</p>
                <ul className="list-disc space-y-0.5 pl-4 text-xs text-slate-300">
                  {match.strengths.map((strength) => (
                    <li key={strength}>{strength}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {match.concerns.length > 0 ? (
              <div>
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">Concerns</p>
                <ul className="list-disc space-y-0.5 pl-4 text-xs text-amber-200/90">
                  {match.concerns.map((concern) => (
                    <li key={concern}>{concern}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {match.mandatoryRequirements.length > 0 ? (
              <div>
                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                  Mandatory requirements
                </p>
                <div className="space-y-1.5">
                  {match.mandatoryRequirements.map((requirement, index) => (
                    <div
                      key={`${requirement.label}-${index}`}
                      className="flex items-start gap-2 rounded-md bg-slate-950/40 px-2.5 py-1.5 text-xs"
                    >
                      <Badge tone={requirementTone[requirement.status]}>
                        {requirement.status === 'preferred_missing'
                          ? 'Preferred missing'
                          : titleCase(requirement.status)}
                      </Badge>
                      <span className="text-slate-300">
                        <span className="font-medium text-slate-200">{requirement.label}: </span>
                        {requirement.detail}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <p className="text-[11px] text-slate-500">
              Model: {match.model} · prompt {match.promptVersion} · evaluated{' '}
              {new Date(match.evaluatedAt).toLocaleString()}
            </p>
          </>
        ) : null}
      </div>
    </Card>
  );
}
