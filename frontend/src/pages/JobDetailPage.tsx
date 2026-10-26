import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, apiBase, errorMessage } from '../api/client';
import type {
  CandidateProfile,
  CoverLetterVersion,
  Job,
  JobDetailResponse,
  JobMatch,
  LetterOptions,
  VerifyResponse,
} from '../api/types';
import { formatDate, scoreTone, statusTone, titleCase } from '../lib/format';
import { ChatPanel } from '../components/ChatPanel';
import { MatchCard } from '../components/MatchCard';
import { useToast } from '../components/Toast';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Input,
  LanguageDecisionBadge,
  PageHeader,
  ScoreBadge,
  Select,
  SpinnerPanel,
  WarningNote,
} from '../components/ui';

export function JobDetailPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [verification, setVerification] = useState<VerifyResponse['verification'] | null>(null);
  const [letterProfileId, setLetterProfileId] = useState('');
  const [letterReferenceId, setLetterReferenceId] = useState('');
  const [letterInstructions, setLetterInstructions] = useState('');
  const [selectedLetterId, setSelectedLetterId] = useState('');
  const [draft, setDraft] = useState('');

  const detail = useQuery<JobDetailResponse>({
    queryKey: ['job', id],
    queryFn: () => api<JobDetailResponse>(`/jobs/${id}`),
    enabled: Boolean(id),
  });

  const profiles = useQuery<CandidateProfile[]>({
    queryKey: ['profiles'],
    queryFn: () => api<CandidateProfile[]>('/profiles'),
  });

  const letters = useQuery<CoverLetterVersion[]>({
    queryKey: ['job-letters', id],
    queryFn: () => api<CoverLetterVersion[]>(`/jobs/${id}/cover-letters`),
    enabled: Boolean(id),
  });

  const letterOptions = useQuery<LetterOptions>({
    queryKey: ['job-letter-options', id],
    queryFn: () => api<LetterOptions>(`/jobs/${id}/cover-letter/options`),
    enabled: Boolean(id),
  });

  const saveLetterPreference = useMutation({
    mutationFn: (patch: { cvProfileId: string; referenceProfileId?: string }) =>
      api<LetterOptions>(`/jobs/${id}/letter-preferences`, { method: 'PATCH', body: patch }),
    onSuccess: (result) => {
      queryClient.setQueryData(['job-letter-options', id], result);
      toast.success('CV and reference letter preferences saved for this job.');
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const generateLetter = useMutation({
    mutationFn: () =>
      api<{ letter: CoverLetterVersion }>(`/jobs/${id}/cover-letter`, {
        method: 'POST',
        body: {
          profileId: letterProfileId || letterOptions.data?.selectedCvProfileId || undefined,
          referenceProfileId:
            letterReferenceId || letterOptions.data?.selectedReferenceProfileId || undefined,
          instructions: letterInstructions || undefined,
        },
      }),
    onSuccess: (result) => {
      setSelectedLetterId(result.letter.id);
      setDraft(result.letter.letterText);
      setLetterInstructions('');
      toast.success('Cover letter draft generated. Review it before using it.');
      void queryClient.invalidateQueries({ queryKey: ['job-letters', id] });
      void queryClient.invalidateQueries({ queryKey: ['job-letter-options', id] });
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const saveLetter = useMutation({
    mutationFn: (letterId: string) =>
      api<{ letter: CoverLetterVersion }>(`/jobs/${id}/cover-letters/${letterId}`, {
        method: 'PATCH',
        body: { letterText: draft },
      }),
    onSuccess: () => {
      toast.success('Cover letter edits saved.');
      void queryClient.invalidateQueries({ queryKey: ['job-letters', id] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const saveState = useMutation({
    mutationFn: (patch: { saved?: boolean; reviewed?: boolean }) =>
      api<{ job: Job }>(`/jobs/${id}/state`, { method: 'PATCH', body: patch }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['job', id] });
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
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

  const letterVersions = letters.data ?? [];
  const activeLetter =
    letterVersions.find((letter) => letter.id === selectedLetterId) ?? letterVersions[0] ?? null;

  useEffect(() => {
    const latest = letters.data?.[0];
    if (!latest) return;
    if (!selectedLetterId || !letters.data?.some((letter) => letter.id === selectedLetterId)) {
      setSelectedLetterId(latest.id);
      setDraft(latest.letterText);
    }
  }, [letters.data, selectedLetterId]);

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
  const approvedProfileIds = new Set(
    (profiles.data ?? []).filter((profile) => profile.status === 'approved').map((profile) => profile.id),
  );
  const topApprovedMatch = sortedMatches.find(
    (match) => typeof match.profile !== 'string' && approvedProfileIds.has(match.profile.id),
  );
  const topProfileId =
    topApprovedMatch && typeof topApprovedMatch.profile !== 'string' ? topApprovedMatch.profile.id : '';

  const letterProfiles = profiles.data ?? [];
  const optionProfiles = letterOptions.data?.profiles ?? [];
  const effectiveLetterProfileId =
    (letterProfileId && optionProfiles.some((item) => item.profileId === letterProfileId)
      ? letterProfileId
      : '') ||
    letterOptions.data?.selectedCvProfileId ||
    topProfileId ||
    '';
  const effectiveReferenceId =
    (letterReferenceId && optionProfiles.some((item) => item.profileId === letterReferenceId)
      ? letterReferenceId
      : '') ||
    letterOptions.data?.selectedReferenceProfileId ||
    '';
  const selectedCvOption = optionProfiles.find((item) => item.profileId === effectiveLetterProfileId);
  const selectedReferenceOption = optionProfiles.find((item) => item.profileId === effectiveReferenceId);
  const effectiveLetterProfile = letterProfiles.find(
    (profile) => profile.id === effectiveLetterProfileId,
  );
  const canGenerateLetter = optionProfiles.length
    ? Boolean(selectedCvOption?.cvReady)
    : Boolean(effectiveLetterProfile?.cvDocumentInfo);

  return (
    <div className="space-y-5">
      <PageHeader
        title={job.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>{job.employer}</span>
            {job.location ? <span>· {job.location}</span> : null}
            <Badge tone="info">{job.sourceLabel || job.source}</Badge>
            {job.simulated ? <Badge tone="warning">Simulated fixture</Badge> : null}
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
            <Button
              variant="ghost"
              onClick={() => saveState.mutate({ saved: !job.saved })}
              loading={saveState.isPending}
            >
              {job.saved ? 'Saved ★' : 'Save job'}
            </Button>
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

          <Card
            title="Cover letter"
            subtitle="Tailored to this vacancy and saved with version history. Generating a letter never creates or submits an application."
          >
            {letterProfiles.length === 0 && optionProfiles.length === 0 ? (
              <EmptyState
                title="No candidate profiles"
                description="Map a CV to a profile before generating a cover letter."
                action={
                  <Link to="/profiles">
                    <Button size="sm" variant="primary">
                      Go to profiles
                    </Button>
                  </Link>
                }
              />
            ) : (
              <div className="space-y-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="text-xs text-slate-300">
                    CV to send
                    <Select
                      className="mt-1"
                      value={effectiveLetterProfileId}
                      onChange={(event) => {
                        setLetterProfileId(event.target.value);
                        saveLetterPreference.mutate({
                          cvProfileId: event.target.value,
                          referenceProfileId: effectiveReferenceId || undefined,
                        });
                      }}
                    >
                      {optionProfiles.length === 0
                        ? letterProfiles.map((profile) => (
                            <option key={profile.id} value={profile.id}>
                              {profile.label}
                              {profile.cvDocumentInfo ? ` — ${profile.cvDocumentInfo.filename}` : ' (no CV mapped)'}
                            </option>
                          ))
                        : optionProfiles.map((option) => (
                            <option
                              key={option.profileId}
                              value={option.profileId}
                              disabled={!option.cvReady}
                            >
                              {option.label}
                              {option.recommended ? ' ★ recommended' : ''}
                              {option.cvReady ? ` — ${option.cvFilename}` : ' (CV text unavailable)'}
                            </option>
                          ))}
                    </Select>
                  </label>
                  <label className="text-xs text-slate-300">
                    Reference cover letter
                    <Select
                      className="mt-1"
                      value={effectiveReferenceId}
                      onChange={(event) => {
                        setLetterReferenceId(event.target.value);
                        saveLetterPreference.mutate({
                          cvProfileId: effectiveLetterProfileId,
                          referenceProfileId: event.target.value || undefined,
                        });
                      }}
                    >
                      {effectiveReferenceId ? null : <option value="">No readable reference letter</option>}
                      {optionProfiles.map((option) => (
                        <option
                          key={option.profileId}
                          value={option.profileId}
                          disabled={!option.referenceReady}
                        >
                          {option.label}
                          {option.referenceRecommended ? ' ★ recommended' : ''}
                          {option.referenceReady ? ` — ${option.referenceFilename}` : ' (letter text unavailable)'}
                        </option>
                      ))}
                    </Select>
                  </label>
                </div>

                <div className="space-y-1 rounded-md border border-slate-800 bg-slate-950/40 px-2.5 py-2 text-[11px] leading-relaxed text-slate-400">
                  <p>
                    <span className="text-slate-300">CV used:</span>{' '}
                    {selectedCvOption
                      ? `${selectedCvOption.label} — ${selectedCvOption.cvFilename || 'no file mapped'}`
                      : effectiveLetterProfile?.cvDocumentInfo?.filename || 'none available'}
                  </p>
                  <p>
                    <span className="text-slate-300">Writing reference:</span>{' '}
                    {selectedReferenceOption
                      ? `${selectedReferenceOption.label} — ${
                          selectedReferenceOption.referenceFilename || 'no file mapped'
                        }`
                      : 'none selected'}
                  </p>
                  {letterOptions.data?.selectionRationale ? (
                    <p>
                      <span className="text-slate-300">Why this selection:</span>{' '}
                      {letterOptions.data.selectionRationale}
                    </p>
                  ) : null}
                  {letterOptions.data?.limitations?.length ? (
                    <ul className="list-disc space-y-0.5 pl-4 text-amber-200/80">
                      {letterOptions.data.limitations.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>

                {letterOptions.data?.jobChangedSinceLetter ? (
                  <WarningNote>
                    This vacancy's description changed after the last saved letter, so the existing draft may
                    need updating. Regenerate to base it on the current text.
                  </WarningNote>
                ) : null}

                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <Button
                    variant="primary"
                    disabled={!effectiveLetterProfileId || !canGenerateLetter}
                    loading={generateLetter.isPending}
                    onClick={() => generateLetter.mutate()}
                  >
                    {activeLetter ? 'Regenerate letter' : 'Generate cover letter'}
                  </Button>
                </div>
                {!canGenerateLetter ? (
                  <p className="text-[11px] text-amber-300">
                    The selected profile has no readable CV text. Map and process a CV on the Profiles page
                    before generating a grounded letter.
                  </p>
                ) : null}

                <label className="block text-xs text-slate-400">
                  Optional instructions for this version
                  <Input
                    className="mt-1"
                    placeholder="e.g. emphasise RAG experience, keep it under 250 words"
                    value={letterInstructions}
                    onChange={(event) => setLetterInstructions(event.target.value)}
                  />
                </label>

                {letters.isLoading ? <SpinnerPanel label="Loading saved letters…" /> : null}

                {activeLetter ? (
                  <div className="space-y-2.5">
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                      <Badge tone={activeLetter.source === 'template' ? 'warning' : 'info'}>
                        {activeLetter.source === 'template' ? 'Template fallback' : titleCase(activeLetter.source)}
                      </Badge>
                      <span>v{activeLetter.version}</span>
                      <span>{activeLetter.wordCount} words</span>
                      <span>{activeLetter.model}</span>
                      {activeLetter.editedByUser ? <Badge tone="neutral">Edited</Badge> : null}
                      {letterVersions.length > 1 ? (
                        <select
                          className="ml-auto rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200"
                          value={activeLetter.id}
                          onChange={(event) => {
                            const letter = letterVersions.find((item) => item.id === event.target.value);
                            setSelectedLetterId(event.target.value);
                            setDraft(letter?.letterText ?? '');
                          }}
                          aria-label="Cover letter version"
                        >
                          {letterVersions.map((letter) => (
                            <option key={letter.id} value={letter.id}>
                              v{letter.version} · {new Date(letter.createdAt).toLocaleDateString()}
                            </option>
                          ))}
                        </select>
                      ) : null}
                    </div>

                    {!activeLetter.grounding.passed ? (
                      <WarningNote>
                        This draft has grounding warnings. Verify every claim against your CV before using it.
                      </WarningNote>
                    ) : null}

                    <textarea
                      className="min-h-[22rem] w-full rounded-lg border border-slate-700 bg-slate-950/70 p-3 font-mono text-xs leading-relaxed text-slate-200 focus:border-indigo-500 focus:outline-none"
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      aria-label="Editable cover letter"
                    />

                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => saveLetter.mutate(activeLetter.id)}
                        loading={saveLetter.isPending}
                        disabled={draft.trim().length < 50 || draft === activeLetter.letterText}
                      >
                        Save edits
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          void navigator.clipboard
                            .writeText(draft)
                            .then(() => toast.success('Letter copied to clipboard.'))
                            .catch(() => toast.error('Could not copy to clipboard.'));
                        }}
                      >
                        Copy
                      </Button>
                      <a
                        href={`${apiBase()}/jobs/${id}/cover-letters/${activeLetter.id}/download?format=pdf`}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        <Button size="sm" variant="secondary">
                          PDF
                        </Button>
                      </a>
                      <a
                        href={`${apiBase()}/jobs/${id}/cover-letters/${activeLetter.id}/download?format=docx`}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        <Button size="sm" variant="secondary">
                          DOCX
                        </Button>
                      </a>
                    </div>

                    {activeLetter.uncertainties?.length ? (
                      <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-amber-200/90">
                        {activeLetter.uncertainties.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">
                    No cover letter exists for this vacancy yet. Generate a draft, then edit it here.
                  </p>
                )}
              </div>
            )}
          </Card>

          <Card title="Eligibility notes" subtitle="Why this vacancy is or is not in the normal results">
            {job.ageEligibility !== 'Eligible' ? (
              <WarningNote>
                Posting-age check: <strong>{job.ageEligibility}</strong>. {job.ageReason} Only postings
                inside the three-calendar-month window appear in the normal job results.
              </WarningNote>
            ) : null}
            {job.languageDecision === 'Excluded' ? (
              <WarningNote>
                This posting mandates German, so it is hidden from the English-first results. Change the
                language classification only if the original listing says otherwise.
              </WarningNote>
            ) : job.languageDecision === 'Needs Review' ? (
              <WarningNote>
                The language requirement is ambiguous. Read the original listing and verify English is
                acceptable before you invest time in an application.
              </WarningNote>
            ) : null}
            <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
              Location, working arrangement, language and posting date are hard filters. A high match score
              never overrides them. This application never submits anything on your behalf.
            </p>
          </Card>
        </div>

        <div className="space-y-4">
          <ChatPanel
            targetPath={`/jobs/${id}`}
            title="Ask about this job"
            suggestions={[
              'Why am I a good match for this job?',
              'Which required skills are missing from my CV?',
              'Which of my CVs is the best fit?',
              'What should I emphasise in my application?',
              'What are the most important responsibilities?',
            ]}
            onUseReply={
              activeLetter
                ? (reply) => {
                    setDraft(reply);
                    toast.info('Suggestion placed in the letter editor. Save edits to keep it.');
                  }
                : undefined
            }
          />

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
                  {job.eligibleAfter ? `Posted after ${formatDate(job.eligibleAfter)}` : 'No posting window'}
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
            <MatchCard key={match.id} match={match} />
          ))
        )}
      </div>
    </div>
  );
}
