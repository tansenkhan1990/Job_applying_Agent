import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../api/client';
import type {
  Application,
  AssistantStatus,
  Job,
  JobMatch,
  Paginated,
} from '../api/types';
import { formatDate, titleCase } from '../lib/format';
import { useToast } from '../components/Toast';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  LanguageDecisionBadge,
  PageHeader,
  SpinnerPanel,
} from '../components/ui';

function asJob(application: Application): Job | null {
  return typeof application.job === 'string' ? null : (application.job as Job);
}

function asMatch(application: Application): JobMatch | null {
  if (!application.match || typeof application.match === 'string') return null;
  return application.match as JobMatch;
}

export function ApplicationQueuePage() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const queue = useQuery<Paginated<Application>>({
    queryKey: ['application-queue'],
    queryFn: () => api<Paginated<Application>>('/applications/queue?limit=50'),
    refetchInterval: 8_000,
  });

  const runner = useQuery<AssistantStatus>({
    queryKey: ['assistant-status'],
    queryFn: () => api<AssistantStatus>('/applications/assistant/status'),
    refetchInterval: 10_000,
  });

  const start = useMutation({
    mutationFn: (applicationId: string) =>
      api<{ application: Application }>(`/applications/${applicationId}/assistant/start`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: (_result, applicationId) => {
      toast.success(
        runner.data?.online
          ? 'Queued. The visible browser runner will open the application page.'
          : 'Queued. Start the host runner to open the visible browser window.',
      );
      void queryClient.invalidateQueries({ queryKey: ['application-queue'] });
      void queryClient.invalidateQueries({ queryKey: ['assistant', applicationId] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const items = queue.data?.items ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Application queue"
        description="Jobs that passed the language and three-calendar-month age checks. Starting the assistant only queues a visible browser session; you review the form and submit it yourself."
        actions={
          <Link to="/assistant">
            <Button variant="secondary">Assistant monitor</Button>
          </Link>
        }
      />

      <div
        className={`rounded-xl border px-4 py-3 text-sm ${
          runner.data?.online
            ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
            : 'border-amber-500/25 bg-amber-500/10 text-amber-200'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">
            {runner.data?.online ? 'Browser runner online' : 'Browser runner offline'}
          </span>
          <span className="text-[11px] opacity-80">
            {runner.data?.lastSeenAt
              ? `Last seen ${formatDate(runner.data.lastSeenAt)}`
              : 'No heartbeat received yet'}
          </span>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed opacity-90">{runner.data?.instructions}</p>
        {!runner.data?.configured ? (
          <p className="mt-1 text-[11px] font-medium">
            Set BROWSER_RUNNER_TOKEN in .env and restart the backend before starting the runner.
          </p>
        ) : null}
      </div>

      {queue.isLoading ? <SpinnerPanel label="Loading application queue…" /> : null}
      {queue.error ? <ErrorNote message={errorMessage(queue.error)} /> : null}

      {!queue.isLoading && !queue.error && items.length === 0 ? (
        <EmptyState
          title="No eligible applications queued"
          description="Prepare an application from a job that is language-eligible and was originally posted at least three calendar months ago. Too-recent and unknown-date jobs stay in job discovery for review."
          action={
            <Link to="/jobs">
              <Button variant="primary">Browse jobs</Button>
            </Link>
          }
        />
      ) : null}

      <div className="space-y-3">
        {items.map((application) => {
          const job = asJob(application);
          const match = asMatch(application);
          const busy = ['ASSISTANT_RUNNING', 'AWAITING_REVIEW', 'NEEDS_INPUT'].includes(
            application.workflow?.status,
          );
          return (
            <Card key={application.id} padded={false}>
              <div className="flex flex-col gap-3 p-4 lg:flex-row lg:items-start">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to={`/applications/${application.id}`}
                      className="text-base font-semibold text-slate-100 hover:text-indigo-200"
                    >
                      {application.jobTitle}
                    </Link>
                    <Badge tone={busy ? 'warning' : 'success'}>
                      {titleCase(application.workflow?.status ?? 'READY_TO_APPLY')}
                    </Badge>
                    {match ? <Badge tone="info">{match.score}/100 match</Badge> : null}
                  </div>
                  <p className="mt-1 text-sm text-slate-300">
                    {application.employer}
                    {application.jobLocation ? ` · ${application.jobLocation}` : ''}
                    {application.workArrangement ? ` · ${titleCase(application.workArrangement)}` : ''}
                  </p>

                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <Badge tone="success">{application.ageEligibility} age</Badge>
                    <LanguageDecisionBadge
                      decision={application.languageSnapshot?.languageDecision ?? 'Needs Review'}
                      confidence={application.languageSnapshot?.languageConfidence}
                    />
                    {application.postedAt ? (
                      <Badge tone="neutral">Posted {formatDate(application.postedAt)}</Badge>
                    ) : null}
                  </div>

                  <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                    {application.ageReason}
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    CV: {application.selectedCvFilename || 'selected CV'} · Uploaded cover letter:{' '}
                    {application.selectedCoverLetterFilename || 'tailored letter'}
                  </p>
                  {application.sourceCoverLetterFilename ? (
                    <p className="mt-1 text-[11px] text-slate-500">
                      Grounded in your mapped letter {application.sourceCoverLetterFilename}
                    </p>
                  ) : null}
                  {job?.url ? (
                    <a
                      href={job.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="mt-1 inline-block text-[11px] text-indigo-300 hover:text-indigo-200"
                    >
                      Original listing ↗
                    </a>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-2 lg:flex-col lg:items-stretch">
                  {busy ? (
                    <Link to={`/assistant/${application.id}`}>
                      <Button size="sm" variant="primary" className="w-full">
                        Open live monitor
                      </Button>
                    </Link>
                  ) : (
                    <Button
                      size="sm"
                      variant="primary"
                      className="w-full"
                      onClick={() => start.mutate(application.id)}
                      loading={start.isPending && start.variables === application.id}
                    >
                      Start application assistant
                    </Button>
                  )}
                  <Link to={`/applications/${application.id}`}>
                    <Button size="sm" variant="secondary" className="w-full">
                      Review documents
                    </Button>
                  </Link>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
