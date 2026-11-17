/**
 * Stripe Terminal React Native — SDK contract (Build-07, Objective 2).
 *
 * The bridge (`stripe-terminal-bridge.ts`) depends ONLY on this file,
 * never on the real SDK at runtime. The contract is a structural
 * subset of the real `useStripeTerminal()` return value, taken with
 * `Pick<ReturnType<typeof useStripeTerminal>, ...>` — so the types
 * are the SDK's own types (`Reader`, `PaymentIntent`, `StripeError`,
 * `DiscoverReadersParams`, `ConnectReaderParams`, ...) and any drift
 * between this contract and the installed SDK version fails the
 * typecheck instead of failing silently at runtime.
 *
 * INSTALLED SDK (verified in this sandbox):
 *  - `@stripe/stripe-terminal-react-native` 0.0.1-beta.34
 *  - `react-native` 0.88.1, `react` 19.3.1
 * The SDK is a hook (`useStripeTerminal`) plus `StripeTerminalProvider`.
 * Hooks cannot be called from a class, so the hosting React Native
 * component calls `useStripeTerminal()` and passes its return value
 * into `new StripeTerminalNativeBridge(sdk, options)`. The bridge
 * never imports the SDK's runtime — only its types — so it compiles
 * and tests with no native runtime, no Metro bundler, and no device.
 *
 * READER MODELS (Arch-03 hardware matrix):
 *  - S700: Wi-Fi — SDK discoveryMethod 'internet', deviceType 'stripeS700'.
 *  - WisePad 3: Bluetooth — SDK discoveryMethod 'bluetoothScan',
 *    deviceType 'wisePad3'.
 */
import type {
  ConnectReaderParams,
  DiscoverReadersParams,
  PaymentIntent,
  Reader,
  useStripeTerminal,
} from '@stripe/stripe-terminal-react-native';

/** The subset of the `useStripeTerminal()` return the bridge uses. */
export type StripeTerminalSdk = Pick<
  ReturnType<typeof useStripeTerminal>,
  | 'discoverReaders'
  | 'connectReader'
  | 'disconnectReader'
  | 'createPaymentIntent'
  | 'collectPaymentMethod'
  | 'processPaymentIntent'
  | 'cancelCollectPaymentMethod'
  | 'getConnectedReader'
  | 'discoveredReaders'
  | 'connectedReader'
>;

/** The two supported readers (same names as the simulated adapter). */
export type NativeReaderModel = 'S700' | 'WisePad 3';

export const NATIVE_READER_DEVICE_TYPES: Record<
  NativeReaderModel,
  Reader.Type['deviceType']
> = {
  S700: 'stripeS700',
  'WisePad 3': 'wisePad3',
};

/** SDK discovery params for a model. S700 is Wi-Fi ('internet'); WisePad 3 is Bluetooth ('bluetoothScan'). */
export function discoveryParamsForModel(
  model: NativeReaderModel,
  locationId: string,
  simulated = false,
): DiscoverReadersParams {
  if (model === 'S700') {
    return { discoveryMethod: 'internet', locationId, simulated };
  }
  return { discoveryMethod: 'bluetoothScan', simulated };
}

/** SDK connect params for a model + discovered reader. */
export function connectParamsForModel(
  model: NativeReaderModel,
  reader: Reader.Type,
  locationId: string,
): ConnectReaderParams {
  if (model === 'S700') {
    // Internet readers carry no locationId at connect time — the
    // location is fixed at discovery.
    return { discoveryMethod: 'internet', reader };
  }
  return { discoveryMethod: 'bluetoothScan', reader, locationId };
}

/**
 * Stripe's `Reader.batteryLevel` is a 0–1 fraction (SDK docs); the
 * register's `ReaderTelemetry.batteryPercent` is 0–100. This mapping
 * is the single place that conversion lives — verify it against a
 * real reader before trusting the drawer percentage (see the bridge's
 * honest limits).
 */
export function batteryLevelToPercent(batteryLevel: number | undefined): number | null {
  if (batteryLevel === undefined || Number.isNaN(batteryLevel)) {
    return null;
  }
  return Math.round(batteryLevel * 100);
}

/**
 * Outcome of a card collection through the bridge. `unknown` is the
 * W-12 state: the charge may or may not have happened, so the
 * register must lock on the blocking modal and never hand over goods.
 */
export type CardPaymentOutcome =
  | { outcome: 'succeeded'; paymentIntentId: string }
  | { outcome: 'declined'; paymentIntentId: string | null; reason: string }
  | { outcome: 'canceled'; paymentIntentId: string | null; reason: string }
  | { outcome: 'unknown'; paymentIntentId: string | null; reason: string }
  | { outcome: 'failed'; paymentIntentId: string | null; reason: string };

/** A PaymentIntent the API created server-side (preferred), or null when the bridge must create one. */
export type SuppliedPaymentIntent = PaymentIntent.Type | null;
