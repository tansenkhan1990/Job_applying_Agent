import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import type { CandidateProfile, ProfileExtractionResponse } from '../api/types';
import { formatDate, titleCase } from '../lib/format';
import { useToast } from '../components/Toast';
import { Modal } from '../components/Modal';
import {
  Badge,
  Button,
  Card,
  CheckboxPill,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  PageHeader,
  Select,
  SpinnerPanel,
  Textarea,
  Toggle,
  WarningNote,
} from '../components/ui';

interface DraftShape {
  name: string;
  targetTitles: string;
  skills: string;
  experienceSummary: string;
  yearsExperience: string;
  location: string;
  languages: string;
  countries: string;
  remote: boolean;
  hybrid: boolean;
  onsite: boolean;
}

const emptyDraft: DraftShape = {
  name: '',
  targetTitles: '',
  skills: '',
  experienceSummary: '',
  yearsExperience: '',
  location: '',
  languages: '',
  countries: '',
  remote: true,
  hybrid: true,
  onsite: true,
};

function toDraft(profile: CandidateProfile): DraftShape {
  return {
    name: profile.name ?? '',
    targetTitles: (profile.targetTitles ?? []).join(', '),
    skills: (profile.skills ?? []).join(', '),
    experienceSummary: profile.experienceSummary ?? '',
    yearsExperience: profile.yearsExperience === null ? '' : String(profile.yearsExperience),
    location: profile.location ?? '',
    languages: (profile.languages ?? []).map((item) => `${item.language}:${item.level}`).join(', '),
    countries: (profile.workPreferences?.countries ?? []).join(', '),
    remote: profile.workPreferences?.remote ?? true,
    hybrid: profile.workPreferences?.hybrid ?? true,
    onsite: profile.workPreferences?.onsite ?? true,
  };
}

const splitCsv = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

export function ProfilesPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<CandidateProfile | null>(null);
  const [draft, setDraft] = useState<DraftShape>(emptyDraft);
  const [warnings, setWarnings] = useState<string[]>([]);

  const profiles = useQuery<CandidateProfile[]>({
    queryKey: ['profiles'],
    queryFn: () => api<CandidateProfile[]>('/profiles'),
  });

  useEffect(() => {
    if (editing) setDraft(toDraft(editing));
  }, [editing]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['profiles'] });
    void queryClient.invalidateQueries({ queryKey: ['settings'] });
  };

  const save = useMutation({
    mutationFn: (input: { id: string; payload: Record<string, unknown> }) =>
      api<CandidateProfile>(`/profiles/${input.id}`, { method: 'PATCH', body: input.payload }),
    onSuccess: () => {
      toast.success('Profile saved.');
      setEditing(null);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const setStatus = useMutation({
    mutationFn: (input: { id: string; status: 'draft' | 'approved' }) =>
      api<CandidateProfile>(`/profiles/${input.id}`, {
        method: 'PATCH',
        body: { status: input.status },
      }),
    onSuccess: (_data, variables) => {
      toast.success(variables.status === 'approved' ? 'Profile approved.' : 'Profile moved back to draft.');
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const extract = useMutation({
    mutationFn: (id: string) =>
      api<ProfileExtractionResponse>(`/profiles/${id}/extract`, { method: 'POST', body: {} }),
    onSuccess: (result) => {
      setWarnings(result.warnings);
      toast.success(
        `Profile extracted with ${result.source === 'ai' ? 'the selected AI model' : 'rule-based fallback'}. Review and approve it.`,
      );
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const profilesList = profiles.data ?? [];
  const draftCount = useMemo(
    () => profilesList.filter((profile) => profile.status === 'draft').length,
    [profilesList],
  );

  if (profiles.isLoading) return <SpinnerPanel label="Loading profiles…" />;
  if (profiles.error) return <ErrorNote message={errorMessage(profiles.error)} />;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Candidate profiles"
        description="Three independent career paths. Each has its own target titles, skills, CV and cover letter. Approve a profile before preparing applications."
        actions={
          <Badge tone={draftCount > 0 ? 'warning' : 'success'}>
            {draftCount > 0 ? `${draftCount} awaiting approval` : 'All approved'}
          </Badge>
        }
      />

      {warnings.length > 0 ? (
        <WarningNote>
          <p className="font-medium">Extraction notes</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </WarningNote>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-3">
        {profilesList.map((profile) => (
          <Card
            key={profile.id}
            title={
              <span className="flex flex-wrap items-center gap-2">
                {profile.label}
                <Badge tone={profile.status === 'approved' ? 'success' : 'warning'}>
                  {profile.status === 'approved' ? 'Approved' : 'Draft'}
                </Badge>
              </span>
            }
            subtitle={
              <span>
                {profile.name || 'Candidate name not set'} · {titleCase(profile.extractionSource)}
                {profile.extractedAt ? ` · ${formatDate(profile.extractedAt)}` : ''}
              </span>
            }
            action={
              <Button size="sm" variant="ghost" onClick={() => setEditing(profile)}>
                Edit
              </Button>
            }
          >
            <div className="space-y-3">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Documents</p>
                <ul className="mt-1 space-y-1 text-xs">
                  <li className="flex items-center justify-between gap-2">
                    <span className="truncate text-slate-300">
                      CV: {profile.cvDocumentInfo?.filename ?? 'not mapped'}
                    </span>
                    {profile.cvDocumentInfo ? (
                      <Badge tone={profile.cvDocumentInfo.status === 'processed' ? 'success' : 'warning'}>
                        {profile.cvDocumentInfo.status}
                      </Badge>
                    ) : (
                      <Badge tone="danger">missing</Badge>
                    )}
                  </li>
                  <li className="flex items-center justify-between gap-2">
                    <span className="truncate text-slate-300">
                      Cover letter: {profile.coverLetterDocumentInfo?.filename ?? 'not mapped'}
                    </span>
                    {profile.coverLetterDocumentInfo ? (
                      <Badge tone="success">mapped</Badge>
                    ) : (
                      <Badge tone="neutral">optional</Badge>
                    )}
                  </li>
                </ul>
              </div>

              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Target titles</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {profile.targetTitles.slice(0, 8).map((title) => (
                    <Badge key={title} tone="info">
                      {title}
                    </Badge>
                  ))}
                </div>
              </div>

              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Skills</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {profile.skills.slice(0, 14).map((skill) => (
                    <Badge key={skill} tone="neutral">
                      {skill}
                    </Badge>
                  ))}
                  {profile.skills.length > 14 ? (
                    <Badge tone="neutral">+{profile.skills.length - 14}</Badge>
                  ) : null}
                </div>
              </div>

              {profile.experienceSummary ? (
                <p className="line-clamp-4 text-xs leading-relaxed text-slate-400">
                  {profile.experienceSummary}
                </p>
              ) : (
                <p className="text-xs text-slate-500">
                  No extracted summary yet. Map a CV and use “Extract from CV”.
                </p>
              )}

              <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                <Badge tone="neutral">{profile.yearsExperience ?? '?'} years</Badge>
                {profile.languages.map((language) => (
                  <Badge key={language.language} tone="neutral">
                    {language.language}: {language.level}
                  </Badge>
                ))}
              </div>

              <div className="flex flex-wrap gap-2 border-t border-slate-800 pt-3">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => extract.mutate(profile.id)}
                  loading={extract.isPending && extract.variables === profile.id}
                  disabled={!profile.cvDocument}
                >
                  Extract from CV
                </Button>
                <Button
                  size="sm"
                  variant={profile.status === 'approved' ? 'ghost' : 'success'}
                  onClick={() =>
                    setStatus.mutate({
                      id: profile.id,
                      status: profile.status === 'approved' ? 'draft' : 'approved',
                    })
                  }
                  loading={setStatus.isPending && setStatus.variables?.id === profile.id}
                >
                  {profile.status === 'approved' ? 'Unapprove' : 'Approve profile'}
                </Button>
                <Link to="/documents" className="ml-auto self-center text-[11px] text-indigo-300">
                  Documents →
                </Link>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {profilesList.length === 0 ? (
        <EmptyState title="No profiles found" description="Profiles are seeded automatically when the backend starts." />
      ) : null}

      {draftCount > 0 ? (
        <WarningNote>
          Draft profiles cannot be used to prepare applications. Extract or edit the profile, verify its
          claims against the CV, then approve it.
        </WarningNote>
      ) : null}

      <Modal
        open={Boolean(editing)}
        title={`Edit ${editing?.label ?? 'profile'}`}
        onClose={() => setEditing(null)}
        wide
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={save.isPending}
              onClick={() => {
                if (!editing) return;
                const years = Number.parseFloat(draft.yearsExperience);
                save.mutate({
                  id: editing.id,
                  payload: {
                    name: draft.name,
                    targetTitles: splitCsv(draft.targetTitles),
                    skills: splitCsv(draft.skills),
                    experienceSummary: draft.experienceSummary,
                    yearsExperience: Number.isFinite(years) ? years : null,
                    location: draft.location,
                    languages: splitCsv(draft.languages).map((entry) => {
                      const [language, ...rest] = entry.split(':');
                      return {
                        language: (language ?? '').trim(),
                        level: rest.join(':').trim() || 'unknown',
                      };
                    }),
                    workPreferences: {
                      countries: splitCsv(draft.countries),
                      remote: draft.remote,
                      hybrid: draft.hybrid,
                      onsite: draft.onsite,
                    },
                  },
                });
              }}
            >
              Save profile
            </Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Candidate name">
            <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </Field>
          <Field label="Location">
            <Input
              value={draft.location}
              onChange={(event) => setDraft({ ...draft, location: event.target.value })}
              placeholder="Berlin, Germany"
            />
          </Field>
          <Field label="Target titles" hint="Comma-separated" className="sm:col-span-2">
            <Input
              value={draft.targetTitles}
              onChange={(event) => setDraft({ ...draft, targetTitles: event.target.value })}
            />
          </Field>
          <Field label="Skills" hint="Comma-separated. Only include verified skills." className="sm:col-span-2">
            <Textarea
              value={draft.skills}
              rows={3}
              onChange={(event) => setDraft({ ...draft, skills: event.target.value })}
            />
          </Field>
          <Field label="Experience summary" className="sm:col-span-2">
            <Textarea
              value={draft.experienceSummary}
              rows={4}
              onChange={(event) => setDraft({ ...draft, experienceSummary: event.target.value })}
            />
          </Field>
          <Field label="Years of experience" hint="Leave empty if the CV does not support a number.">
            <Input
              type="number"
              min={0}
              max={60}
              step="0.5"
              value={draft.yearsExperience}
              onChange={(event) => setDraft({ ...draft, yearsExperience: event.target.value })}
            />
          </Field>
          <Field label="Languages" hint="Format: English:C2, German:B2">
            <Input value={draft.languages} onChange={(event) => setDraft({ ...draft, languages: event.target.value })} />
          </Field>
          <Field label="Target countries" hint="Comma-separated" className="sm:col-span-2">
            <Input
              value={draft.countries}
              onChange={(event) => setDraft({ ...draft, countries: event.target.value })}
            />
          </Field>
          <div className="space-y-2 sm:col-span-2">
            <p className="text-xs font-medium text-slate-300">Work arrangements</p>
            <div className="flex flex-wrap gap-3">
              <Toggle checked={draft.remote} onChange={(value) => setDraft({ ...draft, remote: value })} label="Remote" />
              <Toggle checked={draft.hybrid} onChange={(value) => setDraft({ ...draft, hybrid: value })} label="Hybrid" />
              <Toggle checked={draft.onsite} onChange={(value) => setDraft({ ...draft, onsite: value })} label="On-site" />
            </div>
          </div>
        </div>
        <div className="mt-4">
          <WarningNote>
            Never infer visa status, salary expectations, clearance or other legal declarations from a CV.
            Leave uncertain facts unset.
          </WarningNote>
        </div>
      </Modal>
    </div>
  );
}
