import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../api/client';
import type {
  AiTestResult,
  AppSettings,
  OpenRouterModel,
  SettingsResponse,
} from '../api/types';
import { formatDate, titleCase } from '../lib/format';
import { useToast } from '../components/Toast';
import {
  Badge,
  Button,
  Card,
  CheckboxPill,
  ErrorNote,
  Field,
  Input,
  PageHeader,
  Select,
  SpinnerPanel,
  Toggle,
  WarningNote,
} from '../components/ui';

function CsvInput({
  initial,
  onChange,
  placeholder,
}: {
  initial: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState(initial.join(', '));
  return (
    <Input
      value={text}
      placeholder={placeholder}
      onChange={(event) => {
        setText(event.target.value);
        onChange(
          event.target.value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
        );
      }}
    />
  );
}

function toNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const WORK_ARRANGEMENTS = [
  { value: 'remote', label: 'Remote' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'onsite', label: 'On-site' },
] as const;

const PROFILE_KINDS = [
  { value: 'full_stack', label: 'Full Stack' },
  { value: 'ai_engineer', label: 'AI Engineer' },
  { value: 'devops_cloud', label: 'DevOps / Cloud' },
] as const;

const SENIORITY = [
  { value: 'junior', label: 'Junior' },
  { value: 'mid', label: 'Mid' },
  { value: 'senior', label: 'Senior' },
  { value: 'lead', label: 'Lead' },
] as const;

export function SettingsPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [loadModels, setLoadModels] = useState(false);
  const [testResult, setTestResult] = useState<AiTestResult | null>(null);

  const settings = useQuery<SettingsResponse>({
    queryKey: ['settings'],
    queryFn: () => api<SettingsResponse>('/settings'),
  });

  useEffect(() => {
    if (settings.data && !draft) {
      setDraft(structuredClone(settings.data.settings));
    }
  }, [settings.data, draft]);

  const models = useQuery<{ configured: boolean; models: OpenRouterModel[]; note: string }>({
    queryKey: ['ai-models'],
    queryFn: () =>
      api<{ configured: boolean; models: OpenRouterModel[]; note: string }>('/ai/models?force=true'),
    enabled: loadModels && Boolean(settings.data?.ai.configured),
    staleTime: 5 * 60_000,
  });

  const save = useMutation({
    mutationFn: (payload: AppSettings) =>
      api<SettingsResponse>('/settings', { method: 'PATCH', body: payload }),
    onSuccess: (response) => {
      setDraft(response.settings);
      setTestResult(null);
      toast.success('Settings saved.');
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const test = useMutation({
    mutationFn: () =>
      api<AiTestResult>('/ai/test', {
        method: 'POST',
        body: { model: draft?.ai.model ?? '' },
      }),
    onSuccess: (result) => {
      setTestResult(result);
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const selectedModel = useMemo(
    () => models.data?.models.find((model) => model.id === draft?.ai.model) ?? null,
    [models.data, draft?.ai.model],
  );

  if (settings.isLoading || !draft) return <SpinnerPanel label="Loading settings…" />;
  if (settings.error) return <ErrorNote message={errorMessage(settings.error)} />;
  if (!settings.data) return null;

  const ai = settings.data.ai;
  const sources = settings.data.sources;

  const update = (patch: Partial<AppSettings>) => setDraft({ ...draft, ...patch });
  const updateSearch = (patch: Partial<AppSettings['search']>) =>
    update({ search: { ...draft.search, ...patch } });
  const updateSchedule = (patch: Partial<AppSettings['schedule']>) =>
    update({ schedule: { ...draft.schedule, ...patch } });
  const updateAi = (patch: Partial<AppSettings['ai']>) => update({ ai: { ...draft.ai, ...patch } });

  const toggleSource = (id: string, enabled: boolean) => {
    setDraft({
      ...draft,
      sources: { ...draft.sources, [id]: { enabled } },
      search: { ...draft.search, sources: { ...draft.search.sources, [id]: enabled } },
    });
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Settings"
        description="Non-secret configuration is stored in MongoDB. The OpenRouter API key stays exclusively in the backend environment."
        actions={
          <Button variant="primary" onClick={() => save.mutate(draft)} loading={save.isPending}>
            Save settings
          </Button>
        }
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <Card
          title="OpenRouter model"
          subtitle="Model changes take effect without rebuilding the frontend"
          action={
            <Badge tone={ai.configured ? 'success' : 'warning'}>
              {ai.configured ? 'API key configured' : 'No API key'}
            </Badge>
          }
        >
          <div className="space-y-3">
            <Field
              label="Model ID"
              hint={
                ai.configured
                  ? 'Load the catalog or type any OpenRouter model ID manually.'
                  : 'Add OPENROUTER_API_KEY to .env and restart the backend to enable AI features.'
              }
            >
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  list="openrouter-model-options"
                  value={draft.ai.model}
                  onChange={(event) => updateAi({ model: event.target.value })}
                  placeholder="e.g. google/gemini-2.5-flash"
                />
                <datalist id="openrouter-model-options">
                  {(models.data?.models ?? []).map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                      {model.contextLength ? ` · ${model.contextLength.toLocaleString()} ctx` : ''}
                    </option>
                  ))}
                </datalist>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setLoadModels(true);
                    void models.refetch();
                  }}
                  loading={models.isFetching}
                  disabled={!ai.configured}
                >
                  Load models
                </Button>
              </div>
            </Field>

            {models.data?.note ? <p className="text-[11px] text-amber-300">{models.data.note}</p> : null}
            {models.data ? (
              <p className="text-[11px] text-slate-500">
                {models.data.models.length} model(s) available from OpenRouter.
              </p>
            ) : null}

            {selectedModel ? (
              <div className="rounded-lg bg-slate-950/40 p-3 text-[11px] leading-relaxed text-slate-400">
                <p className="text-slate-200">{selectedModel.name}</p>
                <p>
                  Context: {selectedModel.contextLength?.toLocaleString() ?? 'unknown'} tokens · Supported:
                  {selectedModel.supportedParameters.length > 0
                    ? ` ${selectedModel.supportedParameters.slice(0, 10).join(', ')}`
                    : ' not reported'}
                </p>
                {selectedModel.pricing?.prompt ? (
                  <p>
                    Pricing (per token): prompt {selectedModel.pricing.prompt} · completion{' '}
                    {selectedModel.pricing.completion}
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Temperature" hint="0 = deterministic, 1 = creative. Matching uses low values.">
                <Input
                  type="number"
                  min={0}
                  max={1}
                  step="0.05"
                  value={draft.ai.temperature}
                  onChange={(event) => updateAi({ temperature: toNumber(event.target.value, 0.2) })}
                />
              </Field>
              <Field label="Maximum output tokens" hint={`Hard cap: ${ai.limits.maxOutputTokens}`}>
                <Input
                  type="number"
                  min={256}
                  max={8000}
                  step="100"
                  value={draft.ai.maxOutputTokens}
                  onChange={(event) => updateAi({ maxOutputTokens: toNumber(event.target.value, 2000) })}
                />
              </Field>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                onClick={() => test.mutate()}
                loading={test.isPending}
                disabled={!ai.configured || !draft.ai.model.trim()}
              >
                Test connection
              </Button>
              {testResult ? (
                <Badge tone={testResult.ok ? 'success' : 'danger'}>
                  {testResult.ok ? testResult.message : `${testResult.code ?? 'error'}: ${testResult.message}`}
                </Badge>
              ) : null}
            </div>

            <p className="text-[11px] text-slate-500">
              Timeout {Math.round(ai.limits.timeoutMs / 1000)}s · {ai.limits.maxRetries} retries · input limit{' '}
              {ai.limits.maxInputChars.toLocaleString()} characters. Base URL: {ai.baseUrl}
            </p>
          </div>
        </Card>

        <Card title="Job sources" subtitle="Only enabled and configured adapters run during discovery">
          <div className="space-y-3">
            {sources.map((source) => {
              const enabled = draft.sources[source.id]?.enabled ?? false;
              return (
                <div key={source.id} className="rounded-lg border border-slate-800 bg-slate-950/30 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="flex items-center gap-2 text-sm font-medium text-slate-100">
                        {source.label}
                        <Badge tone={source.configured ? 'success' : 'danger'}>
                          {source.configured ? 'ready' : 'not configured'}
                        </Badge>
                        {source.id === 'mock' ? <Badge tone="warning">test data</Badge> : null}
                      </p>
                      <p className="mt-1 text-xs leading-relaxed text-slate-400">{source.description}</p>
                    </div>
                    <Toggle
                      checked={enabled}
                      onChange={(value) => toggleSource(source.id, value)}
                      label=""
                      disabled={!source.configured}
                    />
                  </div>
                </div>
              );
            })}
            <p className="text-[11px] leading-relaxed text-slate-500">
              Arbeitnow and Remotive are public APIs with documented access. Requests are bounded; credentials
              are not required. The mock source is fictional and exists for end-to-end local testing. No CAPTCHAs
              or access controls are bypassed.
            </p>
          </div>
        </Card>

        <Card title="Search preferences" subtitle="Deterministic filters applied before any AI evaluation">
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Countries" hint="Comma-separated. Default: Germany.">
                <CsvInput
                  initial={draft.search.countries}
                  onChange={(countries) => updateSearch({ countries })}
                />
              </Field>
              <Field label="Remote scope" hint="Comma-separated. Used for remote eligibility.">
                <CsvInput
                  initial={draft.search.remoteScope}
                  onChange={(remoteScope) => updateSearch({ remoteScope })}
                />
              </Field>
              <Field label="Search languages">
                <CsvInput
                  initial={draft.search.languages}
                  onChange={(languages) => updateSearch({ languages })}
                />
              </Field>
              <Field label="Minimum relevance score" hint="Threshold used by the overview's high-match counter.">
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={draft.search.minRelevanceScore}
                  onChange={(event) =>
                    updateSearch({ minRelevanceScore: toNumber(event.target.value, 80) })
                  }
                />
              </Field>
              <Field label="Maximum jobs per run" hint="Capped at 200; shared across sources.">
                <Input
                  type="number"
                  min={1}
                  max={200}
                  value={draft.search.maxJobsPerRun}
                  onChange={(event) => updateSearch({ maxJobsPerRun: toNumber(event.target.value, 40) })}
                />
              </Field>
              <Field
                label="Maximum posting age (calendar months)"
                hint="Hard rule: professional jobs older than three calendar months never appear in normal results. The value is fixed and clamped by the backend."
              >
                <Input type="number" min={3} max={3} value={3} readOnly />
              </Field>
              <Field
                label="Hard retention cap (days)"
                hint="Absolute maximum posting age stored in the database (default 365). The calendar-month window above is applied first."
              >
                <Input
                  type="number"
                  min={30}
                  max={3650}
                  value={draft.search.freshnessDays}
                  onChange={(event) =>
                    updateSearch({ freshnessDays: toNumber(event.target.value, 365) })
                  }
                />
              </Field>
            </div>

            <div>
              <p className="mb-1.5 text-xs font-medium text-slate-300">Work arrangements</p>
              <div className="flex flex-wrap gap-1.5">
                {WORK_ARRANGEMENTS.map((option) => (
                  <CheckboxPill
                    key={option.value}
                    label={option.label}
                    checked={draft.search.workArrangements.includes(option.value)}
                    onChange={(checked) =>
                      updateSearch({
                        workArrangements: checked
                          ? [...draft.search.workArrangements, option.value]
                          : draft.search.workArrangements.filter((item) => item !== option.value),
                      })
                    }
                  />
                ))}
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-xs font-medium text-slate-300">Career profiles to evaluate</p>
              <div className="flex flex-wrap gap-1.5">
                {PROFILE_KINDS.map((option) => (
                  <CheckboxPill
                    key={option.value}
                    label={option.label}
                    checked={draft.search.profileKinds.includes(option.value)}
                    onChange={(checked) =>
                      updateSearch({
                        profileKinds: checked
                          ? [...draft.search.profileKinds, option.value]
                          : draft.search.profileKinds.filter((item) => item !== option.value),
                      })
                    }
                  />
                ))}
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-xs font-medium text-slate-300">Seniority</p>
              <div className="flex flex-wrap gap-1.5">
                {SENIORITY.map((option) => (
                  <CheckboxPill
                    key={option.value}
                    label={option.label}
                    checked={draft.search.seniority.includes(option.value)}
                    onChange={(checked) =>
                      updateSearch({
                        seniority: checked
                          ? [...draft.search.seniority, option.value]
                          : draft.search.seniority.filter((item) => item !== option.value),
                      })
                    }
                  />
                ))}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Include keywords" hint="Optional. Leave empty for broad discovery.">
                <CsvInput
                  initial={draft.search.includeKeywords}
                  onChange={(includeKeywords) => updateSearch({ includeKeywords })}
                  placeholder="typescript, llm"
                />
              </Field>
              <Field label="Exclude keywords">
                <CsvInput
                  initial={draft.search.excludeKeywords}
                  onChange={(excludeKeywords) => updateSearch({ excludeKeywords })}
                  placeholder="unpaid, commission only"
                />
              </Field>
            </div>

            <Field
              label="Additional job titles"
              hint="Added to the target titles from your profiles for discovery relevance."
            >
              <CsvInput
                initial={draft.search.targetTitles}
                onChange={(targetTitles) => updateSearch({ targetTitles })}
                placeholder="AI Engineer, LLM Engineer, Platform Engineer"
              />
            </Field>

            <div className="space-y-2 rounded-lg bg-slate-950/30 p-3">
              <Toggle
                checked={draft.search.excludeInternships}
                onChange={(value) => updateSearch({ excludeInternships: value })}
                label="Exclude internships and working-student roles"
              />
              <Toggle
                checked={draft.search.excludeUnpaid}
                onChange={(value) => updateSearch({ excludeUnpaid: value })}
                label="Exclude unpaid and commission-only roles"
              />
              <Toggle
                checked={draft.search.excludeGermanRequired}
                onChange={(value) => updateSearch({ excludeGermanRequired: value })}
                label="Only keep jobs where German is not required or optional"
                hint="Excludes postings that mandate German. English-friendly, German-optional and unclassified postings stay. Turn off to store every vacancy."
              />
            </div>

            <WarningNote>
              A vacancy is never excluded merely because it mentions German. The posting is filtered only when its
              text explicitly requires German; postings that say German is optional or not required are kept. Language
              detection is heuristic, so review the badge on each job. Normal results additionally require a verified
              original posting date inside the three-calendar-month window.
            </WarningNote>
          </div>
        </Card>

        <div className="space-y-4">
          <Card title="Scheduling" subtitle="Disabled until you explicitly enable it">
            <div className="space-y-3">
              <Toggle
                checked={draft.schedule.enabled}
                onChange={(value) => updateSchedule({ enabled: value })}
                label="Enable scheduled discovery"
                hint="Runs at most once per interval, with a MongoDB lock to prevent overlaps."
              />
              <Field label="Interval (minutes)">
                <Input
                  type="number"
                  min={15}
                  max={1440}
                  value={draft.schedule.intervalMinutes}
                  onChange={(event) => updateSchedule({ intervalMinutes: toNumber(event.target.value, 360) })}
                />
              </Field>
              <Toggle
                checked={draft.schedule.runOnStartup}
                onChange={(value) => updateSchedule({ runOnStartup: value })}
                label="Run once at worker startup"
                hint="Only applies when the optional worker container is running."
              />
              <p className="text-[11px] text-slate-500">
                The worker container uses a persisted lock and SearchRun state so restarts do not create
                overlapping runs.
              </p>
            </div>
          </Card>

          <Card title="Configuration summary">
            <dl className="space-y-2 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-slate-400">Settings last loaded</dt>
                <dd className="text-slate-300">
                  {settings.dataUpdatedAt ? formatDate(new Date(settings.dataUpdatedAt)) : '—'}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-400">AI mode</dt>
                <dd className="text-slate-300">
                  {ai.configured ? 'OpenRouter + deterministic fallback' : 'Deterministic fallback only'}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-400">Enabled sources</dt>
                <dd className="text-slate-300">
                  {sources
                    .filter((source) => draft.sources[source.id]?.enabled)
                    .map((source) => source.label)
                    .join(', ') || 'none'}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-400">Profile modes</dt>
                <dd className="text-slate-300">
                  {draft.search.profileKinds.map((kind) => titleCase(kind)).join(', ')}
                </dd>
              </div>
            </dl>
          </Card>
        </div>
      </div>

      <div className="flex justify-end">
        <Button variant="primary" onClick={() => save.mutate(draft)} loading={save.isPending}>
          Save all settings
        </Button>
      </div>
    </div>
  );
}
