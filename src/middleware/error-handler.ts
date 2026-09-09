/**
 * The last middleware in the chain. Everything that goes wrong ends up here.
 *
 * Route handlers never build error responses themselves. They throw an AppError (or
 * call next(err) from a catch block) and this file decides the status code and body,
 * so every endpoint in BiletFlow fails in exactly the same shape:
 *
 *   { "error": { "code": "...", "message": "..." } }
 */
import type { NextFunction, Request, Response } from 'express';
import { AppError, ErrorCode } from '../lib/errors';

/** 404 for a URL no route matched. Mounted just before the error handler. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(AppError.notFound(ErrorCode.NOT_FOUND, `No route for ${req.method} ${req.path}`));
}

// Express identifies the error handler by its four arguments, so `next` has to stay in
// the signature even though we do not call it.
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.httpStatus).json({ error: { code: err.code, message: err.message } });
    return;
  }

  // Anything else is a bug on our side. The stack goes to the server log where we can
  // read it; the client gets a generic message. Never send err.message here: it can
  // contain SQL, file paths or connection strings.
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: {
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Something went wrong on our side. Try again.',
    },
  });
}
