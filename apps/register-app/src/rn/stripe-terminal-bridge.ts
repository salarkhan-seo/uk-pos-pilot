/**
 * Stripe Terminal native bridge (Build-07, Objective 2).
 *
 * Wraps the real `@stripe/stripe-terminal-react-native` SDK behind
 * the injected `StripeTerminalSdk` contract (see
 * stripe-terminal-contract.ts). The bridge holds NO native state of
 * its own beyond connection status/telemetry: the SDK owns the
 * reader, the bridge owns the pilot's rules around it.
 *
 * RULES THE BRIDGE ENFORCES (never delegated to the SDK):
 *  - D-06 offline card block: `collectCardPayment` throws
 *    `OfflineBlockedError('card_payment')` while offline — the exact
 *    same error and banner the simulated adapter and the offline
 *    guards use. Offline card is deferred; the bridge never attempts
 *    a card collection without connectivity.
 *  - Pre-dip/tap block: `requireReadyForCard()` — card input is
 *    refused until the reader reports ready, mirroring
 *    `SimulatedStripeTerminalAdapter.requireReadyForCard()`.
 *  - W-12 unknown capture: card collection and processing run under
 *    a bounded wait (`collectTimeoutMs`, default 120s). A timeout
 *    cancels the collection (best-effort) and returns
 *    `{ outcome: 'unknown', ... }` — the charge may or may not have
 *    happened, so the caller must lock the register on the W-12
 *    modal (`SplitTenderController.markCardAttemptUnknown`). SDK
 *    errors are classified by code: cancellation → 'canceled',
 *    Stripe/reader decline → 'declined', indeterminate errors
 *    (timeouts, communication loss, API connection errors) →
 *    'unknown', definite setup errors → 'failed' (safe to retry,
 *    no W-12 lock).
 *
 * HOOK SEAM: the SDK is hook-based. The hosting component calls
 * `useStripeTerminal()` and passes its return value here. Discovery
 * results arrive through the hook's `onUpdateDiscoveredReaders`
 * callback, which the host forwards via `noteDiscoveredReaders()`;
 * `discover()` also falls back to the `sdk.discoveredReaders`
 * snapshot for fakes and for hosts that do not forward the callback.
 * The bridge never calls a hook itself, so it compiles and tests
 * with no native runtime.
 */
import type {
  PaymentIntent,
  Reader,
  StripeError,
} from '@stripe/stripe-terminal-react-native';
import { OfflineBlockedError } from '../offline/offline-guards';
import type {
  ReaderConnection,
  ReaderModel,
  ReaderStatus,
  ReaderTelemetry,
} from '../hardware/stripe-terminal';
import {
  batteryLevelToPercent,
  connectParamsForModel,
  discoveryParamsForModel,
  NATIVE_READER_DEVICE_TYPES,
  type CardPaymentOutcome,
  type NativeReaderModel,
  type StripeTerminalSdk,
} from './stripe-terminal-contract';

/** Bounded wait for card collection/processing before the attempt is captured as unknown (W-12). */
export const DEFAULT_COLLECT_TIMEOUT_MS = 120_000;

/** Definite: the customer or reader cancelled — no charge, safe to retry. */
const CANCELED_CODES = new Set(['CANCELED', 'CANCELED_BY_READER']);
/** Definite: Stripe or the reader declined the card. */
const DECLINED_CODES = new Set(['DECLINED_BY_STRIPE_API', 'DECLINED_BY_READER']);
/**
 * Indeterminate: the charge may or may not have happened — W-12
 * 'unknown'. These are the SDK's timeout / communication-loss /
 * API-connection error codes (ErrorCode enum, verified against the
 * installed SDK 0.0.1-beta.34).
 */
const UNKNOWN_CODES = new Set([
  'REQUEST_TIMED_OUT',
  'CARD_READ_TIMED_OUT',
  'BLUETOOTH_SCAN_TIMED_OUT',
  'USB_DISCOVERY_TIMED_OUT',
  'READER_COMMUNICATION_ERROR',
  'BLUETOOTH_ERROR',
  'BLUETOOTH_DISCONNECTED',
  'USB_DISCONNECTED',
  'READER_BUSY',
  'GENERIC_READER_ERROR',
  'UNEXPECTED_SDK_ERROR',
  'STRIPE_API_CONNECTION_ERROR',
  'STRIPE_API_ERROR',
  'STRIPE_API_RESPONSE_DECODING_ERROR',
  'CONNECTION_TOKEN_PROVIDER_ERROR',
  'SESSION_EXPIRED',
]);

/** Device types accepted for a model (includes devkit variants). */
const DEVICE_TYPES_FOR_MODEL: Record<NativeReaderModel, ReadonlySet<string>> = {
  S700: new Set(['stripeS700', 'stripeS700Devkit']),
  'WisePad 3': new Set(['wisePad3', 'wisePad3s']),
};

export interface NativeBridgeOptions {
  /** Register connectivity — D-06: card is refused while this is false. */
  isOnline: () => boolean;
  /** Stripe location id for internet (S700) discovery/connect. */
  locationId: string;
  /** Bounded wait for collect/process before W-12 unknown capture. Defaults to 120s. */
  collectTimeoutMs?: number;
  /** Called when discovery reports readers for the requested model. */
  onDiscoveredReaders?: (readers: Reader.Type[]) => void;
}

const TIMEOUT = Symbol('collect-timeout');

export class StripeTerminalNativeBridge {
  private statusValue: ReaderStatus = 'disconnected';
  private modelValue: ReaderModel = 'S700';
  private connectionValue: ReaderConnection = 'wifi';
  private lastErrorValue: string | null = null;
  private connectedReaderValue: Reader.Type | null = null;
  private latestDiscovered: Reader.Type[] = [];
  private readonly collectTimeoutMs: number;

  constructor(
    private readonly sdk: StripeTerminalSdk,
    private readonly options: NativeBridgeOptions,
  ) {
    this.collectTimeoutMs = options.collectTimeoutMs ?? DEFAULT_COLLECT_TIMEOUT_MS;
  }

  // -- Discovery & connection lifecycle ---------------------------------

  /**
   * Host components call this from the hook's
   * `onUpdateDiscoveredReaders` callback. The bridge keeps the latest
   * list so `discover()` can return it after `discoverReaders`
   * resolves.
   */
  noteDiscoveredReaders(readers: Reader.Type[]): void {
    this.latestDiscovered = [...readers];
  }

  /** Discover readers for a model. Returns only readers of that model. */
  async discover(model: NativeReaderModel, opts: { simulated?: boolean } = {}): Promise<Reader.Type[]> {
    this.modelValue = model;
    this.connectionValue = model === 'S700' ? 'wifi' : 'bluetooth';
    const result = await this.sdk.discoverReaders(
      discoveryParamsForModel(model, this.options.locationId, opts.simulated ?? false),
    );
    if (result.error !== undefined) {
      this.statusValue = 'error';
      this.lastErrorValue = describeStripeError(result.error);
      throw new Error(`Reader discovery failed: ${this.lastErrorValue}`);
    }
    const seen =
      this.latestDiscovered.length > 0
        ? this.latestDiscovered
        : [...(this.sdk.discoveredReaders ?? [])];
    const wanted = DEVICE_TYPES_FOR_MODEL[model];
    const matching = seen.filter(
      (reader) => reader.deviceType === undefined || wanted.has(reader.deviceType),
    );
    this.options.onDiscoveredReaders?.(matching);
    return matching;
  }

  /** Connect to a discovered reader of the requested model. */
  async connect(model: NativeReaderModel, reader: Reader.Type): Promise<Reader.Type> {
    this.modelValue = model;
    this.connectionValue = model === 'S700' ? 'wifi' : 'bluetooth';
    if (reader.deviceType !== undefined && !DEVICE_TYPES_FOR_MODEL[model].has(reader.deviceType)) {
      throw new Error(
        `Reader ${reader.label ?? reader.id ?? 'unknown'} is a ${reader.deviceType}, not a ${model} ` +
          `(expected ${NATIVE_READER_DEVICE_TYPES[model]})`,
      );
    }
    this.statusValue = 'connecting';
    const result = await this.sdk.connectReader(
      connectParamsForModel(model, reader, this.options.locationId),
    );
    if (result.error !== undefined) {
      this.statusValue = 'error';
      this.lastErrorValue = describeStripeError(result.error);
      throw new Error(`Could not connect to ${model} reader: ${this.lastErrorValue}`);
    }
    this.connectedReaderValue = result.reader;
    this.statusValue = 'ready';
    this.lastErrorValue = null;
    return result.reader;
  }

  async disconnect(): Promise<void> {
    await this.sdk.disconnectReader();
    this.connectedReaderValue = null;
    this.statusValue = 'disconnected';
    this.lastErrorValue = null;
  }

  get connectedReader(): Reader.Type | null {
    return this.connectedReaderValue;
  }

  /** Telemetry in the same shape as the simulated adapter, for the status drawer. */
  status(): ReaderTelemetry {
    const reader = this.connectedReaderValue;
    return {
      model: this.modelValue,
      connection: this.connectionValue,
      status: this.statusValue,
      batteryPercent: batteryLevelToPercent(reader?.batteryLevel),
      firmwareVersion: reader?.deviceSoftwareVersion ?? null,
      lastError: this.lastErrorValue,
    };
  }

  /**
   * Throws (blocks) until the reader is ready. The sell screen calls
   * this before enabling card input — a dip/tap must never start
   * against a reader that is not ready. Same wording as the
   * simulated adapter.
   */
  requireReadyForCard(): void {
    if (this.statusValue !== 'ready') {
      throw new Error(
        `Card reader is ${this.statusValue} — card input is blocked until the reader is ready. ` +
          `Check the reader connection and try again.`,
      );
    }
  }

  // -- Card payment -------------------------------------------------------

  /**
   * Take a card payment for `amountPence`.
   *
   * - `paymentIntent`: the PaymentIntent the API created server-side
   *   (preferred — the pilot's PaymentsService owns intent creation).
   *   When omitted, the bridge creates one via the SDK with
   *   `offlineBehavior` unset (online only — D-06 defers offline
   *   card, so no offline intent is ever created here).
   * - D-06: throws `OfflineBlockedError('card_payment')` while
   *   offline, before touching the reader.
   * - W-12: collection and processing each run under
   *   `collectTimeoutMs`. A timeout cancels the collection
   *   (best-effort) and returns `{ outcome: 'unknown' }` — the
   *   caller must lock the register via
   *   `SplitTenderController.markCardAttemptUnknown`.
   */
  async collectCardPayment(input: {
    amountPence: bigint;
    currency: string;
    paymentIntent?: PaymentIntent.Type | null;
  }): Promise<CardPaymentOutcome> {
    if (!this.options.isOnline()) {
      throw new OfflineBlockedError('card_payment');
    }
    this.requireReadyForCard();
    const intent =
      input.paymentIntent ?? (await this.createIntent(input.amountPence, input.currency));
    const intentId = intent.id ?? null;

    const collected = await this.withCollectTimeout(
      this.sdk.collectPaymentMethod({ paymentIntent: intent }),
      () => {
        void this.sdk.cancelCollectPaymentMethod().catch(() => undefined);
      },
    );
    if (collected === TIMEOUT) {
      return {
        outcome: 'unknown',
        paymentIntentId: intentId,
        reason:
          `Card collection timed out after ${this.collectTimeoutMs}ms — payment outcome unknown (W-12). ` +
          `Do not hand over goods on card until checked.`,
      };
    }
    if (collected.error !== undefined) {
      return this.classifySdkError(collected.error, intentId);
    }
    const confirmed = collected.paymentIntent;

    const processed = await this.withCollectTimeout(
      this.sdk.processPaymentIntent({ paymentIntent: confirmed }),
      () => undefined,
    );
    if (processed === TIMEOUT) {
      return {
        outcome: 'unknown',
        paymentIntentId: confirmed.id ?? null,
        reason:
          `Card processing timed out after ${this.collectTimeoutMs}ms — payment outcome unknown (W-12). ` +
          `Do not hand over goods on card until checked.`,
      };
    }
    if (processed.error !== undefined) {
      return this.classifySdkError(processed.error, confirmed.id ?? null);
    }
    const finalIntent = processed.paymentIntent;
    if (finalIntent.status === 'succeeded') {
      return { outcome: 'succeeded', paymentIntentId: finalIntent.id ?? '' };
    }
    if (finalIntent.status === 'canceled') {
      return {
        outcome: 'canceled',
        paymentIntentId: finalIntent.id ?? null,
        reason: 'Payment was canceled',
      };
    }
    return {
      outcome: 'unknown',
      paymentIntentId: finalIntent.id ?? null,
      reason:
        `Payment ended in status ${finalIntent.status ?? 'unknown'} — payment outcome unknown (W-12). ` +
        `Do not hand over goods on card until checked.`,
    };
  }

  private async createIntent(amountPence: bigint, currency: string): Promise<PaymentIntent.Type> {
    // Amounts in this pilot are ordinary till totals (offline cap
    // £250; online card totals are bounded by the same basket), far
    // below Number.MAX_SAFE_INTEGER — the SDK takes a JS number.
    const created = await this.sdk.createPaymentIntent({
      amount: Number(amountPence),
      currency,
    });
    if (created.error !== undefined) {
      throw new Error(`Could not create card payment: ${describeStripeError(created.error)}`);
    }
    return created.paymentIntent;
  }

  private classifySdkError(error: StripeError, paymentIntentId: string | null): CardPaymentOutcome {
    // ErrorCode is a string-literal union; widen once for the set lookups.
    const code: string = error.code;
    const message = describeStripeError(error);
    if (CANCELED_CODES.has(code)) {
      return { outcome: 'canceled', paymentIntentId, reason: message };
    }
    if (DECLINED_CODES.has(code)) {
      return { outcome: 'declined', paymentIntentId, reason: message };
    }
    if (UNKNOWN_CODES.has(code)) {
      return {
        outcome: 'unknown',
        paymentIntentId,
        reason: `${message} — payment outcome unknown (W-12). Do not hand over goods on card until checked.`,
      };
    }
    return { outcome: 'failed', paymentIntentId, reason: message };
  }

  /**
   * Race a promise against the collect timeout. The underlying SDK
   * call cannot be cancelled as a promise — `onTimeout` is the
   * caller's cancellation (e.g. `cancelCollectPaymentMethod`); the
   * late resolution is ignored.
   */
  private async withCollectTimeout<T>(
    promise: Promise<T>,
    onTimeout: () => void,
  ): Promise<T | typeof TIMEOUT> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => {
        onTimeout();
        resolve(TIMEOUT);
      }, this.collectTimeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}

function describeStripeError(error: StripeError): string {
  const code = error.code as string;
  const message =
    error.message !== '' ? error.message : 'Stripe Terminal reported an error';
  return `${code}: ${message}`;
}
