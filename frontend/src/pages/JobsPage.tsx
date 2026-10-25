import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import type { DiscoveryResult, Job, JobMatch, Paginated, ProfileKind } from '../api/types';
import { formatDate, statusTone, titleCase } from '../lib/format';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Input,
  PageHeader,
  Pagination,
  ScoreBadge,
  Select,
  SpinnerPanel,
} from '../components/ui';
import { useToast } from '../components/Toast';

export function JobsPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [profileKind, setProfileKind] = useState<ProfileKind | ''>('');
  const [minScore, setMinScore] = useState('');
  const [page, setPage] = useState(1);
  const [matchingId, setMatchingId] = useState<string | null>(null);

  const params = new URLSearchParams({ page: String(page), limit: '20', status: 'active' });
  if (search.trim()) params.set('q', search.trim());
  if (profileKind) params.set('profileKind', profileKind);
  if (minScore) params.set('minScore', minScore);

  const jobs = useQuery<Paginated<Job>>({
    queryKey: ['jobs', params.toString()],
    queryFn: () => api<Paginated<Job>>(`/jobs?${params.toString()}`),
  });

  const runSearch = useMutation({
    mutationFn: () => api<DiscoveryResult>('/jobs/search', { method: 'POST', body: {} }),
    onSuccess: (result) => {
      toast.success(
        `Discovery: ${result.discovered} found, ${result.created} new, ${result.filteredOut} filtered out.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const matchJob = useMutation({
    mutationFn: (jobId: string) => api<{ matches: JobMatch[] }>(`/jobs/${jobId}/match`, { method: 'POST', body: {} }),
    onMutate: (jobId) => setMatchingId(jobId),
    onSuccess: (result, jobId) => {
      const best = [...result.matches].sort((a, b) => b.score - a.score)[0];
      toast.success(best ? `Best score: ${best.score}/100 (${titleCase(best.profileKind)}).` : 'Matching complete.');
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['job', jobId] });
    },
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: () => setMatchingId(null),
  });

  const items = jobs.data?.items ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Job listings"
        description="Normalized vacancies from enabled sources. Scores explain relevance to a specific career profile; they are not hiring probabilities."
        actions={
          <Button variant="primary" onClick={() => runSearch.mutate()} loading={runSearch.isPending}>
            Run discovery
          </Button>
        }
      />

      <Card padded={false}>
        <form
          className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-[1fr_13rem_10rem_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            setSearch(q);
          }}
        >
          <Input
            placeholder="Search title, employer or location…"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            aria-label="Search jobs"
          />
          <Select
            value={profileKind}
            onChange={(event) => {
              setProfileKind(event.target.value as ProfileKind | '');
              setPage(1);
            }}
            aria-label="Filter by career profile"
          >
            <option value="">All profiles</option>
            <option value="full_stack">Full Stack</option>
            <option value="ai_engineer">AI Engineer</option>
            <option value="devops_cloud">DevOps / Cloud</option>
          </Select>
          <Select
            value={minScore}
            onChange={(event) => {
              setMinScore(event.target.value);
              setPage(1);
            }}
            aria-label="Minimum match score"
          >
            <option value="">Any score</option>
            <option value="80">Score ≥ 80</option>
            <option value="60">Score ≥ 60</option>
            <option value="40">Score ≥ 40</option>
          </Select>
          <div className="flex gap-2">
            <Button type="submit">Filter</Button>
            <Button
              variant="ghost"
              onClick={() => {
                setQ('');
                setSearch('');
                setProfileKind('');
                setMinScore('');
                setPage(1);
              }}
            >
              Reset
            </Button>
          </div>
        </form>
      </Card>

      {jobs.isLoading ? <SpinnerPanel label="Loading jobs…" /> : null}
      {jobs.error ? <ErrorNote message={errorMessage(jobs.error)} /> : null}

      {!jobs.isLoading && !jobs.error && items.length === 0 ? (
        <EmptyState
          title="No jobs match these filters"
          description="Run a discovery to fetch vacancies from Arbeitnow and Remotive, or enable the mock source in Settings for a local test."
          action={
            <Button variant="primary" onClick={() => runSearch.mutate()} loading={runSearch.isPending}>
              Run discovery
            </Button>
          }
        />
      ) : null}

      <div className="space-y-3">
        {items.map((job) => {
          const match = job.bestMatch;
          return (
            <Card key={job.id} padded={false} className="transition-colors hover:border-slate-700">
              <div className="flex flex-col gap-3 p-4 lg:flex-row lg:items-start">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to={`/jobs/${job.id}`}
                      className="text-base font-semibold text-slate-100 hover:text-indigo-200"
                    >
                      {job.title}
                    </Link>
                    {match ? <ScoreBadge score={match.score} /> : <Badge tone="neutral">Unscored</Badge>}
                    {match?.reviewRequired ? <Badge tone="warning">Review required</Badge> : null}
                  </div>
                  <p className="mt-1 text-sm text-slate-300">
                    {job.employer}
                    {job.location ? ` · ${job.location}` : ''}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <Badge tone="info">{job.sourceLabel || job.source}</Badge>
                    <Badge tone="neutral">{titleCase(job.workArrangement)}</Badge>
                    {job.seniority !== 'unknown' ? <Badge tone="neutral">{titleCase(job.seniority)}</Badge> : null}
                    {job.languageRequirement === 'german_required' ? (
                      <Badge tone="warning">German mandatory</Badge>
                    ) : job.languageRequirement === 'german_preferred' ? (
                      <Badge tone="neutral">German preferred</Badge>
                    ) : null}
                    {job.status !== 'active' ? (
                      <Badge tone={statusTone(job.status)}>{job.status}</Badge>
                    ) : null}
                    {job.application ? (
                      <Badge
                        tone={
                          job.application.status === 'SUBMITTED'
                            ? 'success'
                            : job.application.status === 'FAILED'
                              ? 'danger'
                              : 'warning'
                        }
                      >
                        {job.application.status === 'SUBMITTED'
                          ? `Applied${job.application.appliedAt ? ` ${formatDate(job.application.appliedAt)}` : ''}`
                          : titleCase(job.application.status)}
                      </Badge>
                    ) : null}
                    <span className="text-[11px] text-slate-500">
                      {job.postedAt ? `Posted ${formatDate(job.postedAt)}` : `Discovered ${formatDate(job.discoveredAt)}`}
                    </span>
                  </div>
                  {job.descriptionPreview ? (
                    <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-slate-400">
                      {job.descriptionPreview}
                    </p>
                  ) : null}
                  {match ? (
                    <p className="mt-2 max-w-3xl text-xs leading-relaxed text-slate-400">
                      <span className="font-medium text-slate-300">{titleCase(match.profileKind)}: </span>
                      {match.explanation}
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-2 lg:flex-col lg:items-stretch">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => matchJob.mutate(job.id)}
                    loading={matchingId === job.id}
                  >
                    {match ? 'Re-evaluate' : 'Evaluate'}
                  </Button>
                  <Link to={`/jobs/${job.id}`}>
                    <Button size="sm" variant="primary" className="w-full">
                      Review & prepare
                    </Button>
                  </Link>
                  <a href={job.url} target="_blank" rel="noreferrer noopener">
                    <Button size="sm" variant="ghost" className="w-full">
                      Original listing ↗
                    </Button>
                  </a>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      {jobs.data && jobs.data.total > 0 ? (
        <Pagination page={jobs.data.page} pages={jobs.data.pages} total={jobs.data.total} onPage={setPage} />
      ) : null}
    </div>
  );
}
