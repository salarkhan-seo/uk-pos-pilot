/**
 * Till session & Z-report delegation tests (Build-04, Objective 1).
 * The ReportingClient is a fake standing in for the API reporting
 * endpoints — the register never computes a Z-report itself.
 */
import { describe, expect, it } from 'vitest';
import {
  TillSessionController,
  varianceNeedsApproval,
  varianceThresholdPence,
  type ReportingClient,
} from '../src/session/till-session';

function fakeReporting(): { client: ReportingClient; calls: string[] } {
  const calls: string[] = [];
  const client: ReportingClient = {
    openSession: async (input) => {
      calls.push(`open:${input.openingFloatPence.toString()}`);
      return {
        sessionId: 'sess-1',
        warning:
          input.openingFloatPence === 0n
            ? 'Session opened with no float: float must be counted and recorded before trading; manager approval recorded.'
            : null,
      };
    },
    recordCashMovement: async (input) => {
      calls.push(`movement:${input.type}:${input.amountPence.toString()}`);
      return { movementId: 'mov-1' };
    },
    endSession: async (sessionId) => {
      calls.push(`end:${sessionId}`);
      return { sessionId, expectedCashPence: 13900n };
    },
    closeSession: async (input) => {
      calls.push(`close:${input.countedCashPence.toString()}`);
      return { sessionId: input.sessionId, zReportId: 'z-1', zNumber: '1' };
    },
    getZReport: async (zReportId) => ({ zReportId, zNumber: '1' }),
  };
  return { client, calls };
}

describe('D-08 variance threshold', () => {
  it('is the higher of £10 or 2% of expected cash', () => {
    expect(varianceThresholdPence(10000n)).toBe(1000n); // 2% = 200p < £10
    expect(varianceThresholdPence(100000n)).toBe(2000n); // 2% = £20
    expect(varianceNeedsApproval(10000n, 11000n)).toBe(false); // exactly at threshold
    expect(varianceNeedsApproval(10000n, 11001n)).toBe(true);
    expect(varianceNeedsApproval(10000n, 9000n)).toBe(false);
    expect(varianceNeedsApproval(10000n, 8999n)).toBe(true);
  });
});

describe('TillSessionController', () => {
  it('opens with a float and records cash movements', async () => {
    const { client, calls } = fakeReporting();
    const till = new TillSessionController(client, 'r1');
    const sessionId = await till.openSession(10000n);
    expect(sessionId).toBe('sess-1');
    expect(till.currentState).toBe('open');
    await till.recordCashMovement({ type: 'cash_in', amountPence: 2000n, note: 'Float top-up' });
    expect(calls).toContain('movement:cash_in:2000');
  });

  it('blocks a zero-float open without a manager override (D-07), and warns with one', async () => {
    const { client } = fakeReporting();
    const till = new TillSessionController(client, 'r1');
    await expect(till.openSession(0n)).rejects.toThrow('manager override (D-07)');
    const sessionId = await till.openSession(0n, 'approval-ref-1');
    expect(sessionId).toBe('sess-1');
    expect(till.lastZeroFloatWarning).toContain('no float');
  });

  it('blocks petty cash out above £50 without a manager approval', async () => {
    const { client } = fakeReporting();
    const till = new TillSessionController(client, 'r1');
    await till.openSession(10000n);
    await expect(
      till.recordCashMovement({ type: 'petty_cash_out', amountPence: 5001n, note: 'Milk run' }),
    ).rejects.toThrow('above £50 requires a manager approval');
    await till.recordCashMovement({
      type: 'petty_cash_out',
      amountPence: 6000n,
      note: 'Milk run',
      approvalEventId: 'approval-ref-2',
    });
    expect(till.currentState).toBe('open');
  });

  it('runs the two-step End then Close, requiring a reason and approval for a large variance', async () => {
    const { client } = fakeReporting();
    const till = new TillSessionController(client, 'r1');
    await till.openSession(10000n);
    await expect(till.closeSession({ countedCashPence: 13900n })).rejects.toThrow(
      'end the session first',
    );
    const expected = await till.endSession();
    expect(expected).toBe(13900n);
    expect(till.currentState).toBe('ended');

    // Small variance needs a reason but no approval.
    await expect(till.closeSession({ countedCashPence: 13800n })).rejects.toThrow('variance_reason is required');
    const z = await till.closeSession({ countedCashPence: 13800n, varianceReason: '£1 short in float' });
    expect(z).toEqual({ zReportId: 'z-1', zNumber: '1' });
    expect(till.currentState).toBe('closed');
  });

  it('requires manager approval when the variance exceeds the D-08 threshold', async () => {
    const { client } = fakeReporting();
    const till = new TillSessionController(client, 'r1');
    await till.openSession(10000n);
    await till.endSession(); // expected 13900p; threshold max(1000, 278) = 1000p
    await expect(
      till.closeSession({ countedCashPence: 12000n, varianceReason: 'Till short' }),
    ).rejects.toThrow('D-08 threshold');
    const z = await till.closeSession({
      countedCashPence: 12000n,
      varianceReason: 'Till short',
      approvalEventId: 'approval-ref-3',
    });
    expect(z.zNumber).toBe('1');
  });
});
