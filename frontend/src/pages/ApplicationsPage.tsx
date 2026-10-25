import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, apiBase, errorMessage } from '../api/client';
import type { Application, ApplicationListResponse, JobMatch, ProfileKind } from '../api/types';
import { formatDate, formatDateTime, statusTone, titleCase } from '../lib/format';
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

const STATUSES = [
  'DISCOVERED',
  'MATCHED',
  'READY_FOR_REVIEW',
  'APPROVED',
  'SUBMITTING',
  'SUBMITTED',
  'FAILED',
  'NEEDS_MANUAL_ACTION',
  'WITHDRAWN',
] as const;

export function ApplicationsPage() {
  const [status, setStatus] = useState('');
  const [employer, setEmployer] = useState('');
  const [searchEmployer, setSearchEmployer] = useState('');
  const [profileKind, setProfileKind] = useState<ProfileKind | ''>('');
  const [ageEligibility, setAgeEligibility] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [searchTitle, setSearchTitle] = useState('');
  const [languageDecision, setLanguageDecision] = useState('');
  const [postedFrom, setPostedFrom] = useState('');
  const [postedTo, setPostedTo] = useState('');
  const [page, setPage] = useState(1);

  const params = new URLSearchParams({ page: String(page), limit: '20' });
  if (status) params.set('status', status);
  if (searchEmployer.trim()) params.set('employer', searchEmployer.trim());
  if (searchTitle.trim()) params.set('jobTitle', searchTitle.trim());
  if (profileKind) params.set('profileKind', profileKind);
  if (ageEligibility) params.set('ageEligibility', ageEligibility);
  if (languageDecision) params.set('languageDecision', languageDecision);
  if (postedFrom) params.set('from', postedFrom);
  if (postedTo) params.set('to', postedTo);

  const applications = useQuery<ApplicationListResponse>({
    queryKey: ['applications', params.toString()],
    queryFn: () => api<ApplicationListResponse>(`/applications?${params.toString()}`),
  });

  const items = applications.data?.items ?? [];
  const exportParams = new URLSearchParams();
  if (status) exportParams.set('status', status);
  if (searchEmployer.trim()) exportParams.set('employer', searchEmployer.trim());
  if (searchTitle.trim()) exportParams.set('jobTitle', searchTitle.trim());
  if (profileKind) exportParams.set('profileKind', profileKind);
  if (ageEligibility) exportParams.set('ageEligibility', ageEligibility);
  if (languageDecision) exportParams.set('languageDecision', languageDecision);
  if (postedFrom) exportParams.set('from', postedFrom);
  if (postedTo) exportParams.set('to', postedTo);
  const exportUrl = `${apiBase()}/applications/export.csv?${exportParams.toString()}`;

  const matchScore = (application: Application): number | null => {
    const match = application.match;
    if (!match || typeof match === 'string') return null;
    return (match as JobMatch).score ?? null;
  };

  const profileLabel = (application: Application): string => {
    if (typeof application.profile === 'string') return '—';
    return application.profile.label;
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Application tracker"
        description="Every application records its approval, document versions and submission evidence. Only confirmed submissions count as submitted."
        actions={
          <a href={exportUrl}>
            <Button variant="secondary">Export CSV</Button>
          </a>
        }
      />

      <Card padded={false}>
        <form
          className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            setSearchEmployer(employer);
            setSearchTitle(jobTitle);
          }}
        >
          <Input
            placeholder="Filter by employer…"
            value={employer}
            onChange={(event) => setEmployer(event.target.value)}
            aria-label="Filter by employer"
          />
          <Input
            placeholder="Filter by job title…"
            value={jobTitle}
            onChange={(event) => setJobTitle(event.target.value)}
            aria-label="Filter by job title"
          />
          <Select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
            aria-label="Filter by status"
          >
            <option value="">All statuses</option>
            {STATUSES.map((option) => (
              <option key={option} value={option}>
                {titleCase(option)}
              </option>
            ))}
          </Select>
          <Select
            value={profileKind}
            onChange={(event) => {
              setProfileKind(event.target.value as ProfileKind | '');
              setPage(1);
            }}
            aria-label="Filter by profile"
          >
            <option value="">All profiles</option>
            <option value="full_stack">Full Stack</option>
            <option value="ai_engineer">AI Engineer</option>
            <option value="devops_cloud">DevOps / Cloud</option>
          </Select>
          <Select
            value={ageEligibility}
            onChange={(event) => {
              setAgeEligibility(event.target.value);
              setPage(1);
            }}
            aria-label="Filter by posting age eligibility"
          >
            <option value="">Any posting age</option>
            <option value="Eligible">Age eligible</option>
            <option value="Too Recent">Too recent</option>
            <option value="Unknown">Date unknown</option>
            <option value="Expired">Expired</option>
          </Select>
          <Select
            value={languageDecision}
            onChange={(event) => {
              setLanguageDecision(event.target.value);
              setPage(1);
            }}
            aria-label="Filter by language requirement"
          >
            <option value="">Any language result</option>
            <option value="Eligible">English-language eligible</option>
            <option value="Needs Review">Language needs review</option>
            <option value="Excluded">Language excluded</option>
          </Select>
          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Posted from
            <Input
              type="date"
              value={postedFrom}
              onChange={(event) => {
                setPostedFrom(event.target.value);
                setPage(1);
              }}
              aria-label="Filter by earliest posting date"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            Posted to
            <Input
              type="date"
              value={postedTo}
              onChange={(event) => {
                setPostedTo(event.target.value);
                setPage(1);
              }}
              aria-label="Filter by latest posting date"
            />
          </label>
          <div className="flex items-end">
            <Button type="submit">Apply filters</Button>
          </div>
        </form>
      </Card>

      {applications.isLoading ? <SpinnerPanel label="Loading applications…" /> : null}
      {applications.error ? <ErrorNote message={errorMessage(applications.error)} /> : null}

      {!applications.isLoading && !applications.error && items.length === 0 ? (
        <EmptyState
          title="No applications yet"
          description="Open a job, evaluate it against your profiles and prepare an application. Nothing is submitted automatically."
          action={
            <Link to="/jobs">
              <Button variant="primary">Browse jobs</Button>
            </Link>
          }
        />
      ) : null}

      {items.length > 0 ? (
        <Card padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="border-b border-slate-800 text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Role</th>
                  <th className="px-4 py-2.5 font-medium">Profile</th>
                  <th className="px-4 py-2.5 font-medium">Score</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Submission</th>
                  <th className="px-4 py-2.5 font-medium">Updated</th>
                  <th className="px-4 py-2.5 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {items.map((application) => (
                  <tr key={application.id} className="hover:bg-slate-900/40">
                    <td className="px-4 py-3">
                      <Link
                        to={`/applications/${application.id}`}
                        className="font-medium text-slate-100 hover:text-indigo-200"
                      >
                        {application.jobTitle}
                      </Link>
                      <p className="text-xs text-slate-400">{application.employer}</p>
                      <p className="text-[11px] text-slate-500">
                        {application.source} · v{application.version}
                        {application.postedAt ? ` · posted ${formatDate(application.postedAt)}` : ''}
                      </p>
                      <Badge
                        tone={
                          application.ageEligibility === 'Eligible'
                            ? 'success'
                            : application.ageEligibility === 'Too Recent'
                              ? 'warning'
                              : application.ageEligibility === 'Expired'
                                ? 'danger'
                                : 'neutral'
                        }
                        className="mt-1"
                      >
                        {application.ageEligibility}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-300">{profileLabel(application)}</td>
                    <td className="px-4 py-3">
                      <ScoreBadge score={matchScore(application)} />
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={statusTone(application.status)}>{titleCase(application.status)}</Badge>
                      {application.workflow?.status ? (
                        <p className="mt-1 text-[10px] text-slate-400">
                          {titleCase(application.workflow.status)}
                        </p>
                      ) : null}
                      {application.approval?.approvedAt ? (
                        <p className="mt-1 text-[10px] text-slate-500">
                          approved v{application.approval.applicationVersion} ·{' '}
                          {formatDate(application.approval.approvedAt)}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {application.submission?.confirmed ? (
                        <div className="space-y-1">
                          <Badge tone="success">Confirmed</Badge>
                          {application.submission.simulated ? <Badge tone="warning">Simulated</Badge> : null}
                          <p className="text-[10px] text-slate-500">
                            {application.submission.adapter || 'adapter not recorded'}
                          </p>
                        </div>
                      ) : application.status === 'NEEDS_MANUAL_ACTION' ? (
                        <Badge tone="warning">Manual action</Badge>
                      ) : (
                        <span className="text-slate-500">Not submitted</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-400">
                      {formatDateTime(application.updatedAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link to={`/applications/${application.id}`}>
                        <Button size="sm" variant="ghost">
                          Open →
                        </Button>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {applications.data && applications.data.total > 0 ? (
        <Pagination
          page={applications.data.page}
          pages={applications.data.pages}
          total={applications.data.total}
          onPage={setPage}
        />
      ) : null}
    </div>
  );
}
