/**
 * StripeTerminalNativeBridge tests (Build-07, Objective 2).
 *
 * The bridge is tested against a fake SDK implementing the injected
 * `StripeTerminalSdk` contract — no native runtime, no device, no
 * network. The fake scripts discovery, connection, and the card
 * collection behaviours (success / decline / cancel / hang /
 * SDK-error) so every W-12 path is deterministic.
 *
 * Real SDK in this sandbox: @stripe/stripe-terminal-react-native
 * 0.0.1-beta.34, react-native 0.88.1, react 19.3.1 — all installed
 * and typechecked; the bridge imports only their TYPES.
 */
import { describe, expect, it } from 'vitest';
import type {
  CollectPaymentMethodParams,
  ConnectReaderParams,
  DiscoverReadersParams,
  PaymentIntent,
  Reader,
  StripeError,
} from '@stripe/stripe-terminal-react-native';
import { OfflineBlockedError } from '../src/offline/offline-guards';
import { StripeTerminalNativeBridge } from '../src/rn/stripe-terminal-bridge';
import type { StripeTerminalSdk } from '../src/rn/stripe-terminal-contract';

type FakeBehaviour =
  | 'succeed'
  | 'decline'
  | 'cancel'
  | 'hang-collect'
  | 'hang-process'
  | 'error-unknown'
  | 'error-failed';

function stripeError(code: string, message: string): StripeError {
  const error = new Error(message) as StripeError;
  error.name = 'StripeError';
  error.code = code as StripeError['code'];
  error.nativeErrorCode = code;
  error.metadata = {};
  return error;
}

function fakeReader(deviceType: Reader.Type['deviceType'], label: string): Reader.Type {
  return {
    id: `reader-${label}`,
    label,
    deviceType,
    serialNumber: `SN-${label}`,
    batteryLevel: 0.87,
    deviceSoftwareVersion: '2.14.0',
    locationStatus: 'set',
    status: 'online',
  };
}

function fakeIntent(overrides: Partial<PaymentIntent.Type> = {}): PaymentIntent.Type {
  return {
    id: 'pi_test_1',
    amount: 1200,
    created: '2026-11-14T10:00:00.000Z',
    livemode: false,
    sdkUuid: 'sdk-test-1',
    status: 'requiresPaymentMethod',
    ...overrides,
  };
}

/** Deterministic stand-in for the real `useStripeTerminal()` return value. */
class FakeStripeTerminalSdk implements StripeTerminalSdk {
  discoveredReaders: Reader.Type[] = [];
  connectedReader: Reader.Type | null = null;
  behaviour: FakeBehaviour = 'succeed';
  collectCalls = 0;
  processCalls = 0;
  createIntentCalls = 0;
  cancelCollectCalls = 0;
  discoverParams: DiscoverReadersParams[] = [];
  connectParams: ConnectReaderParams[] = [];

  async discoverReaders(params: DiscoverReadersParams): Promise<{ error?: StripeError }> {
    this.discoverParams.push(params);
    this.discoveredReaders =
      params.discoveryMethod === 'internet'
        ? [fakeReader('stripeS700', 'S700-001')]
        : [fakeReader('wisePad3', 'WP3-001')];
    return {};
  }

  async connectReader(
    params: ConnectReaderParams,
  ): Promise<{ reader: Reader.Type; error?: undefined } | { reader?: undefined; error: StripeError }> {
    this.connectParams.push(params);
    this.connectedReader = params.reader;
    return { reader: params.reader };
  }

  async disconnectReader(): Promise<{ error?: StripeError } | undefined> {
    this.connectedReader = null;
    return {};
  }

  async createPaymentIntent(params: {
    amount: number;
    currency: string;
  }): Promise<
    | { paymentIntent: PaymentIntent.Type; error?: undefined }
    | { paymentIntent?: undefined; error: StripeError }
  > {
    this.createIntentCalls += 1;
    return { paymentIntent: fakeIntent({ amount: params.amount, status: 'requiresPaymentMethod' }) };
  }

  async collectPaymentMethod(
    params: CollectPaymentMethodParams,
  ): Promise<
    | { paymentIntent: PaymentIntent.Type; error?: undefined }
    | { paymentIntent?: undefined; error: StripeError }
  > {
    this.collectCalls += 1;
    switch (this.behaviour) {
      case 'hang-collect':
        return new Promise(() => undefined);
      case 'cancel':
        return { error: stripeError('CANCELED', 'Payment canceled') };
      case 'decline':
        return { error: stripeError('DECLINED_BY_READER', 'Card declined by reader') };
      case 'error-unknown':
        return {
          error: stripeError('READER_COMMUNICATION_ERROR', 'Reader stopped responding'),
        };
      case 'error-failed':
        return {
          error: stripeError('NOT_CONNECTED_TO_READER', 'No reader connected'),
        };
      default:
        return {
          paymentIntent: { ...params.paymentIntent, status: 'requiresConfirmation' },
        };
    }
  }

  async processPaymentIntent(params: {
    paymentIntent: PaymentIntent.Type;
  }): Promise<
    | { paymentIntent: PaymentIntent.Type; error?: undefined }
    | { paymentIntent?: undefined; error: StripeError }
  > {
    this.processCalls += 1;
    if (this.behaviour === 'hang-process') {
      return new Promise(() => undefined);
    }
    return { paymentIntent: { ...params.paymentIntent, status: 'succeeded' } };
  }

  async cancelCollectPaymentMethod(): Promise<{ error?: StripeError }> {
    this.cancelCollectCalls += 1;
    return {};
  }

  async getConnectedReader(): Promise<Reader.Type | null> {
    return this.connectedReader;
  }
}

function makeBridge(
  sdk: FakeStripeTerminalSdk,
  overrides: { isOnline?: () => boolean; collectTimeoutMs?: number } = {},
): StripeTerminalNativeBridge {
  return new StripeTerminalNativeBridge(sdk, {
    isOnline: overrides.isOnline ?? (() => true),
    locationId: 'loc_test_1',
    collectTimeoutMs: overrides.collectTimeoutMs ?? 60,
  });
}

describe('StripeTerminalNativeBridge — discovery & connection', () => {
  it('discovers S700 over Wi-Fi (internet) and WisePad 3 over Bluetooth (bluetoothScan)', async () => {
    const sdk = new FakeStripeTerminalSdk();
    const bridge = makeBridge(sdk);
    const s700 = await bridge.discover('S700');
    expect(sdk.discoverParams[0]).toEqual(
      expect.objectContaining({ discoveryMethod: 'internet', locationId: 'loc_test_1' }),
    );
    expect(s700).toHaveLength(1);
    expect(s700[0]?.deviceType).toBe('stripeS700');
    const wisePad = await bridge.discover('WisePad 3');
    expect(sdk.discoverParams[1]).toEqual(
      expect.objectContaining({ discoveryMethod: 'bluetoothScan' }),
    );
    expect(wisePad[0]?.deviceType).toBe('wisePad3');
  });

  it('returns readers forwarded by the host via noteDiscoveredReaders (hook callback seam)', async () => {
    const sdk = new FakeStripeTerminalSdk();
    const bridge = makeBridge(sdk);
    const forwarded = [fakeReader('stripeS700', 'S700-HOST')];
    bridge.noteDiscoveredReaders(forwarded);
    const found = await bridge.discover('S700');
    expect(found).toEqual(forwarded);
  });

  it('connects an S700 and reports ready telemetry with battery + firmware', async () => {
    const sdk = new FakeStripeTerminalSdk();
    const bridge = makeBridge(sdk);
    const [reader] = await bridge.discover('S700');
    const connected = await bridge.connect('S700', reader as Reader.Type);
    expect(connected.deviceType).toBe('stripeS700');
    // Internet connect carries no locationId (fixed at discovery).
    expect(sdk.connectParams[0]).toEqual(
      expect.objectContaining({ discoveryMethod: 'internet' }),
    );
    expect(sdk.connectParams[0]).not.toHaveProperty('locationId');
    const telemetry = bridge.status();
    expect(telemetry.status).toBe('ready');
    expect(telemetry.model).toBe('S700');
    expect(telemetry.connection).toBe('wifi');
    expect(telemetry.batteryPercent).toBe(87);
    expect(telemetry.firmwareVersion).toBe('2.14.0');
    expect(bridge.connectedReader?.deviceType).toBe('stripeS700');
  });

  it('connects a WisePad 3 over Bluetooth', async () => {
    const sdk = new FakeStripeTerminalSdk();
    const bridge = makeBridge(sdk);
    const [reader] = await bridge.discover('WisePad 3');
    await bridge.connect('WisePad 3', reader as Reader.Type);
    expect(sdk.connectParams[0]).toEqual(
      expect.objectContaining({ discoveryMethod: 'bluetoothScan', locationId: 'loc_test_1' }),
    );
    expect(bridge.status().connection).toBe('bluetooth');
  });

  it('refuses to connect a reader of the wrong model', async () => {
    const sdk = new FakeStripeTerminalSdk();
    const bridge = makeBridge(sdk);
    await expect(
      bridge.connect('S700', fakeReader('wisePad3', 'WP3-001')),
    ).rejects.toThrow('not a S700');
    expect(bridge.status().status).toBe('disconnected');
  });

  it('requireReadyForCard blocks until the reader is ready (pre-dip/tap block)', async () => {
    const sdk = new FakeStripeTerminalSdk();
    const bridge = makeBridge(sdk);
    expect(() => bridge.requireReadyForCard()).toThrow('Card reader is disconnected');
    const [reader] = await bridge.discover('S700');
    await bridge.connect('S700', reader as Reader.Type);
    expect(() => bridge.requireReadyForCard()).not.toThrow();
  });

  it('disconnect returns the bridge to disconnected with no reader', async () => {
    const sdk = new FakeStripeTerminalSdk();
    const bridge = makeBridge(sdk);
    const [reader] = await bridge.discover('S700');
    await bridge.connect('S700', reader as Reader.Type);
    await bridge.disconnect();
    expect(bridge.status().status).toBe('disconnected');
    expect(bridge.connectedReader).toBeNull();
  });
});

describe('StripeTerminalNativeBridge — card payment', () => {
  async function readyBridge(
    behaviour: FakeBehaviour = 'succeed',
  ): Promise<{ sdk: FakeStripeTerminalSdk; bridge: StripeTerminalNativeBridge }> {
    const sdk = new FakeStripeTerminalSdk();
    sdk.behaviour = behaviour;
    const bridge = makeBridge(sdk);
    const [reader] = await bridge.discover('S700');
    await bridge.connect('S700', reader as Reader.Type);
    return { sdk, bridge };
  }

  it('D-06: refuses card collection while offline with the exact offline banner', async () => {
    const sdk = new FakeStripeTerminalSdk();
    const bridge = makeBridge(sdk, { isOnline: () => false });
    const [reader] = await bridge.discover('S700');
    await bridge.connect('S700', reader as Reader.Type);
    await expect(
      bridge.collectCardPayment({ amountPence: 1200n, currency: 'gbp' }),
    ).rejects.toThrowError(OfflineBlockedError);
    try {
      await bridge.collectCardPayment({ amountPence: 1200n, currency: 'gbp' });
    } catch (error) {
      expect((error as OfflineBlockedError).feature).toBe('card_payment');
      expect((error as OfflineBlockedError).banner).toContain('offline card is deferred (D-06)');
    }
    expect(sdk.collectCalls).toBe(0);
  });

  it('succeeds: collect then process, returns the intent id', async () => {
    const { sdk, bridge } = await readyBridge('succeed');
    const outcome = await bridge.collectCardPayment({
      amountPence: 1200n,
      currency: 'gbp',
      paymentIntent: fakeIntent(),
    });
    expect(outcome).toEqual({ outcome: 'succeeded', paymentIntentId: 'pi_test_1' });
    expect(sdk.collectCalls).toBe(1);
    expect(sdk.processCalls).toBe(1);
    expect(sdk.createIntentCalls).toBe(0);
  });

  it('creates the intent via the SDK when none is supplied', async () => {
    const { sdk, bridge } = await readyBridge('succeed');
    const outcome = await bridge.collectCardPayment({ amountPence: 1200n, currency: 'gbp' });
    expect(sdk.createIntentCalls).toBe(1);
    expect(outcome.outcome).toBe('succeeded');
  });

  it('decline: a reader-declined card returns declined, not unknown', async () => {
    const { bridge } = await readyBridge('decline');
    const outcome = await bridge.collectCardPayment({
      amountPence: 1200n,
      currency: 'gbp',
      paymentIntent: fakeIntent(),
    });
    expect(outcome.outcome).toBe('declined');
    expect(outcome.paymentIntentId).toBe('pi_test_1');
  });

  it('cancel: a canceled collection returns canceled', async () => {
    const { bridge } = await readyBridge('cancel');
    const outcome = await bridge.collectCardPayment({
      amountPence: 1200n,
      currency: 'gbp',
      paymentIntent: fakeIntent(),
    });
    expect(outcome.outcome).toBe('canceled');
  });

  it('W-12: a hung collection times out, cancels, and returns unknown', async () => {
    const { sdk, bridge } = await readyBridge('hang-collect');
    const outcome = await bridge.collectCardPayment({
      amountPence: 1200n,
      currency: 'gbp',
      paymentIntent: fakeIntent(),
    });
    expect(outcome.outcome).toBe('unknown');
    expect(outcome.paymentIntentId).toBe('pi_test_1');
    if (outcome.outcome !== 'unknown') {
      throw new Error('expected unknown outcome');
    }
    expect(outcome.reason).toContain('timed out');
    expect(outcome.reason).toContain('W-12');
    expect(sdk.cancelCollectCalls).toBe(1);
  });

  it('W-12: a hung process step returns unknown', async () => {
    const { bridge } = await readyBridge('hang-process');
    const outcome = await bridge.collectCardPayment({
      amountPence: 1200n,
      currency: 'gbp',
      paymentIntent: fakeIntent(),
    });
    expect(outcome.outcome).toBe('unknown');
    if (outcome.outcome !== 'unknown') {
      throw new Error('expected unknown outcome');
    }
    expect(outcome.reason).toContain('processing timed out');
  });

  it('W-12: an indeterminate SDK error (communication loss) returns unknown', async () => {
    const { bridge } = await readyBridge('error-unknown');
    const outcome = await bridge.collectCardPayment({
      amountPence: 1200n,
      currency: 'gbp',
      paymentIntent: fakeIntent(),
    });
    expect(outcome).toEqual(
      expect.objectContaining({ outcome: 'unknown', paymentIntentId: 'pi_test_1' }),
    );
    if (outcome.outcome !== 'unknown') {
      throw new Error('expected unknown outcome');
    }
    expect(outcome.reason).toContain('W-12');
  });

  it('a definite setup error returns failed, not unknown', async () => {
    const { bridge } = await readyBridge('error-failed');
    const outcome = await bridge.collectCardPayment({
      amountPence: 1200n,
      currency: 'gbp',
      paymentIntent: fakeIntent(),
    });
    expect(outcome.outcome).toBe('failed');
  });

  it('blocks collection when the reader is not ready', async () => {
    const sdk = new FakeStripeTerminalSdk();
    const bridge = makeBridge(sdk);
    await expect(
      bridge.collectCardPayment({ amountPence: 1200n, currency: 'gbp' }),
    ).rejects.toThrow('Card reader is disconnected');
    expect(sdk.collectCalls).toBe(0);
  });

  it('exposes the onDiscoveredReaders callback on discovery', async () => {
    const sdk = new FakeStripeTerminalSdk();
    const seen: Reader.Type[][] = [];
    const bridge = new StripeTerminalNativeBridge(sdk, {
      isOnline: () => true,
      locationId: 'loc_test_1',
      collectTimeoutMs: 60,
      onDiscoveredReaders: (readers) => {
        seen.push(readers);
      },
    });
    await bridge.discover('S700');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]?.deviceType).toBe('stripeS700');
  });
});
