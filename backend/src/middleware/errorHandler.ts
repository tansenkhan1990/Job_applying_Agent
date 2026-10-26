import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError, errorPayload, notFound } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export function apiNotFound(req: Request, _res: Response, next: NextFunction) {
  next(notFound(`API route ${req.method} ${req.originalUrl}`));
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const requestId = String((req as Request & { id?: string }).id ?? '');

  if (error instanceof ZodError) {
    const issues = error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    }));
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
        details: issues,
        requestId,
      },
    });
    return;
  }

  if (error instanceof AppError) {
    if (error.statusCode >= 500) {
      logger.error({ code: error.code, message: error.message, requestId }, 'API error');
    } else {
      logger.warn({ code: error.code, message: error.message, requestId }, 'API request rejected');
    }
    res.status(error.statusCode).json(errorPayload(error, requestId));
    return;
  }

  if (error instanceof Error && 'type' in error) {
    const type = (error as { type?: string }).type;
    if (type === 'entity.too.large') {
      res.status(413).json({
        error: { code: 'BAD_REQUEST', message: 'Request body too large.', requestId },
      });
      return;
    }
    if (type === 'entity.parse.failed') {
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'Malformed JSON request body.', requestId },
      });
      return;
    }
  }

  // Database unavailability is a dependency failure, not a bug in the request. Report it
  // as 503 so clients and container health checks can back off instead of treating it as a
  // generic server error.
  if (
    error instanceof Error &&
    (['MongoServerSelectionError', 'MongoNetworkError'].includes(error.name) ||
      /ECONNREFUSED|server selection timed out|MongoDB is not connected|buffering timed out/i.test(
        error.message,
      ))
  ) {
    res.status(503).json({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'The database is temporarily unavailable. Try again shortly.',
        requestId,
      },
    });
    return;
  }

  logger.error(
    { message: error instanceof Error ? error.message : 'unknown', requestId },
    'Unhandled API error',
  );
  res.status(500).json(errorPayload(error instanceof Error ? error : new Error('unknown'), requestId));
}
