/**
 * Webhook event catalog (Build-03 Objective 4; Arch-02 §3.2 plus the
 * Arch-06/09/10 additions).
 *
 * Arch-02 §3.2 calls this a "20-event catalog", but its own table
 * enumerates 22 entries once the paired variants are counted
 * separately (customer.created / customer.updated and
 * product.updated / variant.updated); all 22 are included here, plus
 * the 12 Phase 2 additions — 34 event types in total. The additions
 * are additions, not changes: the Arch-02 catalog is untouched.
 *
 * Payload rule (Arch-02 §3.2, enforced by WebhookService): payloads
 * carry references and amounts only — never PAN, full gift/voucher
 * codes, or customer PII. FORBIDDEN_PAYLOAD_KEYS is the enforcement
 * list; publish() throws on any of them.
 */

/** The 22 events from Arch-02 §3.2. */
export const ARCH02_EVENT_TYPES = [
  'order.completed',
  'order.voided',
  'order.refunded',
  'payment.approved',
  'payment.declined',
  'payment.unknown',
  'payment.dispute.created',
  'refund.completed',
  'refund.failed',
  'stock.adjusted',
  'stock.count_applied',
  'session.opened',
  'session.closed',
  'z_report.issued',
  'export.completed',
  'customer.created',
  'customer.updated',
  'product.updated',
  'variant.updated',
  'user.role_changed',
  'tenant.export_window_started',
  'tenant.deleted',
] as const;

/** Phase 2 additions: Arch-06 §3.4 (stock), Arch-09 §2 (CRM/loyalty), Arch-10 §5.3 (promotions). */
export const PHASE2_EVENT_TYPES = [
  'stock.low',
  'stock.transferred',
  'customer.group_changed',
  'loyalty.points_earned',
  'loyalty.points_redeemed',
  'gift_card.issued',
  'gift_card.redeemed',
  'promotion.created',
  'promotion.updated',
  'voucher.redeemed',
  'loyalty_campaign.started',
  'loyalty_campaign.ended',
] as const;

/** The full outbound catalog: Arch-02 §3.2 + Arch-06/09/10 additions. */
export const WEBHOOK_EVENT_TYPES = [...ARCH02_EVENT_TYPES, ...PHASE2_EVENT_TYPES] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export function isWebhookEventType(value: string): value is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Payload keys that must never appear in a webhook payload (Arch-02
 * §3.2: references and amounts only). `code` covers any full code
 * field; the stored hash + last-4 (`code_hash`, `code_last4`) are
 * references and are allowed. Customer PII keys (name, email, phone)
 * are denied — the payload carries the customer id only.
 */
export const FORBIDDEN_PAYLOAD_KEYS = [
  'pan',
  'card_number',
  'cardnumber',
  'cvv',
  'cvc',
  'full_code',
  'gift_code',
  'voucher_code',
  'code',
  'password',
  'password_hash',
  'pin_hash',
  'secret',
  'secret_hash',
  'api_key',
  'email',
  'phone',
  'first_name',
  'last_name',
  'address',
] as const;

/**
 * Retry schedule (Arch-02 §3.4), in milliseconds, indexed by the
 * attempt that just failed: after attempt 1 fails wait 1 minute, ...
 * after attempt 10 fails wait 24 hours. After attempt 11 fails there
 * is no further delay — the delivery moves to the dead-letter queue.
 * 10 retries over ~56 hours from the first attempt.
 */
export const RETRY_DELAYS_MS: readonly number[] = [
  60_000, // after attempt 1  -> attempt 2 in 1 minute
  300_000, // after attempt 2  -> 5 minutes
  900_000, // after attempt 3  -> 15 minutes
  1_800_000, // after attempt 4  -> 30 minutes
  3_600_000, // after attempt 5  -> 1 hour
  7_200_000, // after attempt 6  -> 2 hours
  14_400_000, // after attempt 7  -> 4 hours
  28_800_000, // after attempt 8  -> 8 hours
  57_600_000, // after attempt 9  -> 16 hours
  86_400_000, // after attempt 10 -> 24 hours (attempt 11 is the last)
] as const;

/** Maximum delivery attempts per delivery (1 initial + 10 retries). */
export const MAX_DELIVERY_ATTEMPTS = 11;

/** Dead-letter queue retention (Arch-02 §3.4): 30 days. */
export const DLQ_RETENTION_DAYS = 30;

/** Replay window for X-Webhook-Timestamp (Arch-02 §3.3): 5 minutes. */
export const SIGNATURE_REPLAY_WINDOW_SECONDS = 300;

/** Delivery acknowledgement window (Arch-02 §3.4): 5 seconds. */
export const DELIVERY_TIMEOUT_MS = 5_000;
