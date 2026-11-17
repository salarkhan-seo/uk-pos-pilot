/**
 * Manager PIN Modal — React Native (Build-07, Objective 2).
 *
 * Collects a manager PIN and hands it to the host for verification
 * (the API's ApprovalService verifies the scrypt PIN hash
 * server-side; this component never verifies, stores, or logs a
 * PIN). The PIN is shown masked (one • per digit) and cleared on a
 * failed attempt. The host reports success/failure through the
 * `onSubmitPin` return value and is told via `onVerified` when the
 * PIN is accepted.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

export interface ManagerPinModalRNProps {
  /** What the PIN is for, e.g. "Approve a 15% manual discount". */
  title: string;
  /** Host verification — returns true when the PIN is accepted. */
  onSubmitPin: (pin: string) => Promise<boolean> | boolean;
  /** Called once when the PIN is accepted. */
  onVerified: () => void;
  onCancel: () => void;
}

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

export function ManagerPinModalRN(props: ManagerPinModalRNProps): React.JSX.Element {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (pin.length === 0) {
      setError('Enter the manager PIN');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const accepted = await props.onSubmitPin(pin);
      if (accepted) {
        props.onVerified();
      } else {
        setError('Incorrect PIN — try again');
        setPin('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View testID="manager-pin-modal" style={styles.modal}>
      <Text testID="manager-pin-title" style={styles.title}>
        {props.title}
      </Text>
      <Text testID="manager-pin-display">{'•'.repeat(pin.length) || 'Enter PIN'}</Text>
      {DIGITS.map((digit) => (
        <Pressable
          key={digit}
          testID={`manager-pin-digit-${digit}`}
          disabled={busy}
          onPress={() => setPin((prev) => prev + digit)}
        >
          <Text>{digit}</Text>
        </Pressable>
      ))}
      <Pressable testID="manager-pin-clear" disabled={busy} onPress={() => setPin('')}>
        <Text>Clear</Text>
      </Pressable>
      {error !== null ? <Text testID="manager-pin-error">{error}</Text> : null}
      <Pressable testID="manager-pin-submit" disabled={busy || pin.length === 0} onPress={() => void submit()}>
        <Text>Submit PIN</Text>
      </Pressable>
      <Pressable testID="manager-pin-cancel" onPress={props.onCancel}>
        <Text>Cancel</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  modal: { flex: 1, padding: 16 },
  title: { fontSize: 20, fontWeight: 'bold' },
});
