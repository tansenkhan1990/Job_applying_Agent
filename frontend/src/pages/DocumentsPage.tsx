import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../api/client';
import type { DocumentMeta, DocumentsResponse, ProfileKindOrUnassigned, RescanSummary } from '../api/types';
import { formatDateTime, statusTone, titleCase } from '../lib/format';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toast';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  PageHeader,
  Select,
  SpinnerPanel,
  WarningNote,
} from '../components/ui';

const PROFILE_OPTIONS: Array<{ value: ProfileKindOrUnassigned; label: string }> = [
  { value: 'unassigned', label: 'Unassigned' },
  { value: 'full_stack', label: 'Full Stack Developer' },
  { value: 'ai_engineer', label: 'AI Engineer / Developer' },
  { value: 'devops_cloud', label: 'DevOps / Cloud Engineer' },
];

export function DocumentsPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [preview, setPreview] = useState<DocumentMeta | null>(null);
  const [filter, setFilter] = useState<'all' | 'unmapped' | 'problem'>('all');

  const documents = useQuery<DocumentsResponse>({
    queryKey: ['documents'],
    queryFn: () => api<DocumentsResponse>('/documents'),
  });

  const text = useQuery<{ text: string; wordCount: number; status: string }>({
    queryKey: ['document-text', preview?.id],
    queryFn: () =>
      api<{ text: string; wordCount: number; status: string }>(`/documents/${preview?.id}/text`),
    enabled: Boolean(preview?.id),
  });

  const rescan = useMutation({
    mutationFn: () => api<RescanSummary>('/documents/rescan', { method: 'POST', body: {} }),
    onSuccess: (summary) => {
      toast.success(
        `Rescan: ${summary.scanned} scanned, ${summary.added} added, ${summary.updated} updated, ${summary.failed} failed.`,
      );
      for (const warning of summary.warnings.slice(0, 3)) toast.info(warning);
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      void queryClient.invalidateQueries({ queryKey: ['profiles'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const mapping = useMutation({
    mutationFn: (input: {
      id: string;
      docType: DocumentMeta['docType'];
      profileKind: ProfileKindOrUnassigned;
    }) =>
      api<DocumentMeta>(`/documents/${input.id}/mapping`, {
        method: 'PATCH',
        body: { docType: input.docType, profileKind: input.profileKind, mappingReviewed: true },
      }),
    onSuccess: () => {
      toast.success('Document mapping saved.');
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      void queryClient.invalidateQueries({ queryKey: ['profiles'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const documentsList = useMemo(() => {
    const list = documents.data?.documents ?? [];
    if (filter === 'unmapped') {
      return list.filter((doc) => doc.docType === 'unknown' || doc.profileKind === 'unassigned');
    }
    if (filter === 'problem') {
      return list.filter((doc) => doc.missing || doc.status === 'failed' || doc.status === 'needs_ocr');
    }
    return list;
  }, [documents.data, filter]);

  if (documents.isLoading) return <SpinnerPanel label="Loading documents…" />;
  if (documents.error) return <ErrorNote message={errorMessage(documents.error)} />;
  if (!documents.data) return null;

  const { folder, counts } = documents.data;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Documents"
        description="Read-only ingestion from the configured folder. Files are never modified, and full CV text is never included in document lists."
        actions={
          <Button variant="primary" onClick={() => rescan.mutate()} loading={rescan.isPending}>
            Rescan documents
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: 'Total', value: counts.total },
          { label: 'Processed', value: counts.processed },
          { label: 'Needs OCR', value: counts.needsOcr },
          { label: 'Failed', value: counts.failed },
          { label: 'Missing', value: counts.missing },
          { label: 'Unmapped', value: counts.unmapped },
        ].map((item) => (
          <div key={item.label} className="rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2.5">
            <p className="text-[11px] uppercase tracking-wide text-slate-500">{item.label}</p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums text-slate-100">{item.value}</p>
          </div>
        ))}
      </div>

      {!folder.readable ? (
        <WarningNote>
          The documents folder is not readable at <code>{folder.configuredPath}</code>. In Docker, make sure{' '}
          <code>./documents</code> is mounted read-only into the backend. Then press “Rescan documents”.
        </WarningNote>
      ) : (
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-400">
          Folder: <code className="text-slate-300">{folder.configuredPath}</code> · {folder.filesFound} supported
          file(s) found · max {folder.maxSizeMb} MB each · PDF and DOCX supported
        </div>
      )}

      <Card padded={false}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
          <div className="flex flex-wrap gap-1.5">
            {(['all', 'unmapped', 'problem'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setFilter(option)}
                className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ${
                  filter === option
                    ? 'bg-indigo-500/20 text-indigo-200 ring-indigo-500/40'
                    : 'bg-slate-900 text-slate-400 ring-slate-700'
                }`}
              >
                {titleCase(option === 'problem' ? 'problems' : option)}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-slate-500">
            Assign one CV and optionally one cover letter per career profile.
          </p>
        </div>

        {documentsList.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title="No documents found"
              description="Place your three CVs and three cover letters in the documents/cvs and documents/cover-letters folders, then rescan."
            />
          </div>
        ) : (
          <div className="divide-y divide-slate-800">
            {documentsList.map((doc) => {
              const saving = mapping.isPending && mapping.variables?.id === doc.id;
              return (
                <div key={doc.id} className="grid gap-3 px-4 py-3 lg:grid-cols-[minmax(0,1fr)_9rem_11rem_auto] lg:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium text-slate-100">{doc.filename}</p>
                      <Badge tone={statusTone(doc.status)}>{doc.status}</Badge>
                      {doc.missing ? <Badge tone="danger">file missing</Badge> : null}
                      {doc.mappingReviewed ? <Badge tone="success">mapping reviewed</Badge> : null}
                    </div>
                    <p className="mt-0.5 truncate text-[11px] text-slate-500">
                      {doc.relativePath} · {Math.round(doc.sizeBytes / 1024)} KB · {doc.wordCount} words ·{' '}
                      {doc.pageCount ? `${doc.pageCount}p · ` : ''}
                      {doc.contentHash.slice(0, 10)} · scanned {formatDateTime(doc.lastScannedAt)}
                    </p>
                    {doc.error ? <p className="mt-1 text-[11px] text-rose-300">{doc.error}</p> : null}
                    {doc.status === 'needs_ocr' ? (
                      <p className="mt-1 text-[11px] text-amber-300">
                        Scanned PDF detected. Run OCR and replace the file; extraction cannot use it yet.
                      </p>
                    ) : null}
                  </div>

                  <Select
                    aria-label={`Document type for ${doc.filename}`}
                    value={doc.docType}
                    disabled={saving || doc.missing}
                    onChange={(event) =>
                      mapping.mutate({
                        id: doc.id,
                        docType: event.target.value as DocumentMeta['docType'],
                        profileKind: doc.profileKind,
                      })
                    }
                  >
                    <option value="unknown">Type: unknown</option>
                    <option value="cv">CV</option>
                    <option value="cover_letter">Cover letter</option>
                  </Select>

                  <Select
                    aria-label={`Career profile for ${doc.filename}`}
                    value={doc.profileKind}
                    disabled={saving || doc.missing}
                    onChange={(event) =>
                      mapping.mutate({
                        id: doc.id,
                        docType: doc.docType,
                        profileKind: event.target.value as ProfileKindOrUnassigned,
                      })
                    }
                  >
                    {PROFILE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>

                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setPreview(doc)}>
                      View text
                    </Button>
                    {saving ? <Badge tone="info">saving…</Badge> : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <WarningNote>
        The backend never accepts arbitrary paths from the browser. It only reads supported files inside the
        mounted documents folder, ignores symlinks, enforces a size limit, and stores a content hash so changes
        can be detected. Manual mappings are preserved across rescans.
      </WarningNote>

      <Modal
        open={Boolean(preview)}
        title={preview ? `Extracted text — ${preview.filename}` : 'Extracted text'}
        onClose={() => setPreview(null)}
        wide
        footer={
          <Button variant="secondary" onClick={() => setPreview(null)}>
            Close
          </Button>
        }
      >
        {text.isLoading ? <SpinnerPanel label="Loading extracted text…" /> : null}
        {text.error ? <ErrorNote message={errorMessage(text.error)} /> : null}
        {text.data ? (
          <div className="space-y-2">
            <p className="text-[11px] text-slate-500">
              {text.data.wordCount} words · status {text.data.status} · text stays on your machine
            </p>
            <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950/70 p-3 text-xs leading-relaxed text-slate-300">
              {text.data.text || 'No extractable text.'}
            </pre>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
