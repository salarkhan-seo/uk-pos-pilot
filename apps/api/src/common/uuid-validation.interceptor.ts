/**
 * Global UUID validation interceptor (Build-06 Objective 2).
 *
 * Wired globally via APP_INTERCEPTOR in app.module.ts, so it runs for
 * every controller in this API — sales, inventory, purchasing, crm,
 * api-keys, reporting, catalogue, admin, payments, integrations and
 * sync — with no per-controller edits. (It also covers the
 * integrations controllers' parameters by virtue of being global;
 * no file under modules/integrations/ was touched to achieve that.)
 *
 * WHAT IT CHECKS, before the handler runs:
 *  - Every route parameter whose name is an identifier (`id`, or any
 *    name ending in `Id`: tenantId, locationId, variantId, orderId,
 *    sessionId, periodId, poId, transferId, customerId,
 *    subscriptionId, and the codebase's other id params such as
 *    keyId, countId, priceBookId, promotionId, deliveryId). In this
 *    API every route param is a UUID — the inventory is 31× `:id`,
 *    1× `:tenantId`, 1× `:variantId` — so a malformed value is always
 *    a client error, never a database cast failure.
 *  - Every UUID body field, recursively: any field named `id` or
 *    ending in `Id` (tenantId, userId, locationId, variantId,
 *    registerId, customerId, orderLineId, ...) that is present and
 *    not null must be a well-formed UUID string. This covers nested
 *    bodies such as the sync flush orders[].lines[].variantId and
 *    the sales create-order lines. Absent or null fields are skipped
 *    (optional fields); non-UUID fields (voucherCode, barcode,
 *    idempotencyKey, providerReference, money strings) are untouched.
 *
 * GUARANTEE: a malformed identifier is rejected with 400 Bad Request
 * and body error.code "INVALID_UUID" (InvalidUuidException — the same
 * exception assertUuid throws, so direct call sites and the global
 * check agree). A well-formed UUID that matches nothing still reaches
 * the handler, which answers 404 as before. Valid inputs pass
 * through untouched.
 *
 * ORDERING NOTE: Nest runs guards before interceptors, so the
 * AuthGuard's cross-tenant check fires first on the one route whose
 * param IS the addressed tenant — GET /v1/compliance/statutory-
 * archives/:tenantId. A malformed :tenantId there is answered 404
 * (indistinguishable from cross-tenant, by the G-B rule) rather than
 * 400, and an unauthenticated caller gets 401. That is the guard's
 * deliberate security behaviour, not a gap in this interceptor: no
 * malformed identifier can reach a query and become a 500 on any
 * route, and the controller-level assertUuid still returns 400
 * INVALID_UUID for direct calls. The same applies to a malformed
 * x-tenant-id header, which the guard checks before this interceptor
 * runs. Query parameters are not validated (out of scope — no route
 * takes a UUID query param).
 *
 * OPT-OUT (Build-10 Objective 3): one body field in this API ends in
 * `Id` but is NOT a UUID — POST /v1/webhooks/re-encrypt-secrets
 * takes `fromKeyId`, a master-key id such as 'k1'. The global check
 * rejected every real re-encrypt call with 400 INVALID_UUID before
 * the handler ran, so the route had never worked over HTTP. A
 * handler decorated with @SkipUuidBodyValidation skips BODY
 * validation only (route params are still validated — re-encrypt has
 * none). Use it only for a field that is provably not a UUID; never
 * as a shortcut around a malformed identifier.
 */
import {
  Injectable,
  Optional,
  SetMetadata,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import { InvalidUuidException, isUuid } from './uuid';

/** Metadata key for @SkipUuidBodyValidation (see the header comment). */
export const SKIP_UUID_BODY_VALIDATION = 'skipUuidBodyValidation';

/**
 * Decorate a handler to skip BODY UUID validation for that route
 * only. Route params are still validated. For body fields that end
 * in `Id` but are provably not UUIDs (e.g. a master-key id).
 */
export const SkipUuidBodyValidation = () => SetMetadata(SKIP_UUID_BODY_VALIDATION, true);

/** A request field/param name that always carries a UUID in this API. */
export function isUuidFieldName(name: string): boolean {
  return name === 'id' || name.endsWith('Id');
}

function assertUuidField(value: unknown, field: string): void {
  if (value === undefined || value === null) {
    return;
  }
  if (!isUuid(value)) {
    throw new InvalidUuidException(field);
  }
}

function validateUuidFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      validateUuidFields(item);
    }
    return;
  }
  if (typeof value !== 'object' || value === null) {
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isUuidFieldName(key)) {
      assertUuidField(entry, key);
    } else {
      validateUuidFields(entry);
    }
  }
}

interface RequestLike {
  params?: Record<string, unknown>;
  body?: unknown;
}

@Injectable()
export class UuidValidationInterceptor implements NestInterceptor {
  // Reflector is optional so direct construction in tests
  // (new UuidValidationInterceptor()) keeps working: without it the
  // opt-out simply never applies and behaviour is unchanged.
  constructor(@Optional() private readonly reflector?: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<RequestLike>();
    for (const [name, value] of Object.entries(req.params ?? {})) {
      if (isUuidFieldName(name)) {
        assertUuidField(value, name);
      }
    }
    const skipBody =
      this.reflector?.get<boolean>(SKIP_UUID_BODY_VALIDATION, context.getHandler()) === true;
    if (!skipBody) {
      validateUuidFields(req.body);
    }
    return next.handle();
  }
}
