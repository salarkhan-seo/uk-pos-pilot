/**
 * @uk-pos/register-app — React Native tablet layer (Build-07, Objective 2).
 *
 * Typed RN components + Stripe Terminal native bridge, bound to the
 * existing framework-free view-models. This layer is imported
 * directly (`./rn/index`); it is NOT re-exported from the package
 * root `src/index.ts`, so the HTTP UI shell and the existing
 * view-models are untouched.
 *
 * The bridge depends on the injected `StripeTerminalSdk` contract
 * (the real `useStripeTerminal()` return value) — it never imports
 * the SDK runtime, so this layer compiles and tests with no native
 * runtime, no Metro bundler, and no device. In a real RN app the
 * host component calls `useStripeTerminal()` inside
 * `StripeTerminalProvider` and passes the result into
 * `new StripeTerminalNativeBridge(sdk, options)`.
 */
export * from './format';
export * from './stripe-terminal-contract';
export * from './stripe-terminal-bridge';
export * from './components/SellScreenRN';
export * from './components/SplitTenderModalRN';
export * from './components/W12UnknownPaymentModalRN';
export * from './components/Challenge25ModalRN';
export * from './components/ManagerPinModalRN';
export * from './components/SessionCloseScreenRN';
export * from './components/HardwareStatusDrawerRN';
