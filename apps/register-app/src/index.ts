/**
 * @uk-pos/register-app — public API (Build-04, Objective 1).
 *
 * Framework-free register view-models: storage, offline guards, sync,
 * sell screen, age gate, split tender, till session, hardware
 * adapters. No React Native runtime dependency — bind these to a
 * React Native UI later.
 */
export * from './constants';
export * from './api/client';
export * from './storage/storage-adapter';
export * from './storage/memory-storage';
export * from './storage/sqlite-storage';
export * from './offline/offline-guards';
export * from './sync/sync-client';
export * from './sell/line-pricing';
export * from './sell/age-gate';
export * from './sell/split-tender';
export * from './sell/sell-controller';
export * from './session/till-session';
export * from './hardware/stripe-terminal';
export * from './hardware/receipt-printer';
export * from './hardware/customer-display';
