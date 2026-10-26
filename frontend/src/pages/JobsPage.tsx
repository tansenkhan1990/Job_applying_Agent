import { useEffect, useState } from 'react';
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
  LanguageDecisionBadge,
  PageHeader,
  Pagination,
  ScoreBadge,
  Select,
  SpinnerPanel,
  WarningNote,
} from '../components/ui';
import { useToast } from '../components/Toast';
import {
  DEFAULT_JOB_FILTERS,
  buildJobListQuery,
  type JobDateEvidence,
  type JobFilters,
  type JobLanguageFilter,
  type JobLetterFilter,
  type JobReviewFilter,
  type JobScoreBand,
} from '../lib/listQuery';

const FILTER_STORAGE_KEY = 'job-agent:job-filters:v1';

function loadFilters(): JobFilters {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return DEFAULT_JOB_FILTERS;
    return { ...DEFAULT_JOB_FILTERS, ...(JSON.parse(raw) as Partial<JobFilters>) };
  } catch {
    return DEFAULT_JOB_FILTERS;
  }
}

export function JobsPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [filters, setFilters] = useState<JobFilters>(loadFilters);
  const [search, setSearch] = useState(filters.q);
  const [page, setPage] = useState(1);
  const [matchingId, setMatchingId] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters));
    } catch {
      // Filter persistence is a convenience; storage may be unavailable.
    }
  }, [filters]);

  function patch(next: Partial<JobFilters>) {
    setFilters((current) => ({ ...current, ...next }));
    setPage(1);
  }

  function reset() {
    setFilters(DEFAULT_JOB_FILTERS);
    setSearch('');
    setPage(1);
  }

  const params = buildJobListQuery(filters, search, page);

  const jobs = useQuery<Paginated<Job>>({
    queryKey: ['jobs', params.toString()],
    queryFn: () => api<Paginated<Job>>(`/jobs?${params.toString()}`),
  });

  const runSearch = useMutation({
    mutationFn: () => api<DiscoveryResult>('/jobs/search', { method: 'POST', body: {} }),
    onSuccess: (result) => {
      toast.success(
        `Discovery: ${result.discovered} found, ${result.created} new, ${result.updated} refreshed, ${result.filteredOut} filtered out.`,
      );
      for (const source of result.sources) {
        if (source.error) toast.error(`${source.source}: ${source.error}`);
      }
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const matchJob = useMutation({
    mutationFn: (jobId: string) =>
      api<{ matches: JobMatch[] }>(`/jobs/${jobId}/match`, { method: 'POST', body: {} }),
    onMutate: (jobId) => setMatchingId(jobId),
    onSuccess: (result, jobId) => {
      const best = [...result.matches].sort((a, b) => b.score - a.score)[0];
      toast.success(
        best ? `Best score: ${best.score}/100 (${titleCase(best.profileKind)}).` : 'Matching complete.',
      );
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['job', jobId] });
    },
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: () => setMatchingId(null),
  });

  const setJobState = useMutation({
    mutationFn: (input: { jobId: string; saved?: boolean; reviewed?: boolean }) =>
      api<{ job: Job }>(`/jobs/${input.jobId}/state`, {
        method: 'PATCH',
        body: { saved: input.saved, reviewed: input.reviewed },
      }),
    onSuccess: (_result, input) => {
      if (input.saved !== undefined) toast.success(input.saved ? 'Job saved.' : 'Job removed from saved.');
      if (input.reviewed !== undefined) toast.success(input.reviewed ? 'Marked reviewed.' : 'Marked unreviewed.');
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['job', input.jobId] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const items = jobs.data?.items ?? [];
  const activeFilterCount = [
    filters.category,
    filters.profileKind,
    filters.scoreBand,
    filters.postedWindow,
    filters.dateEvidence === 'needs_review' ? 'needs_review' : '',
    filters.arrangement,
    filters.locationScope,
    filters.country,
    filters.remoteFromGermany,
    filters.employmentType,
    filters.minSalary,
    filters.employer,
    filters.seniority,
    filters.savedOnly ? 'saved' : '',
    filters.reviewFilter !== 'all' ? filters.reviewFilter : '',
    filters.letterFilter !== 'all' ? filters.letterFilter : '',
  ].filter(Boolean).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Job opportunities"
        description="Only vacancies posted within the last three calendar months are listed. Germany: remote, hybrid or onsite. Outside Germany: remote roles only, with remote eligibility marked when the source states it. German-mandatory postings are hidden by default. Listings without a verified original posting date are kept out of normal results and appear only in the separate date-verification review. Match percentages are transparent estimates, not hiring probabilities."
        actions={
          <Button variant="primary" onClick={() => runSearch.mutate()} loading={runSearch.isPending}>
            Run discovery
          </Button>
        }
      />

      <Card padded={false}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
          <p className="text-xs font-medium text-slate-300">
            Filters {activeFilterCount > 0 ? <span className="text-slate-500">({activeFilterCount} active)</span> : null}
          </p>
          <p className="text-[11px] text-slate-500">Preferences are remembered on this device.</p>
        </div>
        <form
          className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            setSearch(filters.q);
          }}
        >
          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Keywords
            <Input
              placeholder="Title, employer or location"
              value={filters.q}
              onChange={(event) => patch({ q: event.target.value })}
            />
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Job category
            <Select value={filters.category} onChange={(event) => patch({ category: event.target.value })}>
              <option value="">All categories</option>
              <option value="fullstack">Full Stack</option>
              <option value="backend">Backend</option>
              <option value="ai">AI / LLM / ML</option>
              <option value="devops_cloud">DevOps / Cloud</option>
              <option value="software">Software Engineering</option>
            </Select>
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Career profile
            <Select
              value={filters.profileKind}
              onChange={(event) => patch({ profileKind: event.target.value as ProfileKind | '' })}
            >
              <option value="">All profiles</option>
              <option value="full_stack">Full Stack</option>
              <option value="ai_engineer">AI Engineer</option>
              <option value="devops_cloud">DevOps / Cloud</option>
            </Select>
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Match score
            <Select
              value={filters.scoreBand}
              onChange={(event) => patch({ scoreBand: event.target.value as JobScoreBand })}
            >
              <option value="">Any score</option>
              <option value="90-100">90–100%</option>
              <option value="80-89">80–89%</option>
              <option value="70-79">70–79%</option>
              <option value="below-70">Below 70%</option>
            </Select>
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Posted
            <Select
              value={filters.postedWindow}
              onChange={(event) => patch({ postedWindow: event.target.value as JobFilters['postedWindow'] })}
            >
              <option value="">Any time</option>
              <option value="1">Last 24 hours</option>
              <option value="7">Last 7 days</option>
              <option value="14">Last 14 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="3m">Last 3 months (maximum window)</option>
              <option value="custom">Custom range</option>
            </Select>
          </label>

          {filters.postedWindow === 'custom' ? (
            <>
              <label className="flex flex-col gap-1 text-[11px] text-slate-400">
                Posted from
                <Input
                  type="date"
                  value={filters.postedFrom}
                  onChange={(event) => patch({ postedFrom: event.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-slate-400">
                Posted to
                <Input
                  type="date"
                  value={filters.postedTo}
                  onChange={(event) => patch({ postedTo: event.target.value })}
                />
              </label>
            </>
          ) : null}

          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Date evidence
            <Select
              value={filters.dateEvidence}
              onChange={(event) =>
                patch({
                  dateEvidence: event.target.value as JobDateEvidence,
                  postedWindow: '',
                  postedFrom: '',
                  postedTo: '',
                })
              }
            >
              <option value="verified">Verified posting dates</option>
              <option value="needs_review">Needs date verification (review)</option>
            </Select>
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Location scope
            <Select
              value={filters.locationScope}
              onChange={(event) => patch({ locationScope: event.target.value as JobFilters['locationScope'] })}
            >
              <option value="">Germany + remote outside</option>
              <option value="germany">Germany only</option>
              <option value="outside_germany_remote">Remote outside Germany</option>
            </Select>
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Work arrangement
            <Select
              value={filters.arrangement}
              onChange={(event) => patch({ arrangement: event.target.value as JobFilters['arrangement'] })}
            >
              <option value="">Any arrangement</option>
              <option value="remote">Remote</option>
              <option value="hybrid">Hybrid</option>
              <option value="onsite">Onsite</option>
            </Select>
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Country
            <Input
              placeholder="e.g. Germany, Netherlands"
              value={filters.country}
              onChange={(event) => patch({ country: event.target.value })}
            />
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Remote from Germany
            <Select
              value={filters.remoteFromGermany}
              onChange={(event) =>
                patch({ remoteFromGermany: event.target.value as JobFilters['remoteFromGermany'] })
              }
            >
              <option value="">Any / not stated</option>
              <option value="true">Explicitly possible</option>
              <option value="false">Explicitly not possible</option>
            </Select>
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Employment type
            <Input
              placeholder="e.g. Full-time, Contract"
              value={filters.employmentType}
              onChange={(event) => patch({ employmentType: event.target.value })}
            />
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Minimum salary (annual)
            <Input
              type="number"
              min="0"
              placeholder="e.g. 60000"
              value={filters.minSalary}
              onChange={(event) => patch({ minSalary: event.target.value })}
            />
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Company
            <Input
              placeholder="Employer name"
              value={filters.employer}
              onChange={(event) => patch({ employer: event.target.value })}
            />
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Seniority
            <Select value={filters.seniority} onChange={(event) => patch({ seniority: event.target.value })}>
              <option value="">Any level</option>
              <option value="junior">Junior</option>
              <option value="mid">Mid</option>
              <option value="senior">Senior</option>
              <option value="lead">Lead</option>
              <option value="unknown">Not stated</option>
            </Select>
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Language
            <Select
              value={filters.languageFilter}
              onChange={(event) => patch({ languageFilter: event.target.value as JobLanguageFilter })}
            >
              <option value="non_required">Exclude German-mandatory</option>
              <option value="eligible">English eligible</option>
              <option value="optional">German optional</option>
              <option value="review">Needs language review</option>
              <option value="all">All jobs</option>
            </Select>
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Review state
            <Select
              value={filters.reviewFilter}
              onChange={(event) => patch({ reviewFilter: event.target.value as JobReviewFilter })}
            >
              <option value="all">All</option>
              <option value="unreviewed">Not yet reviewed</option>
              <option value="reviewed">Reviewed</option>
            </Select>
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Cover letter
            <Select
              value={filters.letterFilter}
              onChange={(event) => patch({ letterFilter: event.target.value as JobLetterFilter })}
            >
              <option value="all">Any</option>
              <option value="yes">Cover letter generated</option>
              <option value="no">No cover letter yet</option>
            </Select>
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Sort by
            <Select
              value={filters.sort}
              onChange={(event) => patch({ sort: event.target.value as JobFilters['sort'] })}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="score">Match score</option>
              <option value="company">Company</option>
              <option value="title">Job title</option>
            </Select>
          </label>

          <label className="flex items-center gap-2 self-end pb-2 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={filters.savedOnly}
              onChange={(event) => patch({ savedOnly: event.target.checked })}
              className="h-4 w-4 rounded border-slate-600 bg-slate-900"
            />
            Saved jobs only
          </label>

          <div className="flex gap-2 self-end pb-0.5 sm:col-span-2 lg:col-span-4">
            <Button type="submit" variant="secondary">
              Apply filters
            </Button>
            <Button variant="ghost" onClick={reset}>
              Reset
            </Button>
          </div>
        </form>
      </Card>

      {filters.dateEvidence === 'needs_review' ? (
        <WarningNote>
          Review group: these listings do not expose a verifiable original posting date. They are
          excluded from normal job results and cannot be prepared for an application until the date
          is verified at the source.
        </WarningNote>
      ) : null}

      {jobs.isLoading ? <SpinnerPanel label="Loading jobs…" /> : null}
      {jobs.error ? <ErrorNote message={errorMessage(jobs.error)} /> : null}

      {!jobs.isLoading && !jobs.error && items.length === 0 ? (
        <EmptyState
          title="No jobs match these filters"
          description="Run a discovery to fetch vacancies from the enabled sources, or enable the mock source in Settings for a local test."
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
          const profile = match && typeof match.profile !== 'string' ? match.profile : null;
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
                    {job.saved ? <Badge tone="success">Saved</Badge> : null}
                    {job.reviewedAt ? <Badge tone="neutral">Reviewed</Badge> : null}
                    {match?.reviewRequired ? <Badge tone="warning">Review required</Badge> : null}
                  </div>
                  <p className="mt-1 text-sm text-slate-300">
                    {job.employer}
                    {job.location ? ` · ${job.location}` : ''}
                    {job.country ? ` · ${job.country}` : ''}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <Badge tone="info">{job.sourceLabel || job.source}</Badge>
                    {job.simulated ? <Badge tone="warning">Simulated fixture</Badge> : null}
                    <Badge tone="neutral">{titleCase(job.workArrangement)}</Badge>
                    {job.employmentType ? <Badge tone="neutral">{job.employmentType}</Badge> : null}
                    {job.seniority !== 'unknown' ? (
                      <Badge tone="neutral">{titleCase(job.seniority)}</Badge>
                    ) : null}
                    {job.salary ? <Badge tone="neutral">{job.salary}</Badge> : null}
                    <LanguageDecisionBadge
                      decision={job.languageDecision}
                      confidence={job.languageConfidence}
                    />
                    {job.germanOptional ? <Badge tone="info">German optional</Badge> : null}
                    {job.remoteEligibleFromGermany === true ? (
                      <Badge tone="success">Remote from Germany</Badge>
                    ) : null}
                    {job.remoteEligibleFromGermany === false ? (
                      <Badge tone="danger">Not remote from Germany</Badge>
                    ) : null}
                    {/* A remote role outside Germany whose eligibility is not stated is kept but
                        must stay visibly ambiguous rather than look verified. */}
                    {job.workArrangement === 'remote' &&
                    job.country !== 'Germany' &&
                    job.remoteEligibleFromGermany === null ? (
                      <Badge tone="warning">Remote scope unverified</Badge>
                    ) : null}
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
                    {job.status !== 'active' ? <Badge tone={statusTone(job.status)}>{job.status}</Badge> : null}
                    <span className="text-[11px] text-slate-500">
                      {job.postedAt
                        ? `Posted ${formatDate(job.postedAt)}`
                        : `Discovered ${formatDate(job.discoveredAt)}`}
                    </span>
                    {job.postedAtUnknown ? <Badge tone="neutral">Posted date unknown</Badge> : null}
                  </div>

                  {match?.matchedSkills.length ? (
                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      <span className="text-[11px] text-slate-500">Top matches:</span>
                      {match.matchedSkills.slice(0, 6).map((skill) => (
                        <Badge key={skill} tone="success">
                          {skill}
                        </Badge>
                      ))}
                      {match.matchedSkills.length > 6 ? (
                        <span className="text-[11px] text-slate-500">
                          +{match.matchedSkills.length - 6} more
                        </span>
                      ) : null}
                    </div>
                  ) : null}

                  {profile ? (
                    <p className="mt-1.5 text-[11px] text-slate-500">
                      Recommended CV: <span className="text-slate-300">{profile.label}</span>
                    </p>
                  ) : null}

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
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setJobState.mutate({ jobId: job.id, saved: !job.saved })}
                  >
                    {job.saved ? 'Unsave' : 'Save'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setJobState.mutate({ jobId: job.id, reviewed: !job.reviewedAt })}
                  >
                    {job.reviewedAt ? 'Mark unreviewed' : 'Mark reviewed'}
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
