import { createHashChain } from '@uk-pos/shared-kernel';
import { describe, expect, it } from 'vitest';
import { FakeAdminApiClient } from '../src/api/fake-client';
import { TerminationBlockedError } from '../src/api/errors';
import { AbuseReportController, aggregateAbuseReport } from '../src/finance/abuse';
import { CsvDownloadController, expectedCsvHeader } from '../src/finance/downloads';
import { ExitPortal } from '../src/finance/exit';
import { IntegrityController, verifyAuditEvents, verifyExportManifest } from '../src/finance/integrity';
import { FinanceConsole, settlementSummary } from '../src/finance/reporting';
import { WebhookConsole, toDeadLetterRows } from '../src/finance/webhooks';
import type { AuditEventView } from '../src/api/types';
import { sha256Hex } from '@uk-pos/shared-kernel';

/** Build AuditEventViews from a real shared-kernel hash chain. */
function chainedEvents(payloads: Array<Record<string, unknown>>): AuditEventView[] {
  const chain = createHashChain(payloads);
  return chain.map((link, i) => ({
    id: `evt-${i}`,
    tenant_id: 'tenant-1',
    user_id: (payloads[i]?.['userId'] as string | undefined) ?? null,
    event_type: (payloads[i]?.['eventType'] as string | undefined) ?? 'test.event',
    entity_type: null,
    entity_id: null,
    payload: payloads[i] as Record<string, unknown>,
    prev_hash: link.prevHash,
    event_hash: link.eventHash,
    created_at: `2026-11-13T0${i}:00:00.000Z`,
  }));
}

describe('abuse reports — aggregation from the API audit data', () => {
  function auditEvent(id: string, userId: string, eventType: string, payload: Record<string, unknown>): AuditEventView {
    return { id, tenant_id: 't', user_id: userId, event_type: eventType, entity_type: null, entity_id: null, payload, prev_hash: 'GENESIS', event_hash: 'x', created_at: '2026-11-13T00:00:00.000Z' };
  }

  it('aggregates discounts, comps and voids per user from audit events', () => {
    const events = [
      auditEvent('e1', 'cashier-1', 'approval.granted', { action: 'manual_discount', amount_pence: '500' }),
      auditEvent('e2', 'cashier-1', 'approval.granted', { action: 'manual_discount', amount_pence: '700' }),
      auditEvent('e3', 'cashier-1', 'order.voided', { action: 'void', amount_pence: '1200' }),
      auditEvent('e4', 'manager-1', 'approval.granted', { action: 'comp', amount_pence: '2000' }),
    ];
    const report = aggregateAbuseReport(events);
    expect(report.windowEventCount).toBe(4);
    const cashier = report.users.find((u) => u.userId === 'cashier-1');
    expect(cashier?.manualDiscountCount).toBe(2);
    expect(cashier?.manualDiscountPence).toBe('1200');
    expect(cashier?.voidCount).toBe(1);
    const manager = report.users.find((u) => u.userId === 'manager-1');
    expect(manager?.compPence).toBe('2000');
  });

  it('flags review at the thresholds (5 discounts, 3 voids, £100 given away)', () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      auditEvent(`d${i}`, 'cashier-9', 'approval.granted', { action: 'manual_discount', amount_pence: '100' }),
    );
    const report = aggregateAbuseReport(events);
    expect(report.users[0]?.review).toBe(true);
    expect(report.users[0]?.reviewReasons.join(' ')).toContain('5 manual discounts');
    const voids = Array.from({ length: 3 }, (_, i) => auditEvent(`v${i}`, 'cashier-8', 'order.voided', { action: 'void' }));
    expect(aggregateAbuseReport(voids).users[0]?.review).toBe(true);
    const big = [auditEvent('b1', 'cashier-7', 'approval.granted', { action: 'comp', amount_pence: '10000' })];
    expect(aggregateAbuseReport(big).users[0]?.review).toBe(true);
  });

  it('unrecognised event types are reported, not silently dropped', () => {
    const report = aggregateAbuseReport([auditEvent('u1', 'x', 'session.opened', {})]);
    expect(report.users).toHaveLength(0);
    expect(report.unrecognisedEventTypes).toEqual(['session.opened']);
  });

  it('controller builds the report from GET /v1/audit-events', async () => {
    const fake = new FakeAdminApiClient({
      auditEvents: [auditEvent('e1', 'cashier-1', 'approval.granted', { action: 'manual_discount', amount_pence: '500' })],
    });
    const report = await new AbuseReportController(fake).buildReport();
    expect(report.users).toHaveLength(1);
    expect(fake.callsFor('audit.list')[0]?.path).toBe('/v1/audit-events');
  });
});

describe('hash-chain integrity verifier — shared kernel, tamper detection', () => {
  it('verifies an untampered chain as ok', () => {
    const events = chainedEvents([
      { eventType: 'order.completed', entityType: 'order', entityId: 'o1', userId: 'u1' },
      { eventType: 'payment.approved', entityType: 'payment', entityId: 'p1', userId: 'u1' },
    ]);
    const report = verifyAuditEvents(events);
    expect(report.eventCount).toBe(2);
    expect(report.verification.ok).toBe(true);
  });

  it('detects a tampered payload (hash no longer matches)', () => {
    const events = chainedEvents([
      { eventType: 'order.completed', entityType: 'order', entityId: 'o1', userId: 'u1' },
      { eventType: 'payment.approved', entityType: 'payment', entityId: 'p1', userId: 'u1' },
    ]);
    events[1]!.payload = { ...events[1]!.payload, amount_pence: '999999' };
    const report = verifyAuditEvents(events);
    expect(report.verification.ok).toBe(false);
    expect(report.verification.brokenIndex).toBe(1);
    expect(report.verification.reason).toContain('tampered');
  });

  it('detects a tampered stored hash', () => {
    const events = chainedEvents([{ eventType: 'order.completed', entityType: 'order', entityId: 'o1', userId: 'u1' }]);
    events[0]!.event_hash = '0'.repeat(64);
    const report = verifyAuditEvents(events);
    expect(report.verification.ok).toBe(false);
    expect(report.verification.brokenIndex).toBe(0);
  });

  it('detects a reordered chain (prev_hash mismatch)', () => {
    const events = chainedEvents([
      { eventType: 'a', entityType: null, entityId: null, userId: 'u1' },
      { eventType: 'b', entityType: null, entityId: null, userId: 'u1' },
    ]);
    const reordered = [events[1]!, events[0]!];
    expect(verifyAuditEvents(reordered).verification.ok).toBe(false);
  });

  it('detects a deleted event (chain link broken at the deletion point)', () => {
    const events = chainedEvents([
      { eventType: 'a', entityType: null, entityId: null, userId: 'u1' },
      { eventType: 'b', entityType: null, entityId: null, userId: 'u1' },
      { eventType: 'c', entityType: null, entityId: null, userId: 'u1' },
    ]);
    const deleted = [events[0]!, events[2]!];
    const report = verifyAuditEvents(deleted);
    expect(report.verification.ok).toBe(false);
    expect(report.verification.brokenIndex).toBe(1);
  });

  it('controller verifies the live audit feed (newest-first list is re-ordered for verification)', async () => {
    const events = chainedEvents([
      { eventType: 'a', entityType: null, entityId: null, userId: 'u1' },
      { eventType: 'b', entityType: null, entityId: null, userId: 'u1' },
    ]);
    // listAuditEvents returns newest first; the controller must reverse.
    const fake = new FakeAdminApiClient({ auditEvents: [...events].reverse() });
    const report = await new IntegrityController(fake).verifyAuditChain();
    expect(report.verification.ok).toBe(true);
    expect(report.eventCount).toBe(2);
  });
});

describe('CSV downloads — right endpoint, reproducibility, contract header', () => {
  it('Z-report download triggers the Z-report CSV endpoint (not the VAT one)', async () => {
    const fake = new FakeAdminApiClient();
    const download = await new CsvDownloadController(fake).download('z-report', 'z-42');
    expect(download.routeKey).toBe('reporting.exportZReportCsv');
    expect(download.filename).toBe('z-report-z-42.csv');
    expect(fake.callsFor('reporting.exportZReportCsv')).toHaveLength(1);
    expect(fake.callsFor('reporting.exportVatPeriodCsv')).toHaveLength(0);
    expect(fake.exportedCsv[0]?.zReportIdOrPeriodId).toBe('z-42');
  });

  it('VAT download triggers the VAT CSV endpoint', async () => {
    const fake = new FakeAdminApiClient();
    const download = await new CsvDownloadController(fake).download('vat-period', 'vp-7');
    expect(download.routeKey).toBe('reporting.exportVatPeriodCsv');
    expect(download.filename).toBe('vat-period-vp-7.csv');
    expect(fake.callsFor('reporting.exportVatPeriodCsv')).toHaveLength(1);
  });

  it('re-exports are byte-identical (reproducible)', async () => {
    const fake = new FakeAdminApiClient();
    const { reproducible, first, second } = await new CsvDownloadController(fake).verifyReproducible('z-report', 'z-42');
    expect(reproducible).toBe(true);
    expect(first.content).toBe(second.content);
  });

  it('expected headers match the Arch-02 §5.3 column contract', () => {
    expect(expectedCsvHeader('z-report').split(',')).toContain('z_number');
    expect(expectedCsvHeader('z-report').split(',')).toContain('promotion_discount_pence');
    expect(expectedCsvHeader('vat-period').split(',')).toContain('vat_period_id');
    expect(expectedCsvHeader('vat-period').split(',')).toContain('refund_adjustment_pence');
  });
});

describe('exit portal — D-11 blockers surfaced exactly', () => {
  it('requestTermination surfaces the exact open-session and unknown-payment ids from the 409', async () => {
    const fake = new FakeAdminApiClient({
      exitStatus: { tenantId: 't1', status: 'active', exportWindowEndsAt: null, openSessionIds: ['sess-1', 'sess-2'], blockingPaymentAttemptIds: ['att-9'] },
    });
    const portal = new ExitPortal(fake);
    await expect(portal.requestTermination()).rejects.toBeInstanceOf(TerminationBlockedError);
    try {
      await portal.requestTermination();
      expect.unreachable('should have thrown');
    } catch (error) {
      const blocked = error as TerminationBlockedError;
      expect(blocked.openSessionIds).toEqual(['sess-1', 'sess-2']);
      expect(blocked.blockingPaymentAttemptIds).toEqual(['att-9']);
    }
  });

  it('with no blockers, termination → export window → full export with a verified manifest', async () => {
    const fake = new FakeAdminApiClient();
    const portal = new ExitPortal(fake);
    const requested = await portal.requestTermination();
    expect(requested.status.status).toBe('termination_requested');
    const window = await portal.beginExportWindow();
    expect(window.status.status).toBe('export_window');
    expect(window.readOnly).toBe(true);
    expect(window.exportWindowEndsAt).toBeTruthy();
    const { result, manifest } = await portal.runFullExport();
    expect(result.jobId).toBeTruthy();
    expect(manifest.ok).toBe(true);
    expect(fake.callsFor('exit.runFullExport')[0]?.path).toBe('/v1/admin/exit/full-export');
  });

  it('manifest verification detects a file altered after export', () => {
    const content = 'z_number,business_date\n1,2026-11-13\n';
    const manifest = [{ file_name: 'z_reports.csv', table_name: 'z_reports', row_count: 1, sha256_checksum: sha256Hex(content) }];
    expect(verifyExportManifest(manifest, { 'z_reports.csv': content }).ok).toBe(true);
    const tampered = verifyExportManifest(manifest, { 'z_reports.csv': 'z_number,business_date\n1,2026-11-14\n' });
    expect(tampered.ok).toBe(false);
    expect(tampered.checks[0]?.ok).toBe(false);
    expect(tampered.checks[0]?.expectedChecksum).not.toBe(tampered.checks[0]?.actualChecksum);
    const missing = verifyExportManifest(manifest, {});
    expect(missing.ok).toBe(false);
    expect(missing.missingFromExport).toEqual(['z_reports.csv']);
  });
});

describe('finance console — Z-reports, VAT, settlement, webhooks', () => {
  it('corrections require a reason and a manager approval id', async () => {
    const fake = new FakeAdminApiClient();
    const console_ = new FinanceConsole(fake);
    await expect(console_.recordCorrection('z-1', { correctionType: 'cash_variance', amountPence: '100', reason: '', approvalEventId: 'ap-1' })).rejects.toThrow('reason is required');
    await expect(console_.recordCorrection('z-1', { correctionType: 'cash_variance', amountPence: '100', reason: 'miscount', approvalEventId: '' })).rejects.toThrow('approval_event_id');
    expect(fake.callsFor('reporting.recordCorrection')).toHaveLength(0);
    const result = await console_.recordCorrection('z-1', { correctionType: 'cash_variance', amountPence: '100', reason: 'miscount', approvalEventId: 'ap-1' });
    expect(result.id).toBeTruthy();
  });

  it('VAT period closure flips the period to closed', async () => {
    const fake = new FakeAdminApiClient({
      vatPeriods: [{ id: 'vp-1', period_start: '2026-10-01', period_end: '2026-12-31', status: 'open' }],
    });
    const period = await new FinanceConsole(fake).closeVatPeriod('vp-1');
    expect(period.status).toBe('closed');
  });

  it('settlement reconciliation reports T+3, reserve holds and dispute debits as distinct lines', async () => {
    const fake = new FakeAdminApiClient();
    const view = await new FinanceConsole(fake).reconcileSettlement('2026-11-10', [
      { providerReference: 'po_1', settlementDate: '2026-11-13', grossPence: '10000', feePence: '150', reserveHoldPence: '500', disputeDebitPence: '0' },
    ]);
    expect(view.settlementDate).toBe('2026-11-13');
    expect(view.reserveHoldTotalPence).toBe('500');
    expect(view.expectedNetPayoutPence).toBe('9350');
    expect(view.status).toBe('reconciled');
    expect(settlementSummary(view)).toContain('T+3');
    expect(settlementSummary(view)).toContain('reserve holds 500p');
  });

  it('DLQ view filters the live Events API by delivery_status=dead_letter', async () => {
    const fake = new FakeAdminApiClient({
      events: {
        events: [
          { id: 'ev-1', tenant_id: 't', event_type: 'order.completed', sequence: '1', payload: {}, created_at: '2026-11-13T00:00:00.000Z', deliveries: [{ id: 'd-1', event_id: 'ev-1', endpoint_id: 'ep-1', status: 'dead_letter', attempts: 11, next_attempt_at: null, last_error: 'timeout', created_at: '2026-11-13T00:00:00.000Z' }] },
          { id: 'ev-2', tenant_id: 't', event_type: 'order.completed', sequence: '2', payload: {}, created_at: '2026-11-13T00:00:00.000Z', deliveries: [{ id: 'd-2', event_id: 'ev-2', endpoint_id: 'ep-1', status: 'delivered', attempts: 1, next_attempt_at: null, last_error: null, created_at: '2026-11-13T00:00:00.000Z' }] },
        ],
        nextCursor: null,
      },
    });
    const rows = await new WebhookConsole(fake).deadLetterQueue(new Date('2026-11-13T12:00:00.000Z'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.delivery.id).toBe('d-1');
    expect(rows[0]?.daysRemaining).toBe(30);
    expect(fake.callsFor('events.list')).toHaveLength(1);
    const raw = toDeadLetterRows(fake.events.events, new Date('2026-11-13T12:00:00.000Z'));
    expect(raw).toHaveLength(1);
  });

  it('webhook registration requires https and at least one event type', async () => {
    const fake = new FakeAdminApiClient();
    const console_ = new WebhookConsole(fake);
    await expect(console_.registerEndpoint({ url: 'http://example.com/hook', eventTypes: ['order.completed'] })).rejects.toThrow('https');
    await expect(console_.registerEndpoint({ url: 'https://example.com/hook', eventTypes: [] })).rejects.toThrow('At least one event type');
  });
});
