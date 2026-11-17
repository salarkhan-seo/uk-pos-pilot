/**
 * UUID format guard (Build-05, error shape standardised Build-06).
 *
 * PostgreSQL rejects a malformed uuid literal with error 22P02
 * ("invalid input syntax for type uuid") — an unhandled 500 when a
 * caller passes a non-UUID id straight into a `where('id', '=', x)`
 * comparison on a uuid column. Validate the format BEFORE any query
 * so malformed ids fail as a client error (400), never a 500.
 * A well-formed UUID that matches nothing is still a 404 at the
 * lookup — this guard changes nothing for valid inputs.
 *
 * ERROR SHAPE (Build-06): a malformed id throws InvalidUuidException,
 * a BadRequestException subclass whose response body follows the
 * codebase's structured-error convention (see RATE_LIMITED in
 * rate-limit.interceptor.ts and PLAN_GATED in tier-gate.ts):
 *   { "error": { "code": "INVALID_UUID", "message": "<field> must be a valid UUID", "field": "<field>" } }
 * with HTTP 400. Nest's default exception filter sends an object
 * response through as-is, so the body reaches the client exactly
 * like this. The global UuidValidationInterceptor throws the same
 * exception for route params and body fields; assertUuid is the
 * same check for direct service/controller call sites (defence in
 * depth — e.g. SessionService.login, which the AuthGuard calls).
 */
import { BadRequestException } from '@nestjs/common';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * An actor's userId as a uuid-column value (Build-06 Objective 4).
 * API-key actors carry the synthetic id `api-key:<keyId>` (AuthGuard),
 * which is a valid audit identity (audit_events.user_id is text) but
 * NOT a UUID — writing it into a uuid REFERENCES users (id) column
 * fails with a 22P02 cast error (500). PIN-session and demo actors
 * carry real user UUIDs. Returns the id when it is a UUID, else null
 * (every such column is nullable); the audit log keeps the full actor
 * identity, so traceability is not lost.
 */
export function userIdAsUuid(userId: string | null | undefined): string | null {
  return typeof userId === 'string' && isUuid(userId) ? userId : null;
}

/** Structured 400 for a malformed identifier: error.code "INVALID_UUID". */
export class InvalidUuidException extends BadRequestException {
  constructor(field: string) {
    super({
      error: {
        code: 'INVALID_UUID',
        message: `${field} must be a valid UUID`,
        field,
      },
    });
  }
}

/** Throw 400 (INVALID_UUID) when `value` is not a well-formed UUID. Returns the value typed as a string. */
export function assertUuid(value: unknown, field: string): string {
  if (!isUuid(value)) {
    throw new InvalidUuidException(field);
  }
  return value;
}
