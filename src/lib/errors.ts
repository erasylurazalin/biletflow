/**
 * One error type for everything we throw on purpose.
 *
 * Throw `new AppError(...)` anywhere in a route and the error middleware turns it
 * into the JSON shape from docs/api.md. Anything else that reaches the middleware
 * (a typo, a broken SQL query) is treated as a bug and becomes a generic 500.
 */

/**
 * The `code` values the frontend is allowed to branch on. Add new ones here, tell the
 * group chat, and write them into docs/api.md. A code that only exists in your route
 * file is a code nobody else can handle.
 */
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  EVENT_NOT_FOUND: 'EVENT_NOT_FOUND',
  CONFLICT: 'CONFLICT',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export class AppError extends Error {
  readonly code: ErrorCodeValue;
  readonly httpStatus: number;

  constructor(code: ErrorCodeValue, message: string, httpStatus: number) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
  }

  // Shortcuts for the cases that come up constantly. `message` is shown to the user
  // as-is (docs/api.md), so write it for a person, not for a log file.
  static badRequest(message: string): AppError {
    return new AppError(ErrorCode.VALIDATION_ERROR, message, 400);
  }

  static unauthorized(message = 'You need to be logged in'): AppError {
    return new AppError(ErrorCode.UNAUTHORIZED, message, 401);
  }

  static forbidden(message = 'You are not allowed to do that'): AppError {
    return new AppError(ErrorCode.FORBIDDEN, message, 403);
  }

  static notFound(code: ErrorCodeValue, message: string): AppError {
    return new AppError(code, message, 404);
  }

  static conflict(code: ErrorCodeValue, message: string): AppError {
    return new AppError(code, message, 409);
  }
}
