import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../api/client';
import type { Application, AssistantStatus, AssistantSummary } from '../api/types';
import { formatDate, titleCase } from '../lib/format';
import { useToast } from '../components/Toast';
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  PageHeader,
  Select,
  SpinnerPanel,
  Textarea,
  WarningNote,
} from '../components/ui';

const BUSY_STATUSES = ['ASSISTANT_RUNNING', 'AWAITING_REVIEW', 'NEEDS_INPUT'];

export function AssistantMonitorPage() {
  const { id = '' } = useParams();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState<'submitted' | 'applied_manually' | 'failed' | 'skipped'>(
    'submitted',
  );
  const [evidence, setEvidence] = useState('');
  const [confirmationId, setConfirmationId] = useState('');
  const [note, setNote] = useState('');

  const runner = useQuery<AssistantStatus>({
    queryKey: ['assistant-status'],
    queryFn: () => api<AssistantStatus>('/applications/assistant/status'),
    refetchInterval: 10_000,
  });

  const summary = useQuery<AssistantSummary>({
    queryKey: ['assistant', id],
    queryFn: () => api<AssistantSummary>(`/applications/${id}/assistant`),
    enabled: Boolean(id),
    refetchInterval: 2_500,
  });

  const control = useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'stop') =>
      api<Application>(`/applications/${id}/assistant/${action}`, { method: 'POST', body: {} }),
    onSuccess: (_result, action) => {
      toast.success(
        action === 'pause'
          ? 'Pause requested. The browser stays open.'
          : action === 'resume'
            ? 'Assistant resumed.'
            : 'Stop requested. No submission is performed.',
      );
      void queryClient.invalidateQueries({ queryKey: ['assistant', id] });
      void queryClient.invalidateQueries({ queryKey: ['application-queue'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const confirm = useMutation({
    mutationFn: () =>
      api<Application>(`/applications/${id}/confirm-outcome`, {
        method: 'POST',
        body: {
          confirmed: true,
          outcome,
          evidence: evidence.trim() || undefined,
          confirmationId: confirmationId.trim() || undefined,
          note: note.trim() || undefined,
        },
      }),
    onSuccess: () => {
      toast.success('Outcome recorded. Nothing was submitted by the assistant.');
      setEvidence('');
      setConfirmationId('');
      setNote('');
      void queryClient.invalidateQueries({ queryKey: ['assistant', id] });
      void queryClient.invalidateQueries({ queryKey: ['application-queue'] });
      void queryClient.invalidateQueries({ queryKey: ['applications'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  if (!id) {
    return (
      <div className="space-y-5">
        <PageHeader
          title="Assistant monitor"
          description="The visible browser runner fills one application at a time. Open a queued application to see live progress."
        />
        <Card title="Runner status">
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={runner.data?.online ? 'success' : 'warning'}>
                {runner.data?.online ? 'Online' : 'Offline'}
              </Badge>
              {runner.data?.lastSeenAt ? (
                <span className="text-xs text-slate-400">
                  Last heartbeat {formatDate(runner.data.lastSeenAt)}
                </span>
              ) : null}
            </div>
            <p className="text-xs leading-relaxed text-slate-400">{runner.data?.instructions}</p>
            <p className="text-xs text-slate-500">
              Run it on the host so Chromium is visible: <code>cd backend && npm run runner</code>.
            </p>
            <Link to="/queue">
              <Button variant="primary">Open application queue</Button>
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  if (summary.isLoading) return <SpinnerPanel label="Loading assistant session…" />;
  if (summary.error) return <ErrorNote message={errorMessage(summary.error)} />;
  if (!summary.data) return null;

  const { workflow, job } = summary.data;
  const busy = BUSY_STATUSES.includes(workflow.status);
  const canConfirm = ['AWAITING_REVIEW', 'NEEDS_INPUT', 'ASSISTANT_RUNNING'].includes(workflow.status);
  const completion =
    workflow.fieldsDetected > 0
      ? Math.round((workflow.fieldsFilled / workflow.fieldsDetected) * 100)
      : 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title={job ? `${job.title} — ${job.employer}` : 'Assistant session'}
        description="The browser window is visible and editable. The assistant fills supported fields and then waits. It never clicks Submit."
        actions={
          <>
            <Link to="/queue">
              <Button variant="ghost">← Queue</Button>
            </Link>
            <Link to={`/applications/${id}`}>
              <Button variant="secondary">Application review</Button>
            </Link>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge
          tone={
            workflow.status === 'SUBMITTED' || workflow.status === 'APPLIED_MANUALLY'
              ? 'success'
              : workflow.status === 'SUBMISSION_FAILED'
                ? 'danger'
                : busy
                  ? 'warning'
                  : 'neutral'
          }
        >
          {titleCase(workflow.status)}
        </Badge>
        {workflow.runnerId ? <Badge tone="info">Runner {workflow.runnerId}</Badge> : null}
        {workflow.pauseRequested ? <Badge tone="warning">Pause requested</Badge> : null}
        {workflow.stopRequested ? <Badge tone="danger">Stop requested</Badge> : null}
        {workflow.pageUrl ? (
          <a
            href={workflow.pageUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs text-indigo-300 hover:text-indigo-200"
          >
            Current page ↗
          </a>
        ) : null}
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card title="Form progress">
            <div className="space-y-3">
              <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
                <div
                  className="h-full rounded-full bg-indigo-500 transition-all"
                  style={{ width: `${Math.max(0, Math.min(100, completion))}%` }}
                />
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">Detected</p>
                  <p className="text-slate-100">{workflow.fieldsDetected}</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">Filled</p>
                  <p className="text-slate-100">{workflow.fieldsFilled}</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">Files</p>
                  <p className="text-slate-100">{workflow.filesUploaded}</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">Completion</p>
                  <p className="text-slate-100">{completion}%</p>
                </div>
              </div>
              <p className="text-[11px] leading-relaxed text-slate-500">
                Filled fields never include declarations, consent boxes, salary, visa/work-authorization,
                availability or other legal answers. Those are left for you.
              </p>
            </div>
          </Card>

          {workflow.unanswered.length > 0 ? (
            <WarningNote>
              <strong>Required questions need your input:</strong> {workflow.unanswered.join(' · ')}
            </WarningNote>
          ) : null}
          {workflow.validationErrors.length > 0 ? (
            <ErrorNote message="Validation messages on the page" details={workflow.validationErrors} />
          ) : null}
          {workflow.lastError ? <ErrorNote message={workflow.lastError} /> : null}

          {workflow.reviewFields.length > 0 ? (
            <Card title="Fields left for your review" padded={false}>
              <ul className="divide-y divide-slate-800">
                {workflow.reviewFields.map((field, index) => (
                  <li key={`${field.label}-${index}`} className="px-4 py-2.5 text-xs">
                    <p className="font-medium text-slate-200">{field.label}</p>
                    <p className="mt-0.5 text-slate-400">{field.reason}</p>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card title="Record the outcome" subtitle="Only you can confirm that an application was submitted">
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Outcome">
                  <Select
                    value={outcome}
                    onChange={(event) =>
                      setOutcome(
                        event.target.value as
                          | 'submitted'
                          | 'applied_manually'
                          | 'failed'
                          | 'skipped',
                      )
                    }
                  >
                    <option value="submitted">Submitted in the browser</option>
                    <option value="applied_manually">Applied manually (outside the assistant)</option>
                    <option value="failed">Submission failed</option>
                    <option value="skipped">Skip this job</option>
                  </Select>
                </Field>
                <Field label="Confirmation number (optional)">
                  <Input
                    value={confirmationId}
                    onChange={(event) => setConfirmationId(event.target.value)}
                    placeholder="Employer reference"
                  />
                </Field>
              </div>
              <Field
                label="Confirmation evidence"
                hint="Required for submitted/applied manually: what the page showed or the email you received."
              >
                <Textarea
                  value={evidence}
                  onChange={(event) => setEvidence(event.target.value)}
                  placeholder="e.g. Confirmation page: 'Application received — reference 12345'"
                />
              </Field>
              <Field label="Note (optional)">
                <Input value={note} onChange={(event) => setNote(event.target.value)} />
              </Field>
              <Button
                variant="primary"
                onClick={() => confirm.mutate()}
                loading={confirm.isPending}
                disabled={!canConfirm}
              >
                Record outcome
              </Button>
              <p className="text-[11px] leading-relaxed text-slate-500">
                This records what you did in the visible browser. It does not click Submit and does not
                contact the employer.
              </p>
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Controls">
            <div className="space-y-2">
              <Button
                variant="secondary"
                className="w-full"
                onClick={() => control.mutate('pause')}
                loading={control.isPending && control.variables === 'pause'}
                disabled={!busy}
              >
                Pause assistant
              </Button>
              <Button
                variant="secondary"
                className="w-full"
                onClick={() => control.mutate('resume')}
                loading={control.isPending && control.variables === 'resume'}
                disabled={!busy}
              >
                Resume assistant
              </Button>
              <Button
                variant="danger"
                className="w-full"
                onClick={() => control.mutate('stop')}
                loading={control.isPending && control.variables === 'stop'}
                disabled={!busy}
              >
                Stop safely
              </Button>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
              Stop only halts automation. The browser window stays open so you can finish or close it
              yourself.
            </p>
          </Card>

          <Card title="Runner">
            <div className="space-y-2 text-xs">
              <Badge tone={runner.data?.online ? 'success' : 'warning'}>
                {runner.data?.online ? 'Runner online' : 'Runner offline'}
              </Badge>
              <p className="leading-relaxed text-slate-400">
                {workflow.runnerId ? `Session owned by ${workflow.runnerId}.` : 'Waiting for the host runner.'}
              </p>
              {workflow.pageTitle ? <p className="text-slate-400">Page: {workflow.pageTitle}</p> : null}
            </div>
          </Card>

          <Card title="Audit log" padded={false}>
            <ul className="max-h-80 divide-y divide-slate-800 overflow-y-auto">
              {workflow.events.length === 0 ? (
                <li className="px-4 py-3 text-xs text-slate-500">No events yet.</li>
              ) : (
                [...workflow.events].reverse().map((event, index) => (
                  <li key={`${event.at}-${index}`} className="px-4 py-2 text-[11px]">
                    <p className="text-slate-300">{event.message}</p>
                    <p className="mt-0.5 text-slate-500">
                      {formatDate(event.at)} · {event.type}
                      {event.source ? ` · ${event.source}` : ''}
                    </p>
                  </li>
                ))
              )}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
