/**
 * Hardware Status Drawer — React Native (Build-07, Objective 2).
 *
 * Thin view over `StripeTerminalNativeBridge`. The drawer shows the
 * bridge's telemetry (same shape as the simulated adapter), the
 * discovered readers for the selected model, and the connect /
 * disconnect actions. It calls the bridge directly — discovery and
 * connection are bridge operations, not host operations.
 *
 * D-06: when the register is offline the drawer shows the card
 * offline banner and the card actions stay unavailable (the bridge
 * refuses collection offline; discovery/connection of a reader is
 * still possible, since a reader can pair while the till has no
 * internet — but no card can be taken until it reconnects).
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Reader } from '@stripe/stripe-terminal-react-native';
import { offlineBannerFor } from '../../offline/offline-guards';
import type { NativeReaderModel } from '../stripe-terminal-contract';
import type { StripeTerminalNativeBridge } from '../stripe-terminal-bridge';

export interface HardwareStatusDrawerRNProps {
  bridge: StripeTerminalNativeBridge;
  isOnline: () => boolean;
}

const MODELS: NativeReaderModel[] = ['S700', 'WisePad 3'];

export function HardwareStatusDrawerRN(props: HardwareStatusDrawerRNProps): React.JSX.Element {
  const { bridge, isOnline } = props;
  const [, setVersion] = useState(0);
  const [model, setModel] = useState<NativeReaderModel>('S700');
  const [readers, setReaders] = useState<Reader.Type[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = (): void => setVersion((v) => v + 1);
  const online = isOnline();
  const telemetry = bridge.status();

  const discover = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const found = await bridge.discover(model);
      setReaders(found);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const connect = async (reader: Reader.Type): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await bridge.connect(model, reader);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await bridge.disconnect();
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View testID="hardware-drawer" style={styles.drawer}>
      <Text testID="hardware-title" style={styles.title}>
        Card reader
      </Text>
      <Text testID="hardware-model">Model: {telemetry.model}</Text>
      <Text testID="hardware-connection">Connection: {telemetry.connection}</Text>
      <Text testID="hardware-status">Status: {telemetry.status}</Text>
      <Text testID="hardware-battery">
        Battery: {telemetry.batteryPercent === null ? 'unknown' : `${telemetry.batteryPercent}%`}
      </Text>
      <Text testID="hardware-firmware">
        Firmware: {telemetry.firmwareVersion ?? 'unknown'}
      </Text>
      {telemetry.lastError !== null ? (
        <Text testID="hardware-error">{telemetry.lastError}</Text>
      ) : null}
      {!online ? (
        <Text testID="hardware-offline-banner">{offlineBannerFor('card_payment')}</Text>
      ) : null}
      {MODELS.map((candidate) => (
        <Pressable
          key={candidate}
          testID={`hardware-model-${candidate === 'S700' ? 's700' : 'wisepad3'}`}
          onPress={() => setModel(candidate)}
        >
          <Text>
            {candidate}
            {model === candidate ? ' (selected)' : ''}
          </Text>
        </Pressable>
      ))}
      <Pressable testID="hardware-discover" disabled={busy} onPress={() => void discover()}>
        <Text>Discover {model} readers</Text>
      </Pressable>
      {readers.map((reader, index) => (
        <Pressable
          key={reader.id ?? `reader-${index}`}
          testID={`hardware-connect-${reader.id ?? index}`}
          disabled={busy}
          onPress={() => void connect(reader)}
        >
          <Text>
            Connect {reader.label ?? reader.id ?? `reader ${index + 1}`}
            {reader.serialNumber !== undefined ? ` (${reader.serialNumber})` : ''}
          </Text>
        </Pressable>
      ))}
      <Pressable
        testID="hardware-disconnect"
        disabled={busy || telemetry.status === 'disconnected'}
        onPress={() => void disconnect()}
      >
        <Text>Disconnect reader</Text>
      </Pressable>
      {error !== null ? <Text testID="hardware-action-error">{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  drawer: { flex: 1, padding: 16 },
  title: { fontSize: 20, fontWeight: 'bold' },
});
