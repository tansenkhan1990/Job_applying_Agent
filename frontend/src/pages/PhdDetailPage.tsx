import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, apiBase, errorMessage } from '../api/client';
import type {
  CandidateProfile,
  CoverLetterVersion,
  LetterOptions,
  PhdDetailResponse,
  PhdMatch,
  PhdPosition,
} from '../api/types';
import { deadlineCountdown, formatDate, titleCase } from '../lib/format';
import { ChatPanel } from '../components/ChatPanel';
import { useToast } from '../components/Toast';
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Input,
  LanguageDecisionBadge,
  PageHeader,
  ScoreBadge,
  ScoreBar,
  Select,
  SpinnerPanel,
  WarningNote,
} from '../components/ui';

const RESEARCH_AREA_LABELS: Record<string, string> = {
  ai: 'Artificial Intelligence',
  cybersecurity: 'Cybersecurity',
  software_engineering: 'Software Engineering',
  other: 'Other research',
};

const DEADLINE_LABELS: Record<string, string> = {
  open: 'Open',
  expired: 'Expired',
  unknown: 'Needs verification',
  closed: 'Closed / filled',
};

function MatchPanel({ match }: { match: PhdMatch }) {
  const profile = typeof match.profile === 'string' ? null : match.profile;
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {profile?.label ?? titleCase(match.profileKind)}
          {match.reviewRequired ? <Badge tone="warning">Review required</Badge> : null}
        </span>
      }
      subtitle="Estimated profile match — not a statistically validated acceptance probability"
      action={<ScoreBadge score={match.score} />}
    >
      <div className="space-y-3">
        <ScoreBar score={match.score} />
        <p className="text-sm leading-relaxed text-slate-300">{match.explanation}</p>

        {match.scoreCategories.map((category) => (
          <div key={category.key} className="rounded-md bg-slate-950/40 px-2.5 py-1.5">
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="text-slate-300">
                {category.label} <span className="text-slate-500">· weight {category.weight}</span>
              </span>
              <span className="font-medium text-slate-200">{Math.round(category.score * 100)}%</span>
            </div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{category.detail}</p>
          </div>
        ))}

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Matched research topics
            </p>
            <div className="flex flex-wrap gap-1">
              {match.matchedTopics.length > 0 ? (
                match.matchedTopics.map((topic) => (
                  <Badge key={topic} tone="success">
                    {topic}
                  </Badge>
                ))
              ) : (
                <span className="text-xs text-slate-500">None detected</span>
              )}
            </div>
          </div>
          <div>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Topics not evidenced
            </p>
            <div className="flex flex-wrap gap-1">
              {match.missingTopics.length > 0 ? (
                match.missingTopics.map((topic) => (
                  <Badge key={topic} tone="neutral">
                    {topic}
                  </Badge>
                ))
              ) : (
                <span className="text-xs text-slate-500">None</span>
              )}
            </div>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">Matched skills</p>
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
              Missing required skills
            </p>
            <div className="flex flex-wrap gap-1">
              {match.missingSkills.length > 0 ? (
                match.missingSkills.map((skill) => (
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

        {match.matchedPublications.length > 0 ? (
          <div>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Relevant publications
            </p>
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-slate-300">
              {match.matchedPublications.map((publication) => (
                <li key={publication}>{publication}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {match.mandatoryMissing.length > 0 ? (
          <div>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-rose-300">
              Mandatory qualification gaps
            </p>
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-rose-200/90">
              {match.mandatoryMissing.map((item) => (
                <li key={item}>{item}</li>
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
      </div>
    </Card>
  );
}

export function PhdDetailPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [letterProfileId, setLetterProfileId] = useState('');
  const [letterReferenceId, setLetterReferenceId] = useState('');
  const [instructions, setInstructions] = useState('');
  const [selectedLetterId, setSelectedLetterId] = useState('');
  const [draft, setDraft] = useState('');

  const detail = useQuery<PhdDetailResponse>({
    queryKey: ['phd-position', id],
    queryFn: () => api<PhdDetailResponse>(`/phd/positions/${id}`),
    enabled: Boolean(id),
  });

  const profiles = useQuery<CandidateProfile[]>({
    queryKey: ['profiles'],
    queryFn: () => api<CandidateProfile[]>('/profiles'),
  });

  const letters = useQuery<CoverLetterVersion[]>({
    queryKey: ['phd-letters', id],
    queryFn: () => api<CoverLetterVersion[]>(`/phd/positions/${id}/cover-letters`),
    enabled: Boolean(id),
  });

  const letterOptions = useQuery<LetterOptions>({
    queryKey: ['phd-letter-options', id],
    queryFn: () => api<LetterOptions>(`/phd/positions/${id}/cover-letter/options`),
    enabled: Boolean(id),
  });

  const saveLetterPreference = useMutation({
    mutationFn: (patch: { cvProfileId: string; referenceProfileId?: string }) =>
      api<LetterOptions>(`/phd/positions/${id}/letter-preferences`, {
        method: 'PATCH',
        body: patch,
      }),
    onSuccess: (result) => {
      queryClient.setQueryData(['phd-letter-options', id], result);
      toast.success('CV and reference letter preferences saved for this position.');
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const evaluate = useMutation({
    mutationFn: () =>
      api<{ matches: PhdMatch[] }>(`/phd/positions/${id}/match`, { method: 'POST', body: {} }),
    onSuccess: (result) => {
      const best = [...result.matches].sort((a, b) => b.score - a.score)[0];
      toast.success(best ? `Estimated profile match: ${best.score}/100.` : 'Matching complete.');
      void queryClient.invalidateQueries({ queryKey: ['phd-position', id] });
      void queryClient.invalidateQueries({ queryKey: ['phd-positions'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const saveState = useMutation({
    mutationFn: (patch: { saved?: boolean; reviewed?: boolean }) =>
      api<{ position: PhdPosition }>(`/phd/positions/${id}/state`, { method: 'PATCH', body: patch }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['phd-position', id] });
      void queryClient.invalidateQueries({ queryKey: ['phd-positions'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const verifyDeadline = useMutation({
    mutationFn: () =>
      api<{
        verification: { status: 'available' | 'unavailable' | 'unknown'; evidence: string };
        position: PhdPosition;
      }>(`/phd/positions/${id}/verify`, { method: 'POST', body: {} }),
    onSuccess: (result) => {
      const verification = result.verification;
      const message = `Deadline check (${verification.status}): ${verification.evidence}`;
      if (verification.status === 'available') toast.success(message);
      else if (verification.status === 'unavailable') toast.error(message);
      else toast.info(message);
      void queryClient.invalidateQueries({ queryKey: ['phd-position', id] });
      void queryClient.invalidateQueries({ queryKey: ['phd-positions'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const generateLetter = useMutation({
    mutationFn: () =>
      api<{ letter: CoverLetterVersion }>(`/phd/positions/${id}/cover-letter`, {
        method: 'POST',
        body: {
          profileId: letterProfileId || letterOptions.data?.selectedCvProfileId || undefined,
          referenceProfileId:
            letterReferenceId || letterOptions.data?.selectedReferenceProfileId || undefined,
          instructions: instructions || undefined,
        },
      }),
    onSuccess: (result) => {
      setSelectedLetterId(result.letter.id);
      setDraft(result.letter.letterText);
      setInstructions('');
      toast.success('Academic cover letter draft generated.');
      void queryClient.invalidateQueries({ queryKey: ['phd-letters', id] });
      void queryClient.invalidateQueries({ queryKey: ['phd-letter-options', id] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const saveLetter = useMutation({
    mutationFn: (letterId: string) =>
      api<{ letter: CoverLetterVersion }>(`/phd/positions/${id}/cover-letters/${letterId}`, {
        method: 'PATCH',
        body: { letterText: draft },
      }),
    onSuccess: () => {
      toast.success('Cover letter edits saved.');
      void queryClient.invalidateQueries({ queryKey: ['phd-letters', id] });
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

  if (detail.isLoading) return <SpinnerPanel label="Loading PhD position…" />;
  if (detail.error) {
    return (
      <div className="space-y-4">
        <PageHeader title="PhD position" />
        <ErrorNote message={errorMessage(detail.error)} />
        <Link to="/phd" className="text-sm text-indigo-300">
          ← Back to PhD opportunities
        </Link>
      </div>
    );
  }
  if (!detail.data) return null;

  const { position, matches } = detail.data;
  const sortedMatches = [...matches].sort((a, b) => b.score - a.score);
  const bestProfileId =
    sortedMatches[0] && typeof sortedMatches[0].profile !== 'string'
      ? sortedMatches[0].profile.id
      : '';
  const letterProfiles = profiles.data ?? [];
  const optionProfiles = letterOptions.data?.profiles ?? [];
  const effectiveLetterProfileId =
    (letterProfileId && optionProfiles.some((item) => item.profileId === letterProfileId)
      ? letterProfileId
      : '') ||
    letterOptions.data?.selectedCvProfileId ||
    bestProfileId ||
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
        title={position.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>{position.institution}</span>
            {position.location ? <span>· {position.location}</span> : null}
            {position.simulated ? <Badge tone="warning">Simulated listing</Badge> : null}
            <Badge tone="info">{position.sourceLabel || position.source}</Badge>
            <Badge tone="neutral">
              {RESEARCH_AREA_LABELS[position.researchArea] ?? 'Other research'}
            </Badge>
            <Badge
              tone={
                position.deadlineStatus === 'open'
                  ? 'success'
                  : position.deadlineStatus === 'unknown'
                    ? 'warning'
                    : 'danger'
              }
            >
              Deadline: {DEADLINE_LABELS[position.deadlineStatus] ?? position.deadlineStatus}
            </Badge>
            <Badge tone={position.status === 'active' ? 'success' : 'danger'}>{position.status}</Badge>
            <LanguageDecisionBadge
              decision={position.languageDecision}
              confidence={position.languageConfidence}
            />
          </span>
        }
        actions={
          <>
            <Link to="/phd">
              <Button variant="ghost">← PhD</Button>
            </Link>
            <Button
              variant="ghost"
              onClick={() => saveState.mutate({ saved: !position.saved })}
              loading={saveState.isPending}
            >
              {position.saved ? 'Saved ★' : 'Save position'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => verifyDeadline.mutate()}
              loading={verifyDeadline.isPending}
              disabled={position.simulated}
              title={
                position.simulated
                  ? 'Simulated fixtures have no live source to verify'
                  : 'Re-read this position from the configured source'
              }
            >
              Verify deadline
            </Button>
            <Button variant="primary" onClick={() => evaluate.mutate()} loading={evaluate.isPending}>
              {matches.length ? 'Re-evaluate profiles' : 'Evaluate profiles'}
            </Button>
          </>
        }
      />

      {position.simulated ? (
        <WarningNote>
          This is a simulated local fixture from the mock PhD source, not a real advertisement. It exists to
          test the workflow. Use a permitted configured feed for real positions.
        </WarningNote>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card
            title="Position details"
            subtitle={`${position.department || 'Department not stated'} · ${
              position.researchGroup || 'Research group not stated'
            }`}
            action={
              <a href={position.url} target="_blank" rel="noreferrer noopener">
                <Button size="sm" variant="ghost">
                  Original advert ↗
                </Button>
              </a>
            }
          >
            <div className="space-y-3">
              <div className="grid gap-2 text-xs sm:grid-cols-2">
                <p className="text-slate-400">
                  Supervisor: <span className="text-slate-200">{position.supervisor || 'not stated'}</span>
                </p>
                <p className="text-slate-400">
                  Funding: <span className="text-slate-200">{position.funding || 'not stated'}</span>
                </p>
                <p className="text-slate-400">
                  Salary: <span className="text-slate-200">{position.salary || 'not stated'}</span>
                </p>
                <p className="text-slate-400">
                  Start date:{' '}
                  <span className="text-slate-200">{position.expectedStartDate || 'not stated'}</span>
                </p>
                <p className="text-slate-400">
                  Deadline:{' '}
                  <span className="text-slate-200">
                    {position.applicationDeadline ? formatDate(position.applicationDeadline) : 'not stated'}
                    {position.deadlineTimezone ? ` (${position.deadlineTimezone})` : ''}
                    {(() => {
                      const countdown = deadlineCountdown(
                        position.applicationDeadline,
                        position.deadlineStatus,
                      );
                      return countdown ? ` · ${countdown}` : '';
                    })()}
                  </span>
                </p>
                <p className="text-slate-400">
                  Deadline status:{' '}
                  <span className="text-slate-200">
                    {DEADLINE_LABELS[position.deadlineStatus] ?? position.deadlineStatus}
                  </span>
                </p>
                <p className="text-slate-400">
                  Posted:{' '}
                  <span className="text-slate-200">
                    {position.postedAt ? formatDate(position.postedAt) : 'date unknown'}
                  </span>
                </p>
                <p className="text-slate-400">
                  Last verified:{' '}
                  <span className="text-slate-200">
                    {position.lastVerifiedAt ? formatDate(position.lastVerifiedAt) : 'not yet checked'}
                  </span>
                </p>
              </div>

              <p className="rounded-md bg-slate-950/40 px-3 py-2 text-xs leading-relaxed text-slate-400">
                {position.deadlineNote ||
                  'No deadline verification note is available. Check the official source before applying.'}
              </p>

              {position.researchTopic ? (
                <p className="rounded-md bg-slate-950/40 px-3 py-2 text-xs leading-relaxed text-slate-300">
                  <span className="text-slate-500">Research topic: </span>
                  {position.researchTopic}
                </p>
              ) : null}

              <div className="max-h-[34rem] overflow-y-auto whitespace-pre-line text-sm leading-relaxed text-slate-300">
                {position.description || 'The source did not provide a description.'}
              </div>
            </div>
          </Card>

          <Card
            title="Academic cover letter"
            subtitle="A tailored doctoral-application letter saved with version history. Generating a letter does not submit an application."
          >
            {letterProfiles.length === 0 && optionProfiles.length === 0 ? (
              <p className="text-xs text-slate-400">Map a CV to a profile before generating a letter.</p>
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
                    This position's description changed after the last saved letter, so the existing draft may
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
                    {activeLetter ? 'Regenerate letter' : 'Generate PhD cover letter'}
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
                    placeholder="e.g. emphasise graph-learning publications, academic tone"
                    value={instructions}
                    onChange={(event) => setInstructions(event.target.value)}
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
                          aria-label="PhD cover letter version"
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
                        This draft has grounding warnings. Verify every claim and publication against your CV.
                      </WarningNote>
                    ) : null}

                    <textarea
                      className="min-h-[24rem] w-full rounded-lg border border-slate-700 bg-slate-950/70 p-3 font-mono text-xs leading-relaxed text-slate-200 focus:border-indigo-500 focus:outline-none"
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      aria-label="Editable PhD cover letter"
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
                            .then(() => toast.success('Letter copied.'))
                            .catch(() => toast.error('Could not copy to clipboard.'));
                        }}
                      >
                        Copy
                      </Button>
                      <a
                        href={`${apiBase()}/phd/positions/${id}/cover-letters/${activeLetter.id}/download?format=pdf`}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        <Button size="sm" variant="secondary">
                          PDF
                        </Button>
                      </a>
                      <a
                        href={`${apiBase()}/phd/positions/${id}/cover-letters/${activeLetter.id}/download?format=docx`}
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
                    No academic cover letter exists yet. Generate a draft, then edit it here.
                  </p>
                )}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <ChatPanel
            targetPath={`/phd/positions/${id}`}
            title="Ask about this PhD"
            suggestions={[
              'How well does my background match this research topic?',
              'Which mandatory qualifications are missing from my CV?',
              'Which of my CVs is the best fit for this position?',
              'Which existing cover letter should be the writing reference?',
              'Does this position require German, or is English sufficient?',
              'Suggest interview questions based on this research project.',
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
                <dt className="text-slate-400">Estimated profile match</dt>
                <dd>
                  {sortedMatches[0] ? <ScoreBadge score={sortedMatches[0].score} /> : <Badge>Not scored</Badge>}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-400">Work arrangement</dt>
                <dd className="text-slate-200">{titleCase(position.workArrangement)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-400">Remote from Germany</dt>
                <dd className="text-slate-200">
                  {position.remoteEligibleFromGermany === true
                    ? 'Explicitly stated'
                    : position.remoteEligibleFromGermany === false
                      ? 'Explicitly not available'
                      : 'Not stated'}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-400">Required languages</dt>
                <dd className="text-right text-slate-200">
                  {position.requiredLanguages.length > 0 ? position.requiredLanguages.join(', ') : 'Not stated'}
                </dd>
              </div>
            </dl>
            <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
              Remote eligibility is only shown when the advertisement explicitly states it. Flexible working is
              not treated as remote eligibility.
            </p>
          </Card>

          <Card title="Language assessment">
            <div className="space-y-2 text-xs">
              <div className="flex flex-wrap gap-1.5">
                <LanguageDecisionBadge
                  decision={position.languageDecision}
                  confidence={position.languageConfidence}
                />
                {position.requiredLanguages.map((language) => (
                  <Badge key={language} tone="neutral">
                    {language}
                  </Badge>
                ))}
              </div>
              <p className="leading-relaxed text-slate-300">{position.languageReason}</p>
              {position.languageEvidence ? (
                <blockquote className="border-l-2 border-slate-700 pl-2 italic leading-relaxed text-slate-400">
                  “{position.languageEvidence}”
                </blockquote>
              ) : null}
            </div>
          </Card>

          <Card title="Required qualifications">
            {position.requiredQualifications.length === 0 ? (
              <p className="text-xs text-slate-400">
                The advertisement does not list qualifications in a structured section. Read the original advert.
              </p>
            ) : (
              <ul className="list-disc space-y-1 pl-4 text-xs text-slate-300">
                {position.requiredQualifications.map((qualification) => (
                  <li key={qualification}>{qualification}</li>
                ))}
              </ul>
            )}
            {position.employmentRequirements.length > 0 ? (
              <div className="mt-3">
                <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                  Employment / enrollment
                </p>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-slate-300">
                  {position.employmentRequirements.map((requirement) => (
                    <li key={requirement}>{requirement}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>

          <Card title="Required skills">
            <div className="flex flex-wrap gap-1">
              {position.requiredSkills.length > 0 ? (
                position.requiredSkills.map((skill) => (
                  <Badge key={skill} tone="neutral">
                    {skill}
                  </Badge>
                ))
              ) : (
                <span className="text-xs text-slate-500">No structured skills stated.</span>
              )}
            </div>
            {position.preferredSkills.length > 0 ? (
              <>
                <p className="mt-3 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                  Preferred skills
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {position.preferredSkills.map((skill) => (
                    <Badge key={skill} tone="info">
                      {skill}
                    </Badge>
                  ))}
                </div>
              </>
            ) : null}
          </Card>
        </div>
      </div>

      <div className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Estimated profile matches
        </h2>
        {sortedMatches.length === 0 ? (
          <Card>
            <p className="text-xs text-slate-400">
              No profile has been evaluated yet. Evaluate your CV profiles to see topic, skill, publication, and
              qualification evidence.
            </p>
            <Button
              className="mt-3"
              variant="primary"
              onClick={() => evaluate.mutate()}
              loading={evaluate.isPending}
            >
              Evaluate profiles
            </Button>
          </Card>
        ) : (
          sortedMatches.map((match) => <MatchPanel key={match.id} match={match} />)
        )}
      </div>
    </div>
  );
}
