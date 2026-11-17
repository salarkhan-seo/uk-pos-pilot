/**
 * Stripe Terminal hardware adapter (Build-04, Objective 1; Arch-04 §3).
 *
 * Interface + SIMULATED implementation — no live hardware, no network.
 * Models the two supported readers (S700 over Wi-Fi, WisePad 3 over
 * Bluetooth): connection state, battery/firmware telemetry, and the
 * pre-dip/tap block — card input is refused until the reader reports
 * ready, so a customer can never dip/tap into a dead reader.
 */
export type ReaderModel = 'S700' | 'WisePad 3';
export type ReaderConnection = 'wifi' | 'bluetooth';
export type ReaderStatus = 'disconnected' | 'connecting' | 'connected' | 'ready' | 'error';

export interface ReaderTelemetry {
  model: ReaderModel;
  connection: ReaderConnection;
  status: ReaderStatus;
  batteryPercent: number | null;
  firmwareVersion: string | null;
  /** Last connection error, when status is 'error'. */
  lastError: string | null;
}

export interface StripeTerminalHardwareAdapter {
  connect(model: ReaderModel, connection: ReaderConnection): Promise<ReaderTelemetry>;
  disconnect(): Promise<void>;
  status(): ReaderTelemetry;
  /**
   * Throws (blocks) until the reader is ready. The sell screen calls
   * this before enabling card input — a dip/tap must never start
   * against a reader that is not ready.
   */
  requireReadyForCard(): void;
}

/** Deterministic simulated reader — scripted state, no hardware, no network. */
export class SimulatedStripeTerminalAdapter implements StripeTerminalHardwareAdapter {
  private telemetry: ReaderTelemetry = {
    model: 'S700',
    connection: 'wifi',
    status: 'disconnected',
    batteryPercent: null,
    firmwareVersion: null,
    lastError: null,
  };

  async connect(model: ReaderModel, connection: ReaderConnection): Promise<ReaderTelemetry> {
    this.telemetry = {
      model,
      connection,
      status: 'ready',
      // Simulated telemetry values (clearly fake — a real reader
      // reports these from the device).
      batteryPercent: model === 'WisePad 3' ? 87 : null,
      firmwareVersion: model === 'S700' ? '2.14.0' : '1.9.3',
      lastError: null,
    };
    return { ...this.telemetry };
  }

  async disconnect(): Promise<void> {
    this.telemetry = { ...this.telemetry, status: 'disconnected', lastError: null };
  }

  status(): ReaderTelemetry {
    return { ...this.telemetry };
  }

  requireReadyForCard(): void {
    if (this.telemetry.status !== 'ready') {
      throw new Error(
        `Card reader is ${this.telemetry.status} — card input is blocked until the reader is ready. ` +
          `Check the reader connection and try again.`,
      );
    }
  }

  /** Test/script hook: force the reader into an error state. */
  simulateError(message: string): void {
    this.telemetry = { ...this.telemetry, status: 'error', lastError: message };
  }
}
