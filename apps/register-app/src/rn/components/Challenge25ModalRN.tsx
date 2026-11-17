/**
 * Challenge 25 Modal — React Native (Build-07, Objective 2).
 *
 * Thin view over `AgeVerificationGate`. The gate owns the rule
 * (threshold ≥ 25, refusals logged with threshold + reason + time,
 * never a date of birth); this component only renders the lines that
 * need verification and forwards confirm/refuse.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { AgeRestrictedLine, AgeVerificationGate } from '../../sell/age-gate';

export interface Challenge25ModalRNProps {
  gate: AgeVerificationGate;
  lines: readonly AgeRestrictedLine[];
  /** Called after the gate records a verification. */
  onConfirmed?: (verifiedAgeThreshold: number) => void;
  /** Called after the gate logs a refusal. */
  onRefused?: (line: AgeRestrictedLine, reason: string) => void;
}

export function Challenge25ModalRN(props: Challenge25ModalRNProps): React.JSX.Element {
  const { gate } = props;
  const [, setVersion] = useState(0);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = (): void => setVersion((v) => v + 1);
  const required = gate.requiredLines(props.lines);

  const confirm = (): void => {
    try {
      const { verifiedAgeThreshold } = gate.confirm();
      props.onConfirmed?.(verifiedAgeThreshold);
      setError(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const refuse = (line: AgeRestrictedLine): void => {
    const reason = (reasons[line.variantId] ?? '').trim();
    if (reason === '') {
      setError('A reason is required to log a refusal');
      return;
    }
    gate.refuse(line, reason);
    props.onRefused?.(line, reason);
    setError(null);
    refresh();
  };

  return (
    <View testID="challenge25-modal" style={styles.modal}>
      <Text testID="challenge25-title" style={styles.title}>
        Challenge 25 — age verification
      </Text>
      <Text testID="challenge25-instruction">
        Check ID for the items below. No date of birth is ever recorded — only the verified age
        threshold.
      </Text>
      {required.map((line) => (
        <View key={line.variantId} testID={`challenge25-line-${line.sku}`}>
          <Text>
            {line.sku} — age-restricted
          </Text>
          <TextInput
            testID={`challenge25-refusal-reason-${line.sku}`}
            value={reasons[line.variantId] ?? ''}
            onChangeText={(value) => setReasons((prev) => ({ ...prev, [line.variantId]: value }))}
            placeholder="Refusal reason"
          />
          <Pressable testID={`challenge25-refuse-${line.sku}`} onPress={() => refuse(line)}>
            <Text>Log refusal</Text>
          </Pressable>
        </View>
      ))}
      {gate.verifiedAgeThreshold !== null ? (
        <Text testID="challenge25-verified">
          Verified — age {gate.verifiedAgeThreshold}+
        </Text>
      ) : null}
      {gate.listRefusals().map((refusal, index) => (
        <Text key={`${refusal.variantId}-${index}`} testID={`challenge25-refusal-${index}`}>
          Refused {refusal.sku}: {refusal.reason}
        </Text>
      ))}
      {error !== null ? <Text testID="challenge25-error">{error}</Text> : null}
      <Pressable testID="challenge25-confirm" onPress={confirm}>
        <Text>Confirm age 25+ verified</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  modal: { flex: 1, padding: 16 },
  title: { fontSize: 20, fontWeight: 'bold' },
});
