import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import type { DashboardSummary, DiscoveryResult } from '../api/types';
import { formatDateTime, scoreTone, statusTone, timeAgo, titleCase } from '../lib/format';
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

  const { totals, topMatches, recentRuns, ai } = summary.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description="Local job discovery, profile-specific relevance scores and application review in one place."
        actions={
          <>
            <Button variant="secondary" onClick={() => void summary.refetch()} loading={summary.isFetching}>
              Refresh
            </Button>
            <Button variant="primary" onClick={() => runSearch.mutate()} loading={runSearch.isPending}>
              Run discovery
            </Button>
          </>
        }
      />

      {!ai.configured ? (
        <WarningNote>
          <strong className="font-semibold">OpenRouter is not configured.</strong> Matching, profile
          extraction and cover letters currently use deterministic fallbacks. Add OPENROUTER_API_KEY to{' '}
          <code className="rounded bg-slate-950/50 px-1">.env</code>, restart the backend, then choose a model
          in Settings. Nothing will be submitted automatically.
        </WarningNote>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <StatCard label="Discovered" value={totals.totalJobs} hint={`${totals.activeJobs} active`} />
        <StatCard label="Relevant ≥80" value={totals.relevant} tone="success" hint="Across all profiles" />
        <StatCard
          label="Age eligible"
          value={totals.eligibleByAge}
          tone="success"
          hint={`${totals.eligibleNotApplied} not applied`}
        />
        <StatCard label="Too recent" value={totals.tooRecent} tone="warning" hint="Under 3 calendar months" />
        <StatCard
          label="Date unknown"
          value={totals.unknownPostingDate}
          tone="neutral"
          hint="Needs review, never auto-applied"
        />
        <StatCard label="Expired" value={totals.expiredByAge} tone="danger" hint="Not accepting applications" />
        <StatCard label="Pending review" value={totals.pendingApproval} tone="warning" hint="Approval required" />
        <StatCard
          label="Awaiting me"
          value={totals.preparedAwaitingReview}
          tone="info"
          hint={`${totals.assistantActive} assistant active`}
        />
        <StatCard label="Submitted" value={totals.submitted} tone="success" hint="Confirmed only" />
        <StatCard label="Manual action" value={totals.manual} tone="info" hint="Needs your browser" />
        <StatCard label="Failed" value={totals.failed} tone="danger" hint="See application details" />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card
          title="Top matches"
          subtitle="Highest relevance scores across your career profiles"
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
                description="Run a discovery first, then open a job and evaluate it against your profiles."
                action={
                  <Link to="/jobs">
                    <Button size="sm">Go to jobs</Button>
                  </Link>
                }
              />
            </div>
          ) : (
            <ul className="divide-y divide-slate-800/80">
              {topMatches.map((match) => {
                const jobId = typeof match.job === 'string' ? match.job : match.job.id;
                return (
                  <li key={match.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <Link
                        to={`/jobs/${jobId}`}
                        className="block truncate text-sm font-medium text-slate-100 hover:text-indigo-200"
                      >
                        {match.jobTitle}
                      </Link>
                      <p className="truncate text-xs text-slate-400">
                        {match.employer} · {titleCase(match.profileKind)}
                      </p>
                    </div>
                    {match.reviewRequired ? <Badge tone="warning">Review</Badge> : null}
                    <ScoreBadge score={match.score} />
                  </li>
                );
              })}
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
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Workflow reminders">
          <ol className="space-y-2 text-sm text-slate-300">
            <li>
              <span className="font-medium text-slate-100">1. Map documents.</span> Assign each CV and cover
              letter to a profile, then approve the parsed profile.
            </li>
            <li>
              <span className="font-medium text-slate-100">2. Discover & score.</span> Pull vacancies from
              enabled sources and evaluate the relevant ones.
            </li>
            <li>
              <span className="font-medium text-slate-100">3. Review the letter.</span> Edit or regenerate it
              until every claim is grounded in your CV.
            </li>
            <li>
              <span className="font-medium text-slate-100">4. Approve explicitly.</span> The backend refuses to
              submit without a matching approval record.
            </li>
          </ol>
        </Card>
        <Card title="Safety invariants">
          <ul className="space-y-2 text-sm text-slate-300">
            <li>No fabricated experience, metrics or legal declarations.</li>
            <li>Jobs that require German are filtered out by default; optional or not-required German stays.</li>
            <li>Only postings at least three calendar months old can enter the application assistant.</li>
            <li>Unknown posting dates and too-recent jobs are stored but kept out of the queue.</li>
            <li>Only fictional mock jobs can use simulated submission.</li>
            <li>Real employers require you to complete the form and confirm manually.</li>
            <li>Duplicate applications are blocked by job and by employer/title.</li>
          </ul>
        </Card>
      </div>

      {summary.data.applicationsByStatus && Object.keys(summary.data.applicationsByStatus).length > 0 ? (
        <Card title="Applications by status">
          <div className="flex flex-wrap gap-2">
            {Object.entries(summary.data.applicationsByStatus).map(([status, count]) => (
              <Badge key={status} tone={statusTone(status)}>
                {status}: {count}
              </Badge>
            ))}
          </div>
          <p className="mt-3 text-[11px] text-slate-500">
            Last refreshed {formatDateTime(new Date().toISOString())}
          </p>
        </Card>
      ) : null}
    </div>
  );
}
