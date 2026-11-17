/**
 * Refund retry columns — Build-03 migration 012.
 *
 * Build-03 coordinator merge: `retry_count`, `next_retry_at` and
 * `failure_reason` now live on `RefundsTable` in
 * packages/db/src/schema.ts (the single source of truth). This file
 * re-exports them so existing `DBWithRefundRetry` usages keep compiling
 * unchanged.
 */
import type { DB, RefundsTable } from '@uk-pos/db';

export type RefundsTableWithRetry = RefundsTable;

export type DBWithRefundRetry = DB;
