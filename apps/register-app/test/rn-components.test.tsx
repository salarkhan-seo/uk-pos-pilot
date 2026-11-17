/**
 * React Native component tests (Build-07, Objective 2).
 *
 * The RN host components are mocked to string types (no native
 * runtime — `react-native` is never loaded at test time), and the
 * screens are rendered with `react-test-renderer`. Every assertion
 * is a state-binding assertion: the components read from the real
 * controllers (`SellController`, `SplitTenderController`,
 * `AgeVerificationGate`, `TillSessionController`,
 * `StripeTerminalNativeBridge`) and the tests prove the rendered
 * output and the button handlers reflect controller state — the
 * components never re-implement controller logic.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import React from 'react';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

import type {
  DiscoverReadersParams,
  PaymentIntent,
  Reader,
  StripeError,
} from '@stripe/stripe-terminal-react-native';
import { InMemoryStorageAdapter } from '../src/storage/memory-storage';
import type { CatalogCacheEntry } from '../src/storage/storage-adapter';
import { AgeVerificationGate } from '../src/sell/age-gate';
import { SellController } from '../src/sell/sell-controller';
import { SplitTenderController } from '../src/sell/split-tender';
import { TillSessionController, type ReportingClient } from '../src/session/till-session';
import { StripeTerminalNativeBridge } from '../src/rn/stripe-terminal-bridge';
import type { StripeTerminalSdk } from '../src/rn/stripe-terminal-contract';
import { SellScreenRN } from '../src/rn/components/SellScreenRN';
import { SplitTenderModalRN } from '../src/rn/components/SplitTenderModalRN';
import { W12UnknownPaymentModalRN } from '../src/rn/components/W12UnknownPaymentModalRN';
import { Challenge25ModalRN } from '../src/rn/components/Challenge25ModalRN';
import { ManagerPinModalRN } from '../src/rn/components/ManagerPinModalRN';
import { SessionCloseScreenRN } from '../src/rn/components/SessionCloseScreenRN';
import { HardwareStatusDrawerRN } from '../src/rn/components/HardwareStatusDrawerRN';
import { UNKNOWN_PAYMENT_MESSAGE } from '../src/constants';

// -- helpers ---------------------------------------------------------------

function textOf(node: ReactTestInstance): string {
  const flatten = (value: unknown): string => {
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value);
    }
    if (Array.isArray(value)) {
      return value.map(flatten).join('');
    }
    if (value !== null && typeof value === 'object' && 'props' in (value as object)) {
      return flatten((value as { props: { children?: unknown } }).props.children);
    }
    return '';
  };
  return flatten(node.props.children);
}

function byTestId(root: ReactTestInstance, testID: string): ReactTestInstance {
  return root.findByProps({ testID });
}

function hasTestId(root: ReactTestInstance, testID: string): boolean {
  return root.findAllByProps({ testID }).length > 0;
}

async function renderEl(element: React.ReactElement): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(element);
  });
  if (renderer === undefined) {
    throw new Error('render failed');
  }
  return renderer;
}

async function press(instance: ReactTestInstance): Promise<void> {
  await act(async () => {
    await instance.props.onPress();
  });
}

async function typeText(instance: ReactTestInstance, value: string): Promise<void> {
  await act(async () => {
    instance.props.onChangeText(value);
  });
}

// -- shared fixtures --------------------------------------------------------

function catalogEntry(overrides: Partial<CatalogCacheEntry> = {}): CatalogCacheEntry {
  return {
    variantId: 'variant-1',
    sku: 'SKU-001',
    barcode: '5012345678900',
    name: 'Widget',
    pricePence: 1200n,
    priceBookPricePence: null,
    taxRateKind: 'standard',
    taxRatePercent: '20.00',
    stockOnHand: 10n,
    stockComputedAt: '2026-11-14T10:00:00.000Z',
    requiresChallenge25: false,
    minAge: null,
    updatedAt: '2026-11-14T10:00:00.000Z',
    ...overrides,
  };
}

async function makeSellController(
  entries: CatalogCacheEntry[],
  isOnline = true,
): Promise<{ storage: InMemoryStorageAdapter; sell: SellController }> {
  const storage = new InMemoryStorageAdapter();
  await storage.upsertCatalog(entries);
  const sell = new SellController(storage, {
    tenantId: 't1',
    locationId: 'l1',
    registerId: 'r1',
    roles: ['cashier'],
    barcodeMode: null,
    isOnline: () => isOnline,
    offlineSinceMs: () => null,
    now: () => new Date('2026-11-14T10:00:00.000Z'),
  });
  return { storage, sell };
}

/** Minimal fake SDK for the drawer (discovery/connection only). */
class DrawerFakeSdk implements StripeTerminalSdk {
  discoveredReaders: Reader.Type[] = [];
  connectedReader: Reader.Type | null = null;

  async discoverReaders(params: DiscoverReadersParams): Promise<{ error?: StripeError }> {
    this.discoveredReaders =
      params.discoveryMethod === 'internet'
        ? [
            {
              id: 'reader-s700',
              label: 'S700-001',
              deviceType: 'stripeS700',
              serialNumber: 'SN-S700',
              batteryLevel: 0.87,
              deviceSoftwareVersion: '2.14.0',
              locationStatus: 'set',
              status: 'online',
            },
          ]
        : [
            {
              id: 'reader-wp3',
              label: 'WP3-001',
              deviceType: 'wisePad3',
              serialNumber: 'SN-WP3',
              batteryLevel: 0.5,
              deviceSoftwareVersion: '1.9.3',
              locationStatus: 'set',
              status: 'online',
            },
          ];
    return {};
  }

  async connectReader(params: {
    reader: Reader.Type;
  }): Promise<{ reader: Reader.Type; error?: undefined } | { reader?: undefined; error: StripeError }> {
    this.connectedReader = params.reader;
    return { reader: params.reader };
  }

  async disconnectReader(): Promise<{ error?: StripeError } | undefined> {
    this.connectedReader = null;
    return {};
  }

  async createPaymentIntent(): Promise<never> {
    throw new Error('not used by the drawer');
  }

  async collectPaymentMethod(): Promise<never> {
    throw new Error('not used by the drawer');
  }

  async processPaymentIntent(): Promise<never> {
    throw new Error('not used by the drawer');
  }

  async cancelCollectPaymentMethod(): Promise<{ error?: StripeError }> {
    return {};
  }

  async getConnectedReader(): Promise<Reader.Type | null> {
    return this.connectedReader;
  }
}

function makeBridge(sdk: DrawerFakeSdk, isOnline = true): StripeTerminalNativeBridge {
  return new StripeTerminalNativeBridge(sdk, {
    isOnline: () => isOnline,
    locationId: 'loc_test_1',
    collectTimeoutMs: 60,
  });
}

// -- SellScreenRN -----------------------------------------------------------

describe('SellScreenRN', () => {
  it('renders basket lines and the total from the controller', async () => {
    const { sell } = await makeSellController([catalogEntry()]);
    sell.addLine(catalogEntry(), 2n);
    const bridge = makeBridge(new DrawerFakeSdk());
    const renderer = await renderEl(
      <SellScreenRN
        sell={sell}
        bridge={bridge}
        isOnline={() => true}
        onCardCheckout={async () => ({ outcome: 'succeeded', paymentIntentId: 'pi_1' })}
        onCashCheckout={async () => ({ idempotencyKey: 'k', totalPence: 2400n })}
        onUnknownPayment={() => undefined}
      />,
    );
    const root = renderer.root;
    expect(textOf(byTestId(root, 'sell-line-0'))).toContain('Widget');
    expect(textOf(byTestId(root, 'sell-line-0'))).toContain('£24.00');
    expect(textOf(byTestId(root, 'sell-total'))).toBe('Total: £24.00');
  });

  it('search finds an entry and tapping it adds a line', async () => {
    const { sell } = await makeSellController([catalogEntry()]);
    const bridge = makeBridge(new DrawerFakeSdk());
    const renderer = await renderEl(
      <SellScreenRN
        sell={sell}
        bridge={bridge}
        isOnline={() => true}
        onCardCheckout={async () => ({ outcome: 'succeeded', paymentIntentId: 'pi_1' })}
        onCashCheckout={async () => ({ idempotencyKey: 'k', totalPence: 1200n })}
        onUnknownPayment={() => undefined}
      />,
    );
    const root = renderer.root;
    await typeText(byTestId(root, 'sell-search-input'), 'widg');
    await press(byTestId(root, 'sell-search-button'));
    expect(textOf(byTestId(root, 'sell-search-result-SKU-001'))).toContain('Widget');
    await press(byTestId(root, 'sell-search-result-SKU-001'));
    expect(textOf(byTestId(root, 'sell-total'))).toBe('Total: £12.00');
  });

  it('offline shows the D-06 card banner and disables the card button', async () => {
    const { sell } = await makeSellController([catalogEntry()], false);
    sell.addLine(catalogEntry(), 1n);
    const bridge = makeBridge(new DrawerFakeSdk(), false);
    const renderer = await renderEl(
      <SellScreenRN
        sell={sell}
        bridge={bridge}
        isOnline={() => false}
        onCardCheckout={async () => ({ outcome: 'succeeded', paymentIntentId: 'pi_1' })}
        onCashCheckout={async () => ({ idempotencyKey: 'k', totalPence: 1200n })}
        onUnknownPayment={() => undefined}
      />,
    );
    const root = renderer.root;
    expect(textOf(byTestId(root, 'sell-card-offline-banner'))).toContain(
      'offline card is deferred (D-06)',
    );
    expect(byTestId(root, 'sell-checkout-card').props.disabled).toBe(true);
  });

  it('shows the age-gate banner when a Challenge 25 line is unverified', async () => {
    const { sell } = await makeSellController([
      catalogEntry({ requiresChallenge25: true, minAge: 18 }),
    ]);
    sell.addLine(catalogEntry({ requiresChallenge25: true, minAge: 18 }), 1n);
    const bridge = makeBridge(new DrawerFakeSdk());
    const renderer = await renderEl(
      <SellScreenRN
        sell={sell}
        bridge={bridge}
        isOnline={() => true}
        onCardCheckout={async () => ({ outcome: 'succeeded', paymentIntentId: 'pi_1' })}
        onCashCheckout={async () => ({ idempotencyKey: 'k', totalPence: 1200n })}
        onUnknownPayment={() => undefined}
      />,
    );
    expect(hasTestId(renderer.root, 'sell-age-gate-banner')).toBe(true);
  });

  it('card checkout reports an unknown outcome to the host (W-12)', async () => {
    const { sell } = await makeSellController([catalogEntry()]);
    sell.addLine(catalogEntry(), 1n);
    const sdk = new DrawerFakeSdk();
    const bridge = makeBridge(sdk);
    const [reader] = await bridge.discover('S700');
    await bridge.connect('S700', reader as Reader.Type);
    const onUnknownPayment = vi.fn();
    const onCardCheckout = vi.fn(async () => ({
      outcome: 'unknown' as const,
      paymentIntentId: 'pi_unknown_1',
      reason: 'timed out — W-12',
    }));
    const renderer = await renderEl(
      <SellScreenRN
        sell={sell}
        bridge={bridge}
        isOnline={() => true}
        onCardCheckout={onCardCheckout}
        onCashCheckout={async () => ({ idempotencyKey: 'k', totalPence: 1200n })}
        onUnknownPayment={onUnknownPayment}
      />,
    );
    await press(byTestId(renderer.root, 'sell-checkout-card'));
    expect(onCardCheckout).toHaveBeenCalledWith(1200n);
    expect(onUnknownPayment).toHaveBeenCalledWith(
      'pi_unknown_1',
      expect.objectContaining({ outcome: 'unknown' }),
    );
    expect(textOf(byTestId(renderer.root, 'sell-card-outcome'))).toContain('unknown');
  });

  it('disables the card button while the reader is not ready', async () => {
    const { sell } = await makeSellController([catalogEntry()]);
    sell.addLine(catalogEntry(), 1n);
    const bridge = makeBridge(new DrawerFakeSdk());
    const renderer = await renderEl(
      <SellScreenRN
        sell={sell}
        bridge={bridge}
        isOnline={() => true}
        onCardCheckout={async () => ({ outcome: 'succeeded', paymentIntentId: 'pi_1' })}
        onCashCheckout={async () => ({ idempotencyKey: 'k', totalPence: 1200n })}
        onUnknownPayment={() => undefined}
      />,
    );
    expect(textOf(byTestId(renderer.root, 'sell-reader-status'))).toContain('disconnected');
    expect(byTestId(renderer.root, 'sell-checkout-card').props.disabled).toBe(true);
  });
});

// -- SplitTenderModalRN + W12UnknownPaymentModalRN ---------------------------

describe('SplitTenderModalRN', () => {
  it('adds tenders and shows tendered / remaining / complete', async () => {
    const split = new SplitTenderController(1200n);
    const renderer = await renderEl(<SplitTenderModalRN split={split} />);
    const root = renderer.root;
    expect(textOf(byTestId(root, 'split-total'))).toBe('Total: £12.00');
    expect(textOf(byTestId(root, 'split-remaining'))).toBe('Remaining: £12.00');
    await typeText(byTestId(root, 'split-amount-input'), '7.00');
    await press(byTestId(root, 'split-add-tender'));
    expect(textOf(byTestId(root, 'split-tendered'))).toBe('Tendered: £7.00');
    expect(textOf(byTestId(root, 'split-remaining'))).toBe('Remaining: £5.00');
    await typeText(byTestId(root, 'split-amount-input'), '5.00');
    await press(byTestId(root, 'split-add-tender'));
    expect(hasTestId(renderer.root, 'split-complete')).toBe(true);
  });

  it('shows the 5-minute timeout state once the window passes', async () => {
    let now = 1_000;
    const split = new SplitTenderController(1200n, () => now);
    split.addTender({ kind: 'cash', amountPence: 100n });
    now = 1_000 + 5 * 60 * 1000 + 1;
    const renderer = await renderEl(<SplitTenderModalRN split={split} />);
    expect(textOf(byTestId(renderer.root, 'split-timed-out'))).toContain('timed out');
  });

  it('locked on unknown: renders the W-12 modal verbatim, then unlocks on poll', async () => {
    const split = new SplitTenderController(1200n);
    split.markCardAttemptUnknown('att_1');
    const onResolved = vi.fn();
    const renderer = await renderEl(
      <SplitTenderModalRN split={split} onUnknownResolved={onResolved} />,
    );
    const root = renderer.root;
    expect(textOf(byTestId(root, 'w12-message'))).toBe(UNKNOWN_PAYMENT_MESSAGE);
    expect(textOf(byTestId(root, 'w12-attempt-id'))).toContain('att_1');
    // All four resolution actions are offered.
    for (const action of [
      'poll_provider_status',
      'reconcile_terminal',
      'manager_void_or_retry',
      'manager_standalone_reference',
    ]) {
      expect(hasTestId(root, `w12-action-${action}`)).toBe(true);
    }
    // Manager actions are disabled until an approval reference is entered.
    expect(byTestId(root, 'w12-action-manager_void_or_retry').props.disabled).toBe(true);
    await press(byTestId(root, 'w12-action-poll_provider_status'));
    expect(onResolved).toHaveBeenCalledWith('poll_provider_status');
    expect(split.isLockedOnUnknown).toBe(false);
    expect(hasTestId(renderer.root, 'split-tender-modal')).toBe(true);
  });

  it('manager resolution requires an approval reference', async () => {
    const split = new SplitTenderController(1200n);
    split.markCardAttemptUnknown('att_2');
    const renderer = await renderEl(<SplitTenderModalRN split={split} />);
    const root = renderer.root;
    await typeText(byTestId(root, 'w12-approval-ref'), 'APPR-9');
    await press(byTestId(root, 'w12-action-manager_void_or_retry'));
    expect(split.isLockedOnUnknown).toBe(false);
  });
});

describe('W12UnknownPaymentModalRN', () => {
  it('renders the verbatim message and all four actions', async () => {
    const onResolve = vi.fn();
    const renderer = await renderEl(
      <W12UnknownPaymentModalRN
        message={UNKNOWN_PAYMENT_MESSAGE}
        attemptId="att_9"
        onResolve={onResolve}
      />,
    );
    const root = renderer.root;
    expect(textOf(byTestId(root, 'w12-message'))).toBe(
      'Payment outcome unknown — do not hand over goods on card until checked',
    );
    await press(byTestId(root, 'w12-action-reconcile_terminal'));
    expect(onResolve).toHaveBeenCalledWith('reconcile_terminal', undefined);
  });
});

// -- Challenge25ModalRN -----------------------------------------------------

describe('Challenge25ModalRN', () => {
  const lines = [{ variantId: 'variant-1', sku: 'SKU-001', requiresChallenge25: true }];

  it('confirms verification and records only the threshold', async () => {
    const gate = new AgeVerificationGate();
    const onConfirmed = vi.fn();
    const renderer = await renderEl(
      <Challenge25ModalRN gate={gate} lines={lines} onConfirmed={onConfirmed} />,
    );
    await press(byTestId(renderer.root, 'challenge25-confirm'));
    expect(gate.verifiedAgeThreshold).toBe(25);
    expect(onConfirmed).toHaveBeenCalledWith(25);
    expect(textOf(byTestId(renderer.root, 'challenge25-verified'))).toContain('age 25+');
  });

  it('logs a refusal with a reason; refuses without a reason', async () => {
    const gate = new AgeVerificationGate();
    const onRefused = vi.fn();
    const renderer = await renderEl(
      <Challenge25ModalRN gate={gate} lines={lines} onRefused={onRefused} />,
    );
    const root = renderer.root;
    await press(byTestId(root, 'challenge25-refuse-SKU-001'));
    expect(textOf(byTestId(root, 'challenge25-error'))).toContain('reason is required');
    expect(gate.listRefusals()).toHaveLength(0);
    await typeText(byTestId(root, 'challenge25-refusal-reason-SKU-001'), 'No ID shown');
    await press(byTestId(root, 'challenge25-refuse-SKU-001'));
    expect(gate.listRefusals()).toHaveLength(1);
    expect(gate.listRefusals()[0]).toEqual(
      expect.objectContaining({ sku: 'SKU-001', reason: 'No ID shown' }),
    );
    expect(onRefused).toHaveBeenCalledWith(lines[0], 'No ID shown');
    expect(textOf(byTestId(renderer.root, 'challenge25-refusal-0'))).toContain('No ID shown');
  });
});

// -- ManagerPinModalRN ------------------------------------------------------

describe('ManagerPinModalRN', () => {
  async function renderPin(onSubmitPin: (pin: string) => Promise<boolean> | boolean) {
    const onVerified = vi.fn();
    const onCancel = vi.fn();
    const renderer = await renderEl(
      <ManagerPinModalRN
        title="Approve a manual discount"
        onSubmitPin={onSubmitPin}
        onVerified={onVerified}
        onCancel={onCancel}
      />,
    );
    return { renderer, onVerified, onCancel };
  }

  async function typePin(root: ReactTestInstance, pin: string): Promise<void> {
    for (const digit of pin) {
      await press(byTestId(root, `manager-pin-digit-${digit}`));
    }
  }

  it('masks the PIN and clears it after a wrong attempt', async () => {
    const onSubmitPin = vi.fn(async () => false);
    const { renderer } = await renderPin(onSubmitPin);
    const root = renderer.root;
    await typePin(root, '1234');
    expect(textOf(byTestId(root, 'manager-pin-display'))).toBe('••••');
    expect(textOf(byTestId(root, 'manager-pin-display'))).not.toContain('1234');
    await press(byTestId(root, 'manager-pin-submit'));
    expect(onSubmitPin).toHaveBeenCalledWith('1234');
    expect(textOf(byTestId(root, 'manager-pin-error'))).toContain('Incorrect PIN');
    expect(textOf(byTestId(root, 'manager-pin-display'))).toBe('Enter PIN');
  });

  it('calls onVerified when the PIN is accepted', async () => {
    const onSubmitPin = vi.fn(async (pin: string) => pin === '4321');
    const { renderer, onVerified } = await renderPin(onSubmitPin);
    const root = renderer.root;
    await typePin(root, '4321');
    await press(byTestId(root, 'manager-pin-submit'));
    expect(onVerified).toHaveBeenCalledTimes(1);
  });
});

// -- SessionCloseScreenRN ---------------------------------------------------

describe('SessionCloseScreenRN', () => {
  function fakeReporting(): ReportingClient & {
    calls: { open: unknown[]; end: unknown[]; close: unknown[] };
  } {
    const calls: { open: unknown[]; end: unknown[]; close: unknown[] } = {
      open: [],
      end: [],
      close: [],
    };
    return {
      calls,
      openSession: async (input) => {
        calls.open.push(input);
        return { sessionId: 'sess-1', warning: null };
      },
      recordCashMovement: async () => ({ movementId: 'mov-1' }),
      endSession: async (sessionId) => {
        calls.end.push(sessionId);
        return { sessionId, expectedCashPence: 7400n };
      },
      closeSession: async () => {
        calls.close.push(true);
        return { sessionId: 'sess-1', zReportId: 'z-1', zNumber: 'Z-001' };
      },
      getZReport: async (zReportId) => ({ zReportId, zNumber: 'Z-001' }),
    };
  }

  it('opens, ends, and closes a session, issuing the Z-report', async () => {
    const reporting = fakeReporting();
    const till = new TillSessionController(reporting, 'r1');
    const renderer = await renderEl(<SessionCloseScreenRN till={till} />);
    const root = renderer.root;
    expect(textOf(byTestId(root, 'session-state'))).toContain('closed');
    await typeText(byTestId(root, 'till-float-input'), '50.00');
    await press(byTestId(root, 'till-open'));
    expect(textOf(byTestId(renderer.root, 'session-state'))).toContain('open');
    await press(byTestId(renderer.root, 'till-end'));
    expect(textOf(byTestId(renderer.root, 'session-expected-cash'))).toContain('£74.00');
    await typeText(byTestId(renderer.root, 'till-counted-input'), '74.00');
    await press(byTestId(renderer.root, 'till-close'));
    expect(textOf(byTestId(renderer.root, 'session-z-report'))).toContain('Z-001');
    expect(reporting.calls.close).toHaveLength(1);
  });

  it('zero float without a manager override is blocked; with one it opens', async () => {
    const reporting = fakeReporting();
    const till = new TillSessionController(reporting, 'r1');
    const renderer = await renderEl(<SessionCloseScreenRN till={till} />);
    const root = renderer.root;
    await typeText(byTestId(root, 'till-float-input'), '0.00');
    await press(byTestId(root, 'till-open'));
    expect(textOf(byTestId(renderer.root, 'session-error'))).toContain('manager override');
    expect(textOf(byTestId(renderer.root, 'session-state'))).toContain('closed');
    await typeText(byTestId(renderer.root, 'till-approval-ref'), 'APPR-1');
    await press(byTestId(renderer.root, 'till-open'));
    expect(textOf(byTestId(renderer.root, 'session-state'))).toContain('open');
    expect(textOf(byTestId(renderer.root, 'session-zero-float-warning'))).toContain(
      'no float',
    );
  });

  it('a variance above the D-08 threshold needs manager approval', async () => {
    const reporting = fakeReporting();
    const till = new TillSessionController(reporting, 'r1');
    const renderer = await renderEl(<SessionCloseScreenRN till={till} />);
    const root = renderer.root;
    await typeText(byTestId(root, 'till-float-input'), '50.00');
    await press(byTestId(root, 'till-open'));
    await press(byTestId(renderer.root, 'till-end'));
    // Expected £74.00; counted £60.00 is £14.00 short — above the £10 floor.
    await typeText(byTestId(renderer.root, 'till-counted-input'), '60.00');
    expect(textOf(byTestId(renderer.root, 'session-variance'))).toContain('-£14.00');
    expect(hasTestId(renderer.root, 'session-variance-needs-approval')).toBe(true);
    await typeText(byTestId(renderer.root, 'till-variance-reason'), 'Till short');
    await press(byTestId(renderer.root, 'till-close'));
    expect(textOf(byTestId(renderer.root, 'session-error'))).toContain('manager approval');
    expect(reporting.calls.close).toHaveLength(0);
    await typeText(byTestId(renderer.root, 'till-close-approval'), 'APPR-2');
    await press(byTestId(renderer.root, 'till-close'));
    expect(textOf(byTestId(renderer.root, 'session-z-report'))).toContain('Z-001');
  });
});

// -- HardwareStatusDrawerRN -------------------------------------------------

describe('HardwareStatusDrawerRN', () => {
  it('discovers, connects, and disconnects an S700', async () => {
    const sdk = new DrawerFakeSdk();
    const bridge = makeBridge(sdk);
    const renderer = await renderEl(
      <HardwareStatusDrawerRN bridge={bridge} isOnline={() => true} />,
    );
    const root = renderer.root;
    expect(textOf(byTestId(root, 'hardware-status'))).toContain('disconnected');
    await press(byTestId(root, 'hardware-discover'));
    expect(hasTestId(renderer.root, 'hardware-connect-reader-s700')).toBe(true);
    await press(byTestId(renderer.root, 'hardware-connect-reader-s700'));
    expect(textOf(byTestId(renderer.root, 'hardware-status'))).toContain('ready');
    expect(textOf(byTestId(renderer.root, 'hardware-battery'))).toContain('87%');
    expect(textOf(byTestId(renderer.root, 'hardware-firmware'))).toContain('2.14.0');
    await press(byTestId(renderer.root, 'hardware-disconnect'));
    expect(textOf(byTestId(renderer.root, 'hardware-status'))).toContain('disconnected');
  });

  it('shows the D-06 offline banner while offline', async () => {
    const sdk = new DrawerFakeSdk();
    const bridge = makeBridge(sdk, false);
    const renderer = await renderEl(
      <HardwareStatusDrawerRN bridge={bridge} isOnline={() => false} />,
    );
    expect(textOf(byTestId(renderer.root, 'hardware-offline-banner'))).toContain(
      'offline card is deferred (D-06)',
    );
  });
});
