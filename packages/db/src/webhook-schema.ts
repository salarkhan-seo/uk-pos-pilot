/**
 * Kysely schema types for migration 011 (webhook_events_dlq).
 *
 * Build-03 coordinator merge: the three table interfaces now live in
 * packages/db/src/schema.ts (the single source of truth). This file
 * re-exports them so existing `Kysely<DB & WebhookTables>` usages keep
 * compiling unchanged.
 */
import type { DB } from './schema';

export type {
  WebhookEndpointsTable,
  WebhookEventsTable,
  WebhookDeliveriesTable,
} from './schema';

/** The three webhook tables, as a slice of the merged `DB` interface. */
export type WebhookTables = Pick<
  DB,
  'webhook_endpoints' | 'webhook_events' | 'webhook_deliveries'
>;
