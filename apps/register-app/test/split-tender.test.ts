/**
 * Split Tender & W-12 Unknown Payment tests (Build-04, Objective 1).
 */
import { describe, expect, it } from 'vitest';
import {
  SplitTenderController,
  UNKNOWN_RESOLUTION_ACTIONS,
} from '../src/sell/split-tender';
import { UNKNOWN_PAYMENT_MESSAGE } from '../src/constants';

describe('SplitTenderController', () => {
  it('accepts multi-tender checkout up to the exact total', () => {
    const split = new SplitTenderController(1000n);
    split.addTender({ kind: 'cash', amountPence: 400n });
    split.addTender({ kind: 'card', amountPence: 600n, paymentAttemptId: 'att-1' });
    expect(split.tenderedTotal).toBe(1000n);
    expect(split.remaining).toBe(0n);
    expect(split.isComplete).toBe(true);
  });

  it('rejects a tender larger than the remaining balance', () => {
    const split = new SplitTenderController(1000n);
    expect(() => split.addTender({ kind: 'cash', amountPence: 1001n })).toThrow('exceeds the remaining');
  });

  it('times out 5 minutes after the first tender', () => {
    let now = 1_000_000;
    const split = new SplitTenderController(1000n, () => now);
    split.addTender({ kind: 'cash', amountPence: 400n });
    expect(split.isTimedOut()).toBe(false);
    now += 5 * 60 * 1000 + 1;
    expect(split.isTimedOut()).toBe(true);
    expect(() => split.addTender({ kind: 'cash', amountPence: 100n })).toThrow('timed out');
  });

  it('locks on the verbatim W-12 modal on an unknown card attempt, with the 3 resolution actions', () => {
    const split = new SplitTenderController(1000n);
    split.addTender({ kind: 'card', amountPence: 1000n, paymentAttemptId: 'att-9' });
    const modal = split.markCardAttemptUnknown('att-9');
    expect(modal).toBe(UNKNOWN_PAYMENT_MESSAGE);
    expect(split.blockingModal).toBe(UNKNOWN_PAYMENT_MESSAGE);
    expect(split.isLockedOnUnknown).toBe(true);
    expect(split.isComplete).toBe(false);
    expect(split.unknownPaymentAttemptId).toBe('att-9');

    expect(UNKNOWN_RESOLUTION_ACTIONS.map((a) => a.label)).toEqual([
      'Poll Provider Status',
      'Reconcile Terminal',
      'Manager Approval to Void/Retry',
      'Manager Approval to Record Standalone Reference',
    ]);

    // No further tender while locked.
    expect(() => split.addTender({ kind: 'cash', amountPence: 100n })).toThrow('locked on an unknown card payment');
  });

  it('requires a manager approval reference for manager resolutions, and unlocks on resolution', () => {
    const split = new SplitTenderController(1000n);
    split.addTender({ kind: 'card', amountPence: 1000n, paymentAttemptId: 'att-9' });
    split.markCardAttemptUnknown('att-9');
    expect(() => split.resolveUnknown('manager_void_or_retry')).toThrow('Manager approval is required');
    expect(split.resolveUnknown('poll_provider_status')).toBe(true);
    expect(split.isLockedOnUnknown).toBe(false);
    expect(split.blockingModal).toBeNull();
  });

  it('refuses to resolve when nothing is locking the register', () => {
    const split = new SplitTenderController(1000n);
    expect(() => split.resolveUnknown('poll_provider_status')).toThrow('No unknown payment');
  });
});
