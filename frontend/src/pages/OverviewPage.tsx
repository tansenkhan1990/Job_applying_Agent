import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import type { DashboardSummary, DiscoveryResult } from '../api/types';
import { formatDateTime, statusTone, timeAgo } from '../lib/format';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  PageHeader,
  ScoreBadge,
  SpinnerPanel,
  StatCard,
  WarningNote,
} from '../components/ui';
import { useToast } from '../components/Toast';

export function OverviewPage() {
  const queryClient = useQueryClient();
  const toast = useToast();

  const summary = useQuery<DashboardSummary>({
    queryKey: ['dashboard-summary'],
    queryFn: () => api<DashboardSummary>('/dashboard/summary'),
  });

  const runSearch = useMutation({
    mutationFn: () => api<DiscoveryResult>('/jobs/search', { method: 'POST', body: {} }),
    onSuccess: (result) => {
      toast.success(
        `Discovery finished: ${result.created} new, ${result.updated} updated, ${result.filteredOut} filtered out.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['search-runs'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  if (summary.isLoading) return <SpinnerPanel label="Loading dashboard…" />;
  if (summary.error) {
    return (
      <div className="space-y-4">
        <PageHeader title="Overview" />
        <ErrorNote message={errorMessage(summary.error)} />
      </div>
    );
  }
  if (!summary.data) return null;

  const { totals, topMatches, recentRuns, ai, sourceFailures, lastSuccessful } = summary.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description="Verified vacancies and doctoral positions, estimated profile matches and tailored cover letters in one place."
        actions={
          <>
            <Button variant="secondary" onClick={() => void summary.refetch()} loading={summary.isFetching}>
              Refresh
            </Button>
            <Button variant="primary" onClick={() => runSearch.mutate()} loading={runSearch.isPending}>
              Run job discovery
            </Button>
          </>
        }
      />

      {!ai.configured ? (
        <WarningNote>
          <strong className="font-semibold">OpenRouter is not configured.</strong> Matching, profile
          extraction and cover letters use deterministic fallbacks. Add OPENROUTER_API_KEY to{' '}
          <code className="rounded bg-slate-950/50 px-1">.env</code>, restart the backend, then choose a model
          in Settings. This tool never submits an application.
        </WarningNote>
      ) : null}

      {sourceFailures.length > 0 ? (
        <WarningNote>
          <strong className="font-semibold">Some sources failed in the last run.</strong> Stored results were
          kept, but freshness is not guaranteed.
          <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
            {sourceFailures.map((failure) => (
              <li key={`${failure.kind}-${failure.source}`}>
                {failure.kind === 'jobs' ? 'Jobs' : 'PhD'} · {failure.source}: {failure.error}
              </li>
            ))}
          </ul>
        </WarningNote>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
        <StatCard
          label="Jobs in window"
          value={totals.eligibleByDate}
          hint={`${totals.totalJobs} active stored`}
        />
        <StatCard label="New in 24h" value={totals.newJobs} tone="info" hint="Discovered recently" />
        <StatCard
          label={`High match ≥${summary.data.highMatchThreshold}`}
          value={totals.highMatchJobs}
          tone="success"
          hint="Inside the date window"
        />
        <StatCard label="Saved jobs" value={totals.savedJobs} tone="neutral" hint="Your shortlist" />
        <StatCard label="Open PhDs" value={totals.openPhd} tone="success" hint="Verified deadline or rolling" />
        <StatCard
          label="PhD deadlines ≤14d"
          value={totals.phdDeadlineSoon}
          tone="warning"
          hint="Still open"
        />
        <StatCard
          label="PhD date unknown"
          value={totals.phdUnknownDeadline}
          tone="neutral"
          hint="Needs verification"
        />
        <StatCard label="Saved PhDs" value={totals.savedPhd} tone="neutral" hint="Your shortlist" />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Last job search"
          value={lastSuccessful.jobs ? timeAgo(lastSuccessful.jobs) : 'never'}
          hint={lastSuccessful.jobs ? formatDateTime(lastSuccessful.jobs) : 'Run a discovery'}
        />
        <StatCard
          label="Last PhD search"
          value={lastSuccessful.phd ? timeAgo(lastSuccessful.phd) : 'never'}
          hint={lastSuccessful.phd ? formatDateTime(lastSuccessful.phd) : 'Run a PhD search'}
        />
        <StatCard
          label="Cover letters saved"
          value={totals.savedLetters}
          hint={`${totals.approvedProfiles} approved profile(s)`}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card
          title="Top matches"
          subtitle="Highest estimated profile matches across your career profiles"
          action={
            <Link to="/jobs" className="text-xs text-indigo-300 hover:text-indigo-200">
              View all jobs →
            </Link>
          }
          padded={false}
        >
          {topMatches.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="No matches yet"
                description="Run a discovery, then open a job to evaluate it against your profiles."
                action={
                  <Link to="/jobs">
                    <Button size="sm">Go to jobs</Button>
                  </Link>
                }
              />
            </div>
          ) : (
            <ul className="divide-y divide-slate-800/80">
              {topMatches.map((match) => (
                <li key={match.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/jobs/${match.jobId}`}
                      className="block truncate text-sm font-medium text-slate-100 hover:text-indigo-200"
                    >
                      {match.jobTitle}
                    </Link>
                    <p className="truncate text-xs text-slate-400">
                      {match.employer}
                      {match.location ? ` · ${match.location}` : ''}
                    </p>
                  </div>
                  {match.reviewRequired ? <Badge tone="warning">Review</Badge> : null}
                  <ScoreBadge score={match.score} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Recent search runs"
          subtitle="Discovery is bounded per source and never runs concurrently"
          padded={false}
        >
          {recentRuns.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No search runs" description="Start a discovery run to populate jobs." />
            </div>
          ) : (
            <ul className="divide-y divide-slate-800/80">
              {recentRuns.map((run) => (
                <li key={run.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Badge tone={statusTone(run.status)}>{run.status}</Badge>
                      <Badge tone="neutral">{run.status === 'running' ? 'phd' : 'jobs'}</Badge>
                      <span className="text-xs text-slate-400">{timeAgo(run.startedAt)}</span>
                      <Badge tone="neutral">{run.trigger}</Badge>
                    </div>
                    <span className="text-[11px] text-slate-500">
                      {run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : '—'}
                    </span>
                  </div>
                  <p className="mt-1.5 text-xs text-slate-300">
                    {run.discovered} found · {run.created} new · {run.updatedJobs} updated ·{' '}
                    {run.filteredOut} filtered
                  </p>
                  {run.sources.length > 0 ? (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {run.sources.map((source) => (
                        <Badge key={source.source} tone={source.status === 'ok' ? 'success' : 'danger'}>
                          {source.source}: {source.found}
                          {source.error ? ' (error)' : ''}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  {run.errorMessages?.length ? (
                    <p className="mt-1 text-[11px] text-rose-300">{run.errorMessages.join(' · ')}</p>
                  ) : null}
                  {run.sources.some((source) => source.rejectionReasons && Object.keys(source.rejectionReasons).length > 0) ? (
                    <div className="mt-1.5 space-y-0.5 text-[11px] text-slate-400">
                      {run.sources.map((source) =>
                        source.rejectionReasons && Object.keys(source.rejectionReasons).length > 0 ? (
                          <p key={source.source}>
                            {source.source} rejected:{' '}
                            {Object.entries(source.rejectionReasons)
                              .map(([reason, count]) => `${reason.replace(/_/g, ' ')} ${count}`)
                              .join(' · ')}
                          </p>
                        ) : null,
                      )}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="How to use this dashboard">
          <ol className="space-y-2 text-sm text-slate-300">
            <li>
              <span className="font-medium text-slate-100">1. Confirm documents.</span> Check that each CV and
              reference letter was mapped to the right career profile.
            </li>
            <li>
              <span className="font-medium text-slate-100">2. Discover & score.</span> Pull vacancies from
              enabled sources and let the deterministic scorer explain each match.
            </li>
            <li>
              <span className="font-medium text-slate-100">3. Review the fit.</span> Read the missing skills,
              deadline and eligibility notes before deciding where to apply.
            </li>
            <li>
              <span className="font-medium text-slate-100">4. Draft the letter.</span> Generate, edit and
              download it in the job or PhD workspace.
            </li>
          </ol>
        </Card>
        <Card title="Rules enforced by the backend">
          <ul className="space-y-2 text-sm text-slate-300">
            <li>Professional jobs must be posted inside the last three calendar months.</li>
            <li>Unknown posting dates never appear in normal job results.</li>
            <li>Jobs that mandate German are excluded by default; optional German stays.</li>
            <li>Jobs outside Germany are remote-only and must allow work from Germany.</li>
            <li>PhD positions are filtered by deadline, not posting age.</li>
            <li>PhD deadlines that cannot be verified are shown separately.</li>
            <li>Dates, filters, deduplication and match scores are deterministic, never invented by the model.</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
