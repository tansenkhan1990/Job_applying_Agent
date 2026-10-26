import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import type {
  Paginated,
  PhdDiscoveryResult,
  PhdMatch,
  PhdPosition,
  PhdSourceStatus,
} from '../api/types';
import { deadlineCountdown, formatDate, titleCase } from '../lib/format';
import {
  buildPhdListQuery,
  type PhdSort,
} from '../lib/listQuery';
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

type ScoreBand = '' | '80-100' | '60-79' | 'below-60';
type DeadlineGroup = 'open' | 'unknown' | 'expired' | 'closed';

const RESEARCH_AREA_LABELS: Record<string, string> = {
  ai: 'Artificial Intelligence',
  cybersecurity: 'Cybersecurity',
  software_engineering: 'Software Engineering',
  other: 'Other research',
};

const DEADLINE_STATUS_LABELS: Record<DeadlineGroup, string> = {
  open: 'Open',
  unknown: 'Needs verification',
  expired: 'Expired',
  closed: 'Closed / filled',
};

export function PhdPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [topic, setTopic] = useState('');
  const [researchArea, setResearchArea] = useState('');
  const [institution, setInstitution] = useState('');
  const [country, setCountry] = useState('');
  const [deadlineGroup, setDeadlineGroup] = useState<DeadlineGroup>('open');
  const [deadlineWindow, setDeadlineWindow] = useState('');
  const [scoreBand, setScoreBand] = useState<ScoreBand>('');
  const [language, setLanguage] = useState('');
  const [funded, setFunded] = useState('');
  const [savedOnly, setSavedOnly] = useState(false);
  const [unreviewedOnly, setUnreviewedOnly] = useState(false);
  const [letterFilter, setLetterFilter] = useState('all');
  const [sort, setSort] = useState('newest');
  const [page, setPage] = useState(1);

  const params = buildPhdListQuery({
    search,
    topic,
    researchArea,
    institution,
    country,
    deadlineGroup,
    deadlineWindow,
    scoreBand,
    language,
    funded,
    savedOnly,
    unreviewedOnly,
    letterFilter,
    sort: sort as PhdSort,
    page,
  });

  const positions = useQuery<Paginated<PhdPosition>>({
    queryKey: ['phd-positions', params.toString()],
    queryFn: () => api<Paginated<PhdPosition>>(`/phd/positions?${params.toString()}`),
  });

  const sources = useQuery<PhdSourceStatus[]>({
    queryKey: ['phd-sources'],
    queryFn: () => api<PhdSourceStatus[]>('/phd/sources'),
  });

  const realPhdSourceEnabled = (sources.data ?? []).some(
    (source) => !source.simulated && source.enabled && source.configured,
  );
  const onlySimulatedPhdSource =
    !realPhdSourceEnabled && (sources.data ?? []).some((source) => source.simulated && source.enabled);

  const discover = useMutation({
    mutationFn: () => api<PhdDiscoveryResult>('/phd/search', { method: 'POST', body: {} }),
    onSuccess: (result) => {
      const failures = result.sources.filter((source) => source.error);
      toast.success(
        `PhD discovery: ${result.discovered} found, ${result.created} new, ${result.filteredOut} filtered out.`,
      );
      for (const failure of failures) toast.error(`${failure.source}: ${failure.error}`);
      void queryClient.invalidateQueries({ queryKey: ['phd-positions'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const setSource = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      api('/settings', { method: 'PATCH', body: { sources: { [input.id]: { enabled: input.enabled } } } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['phd-sources'] });
      toast.success('PhD source updated.');
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const matchPosition = useMutation({
    mutationFn: (positionId: string) =>
      api<{ matches: PhdMatch[] }>(`/phd/positions/${positionId}/match`, { method: 'POST', body: {} }),
    onSuccess: (result) => {
      const best = [...result.matches].sort((a, b) => b.score - a.score)[0];
      toast.success(best ? `Best profile match: ${best.score}/100.` : 'Profile matching complete.');
      void queryClient.invalidateQueries({ queryKey: ['phd-positions'] });
      void queryClient.invalidateQueries({ queryKey: ['phd-position', best?.position] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const setState = useMutation({
    mutationFn: (input: { id: string; saved?: boolean; reviewed?: boolean }) =>
      api(`/phd/positions/${input.id}/state`, {
        method: 'PATCH',
        body: { saved: input.saved, reviewed: input.reviewed },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['phd-positions'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const items = positions.data?.items ?? [];
  const simulated = items.some((position) => position.simulated) || sources.data?.some((source) => source.simulated && source.enabled);

  return (
    <div className="space-y-5">
      <PageHeader
        title="PhD opportunities"
        description="Doctoral positions matched to your academic background, research experience, and technical skills. Scores are estimated profile matches, not admission probabilities."
        actions={
          <Button variant="primary" onClick={() => discover.mutate()} loading={discover.isPending}>
            Search PhD positions
          </Button>
        }
      />

      <Card title="PhD sources" subtitle="Germany-based positions and explicitly Germany-remote EU positions are included.">
        <div className="space-y-2">
          {(sources.data ?? []).map((source) => (
            <div
              key={source.id}
              className="flex flex-wrap items-start justify-between gap-3 rounded-md bg-slate-950/40 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-slate-200">
                  {source.label}
                  {source.simulated ? <Badge tone="warning">Simulated</Badge> : null}
                  {!source.configured ? <Badge tone="neutral">Not configured</Badge> : null}
                </p>
                <p className="mt-0.5 max-w-3xl text-[11px] leading-relaxed text-slate-500">
                  {source.description}
                </p>
              </div>
              <Button
                size="sm"
                variant={source.enabled ? 'secondary' : 'primary'}
                disabled={!source.configured}
                onClick={() => setSource.mutate({ id: source.id, enabled: !source.enabled })}
              >
                {source.enabled ? 'Disable' : 'Enable'}
              </Button>
            </div>
          ))}
          {sources.error ? <ErrorNote message={errorMessage(sources.error)} /> : null}
        </div>
      </Card>

      {simulated ? (
        <WarningNote>
          Simulated fixtures are included below. They are labelled and use example.org links; they are not real
          PhD advertisements. Configure <code>PHD_FEED_URL</code> or add a permitted source adapter for real listings.
        </WarningNote>
      ) : null}

      <Card padded={false}>
        <form
          className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            setSearch(q);
          }}
        >
          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Search
            <Input
              placeholder="Title, institution, topic"
              value={q}
              onChange={(event) => {
                setQ(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Research topic
            <Input
              placeholder="e.g. knowledge graph, RAG"
              value={topic}
              onChange={(event) => {
                setTopic(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Research area
            <Select
              value={researchArea}
              onChange={(event) => {
                setResearchArea(event.target.value);
                setPage(1);
              }}
            >
              <option value="">All relevant areas</option>
              <option value="ai">Artificial Intelligence</option>
              <option value="cybersecurity">Cybersecurity</option>
              <option value="software_engineering">Software Engineering</option>
              <option value="other">Other relevant research</option>
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Institution
            <Input
              placeholder="University or institute"
              value={institution}
              onChange={(event) => {
                setInstitution(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Country
            <Input
              placeholder="Germany"
              value={country}
              onChange={(event) => {
                setCountry(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Deadline group
            <Select
              value={deadlineGroup}
              onChange={(event) => {
                setDeadlineGroup(event.target.value as DeadlineGroup);
                setDeadlineWindow('');
                setPage(1);
              }}
            >
              <option value="open">Open (deadline verified)</option>
              <option value="unknown">Deadline needs verification</option>
              <option value="expired">Expired</option>
              <option value="closed">Closed / filled</option>
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Closing within
            <Select
              value={deadlineWindow}
              onChange={(event) => {
                setDeadlineWindow(event.target.value);
                setPage(1);
              }}
            >
              <option value="">Any open deadline</option>
              <option value="14">Next 14 days</option>
              <option value="30">Next 30 days</option>
              <option value="60">Next 60 days</option>
              <option value="90">Next 90 days</option>
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Profile match
            <Select
              value={scoreBand}
              onChange={(event) => {
                setScoreBand(event.target.value as ScoreBand);
                setPage(1);
              }}
            >
              <option value="">Any score</option>
              <option value="80-100">80–100%</option>
              <option value="60-79">60–79%</option>
              <option value="below-60">Below 60%</option>
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Language eligibility
            <Select
              value={language}
              onChange={(event) => {
                setLanguage(event.target.value);
                setPage(1);
              }}
            >
              <option value="">Any language status</option>
              <option value="Eligible">Eligible</option>
              <option value="Needs Review">Needs review</option>
              <option value="Excluded">German-mandatory (excluded)</option>
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Funding
            <Select
              value={funded}
              onChange={(event) => {
                setFunded(event.target.value);
                setPage(1);
              }}
            >
              <option value="">Any funding status</option>
              <option value="true">Funding or salary stated</option>
              <option value="false">Funding not stated</option>
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Cover letter
            <Select
              value={letterFilter}
              onChange={(event) => {
                setLetterFilter(event.target.value);
                setPage(1);
              }}
            >
              <option value="all">Any</option>
              <option value="true">Generated</option>
              <option value="false">Not generated</option>
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Sort by
            <Select
              value={sort}
              onChange={(event) => {
                setSort(event.target.value);
                setPage(1);
              }}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="score">Profile match</option>
              <option value="deadline">Application deadline</option>
              <option value="institution">Institution</option>
              <option value="title">Title</option>
            </Select>
          </label>
          <div className="flex flex-wrap items-end gap-3 pb-1 text-xs text-slate-300">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={savedOnly}
                onChange={(event) => {
                  setSavedOnly(event.target.checked);
                  setPage(1);
                }}
                className="h-4 w-4 rounded border-slate-600 bg-slate-900"
              />
              Saved only
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={unreviewedOnly}
                onChange={(event) => {
                  setUnreviewedOnly(event.target.checked);
                  setPage(1);
                }}
                className="h-4 w-4 rounded border-slate-600 bg-slate-900"
              />
              Not reviewed
            </label>
          </div>
          <div className="flex gap-2 sm:col-span-2 lg:col-span-4">
            <Button type="submit" variant="secondary">
              Apply filters
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setQ('');
                setSearch('');
                setTopic('');
                setResearchArea('');
                setInstitution('');
                setCountry('');
                setDeadlineGroup('open');
                setDeadlineWindow('');
                setScoreBand('');
                setLanguage('');
                setFunded('');
                setSavedOnly(false);
                setUnreviewedOnly(false);
                setLetterFilter('all');
                setSort('newest');
                setPage(1);
              }}
            >
              Reset
            </Button>
          </div>
        </form>
      </Card>

      {onlySimulatedPhdSource ? (
        <WarningNote>
          <strong className="font-semibold">No real PhD source is configured.</strong> The positions
          below are simulated fixtures for exercising the workflow, not real advertisements. Set{' '}
          <code className="rounded bg-slate-950/50 px-1">PHD_FEED_URL</code> to a permitted academic
          feed and enable it in sources to see live doctoral vacancies.
        </WarningNote>
      ) : null}

      {deadlineGroup === 'unknown' ? (
        <WarningNote>
          Deadline-verification group: these positions do not state a verifiable deadline. They are
          excluded from open opportunities until the official source confirms that applications
          are still accepted.
        </WarningNote>
      ) : null}

      {positions.isLoading ? <SpinnerPanel label="Loading PhD positions…" /> : null}
      {positions.error ? <ErrorNote message={errorMessage(positions.error)} /> : null}

      {!positions.isLoading && !positions.error && items.length === 0 ? (
        <EmptyState
          title="No PhD positions yet"
          description="Run a PhD search to load positions from the enabled sources."
          action={
            <Button variant="primary" onClick={() => discover.mutate()} loading={discover.isPending}>
              Search PhD positions
            </Button>
          }
        />
      ) : null}

      <div className="space-y-3">
        {items.map((position) => {
          const match = position.bestMatch;
          const deadlineTone: 'success' | 'warning' | 'danger' =
            position.deadlineStatus === 'open'
              ? 'success'
              : position.deadlineStatus === 'unknown'
                ? 'warning'
                : 'danger';
          const countdown = deadlineCountdown(
            position.applicationDeadline,
            position.deadlineStatus,
          );
          return (
            <Card key={position.id} padded={false} className="transition-colors hover:border-slate-700">
              <div className="flex flex-col gap-3 p-4 lg:flex-row lg:items-start">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to={`/phd/${position.id}`}
                      className="text-base font-semibold text-slate-100 hover:text-indigo-200"
                    >
                      {position.title}
                    </Link>
                    {match ? <ScoreBadge score={match.score} /> : <Badge tone="neutral">Unmatched</Badge>}
                    {position.simulated ? <Badge tone="warning">Simulated</Badge> : null}
                    {position.saved ? <Badge tone="success">Saved</Badge> : null}
                    {position.reviewedAt ? <Badge tone="neutral">Reviewed</Badge> : null}
                    {match?.mandatoryMissing.length ? <Badge tone="danger">Mandatory gap</Badge> : null}
                  </div>
                  <p className="mt-1 text-sm text-slate-300">
                    {position.institution}
                    {position.location ? ` · ${position.location}` : ''}
                    {position.country ? ` · ${position.country}` : ''}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <Badge tone="info">{position.sourceLabel || position.source}</Badge>
                    <Badge tone="neutral">
                      {RESEARCH_AREA_LABELS[position.researchArea] ?? 'Other research'}
                    </Badge>
                    <Badge tone="neutral">{titleCase(position.workArrangement)}</Badge>
                    <LanguageDecisionBadge
                      decision={position.languageDecision}
                      confidence={position.languageConfidence}
                    />
                    {position.remoteEligibleFromGermany ? (
                      <Badge tone="success">Remote from Germany</Badge>
                    ) : null}
                    <Badge tone={deadlineTone}>
                      {DEADLINE_STATUS_LABELS[position.deadlineStatus]}
                    </Badge>
                    {position.applicationDeadline ? (
                      <Badge tone="warning">
                        Apply by {formatDate(position.applicationDeadline)}
                        {countdown ? ` · ${countdown}` : ''}
                      </Badge>
                    ) : null}
                    {position.postedAt ? (
                      <span className="text-[11px] text-slate-500">Posted {formatDate(position.postedAt)}</span>
                    ) : (
                      <Badge tone="neutral">Posted date unknown</Badge>
                    )}
                    {position.lastVerifiedAt ? (
                      <span className="text-[11px] text-slate-500">
                        Source checked {formatDate(position.lastVerifiedAt)}
                      </span>
                    ) : null}
                  </div>
                  {position.researchTopic ? (
                    <p className="mt-2 text-xs leading-relaxed text-slate-400">
                      <span className="text-slate-500">Research topic: </span>
                      {position.researchTopic}
                    </p>
                  ) : null}
                  {match?.matchedTopics.length ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      <span className="text-[11px] text-slate-500">Topic match:</span>
                      {match.matchedTopics.slice(0, 5).map((topicName) => (
                        <Badge key={topicName} tone="success">
                          {topicName}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  {match?.matchedSkills.length ? (
                    <div className="mt-1 flex flex-wrap gap-1">
                      <span className="text-[11px] text-slate-500">Skills:</span>
                      {match.matchedSkills.slice(0, 6).map((skill) => (
                        <Badge key={skill} tone="neutral">
                          {skill}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-2 lg:flex-col lg:items-stretch">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => matchPosition.mutate(position.id)}
                    loading={matchPosition.isPending && matchPosition.variables === position.id}
                  >
                    {match ? 'Re-evaluate' : 'Evaluate profile'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setState.mutate({ id: position.id, saved: !position.saved })}
                  >
                    {position.saved ? 'Unsave' : 'Save'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setState.mutate({ id: position.id, reviewed: !position.reviewedAt })}
                  >
                    {position.reviewedAt ? 'Mark unreviewed' : 'Mark reviewed'}
                  </Button>
                  <Link to={`/phd/${position.id}`}>
                    <Button size="sm" variant="primary" className="w-full">
                      View details
                    </Button>
                  </Link>
                  <a href={position.url} target="_blank" rel="noreferrer noopener">
                    <Button size="sm" variant="ghost" className="w-full">
                      Original advert ↗
                    </Button>
                  </a>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      {positions.data && positions.data.total > 0 ? (
        <Pagination
          page={positions.data.page}
          pages={positions.data.pages}
          total={positions.data.total}
          onPage={setPage}
        />
      ) : null}
    </div>
  );
}
