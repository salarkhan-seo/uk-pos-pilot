/**
 * Live transport tests (Build-06, Objective 3).
 *
 * LiveSalesClient + LiveApprovalsClient + createHttpSyncTransport +
 * probeApi against a recording fetch stub — no live server. Proves the
 * request mapping (method, path, demo actor headers, Bearer token),
 * the void / approval request shapes, and that probeApi never throws.
 */
import { describe, expect, it } from 'vitest';
import {
  LiveApprovalsClient,
  LiveSalesClient,
  createHttpSyncTransport,
  probeApi,
  type ActorHeaders,
} from '../src/api/live-transport';
import type {
  FlushRequest,
  FlushResponse,
  HandshakeRequest,
  HandshakeResponse,
} from '../../api/src/modules/sync/sync.dto';

type SeenRequest = { url: string; init: RequestInit | undefined };

function recordingFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }): {
  fetchImpl: typeof fetch;
  seen: SeenRequest[];
} {
  const seen: SeenRequest[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    const { status, body } = handler(url, init);
    return { status, text: async () => JSON.stringify(body) } as unknown as Response;
  }) as typeof fetch;
  return { fetchImpl, seen };
}

function headersOf(seen: SeenRequest[]): Record<string, string> {
  return (seen[0]?.init?.headers ?? {}) as Record<string, string>;
}

function bodyOf(seen: SeenRequest[]): unknown {
  const raw = seen[0]?.init?.body;
  return typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
}

const ACTOR: ActorHeaders = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  locationId: 'loc-1',
  roles: ['cashier'],
};
const BASE = 'http://localhost:3127';

describe('LiveSalesClient — request mapping', () => {
  it('createOrder POSTs /v1/sales/orders with the demo actor headers and the line mapping', async () => {
    const { fetchImpl, seen } = recordingFetch(() => ({
      status: 200,
      body: { id: 'order-1', status: 'pending_payment', total_pence: '1200', order_number: 'R-1' },
    }));
    const client = new LiveSalesClient({ baseUrl: BASE, getActor: () => ACTOR, fetchImpl });
    const created = await client.createOrder({
      locationId: 'loc-1',
      registerId: 'register-1',
      customerId: null,
      lines: [{ variantId: 'live-v-1', quantity: '2', manualDiscountPence: '50' }],
    });
    expect(created.id).toBe('order-1');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`${BASE}/v1/sales/orders`);
    expect(seen[0]?.init?.method).toBe('POST');
    expect(headersOf(seen)).toMatchObject({
      'x-tenant-id': 'tenant-1',
      'x-user-id': 'user-1',
      'x-location-id': 'loc-1',
      'x-roles': 'cashier',
    });
    expect(headersOf(seen)['Authorization']).toBeUndefined();
    expect(bodyOf(seen)).toMatchObject({
      locationId: 'loc-1',
      registerId: 'register-1',
      lines: [{ variantId: 'live-v-1', quantity: '2', manualDiscountPence: '50' }],
    });
  });

  it('createOrder sends Authorization: Bearer when a token is provided (Build-10 — sales routes are AuthGuarded)', async () => {
    const { fetchImpl, seen } = recordingFetch(() => ({
      status: 200,
      body: { id: 'order-1', status: 'pending_payment', total_pence: '1200', order_number: 'R-1' },
    }));
    const client = new LiveSalesClient({
      baseUrl: BASE,
      getActor: () => ACTOR,
      getToken: () => 'ukp_test-key',
      fetchImpl,
    });
    await client.createOrder({
      locationId: 'loc-1',
      lines: [{ variantId: 'live-v-1', quantity: '1' }],
    });
    expect(headersOf(seen)['Authorization']).toBe('Bearer ukp_test-key');
    // The actor headers still ride along (x-tenant-id for the guard's
    // cross-tenant check, x-location-id for the API-key actor).
    expect(headersOf(seen)).toMatchObject({
      'x-tenant-id': 'tenant-1',
      'x-location-id': 'loc-1',
    });
  });

  it('addTender POSTs the tender and surfaces the card payment_attempt_id', async () => {
    const { fetchImpl, seen } = recordingFetch(() => ({
      status: 200,
      body: {
        id: 'tender-1',
        order_id: 'order-1',
        tender_type: 'card',
        amount_pence: '1200',
        payment_attempt_id: 'attempt-1',
      },
    }));
    const client = new LiveSalesClient({ baseUrl: BASE, getActor: () => ACTOR, fetchImpl });
    const added = await client.addTender('order-1', { tenderType: 'card', amountPence: '1200' });
    expect(added.payment_attempt_id).toBe('attempt-1');
    expect(seen[0]?.url).toBe(`${BASE}/v1/sales/orders/order-1/tenders`);
    expect(bodyOf(seen)).toMatchObject({ tenderType: 'card', amountPence: '1200' });
  });

  it('recordPaymentAttemptOutcome POSTs the outcome and the provider reference', async () => {
    const { fetchImpl, seen } = recordingFetch(() => ({ status: 200, body: { status: 'ok' } }));
    const client = new LiveSalesClient({ baseUrl: BASE, getActor: () => ACTOR, fetchImpl });
    await client.recordPaymentAttemptOutcome('attempt-1', {
      outcome: 'approved',
      providerReference: 'S700-2026-11-14/07',
    });
    expect(seen[0]?.url).toBe(`${BASE}/v1/sales/payment-attempts/attempt-1/outcome`);
    expect(bodyOf(seen)).toMatchObject({ outcome: 'approved', providerReference: 'S700-2026-11-14/07' });
  });

  it('completeOrder POSTs /complete and returns the order + receipt', async () => {
    const { fetchImpl, seen } = recordingFetch(() => ({
      status: 200,
      body: {
        order: { id: 'order-1', status: 'completed', total_pence: '1200' },
        receipt: {
          receiptNumber: 'R-1',
          orderId: 'order-1',
          issuedAt: '2026-11-14T10:00:00.000Z',
          lines: [
            {
              taxRateKind: 'standard',
              taxRatePercent: '20.00',
              grossPence: '1200',
              vatPence: '200',
              netPence: '1000',
            },
          ],
          totalPence: '1200',
          vatInvoiceNotice: 'This is not a VAT invoice',
        },
      },
    }));
    const client = new LiveSalesClient({ baseUrl: BASE, getActor: () => ACTOR, fetchImpl });
    const completed = await client.completeOrder('order-1');
    expect(completed.receipt.receiptNumber).toBe('R-1');
    expect(seen[0]?.url).toBe(`${BASE}/v1/sales/orders/order-1/complete`);
    expect(bodyOf(seen)).toEqual({});
  });

  it('voidOrder POSTs /void with the reason and the manager approval id', async () => {
    const { fetchImpl, seen } = recordingFetch(() => ({
      status: 200,
      body: { orderId: 'order-1', status: 'voided' },
    }));
    const client = new LiveSalesClient({ baseUrl: BASE, getActor: () => ACTOR, fetchImpl });
    const voided = await client.voidOrder('order-1', {
      reason: 'Manager void and retry',
      approvalEventsId: 'approval-1',
    });
    expect(voided.status).toBe('voided');
    expect(seen[0]?.url).toBe(`${BASE}/v1/sales/orders/order-1/void`);
    expect(bodyOf(seen)).toMatchObject({
      reason: 'Manager void and retry',
      approvalEventsId: 'approval-1',
    });
  });

  it('getReceipt GETs the server receipt for the order', async () => {
    const { fetchImpl, seen } = recordingFetch(() => ({
      status: 200,
      body: {
        receiptNumber: 'R-1',
        orderId: 'order-1',
        issuedAt: '2026-11-14T10:00:00.000Z',
        lines: [],
        totalPence: '1200',
        vatInvoiceNotice: 'This is not a VAT invoice',
      },
    }));
    const client = new LiveSalesClient({ baseUrl: BASE, getActor: () => ACTOR, fetchImpl });
    const receipt = await client.getReceipt('order-1');
    expect(receipt.receiptNumber).toBe('R-1');
    expect(seen[0]?.url).toBe(`${BASE}/v1/sales/orders/order-1/receipt`);
    expect(seen[0]?.init?.method).toBe('GET');
  });

  it('a non-2xx response throws with the server message', async () => {
    const { fetchImpl } = recordingFetch(() => ({ status: 404, body: { message: 'Resource not found' } }));
    const client = new LiveSalesClient({ baseUrl: BASE, getActor: () => ACTOR, fetchImpl });
    await expect(client.completeOrder('missing-order')).rejects.toThrow('Resource not found');
  });
});

describe('LiveApprovalsClient — request mapping', () => {
  it('createApproval POSTs /v1/approvals with the action, requester, PIN and order', async () => {
    const { fetchImpl, seen } = recordingFetch(() => ({
      status: 200,
      body: { id: 'approval-1', action: 'void_post_tender' },
    }));
    const client = new LiveApprovalsClient(BASE, () => ACTOR, fetchImpl);
    const approval = await client.createApproval({
      action: 'void_post_tender',
      requestedByUserId: 'cashier-1',
      approverPin: '1234',
      orderId: 'order-1',
      reason: 'W-12 manager void and retry',
    });
    expect(approval.id).toBe('approval-1');
    expect(seen[0]?.url).toBe(`${BASE}/v1/approvals`);
    expect(headersOf(seen)).toMatchObject({ 'x-user-id': 'user-1' });
    expect(bodyOf(seen)).toMatchObject({
      action: 'void_post_tender',
      requestedByUserId: 'cashier-1',
      approverPin: '1234',
      orderId: 'order-1',
    });
  });

  it('a rejected approval (wrong PIN) throws', async () => {
    const { fetchImpl } = recordingFetch(() => ({ status: 403, body: { message: 'Invalid PIN' } }));
    const client = new LiveApprovalsClient(BASE, () => ACTOR, fetchImpl);
    await expect(
      client.createApproval({
        action: 'void_post_tender',
        requestedByUserId: 'cashier-1',
        approverPin: '0000',
        orderId: 'order-1',
      }),
    ).rejects.toThrow('Invalid PIN');
  });
});

describe('createHttpSyncTransport — request mapping', () => {
  const handshakeBody: HandshakeResponse = {
    serverTime: '2026-11-14T10:00:00.000Z',
    tenantId: 'tenant-1',
    tenantStatus: 'active',
    registerId: 'register-1',
    registerName: 'Till 1',
    registerStatus: 'active',
    locationId: 'loc-1',
    catalogue: {
      variants: [],
      taxRates: [],
      priceBookEntries: [],
      barcodeMode: 'price_embedded',
      fullSnapshot: true,
    },
  };
  const flushBody: FlushResponse = { serverTime: '2026-11-14T10:00:00.000Z', outcomes: [] };

  it('handshake sends the Bearer token and the register id', async () => {
    const { fetchImpl, seen } = recordingFetch((url) => ({
      status: 200,
      body: url.endsWith('/handshake') ? handshakeBody : flushBody,
    }));
    const transport = createHttpSyncTransport({
      baseUrl: BASE,
      getToken: () => 'sess_live',
      fetchImpl,
    });
    const request: HandshakeRequest = { registerId: 'register-1', since: null };
    const response = await transport.handshake(request);
    expect(response.serverTime).toBe('2026-11-14T10:00:00.000Z');
    expect(seen[0]?.url).toBe(`${BASE}/v1/sync/handshake`);
    expect(headersOf(seen)['Authorization']).toBe('Bearer sess_live');
    expect(bodyOf(seen)).toMatchObject({ registerId: 'register-1' });
  });

  it('flush sends the queued orders with no Bearer token when logged out', async () => {
    const { fetchImpl, seen } = recordingFetch(() => ({ status: 200, body: flushBody }));
    const transport = createHttpSyncTransport({ baseUrl: BASE, getToken: () => null, fetchImpl });
    const request: FlushRequest = {
      registerId: 'register-1',
      orders: [
        {
          idempotencyKey: 'key-1',
          locationId: 'loc-1',
          registerId: 'register-1',
          tenderTotalPence: '1200',
          createdAt: '2026-11-14T10:00:00.000Z',
          lines: [],
        },
      ],
    };
    await transport.flush(request);
    expect(seen[0]?.url).toBe(`${BASE}/v1/sync/flush`);
    expect(headersOf(seen)['Authorization']).toBeUndefined();
    expect(bodyOf(seen)).toMatchObject({ registerId: 'register-1' });
  });
});

describe('probeApi', () => {
  it('returns true on a 2xx from /sales/status', async () => {
    const { fetchImpl, seen } = recordingFetch(() => ({ status: 200, body: { module: 'sales', status: 'ok' } }));
    expect(await probeApi(BASE, fetchImpl)).toBe(true);
    expect(seen[0]?.url).toBe(`${BASE}/sales/status`);
  });

  it('returns false on a 5xx and never throws when the fetch rejects', async () => {
    const { fetchImpl } = recordingFetch(() => ({ status: 500, body: { message: 'boom' } }));
    expect(await probeApi(BASE, fetchImpl)).toBe(false);
    const throwing = (async () => {
      throw new Error('connection refused');
    }) as typeof fetch;
    expect(await probeApi(BASE, throwing)).toBe(false);
  });
});

describe('LiveSalesClient — age verifications (Build-09 Objective 2)', () => {
  const verification = {
    variant_id: 'v-c25',
    verified_age_threshold: 25,
    verified_by_user_id: 'user-1',
    verified_at: '2026-11-14T10:00:00.000Z',
  };

  it('addTender sends age_verifications when provided and omits the key when not', async () => {
    const { fetchImpl, seen } = recordingFetch(() => ({
      status: 200,
      body: { id: 'tender-1', amount_pence: '800' },
    }));
    const client = new LiveSalesClient({ baseUrl: BASE, getActor: () => ACTOR, fetchImpl });
    await client.addTender('order-1', {
      tenderType: 'cash',
      amountPence: '800',
      age_verifications: [verification],
    });
    expect(seen[0]?.url).toBe(`${BASE}/v1/sales/orders/order-1/tenders`);
    expect(bodyOf(seen)).toMatchObject({ age_verifications: [verification] });

    const second = recordingFetch(() => ({
      status: 200,
      body: { id: 'tender-2', amount_pence: '800' },
    }));
    const plainClient = new LiveSalesClient({
      baseUrl: BASE,
      getActor: () => ACTOR,
      fetchImpl: second.fetchImpl,
    });
    await plainClient.addTender('order-1', { tenderType: 'cash', amountPence: '800' });
    expect(bodyOf(second.seen)).not.toHaveProperty('age_verifications');
  });

  it('completeOrder sends { age_verifications } when provided and {} when not', async () => {
    const { fetchImpl, seen } = recordingFetch(() => ({
      status: 200,
      body: { order: { id: 'order-1', status: 'completed' }, receipt: null },
    }));
    const client = new LiveSalesClient({ baseUrl: BASE, getActor: () => ACTOR, fetchImpl });
    await client.completeOrder('order-1', [verification]);
    expect(seen[0]?.url).toBe(`${BASE}/v1/sales/orders/order-1/complete`);
    expect(bodyOf(seen)).toEqual({ age_verifications: [verification] });

    const second = recordingFetch(() => ({
      status: 200,
      body: { order: { id: 'order-1', status: 'completed' }, receipt: null },
    }));
    const plainClient = new LiveSalesClient({
      baseUrl: BASE,
      getActor: () => ACTOR,
      fetchImpl: second.fetchImpl,
    });
    await plainClient.completeOrder('order-1');
    expect(bodyOf(second.seen)).toEqual({});
  });

  it('surfaces a nested error.message (e.g. the 422 AGE_VERIFICATION_REQUIRED body) instead of a generic status', async () => {
    const { fetchImpl } = recordingFetch(() => ({
      status: 422,
      body: {
        error: {
          code: 'AGE_VERIFICATION_REQUIRED',
          message: 'Age verification required for variant(s): v-c25',
          variantIds: ['v-c25'],
        },
      },
    }));
    const client = new LiveSalesClient({ baseUrl: BASE, getActor: () => ACTOR, fetchImpl });
    await expect(
      client.completeOrder('order-1'),
    ).rejects.toThrow('Age verification required for variant(s): v-c25');
  });
});
