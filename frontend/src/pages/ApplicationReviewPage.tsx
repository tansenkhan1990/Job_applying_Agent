import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, apiBase, errorDetails, errorMessage } from '../api/client';
import type { Application, SettingsResponse } from '../api/types';
import { formatDateTime, statusTone, titleCase } from '../lib/format';
import { MatchCard } from '../components/MatchCard';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toast';
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  PageHeader,
  SpinnerPanel,
  Textarea,
  WarningNote,
} from '../components/ui';

export function ApplicationReviewPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [letterText, setLetterText] = useState('');
  const [subjectLine, setSubjectLine] = useState('');
  const [letterDirty, setLetterDirty] = useState(false);
  const [revisionInstruction, setRevisionInstruction] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [approvalConfirmed, setApprovalConfirmed] = useState(false);
  const [approvalNote, setApprovalNote] = useState('');
  const [manualNote, setManualNote] = useState('');
  const [showCv, setShowCv] = useState(false);
  const [actionError, setActionError] = useState<{ message: string; details: string[] } | null>(null);

  const application = useQuery<Application>({
    queryKey: ['application', id],
    queryFn: () => api<Application>(`/applications/${id}`),
    enabled: Boolean(id),
  });

  const settings = useQuery<SettingsResponse>({
    queryKey: ['settings'],
    queryFn: () => api<SettingsResponse>('/settings'),
  });

  const app = application.data;
  const letter = app && app.currentLetter && typeof app.currentLetter !== 'string' ? app.currentLetter : null;
  const job = app && typeof app.job !== 'string' ? app.job : null;
  const profile = app && typeof app.profile !== 'string' ? app.profile : null;
  const match = app && app.match && typeof app.match !== 'string' ? app.match : null;
  const cvDocument =
    app && app.selectedCvDocument && typeof app.selectedCvDocument !== 'string'
      ? app.selectedCvDocument
      : null;

  const cvText = useQuery<{ text: string; wordCount: number }>({
    queryKey: ['document-text', cvDocument?.id],
    queryFn: () => api<{ text: string; wordCount: number }>(`/documents/${cvDocument?.id}/text`),
    enabled: showCv && Boolean(cvDocument?.id),
  });

  useEffect(() => {
    if (letter) {
      setLetterText(letter.letterText);
      setSubjectLine(letter.subjectLine);
      setLetterDirty(false);
    }
  }, [letter?.id]);

  useEffect(() => {
    if (app) {
      setAnswers(
        Object.fromEntries(app.screeningQuestions.map((question) => [question.questionId, question.answer])),
      );
    }
    // Re-sync when the server-side version changes (answers/approval invalidation).
  }, [app?.version, app?.screeningQuestions.length]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['application', id] });
    void queryClient.invalidateQueries({ queryKey: ['applications'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
  };

  const handleError = (error: unknown) => {
    const message = errorMessage(error);
    setActionError({ message, details: errorDetails(error) });
    toast.error(message);
  };

  const saveLetter = useMutation({
    mutationFn: () =>
      api<{ application: Application }>(`/applications/${id}/cover-letter`, {
        method: 'PATCH',
        body: { letterText, subjectLine },
      }),
    onSuccess: () => {
      setLetterDirty(false);
      setActionError(null);
      toast.success('Cover letter saved as a new version. Approval must be repeated.');
      invalidate();
    },
    onError: handleError,
  });

  const regenerate = useMutation({
    mutationFn: () =>
      api<{ application: Application }>(`/applications/${id}/cover-letter/regenerate`, {
        method: 'POST',
        body: revisionInstruction.trim() ? { instructions: revisionInstruction.trim() } : {},
      }),
    onSuccess: () => {
      setRevisionInstruction('');
      setActionError(null);
      toast.success('Cover letter regenerated. Review every claim before approving.');
      invalidate();
    },
    onError: handleError,
  });

  const answerQuestion = useMutation({
    mutationFn: (questionId: string) =>
      api<Application>(`/applications/${id}/questions/answer`, {
        method: 'POST',
        body: { questionId, answer: answers[questionId] ?? '' },
      }),
    onSuccess: () => {
      setActionError(null);
      toast.success('Answer saved. Review the new version before approving.');
      invalidate();
    },
    onError: handleError,
  });

  const approve = useMutation({
    mutationFn: () =>
      api<Application>(`/applications/${id}/approve`, {
        method: 'POST',
        body: {
          confirmed: true,
          note: approvalNote,
          confirmedAnswers: (app?.screeningQuestions ?? []).map((question) => ({
            questionId: question.questionId,
            answer: answers[question.questionId] ?? question.answer,
          })),
        },
      }),
    onSuccess: () => {
      setApprovalConfirmed(false);
      setApprovalNote('');
      setActionError(null);
      toast.success('Application approved. Submission is now available.');
      invalidate();
    },
    onError: handleError,
  });

  const submit = useMutation({
    mutationFn: () => api<Application>(`/applications/${id}/submit`, { method: 'POST', body: { confirmed: true } }),
    onSuccess: (result) => {
      setActionError(null);
      if (result.status === 'SUBMITTED') {
        toast.success(
          result.submission?.simulated
            ? 'Simulated submission recorded for the fictional mock vacancy.'
            : 'Submission confirmed.',
        );
      } else if (result.status === 'NEEDS_MANUAL_ACTION') {
        toast.info('This channel requires you to complete the employer form manually.');
      } else {
        toast.error(result.submission?.message || `Submission ended in ${result.status}.`);
      }
      invalidate();
    },
    onError: handleError,
  });

  const confirmManual = useMutation({
    mutationFn: () =>
      api<Application>(`/applications/${id}/confirm-manual`, {
        method: 'POST',
        body: { confirmed: true, note: manualNote || undefined },
      }),
    onSuccess: () => {
      setActionError(null);
      toast.success('Manual submission recorded as confirmed by you.');
      invalidate();
    },
    onError: handleError,
  });

  const startAssistant = useMutation({
    mutationFn: () =>
      api<Application>(`/applications/${id}/assistant/start`, {
        method: 'POST',
        body: { confirmedLanguage: true },
      }),
    onSuccess: () => {
      toast.success('Assistant session queued. It will open in the visible browser runner.');
      invalidate();
    },
    onError: handleError,
  });

  const cancel = useMutation({
    mutationFn: () =>
      api<Application>(`/applications/${id}/cancel`, {
        method: 'POST',
        body: { reason: 'Withdrawn from the local dashboard' },
      }),
    onSuccess: () => {
      toast.info('Application marked as withdrawn locally.');
      invalidate();
    },
    onError: handleError,
  });

  const unanswered = useMemo(
    () => (app?.screeningQuestions ?? []).filter((question) => question.required && question.status !== 'answered'),
    [app],
  );

  const approvalValid =
    app?.status === 'APPROVED' &&
    Boolean(app.approval?.approvedAt) &&
    app.approval?.applicationVersion === app.version;

  if (application.isLoading) return <SpinnerPanel label="Loading application…" />;
  if (application.error) {
    return (
      <div className="space-y-4">
        <PageHeader title="Application" />
        <ErrorNote message={errorMessage(application.error)} />
        <Link to="/applications" className="text-sm text-indigo-300">
          ← Back to applications
        </Link>
      </div>
    );
  }
  if (!app) return null;

  const prepareOnly = settings.data?.settings.application.mode === 'prepare_only';
  const locked = ['SUBMITTING', 'SUBMITTED', 'WITHDRAWN'].includes(app.status);

  return (
    <div className="space-y-5">
      <PageHeader
        title={app.jobTitle}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>{app.employer}</span>
            <Badge tone={statusTone(app.status)}>{titleCase(app.status)}</Badge>
            <Badge tone="neutral">version {app.version}</Badge>
            {app.submission?.simulated ? <Badge tone="warning">simulated submission</Badge> : null}
            {approvalValid ? <Badge tone="success">approval valid</Badge> : <Badge tone="neutral">not approved</Badge>}
          </span>
        }
        actions={
          <>
            <Link to="/applications">
              <Button variant="ghost">← Tracker</Button>
            </Link>
            {job ? (
              <a href={job.url} target="_blank" rel="noreferrer noopener">
                <Button variant="secondary">Original listing ↗</Button>
              </a>
            ) : null}
          </>
        }
      />

      {actionError ? <ErrorNote message={actionError.message} details={actionError.details} /> : null}

      <Card
        title="Human-supervised application assistant"
        subtitle="Opens the employer form in a visible browser, fills verified fields, and pauses. You submit."
        action={
          <Link to={`/assistant/${app.id}`}>
            <Button size="sm" variant="secondary">
              Live monitor
            </Button>
          </Link>
        }
      >
        <div className="space-y-3 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge
              tone={
                app.ageEligibility === 'Eligible'
                  ? 'success'
                  : app.ageEligibility === 'Too Recent'
                    ? 'warning'
                    : app.ageEligibility === 'Expired'
                      ? 'danger'
                      : 'neutral'
              }
            >
              {app.ageEligibility ?? 'Unknown'} posting age
            </Badge>
            <Badge
              tone={
                app.languageSnapshot?.languageDecision === 'Eligible'
                  ? 'success'
                  : app.languageSnapshot?.languageDecision === 'Excluded'
                    ? 'danger'
                    : 'warning'
              }
            >
              {app.languageSnapshot?.languageDecision ?? 'Needs Review'} language
            </Badge>
            {app.postedAt ? (
              <Badge tone="neutral">Posted {formatDateTime(app.postedAt)}</Badge>
            ) : null}
          </div>
          <p className="leading-relaxed text-slate-400">
            {app.ageReason || 'Posting age has not been checked.'}
          </p>
          <p className="leading-relaxed text-slate-500">
            The queue re-checks the original posting date, language, availability and duplicates immediately
            before starting. The assistant never clicks Submit, and the browser stays open for your edits.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              onClick={() => startAssistant.mutate()}
              loading={startAssistant.isPending}
              disabled={
                locked ||
                app.ageEligibility !== 'Eligible' ||
                app.languageSnapshot?.languageDecision === 'Excluded'
              }
            >
              Start application assistant
            </Button>
            {app.languageSnapshot?.languageDecision === 'Needs Review' ? (
              <span className="text-[11px] text-amber-300">
                Starting confirms you checked the original listing and English is acceptable.
              </span>
            ) : null}
          </div>
        </div>
      </Card>

      {prepareOnly ? (
        <WarningNote>
          Application mode is <strong>prepare only</strong>. Approval can be recorded, but the backend will
          reject submission until you deliberately change the mode in Settings.
        </WarningNote>
      ) : null}

      <Modal
        open={showCv}
        title={cvDocument ? `Selected CV — ${cvDocument.filename}` : 'Selected CV'}
        onClose={() => setShowCv(false)}
        wide
        footer={
          <Button variant="secondary" onClick={() => setShowCv(false)}>
            Close
          </Button>
        }
      >
        {cvText.isLoading ? <SpinnerPanel label="Loading CV text…" /> : null}
        {cvText.error ? <ErrorNote message={errorMessage(cvText.error)} /> : null}
        {cvText.data ? (
          <div className="space-y-2">
            <p className="text-[11px] text-slate-500">
              Extracted text used for matching and letter grounding · {cvText.data.wordCount} words
            </p>
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950/70 p-3 text-xs leading-relaxed text-slate-300">
              {cvText.data.text || 'No extractable text.'}
            </pre>
          </div>
        ) : null}
      </Modal>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card
            title="Cover letter"
            subtitle={
              letter
                ? `${titleCase(letter.source)} · version ${letter.version} · ${letter.wordCount} words · ${letter.model || 'no model'}`
                : 'No letter prepared'
            }
            action={
              letter ? (
                <Badge tone={letter.grounding?.passed ? 'success' : 'warning'}>
                  {letter.grounding?.passed ? 'Grounding checks passed' : 'Grounding needs review'}
                </Badge>
              ) : null
            }
          >
            {letter ? (
              <div className="space-y-3">
                {letter.grounding && letter.grounding.notes?.length > 0 ? (
                  <WarningNote>
                    <ul className="list-disc space-y-0.5 pl-4">
                      {letter.grounding.notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  </WarningNote>
                ) : null}

                <Field label="Subject line">
                  <Input
                    value={subjectLine}
                    onChange={(event) => {
                      setSubjectLine(event.target.value);
                      setLetterDirty(true);
                    }}
                    disabled={locked}
                  />
                </Field>
                <Field
                  label="Letter body"
                  hint="Every claim must be traceable to your CV or original letter. Editing creates a new version and invalidates approval."
                >
                  <Textarea
                    value={letterText}
                    rows={18}
                    onChange={(event) => {
                      setLetterText(event.target.value);
                      setLetterDirty(true);
                    }}
                    disabled={locked}
                    className="font-[450]"
                  />
                </Field>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="primary"
                    disabled={!letterDirty || letterText.trim().length < 50 || locked}
                    loading={saveLetter.isPending}
                    onClick={() => saveLetter.mutate()}
                  >
                    Save new version
                  </Button>
                  <Input
                    value={revisionInstruction}
                    onChange={(event) => setRevisionInstruction(event.target.value)}
                    placeholder="Optional revision instruction…"
                    className="max-w-xs"
                    disabled={locked}
                  />
                  <Button
                    variant="secondary"
                    onClick={() => regenerate.mutate()}
                    loading={regenerate.isPending}
                    disabled={locked}
                  >
                    Regenerate
                  </Button>
                  <a href={`${apiBase()}/applications/${app.id}/cover-letter/download?format=pdf`}>
                    <Button size="sm" variant="ghost">
                      PDF ↓
                    </Button>
                  </a>
                  <a href={`${apiBase()}/applications/${app.id}/cover-letter/download?format=docx`}>
                    <Button size="sm" variant="ghost">
                      DOCX ↓
                    </Button>
                  </a>
                  {letterDirty ? <Badge tone="warning">unsaved edits</Badge> : null}
                </div>
                {letter.claimsUsed?.length ? (
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                      Claims the model says it used
                    </p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-slate-400">
                      {letter.claimsUsed.map((claim) => (
                        <li key={claim}>{claim}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-slate-400">No cover letter is attached to this application.</p>
            )}
          </Card>

          <Card
            title="Screening questions"
            subtitle="Only questions explicitly present in the job description are extracted. Legal declarations are never answered for you."
          >
            {app.screeningQuestions.length === 0 ? (
              <p className="text-sm text-slate-400">
                No screening questions were found in the vacancy text. The employer form may still ask for
                declarations you must answer yourself.
              </p>
            ) : (
              <div className="space-y-4">
                {app.screeningQuestions.map((question) => (
                  <div key={question.questionId} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="max-w-2xl text-sm text-slate-200">{question.question}</p>
                      <div className="flex flex-wrap gap-1">
                        {question.required ? <Badge tone="warning">required</Badge> : <Badge>optional</Badge>}
                        <Badge tone={question.status === 'answered' ? 'success' : question.status === 'requires_user' ? 'danger' : 'neutral'}>
                          {titleCase(question.status)}
                        </Badge>
                      </div>
                    </div>
                    {question.status === 'requires_user' ? (
                      <p className="mt-1.5 text-[11px] text-amber-300">
                        This looks like a legal or sensitive declaration. The agent will not guess it.
                      </p>
                    ) : null}
                    <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                      <Textarea
                        rows={2}
                        value={answers[question.questionId] ?? ''}
                        onChange={(event) =>
                          setAnswers({ ...answers, [question.questionId]: event.target.value })
                        }
                        placeholder="Your verified answer…"
                        disabled={locked}
                      />
                      <Button
                        size="sm"
                        variant="secondary"
                        className="sm:self-start"
                        loading={answerQuestion.isPending && answerQuestion.variables === question.questionId}
                        onClick={() => answerQuestion.mutate(question.questionId)}
                        disabled={locked}
                      >
                        Save answer
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Job description">
            <div className="max-h-[30rem] overflow-y-auto whitespace-pre-line text-sm leading-relaxed text-slate-300">
              {job?.description || 'No description stored.'}
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Approval & submission">
            <div className="space-y-3 text-sm">
              <div className="space-y-1.5 rounded-lg bg-slate-950/40 p-3 text-xs">
                <p className="flex items-center justify-between gap-2">
                  <span className="text-slate-400">Profile approved</span>
                  <Badge tone={profile?.status === 'approved' ? 'success' : 'warning'}>
                    {profile?.status ?? 'unknown'}
                  </Badge>
                </p>
                <p className="flex items-center justify-between gap-2">
                  <span className="text-slate-400">CV mapped</span>
                  <Badge tone={cvDocument ? 'success' : 'danger'}>
                    {cvDocument?.filename ?? 'missing'}
                  </Badge>
                </p>
                {cvDocument ? (
                  <Button size="sm" variant="ghost" className="w-full" onClick={() => setShowCv(true)}>
                    View selected CV text
                  </Button>
                ) : null}
                <p className="flex items-center justify-between gap-2">
                  <span className="text-slate-400">Required answers</span>
                  <Badge tone={unanswered.length === 0 ? 'success' : 'warning'}>
                    {app.screeningQuestions.filter((q) => q.required && q.status === 'answered').length}/
                    {app.screeningQuestions.filter((q) => q.required).length}
                  </Badge>
                </p>
                <p className="flex items-center justify-between gap-2">
                  <span className="text-slate-400">Letter hash</span>
                  <span className="font-mono text-[10px] text-slate-500">
                    {app.coverLetterHash.slice(0, 12)}
                  </span>
                </p>
              </div>

              {app.approval?.approvedAt ? (
                <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
                  Approved for version {app.approval.applicationVersion} on{' '}
                  {formatDateTime(app.approval.approvedAt)}.
                  {app.approval.applicationVersion !== app.version ? (
                    <p className="mt-1 text-amber-200">This approval is stale; approve the current version.</p>
                  ) : null}
                </div>
              ) : null}

              {app.status === 'READY_FOR_REVIEW' ? (
                <div className="space-y-2">
                  <label className="flex items-start gap-2 text-xs text-slate-300">
                    <input
                      type="checkbox"
                      checked={approvalConfirmed}
                      onChange={(event) => setApprovalConfirmed(event.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-slate-900"
                    />
                    <span>
                      I reviewed the job, the CV, the complete cover letter and every screening answer. I
                      confirm these facts are accurate.
                    </span>
                  </label>
                  <Input
                    value={approvalNote}
                    onChange={(event) => setApprovalNote(event.target.value)}
                    placeholder="Optional approval note"
                  />
                  <Button
                    variant="success"
                    className="w-full"
                    disabled={
                      !approvalConfirmed || unanswered.length > 0 || !letter || letterDirty || locked
                    }
                    loading={approve.isPending}
                    onClick={() => approve.mutate()}
                  >
                    Approve application
                  </Button>
                  {letterDirty ? (
                    <p className="text-[11px] text-amber-300">Save your letter edits before approving.</p>
                  ) : null}
                  {unanswered.length > 0 ? (
                    <p className="text-[11px] text-amber-300">
                      Answer all mandatory screening questions before approving.
                    </p>
                  ) : null}
                </div>
              ) : null}

              {approvalValid ? (
                <div className="space-y-2 border-t border-slate-800 pt-3">
                  <Button
                    variant="primary"
                    className="w-full"
                    loading={submit.isPending}
                    onClick={() => submit.mutate()}
                    disabled={prepareOnly}
                  >
                    {submit.isPending ? 'Submitting…' : 'Submit application'}
                  </Button>
                  <p className="text-[11px] leading-relaxed text-slate-500">
                    The backend re-verifies the vacancy, approval version, CV hash, letter hash, answers and
                    duplicate history before doing anything. Real employer sites require manual completion.
                  </p>
                </div>
              ) : null}

              {app.status === 'NEEDS_MANUAL_ACTION' ? (
                <div className="space-y-2 border-t border-slate-800 pt-3">
                  <p className="text-xs font-medium text-amber-200">Manual action required</p>
                  <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950/60 p-2.5 text-[11px] leading-relaxed text-slate-300">
                    {app.submission?.manualInstructions || app.submission?.message || 'Open the employer form.'}
                  </pre>
                  <a href={app.applicationUrl || app.jobUrl} target="_blank" rel="noreferrer noopener">
                    <Button variant="secondary" className="w-full">
                      Open employer form ↗
                    </Button>
                  </a>
                  <Input
                    value={manualNote}
                    onChange={(event) => setManualNote(event.target.value)}
                    placeholder="Confirmation details (optional)"
                  />
                  <Button
                    variant="success"
                    className="w-full"
                    loading={confirmManual.isPending}
                    onClick={() => confirmManual.mutate()}
                  >
                    I submitted this application manually
                  </Button>
                  <p className="text-[11px] text-slate-500">
                    This records your own attestation. It is labelled as user-confirmed, not automated.
                  </p>
                </div>
              ) : null}

              {app.status === 'SUBMITTED' ? (
                <div className="space-y-1.5 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
                  <p className="font-medium">Submission confirmed</p>
                  <p>Adapter: {app.submission?.adapter || 'manual confirmation'}</p>
                  <p>Attempts: {app.submission?.attempts ?? 0}</p>
                  {app.submission?.confirmationId ? (
                    <p className="break-all">Confirmation: {app.submission.confirmationId}</p>
                  ) : null}
                  {app.submission?.simulated ? (
                    <p className="text-amber-200">
                      This was a simulated submission to a fictional mock vacancy. No employer was contacted.
                    </p>
                  ) : null}
                  <p className="break-words text-emerald-300/80">{app.submission?.evidence}</p>
                </div>
              ) : null}

              {app.status === 'FAILED' ? (
                <div className="rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                  <p className="font-medium">Submission failed</p>
                  <p className="mt-1 break-words">{app.submission?.message}</p>
                  <p className="mt-1 text-rose-300/80">{app.submission?.evidence}</p>
                </div>
              ) : null}

              {!locked ? (
                <Button
                  variant="ghost"
                  className="w-full text-rose-300"
                  loading={cancel.isPending}
                  onClick={() => {
                    if (window.confirm('Withdraw this application locally? This does not notify the employer.')) {
                      cancel.mutate();
                    }
                  }}
                >
                  Withdraw application
                </Button>
              ) : null}
            </div>
          </Card>

          {match ? <MatchCard match={match} compact /> : null}

          <Card title="Status history" padded={false}>
            <ol className="divide-y divide-slate-800">
              {[...app.statusHistory].reverse().map((entry, index) => (
                <li key={`${entry.to}-${index}`} className="px-4 py-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <Badge tone={statusTone(entry.to)}>{titleCase(entry.to)}</Badge>
                    <span className="text-[10px] text-slate-500">{formatDateTime(entry.at)}</span>
                  </div>
                  {entry.reason ? <p className="mt-1 text-slate-400">{entry.reason}</p> : null}
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </div>
  );
}
