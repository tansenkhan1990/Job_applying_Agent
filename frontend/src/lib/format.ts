export function formatDate(value?: string | Date | null): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}

export function formatDateTime(value?: string | Date | null): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function timeAgo(value?: string | Date | null): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  const diff = Date.now() - date.getTime();
  if (Number.isNaN(diff)) return '—';
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(date);
}

export function deadlineCountdown(
  value?: string | Date | null,
  status?: string | null,
): string | null {
  if (!value || status === 'expired' || status === 'closed') return null;
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return null;
  const days = Math.ceil((date.getTime() - Date.now()) / 86_400_000);
  if (days < 0) return 'deadline passed';
  if (days === 0) return 'closes today';
  return `${days} day${days === 1 ? '' : 's'} left`;
}

export function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'purple';

export function scoreTone(score?: number | null): BadgeTone {
  if (score === null || score === undefined) return 'neutral';
  if (score >= 80) return 'success';
  if (score >= 60) return 'warning';
  return 'danger';
}

export function statusTone(status?: string | null): BadgeTone {
  switch (status) {
    case 'SUBMITTED':
    case 'APPROVED':
    case 'processed':
    case 'completed':
    case 'ok':
      return 'success';
    case 'READY_FOR_REVIEW':
    case 'NEEDS_MANUAL_ACTION':
    case 'needs_ocr':
    case 'running':
      return 'warning';
    case 'FAILED':
    case 'unavailable':
    case 'missing':
    case 'failed':
      return 'danger';
    case 'SUBMITTING':
    case 'MATCHED':
    case 'DISCOVERED':
      return 'info';
    case 'WITHDRAWN':
      return 'purple';
    default:
      return 'neutral';
  }
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function truncate(value: string, max = 180): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max).trimEnd()}…`;
}

export function isoDate(value: string): string {
  return value.slice(0, 10);
}
