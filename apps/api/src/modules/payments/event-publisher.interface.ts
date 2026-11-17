/**
 * EventPublisher — the outbound event seam (Build-03 Objective 2).
 *
 * The integrations module (Build-03 Objective 4) implements this
 * interface (outbound webhooks + Events API, Arch-02 §3). Until then,
 * PaymentsService works WITHOUT a publisher: the hash-chained audit log
 * is the durable record, and publishing is best-effort — a publisher
 * failure never fails the payment operation it follows.
 *
 * Payloads carry references and amounts only — never PAN, full
 * gift/voucher codes, or customer PII (Arch-02 §3.2 payload rule).
 *
 * The return type is deliberately `Promise<unknown> | void`: callers
 * ignore it, and an implementation may resolve with its own receipt
 * (the integrations WebhookService resolves with its PublishedEvent).
 * Narrowing this to `Promise<void> | void` breaks that implementation
 * (TS does not accept Promise<PublishedEvent> as Promise<void>), so the
 * wider type is the contract — see the coordinator note in the report.
 */
export interface EventPublisher {
  publish(eventType: string, payload: Record<string, unknown>): Promise<unknown> | void;
}
