export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'AI_NOT_CONFIGURED'
  | 'AI_ERROR'
  | 'UPSTREAM_ERROR'
  | 'INTERNAL';

export class AppError extends Error {
  statusCode: number;
  code: ErrorCode;
  details?: unknown;
  retryable: boolean;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    options: { details?: unknown; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}

export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, { details });
export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'CONFLICT', message, { details });
export const aiNotConfigured = () =>
  new AppError(
    503,
    'AI_NOT_CONFIGURED',
    'OpenRouter is not configured. Add OPENROUTER_API_KEY to .env, or use the deterministic fallback.',
  );

export function errorPayload(error: AppError | Error, requestId?: string) {
  if (error instanceof AppError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        details: error.details ?? undefined,
        requestId,
      },
    };
  }
  return {
    error: {
      code: 'INTERNAL' as const,
      message: 'An unexpected error occurred.',
      requestId,
    },
  };
}
