const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  if (!response.ok) {
    let code = 'HTTP_ERROR';
    let message = `Request failed with status ${response.status}`;
    let details: unknown;
    try {
      const payload = (await response.json()) as {
        error?: { code?: string; message?: string; details?: unknown };
      };
      if (payload.error) {
        code = payload.error.code ?? code;
        message = payload.error.message ?? message;
        details = payload.error.details;
      }
    } catch {
      // Non-JSON error body.
    }
    throw new ApiError(response.status, code, message, details);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function apiBase(): string {
  return API_BASE;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'An unexpected error occurred.';
}

export function errorDetails(error: unknown): string[] {
  if (!(error instanceof ApiError)) return [];
  const details = error.details;
  if (Array.isArray(details)) {
    return details.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        return String(record.message ?? record.question ?? JSON.stringify(record));
      }
      return String(item);
    });
  }
  if (details && typeof details === 'object') {
    const record = details as Record<string, unknown>;
    if (Array.isArray(record.unanswered)) {
      return record.unanswered.map((item) =>
        String((item as { question?: string }).question ?? 'Unanswered question'),
      );
    }
    if (Array.isArray(record.issues)) {
      return record.issues.map((item) => {
        const issue = item as { path?: string; message?: string };
        return `${issue.path ? `${issue.path}: ` : ''}${issue.message ?? ''}`;
      });
    }
    if (typeof record.reason === 'string') return [record.reason];
  }
  return [];
}
