import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import type {
  CandidateProfile,
  Job,
  JobDetailResponse,
  JobMatch,
  PrepareResponse,
  VerifyResponse,
} from '../api/types';
import { formatDate, scoreTone, statusTone, titleCase } from '../lib/format';
import { MatchCard } from '../components/MatchCard';
import { useToast } from '../components/Toast';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  LanguageDecisionBadge,
  PageHeader,
  ScoreBadge,
  Select,
  SpinnerPanel,
  WarningNote,
} from '../components/ui';

export function JobDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [profileId, setProfileId] = useState('');
  const [verification, setVerification] = useState<VerifyResponse['verification'] | null>(null);

  const detail = useQuery<JobDetailResponse>({
    queryKey: ['job', id],
    queryFn: () => api<JobDetailResponse>(`/jobs/${id}`),
    enabled: Boolean(id),
  });

  const profiles = useQuery<CandidateProfile[]>({
    queryKey: ['profiles'],
    queryFn: () => api<CandidateProfile[]>('/profiles'),
  });

  const evaluate = useMutation({
    mutationFn: () => api<{ matches: JobMatch[] }>(`/jobs/${id}/match`, { method: 'POST', body: {} }),
    onSuccess: (result) => {
      const best = [...result.matches].sort((a, b) => b.score - a.score)[0];
      toast.success(best ? `Evaluated. Best score ${best.score}/100.` : 'Evaluation complete.');
      void queryClient.invalidateQueries({ queryKey: ['job', id] });
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const verify = useMutation({
    mutationFn: () => api<VerifyResponse>(`/jobs/${id}/verify`, { method: 'POST', body: {} }),
    onSuccess: (result) => {
      setVerification(result.verification);
      void queryClient.invalidateQueries({ queryKey: ['job', id] });
      toast.info(`Availability: ${result.verification.status} — ${result.verification.evidence}`);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const ageCheck = useMutation({
    mutationFn: () => api<{ job: Job }>(`/jobs/${id}/age-check`, { method: 'POST', body: {} }),
    onSuccess: () => {
      toast.success('Posting age rechecked.');
      void queryClient.invalidateQueries({ queryKey: ['job', id] });
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const classify = useMutation({
    mutationFn: () => api<{ job: Job }>(`/jobs/${id}/classify-language`, { method: 'POST', body: {} }),
    onSuccess: () => {
      toast.success('Language requirement reclassified.');
      void queryClient.invalidateQueries({ queryKey: ['job', id] });
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const prepare = useMutation({
    mutationFn: (chosenProfileId: string) =>
      api<PrepareResponse>('/applications/prepare', {
        method: 'POST',
        body: { jobId: id, profileId: chosenProfileId },
      }),
    onSuccess: (result) => {
      for (const warning of result.warnings) toast.info(warning);
      toast.success(result.created ? 'Application prepared for review.' : 'Existing prepared application opened.');
      void queryClient.invalidateQueries({ queryKey: ['applications'] });
      navigate(`/applications/${result.application.id}`);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  if (detail.isLoading) return <SpinnerPanel label="Loading vacancy…" />;
  if (detail.error) {
    return (
      <div className="space-y-4">
        <PageHeader title="Vacancy" />
        <ErrorNote message={errorMessage(detail.error)} />
        <Link to="/jobs" className="text-sm text-indigo-300">
          ← Back to jobs
        </Link>
      </div>
    );
  }
  if (!detail.data) return null;

  const { job, matches } = detail.data;
  const sortedMatches = [...matches].sort((a, b) => b.score - a.score);
  const approvedProfiles = (profiles.data ?? []).filter((profile) => profile.status === 'approved');
  const approvedProfileIds = new Set(approvedProfiles.map((profile) => profile.id));
  const topApprovedMatch = sortedMatches.find(
    (match) => typeof match.profile !== 'string' && approvedProfileIds.has(match.profile.id),
  );
  const topProfileId =
    topApprovedMatch && typeof topApprovedMatch.profile !== 'string' ? topApprovedMatch.profile.id : '';
  // Never preselect a draft profile: the select only lists approved profiles, so a draft
  // id would otherwise be submitted while the UI appears to show an approved one.
  const chosen =
    (profileId && approvedProfileIds.has(profileId) ? profileId : '') ||
    topProfileId ||
    approvedProfiles[0]?.id ||
    '';

  return (
    <div className="space-y-5">
      <PageHeader
        title={job.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>{job.employer}</span>
            {job.location ? <span>· {job.location}</span> : null}
            <Badge tone="info">{job.sourceLabel || job.source}</Badge>
            <Badge tone={statusTone(job.status)}>{job.status}</Badge>
            {job.workArrangement !== 'unknown' ? (
              <Badge tone="neutral">{titleCase(job.workArrangement)}</Badge>
            ) : null}
            {job.seniority !== 'unknown' ? <Badge tone="neutral">{titleCase(job.seniority)}</Badge> : null}
            <LanguageDecisionBadge
              decision={job.languageDecision}
              confidence={job.languageConfidence}
            />
          </span>
        }
        actions={
          <>
            <Link to="/jobs">
              <Button variant="ghost">← Jobs</Button>
            </Link>
            <Button variant="secondary" onClick={() => verify.mutate()} loading={verify.isPending}>
              Verify availability
            </Button>
            <Button variant="primary" onClick={() => evaluate.mutate()} loading={evaluate.isPending}>
              {matches.length ? 'Re-evaluate profiles' : 'Evaluate profiles'}
            </Button>
          </>
        }
      />

      {job.status !== 'active' ? (
        <WarningNote>
          This vacancy is marked <strong>{job.status}</strong>
          {job.statusNote ? `: ${job.statusNote}` : '.'} Preparation is blocked until it is active again.
        </WarningNote>
      ) : null}

      {verification ? (
        <div className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs text-slate-300">
          Availability: <span className="font-medium">{verification.status}</span> — {verification.evidence}
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card
            title="Job description"
            subtitle={`${job.employmentType || 'Type not stated'}${job.salary ? ` · ${job.salary}` : ''} · ${
              job.postedAt ? `Posted ${formatDate(job.postedAt)}` : `Discovered ${formatDate(job.discoveredAt)}`
            }`}
            action={
              <a href={job.url} target="_blank" rel="noreferrer noopener">
                <Button size="sm" variant="ghost">
                  Original listing ↗
                </Button>
              </a>
            }
          >
            <div className="max-h-[38rem] overflow-y-auto whitespace-pre-line text-sm leading-relaxed text-slate-300">
              {job.description || 'The source did not provide a description.'}
            </div>
            {job.tags.length > 0 ? (
              <div className="mt-4 flex flex-wrap gap-1">
                {job.tags.map((tag) => (
                  <Badge key={tag} tone="neutral">
                    {tag}
                  </Badge>
                ))}
              </div>
            ) : null}
          </Card>

          <Card title="Prepare an application" subtitle="You can prepare with any approved profile">
            {approvedProfiles.length === 0 ? (
              <EmptyState
                title="No approved profiles"
                description="Approve a candidate profile before preparing an application."
                action={
                  <Link to="/profiles">
                    <Button size="sm" variant="primary">
                      Go to profiles
                    </Button>
                  </Link>
                }
              />
            ) : (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <label className="flex-1 text-xs text-slate-300">
                  Career profile
                  <Select
                    className="mt-1"
                    value={chosen}
                    onChange={(event) => setProfileId(event.target.value)}
                  >
                    {approvedProfiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.label}
                        {profile.cvDocumentInfo ? ` — ${profile.cvDocumentInfo.filename}` : ' (no CV mapped)'}
                      </option>
                    ))}
                  </Select>
                </label>
                <Button
                  variant="primary"
                  disabled={
                    !chosen ||
                    job.status !== 'active' ||
                    job.languageDecision === 'Excluded' ||
                    job.ageEligibility !== 'Eligible'
                  }
                  loading={prepare.isPending}
                  onClick={() => prepare.mutate(chosen)}
                >
                  Prepare application
                </Button>
              </div>
            )}
            {job.ageEligibility !== 'Eligible' ? (
              <WarningNote>
                Posting-age check: <strong>{job.ageEligibility}</strong>. {job.ageReason} The application
                assistant cannot start until the original posting date confirms at least three calendar months.
              </WarningNote>
            ) : null}
            {job.languageDecision === 'Excluded' ? (
              <WarningNote>
                This posting mandates German, so it is excluded from the English-first queue. Change the
                language classification only if the original listing says otherwise.
              </WarningNote>
            ) : job.languageDecision === 'Needs Review' ? (
              <WarningNote>
                The language requirement is ambiguous. Read the original listing and verify English is
                acceptable before starting an application.
              </WarningNote>
            ) : null}
            <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
              Preparation generates a tailored cover letter, extracts screening questions and creates an
              approval record request. Nothing is submitted until you approve and explicitly submit.
            </p>
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="At a glance">
            <dl className="space-y-2.5 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-slate-400">Match score</dt>
                <dd>
                  {sortedMatches[0] ? <ScoreBadge score={sortedMatches[0].score} /> : <Badge>Not scored</Badge>}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-400">Language</dt>
                <dd className="text-slate-200">{titleCase(job.languageRequirement)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-400">Work arrangement</dt>
                <dd className="text-slate-200">{titleCase(job.workArrangement)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-400">Last verified</dt>
                <dd className="text-slate-200">{formatDate(job.lastVerifiedAt)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-400">Application URL</dt>
                <dd>
                  <a
                    href={job.applicationUrl || job.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-indigo-300 hover:text-indigo-200"
                  >
                    Open ↗
                  </a>
                </dd>
              </div>
            </dl>
          </Card>

          <Card
            title="Posting age"
            subtitle={
              job.postedAt ? `Originally posted ${formatDate(job.postedAt)}` : 'Original posting date unknown'
            }
            action={
              <Button
                size="sm"
                variant="ghost"
                onClick={() => ageCheck.mutate()}
                loading={ageCheck.isPending}
              >
                Recheck
              </Button>
            }
          >
            <div className="space-y-2.5 text-xs">
              <div className="flex flex-wrap gap-1.5">
                <Badge
                  tone={
                    job.ageEligibility === 'Eligible'
                      ? 'success'
                      : job.ageEligibility === 'Too Recent'
                        ? 'warning'
                        : job.ageEligibility === 'Expired'
                          ? 'danger'
                          : 'neutral'
                  }
                >
                  {job.ageEligibility}
                </Badge>
                <Badge tone="neutral">
                  {job.eligibleAfter ? `Eligible from ${formatDate(job.eligibleAfter)}` : 'No eligible date'}
                </Badge>
              </div>
              <p className="leading-relaxed text-slate-300">{job.ageReason}</p>
              <p className="text-[11px] leading-relaxed text-slate-500">
                Calendar-month calculation from the original posting date. First-seen and discovery dates are
                never used as a substitute.
              </p>
            </div>
          </Card>

          <Card
            title="Language assessment"
            subtitle={`Confidence ${job.languageConfidence}% · ${job.jobLanguage} posting`}
            action={
              <Button
                size="sm"
                variant="ghost"
                onClick={() => classify.mutate()}
                loading={classify.isPending}
              >
                Reclassify
              </Button>
            }
          >
            <div className="space-y-2.5 text-xs">
              <div className="flex flex-wrap gap-1.5">
                <LanguageDecisionBadge decision={job.languageDecision} />
                {job.englishRequired ? (
                  <Badge tone="success">English required / sufficient</Badge>
                ) : null}
                {job.germanOptional ? <Badge tone="info">German optional</Badge> : null}
                {job.germanRequired ? <Badge tone="danger">German required</Badge> : null}
              </div>
              <p className="leading-relaxed text-slate-300">{job.languageReason}</p>
              {job.languageEvidence ? (
                <blockquote className="border-l-2 border-slate-700 pl-2 italic leading-relaxed text-slate-400">
                  “{job.languageEvidence}”
                </blockquote>
              ) : (
                <p className="text-slate-500">No direct language statement was found in the description.</p>
              )}
              <p className="text-[11px] leading-relaxed text-slate-500">
                Rule-based classification with supporting evidence. Always verify the original listing.
              </p>
            </div>
          </Card>

          <Card title="Profiles evaluated" padded={false}>
            {sortedMatches.length === 0 ? (
              <div className="p-4 text-xs text-slate-400">
                No profile has been evaluated yet. Use “Evaluate profiles”.
              </div>
            ) : (
              <ul className="divide-y divide-slate-800">
                {sortedMatches.map((match) => (
                  <li key={match.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <span className="text-xs text-slate-300">
                      {typeof match.profile === 'string' ? titleCase(match.profileKind) : match.profile.label}
                    </span>
                    <ScoreBadge score={match.score} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <div className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Match explanations
        </h2>
        {sortedMatches.length === 0 ? (
          <EmptyState
            title="No match data"
            description="Evaluate this vacancy against your career profiles to see evidence-based reasoning."
            action={
              <Button variant="primary" onClick={() => evaluate.mutate()} loading={evaluate.isPending}>
                Evaluate profiles
              </Button>
            }
          />
        ) : (
          sortedMatches.map((match) => (
            <MatchCard
              key={match.id}
              match={match}
              preparing={prepare.isPending}
              onPrepare={(matchedProfileId) => prepare.mutate(matchedProfileId)}
            />
          ))
        )}
      </div>
    </div>
  );
}
