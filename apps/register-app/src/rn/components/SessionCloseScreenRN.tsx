/**
 * Session Close Screen — React Native (Build-07, Objective 2).
 *
 * Thin view over `TillSessionController`. The controller owns the
 * session state machine (open → end → close), the D-07 zero-float
 * rule, and the D-08 variance rule; this screen only renders the
 * current state and forwards the cashier's counted cash. The
 * Z-report itself is server-issued — the screen displays the
 * `zNumber` the controller returns, it never computes one locally.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  varianceNeedsApproval,
  varianceThresholdPence,
  type TillSessionController,
} from '../../session/till-session';
import { formatPence, parsePenceInput } from '../format';

export interface SessionCloseScreenRNProps {
  till: TillSessionController;
}

export function SessionCloseScreenRN(props: SessionCloseScreenRNProps): React.JSX.Element {
  const { till } = props;
  const [, setVersion] = useState(0);
  const [floatInput, setFloatInput] = useState('');
  const [approvalRef, setApprovalRef] = useState('');
  const [countedInput, setCountedInput] = useState('');
  const [varianceReason, setVarianceReason] = useState('');
  const [expectedCash, setExpectedCash] = useState<bigint | null>(null);
  const [zReport, setZReport] = useState<{ zReportId: string; zNumber: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = (): void => setVersion((v) => v + 1);
  const state = till.currentState;
  const counted = parsePenceInput(countedInput);
  const variance = expectedCash !== null && counted !== null ? counted - expectedCash : null;
  const needsApproval =
    expectedCash !== null && counted !== null && varianceNeedsApproval(expectedCash, counted);

  const open = async (): Promise<void> => {
    const float = parsePenceInput(floatInput);
    if (float === null) {
      setError('Enter an opening float, e.g. 50.00 (0 allowed with a manager override)');
      return;
    }
    try {
      await till.openSession(float, approvalRef.trim() === '' ? undefined : approvalRef.trim());
      setError(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const end = async (): Promise<void> => {
    try {
      const expected = await till.endSession();
      setExpectedCash(expected);
      setError(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const close = async (): Promise<void> => {
    if (counted === null) {
      setError('Enter the counted cash, e.g. 123.45');
      return;
    }
    try {
      const result = await till.closeSession({
        countedCashPence: counted,
        varianceReason: varianceReason.trim() === '' ? null : varianceReason.trim(),
        approvalEventId: approvalRef.trim() === '' ? null : approvalRef.trim(),
      });
      setZReport(result);
      setExpectedCash(null);
      setError(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <View testID="session-close-screen" style={styles.screen}>
      <Text testID="session-title" style={styles.title}>
        Till session
      </Text>
      <Text testID="session-state">State: {state}</Text>
      {till.currentSessionId !== null ? (
        <Text testID="session-id">Session: {till.currentSessionId}</Text>
      ) : null}
      {till.lastZeroFloatWarning !== null ? (
        <Text testID="session-zero-float-warning">{till.lastZeroFloatWarning}</Text>
      ) : null}
      {state === 'closed' ? (
        <View testID="session-open-form">
          <TextInput
            testID="till-float-input"
            value={floatInput}
            onChangeText={setFloatInput}
            placeholder="Opening float, e.g. 50.00"
          />
          <TextInput
            testID="till-approval-ref"
            value={approvalRef}
            onChangeText={setApprovalRef}
            placeholder="Manager approval reference (needed for zero float)"
          />
          <Pressable testID="till-open" onPress={() => void open()}>
            <Text>Open session</Text>
          </Pressable>
        </View>
      ) : null}
      {state === 'open' ? (
        <Pressable testID="till-end" onPress={() => void end()}>
          <Text>End session</Text>
        </Pressable>
      ) : null}
      {state === 'ended' && expectedCash !== null ? (
        <View testID="session-close-form">
          <Text testID="session-expected-cash">Expected cash: {formatPence(expectedCash)}</Text>
          <Text testID="session-variance-threshold">
            Variance needs approval above {formatPence(varianceThresholdPence(expectedCash))} (higher
            of £10 or 2%)
          </Text>
          <TextInput
            testID="till-counted-input"
            value={countedInput}
            onChangeText={setCountedInput}
            placeholder="Counted cash, e.g. 123.45"
          />
          {variance !== null ? (
            <Text testID="session-variance">Variance: {formatPence(variance)}</Text>
          ) : null}
          {needsApproval ? (
            <Text testID="session-variance-needs-approval">
              Variance exceeds the D-08 threshold — manager approval required
            </Text>
          ) : null}
          <TextInput
            testID="till-variance-reason"
            value={varianceReason}
            onChangeText={setVarianceReason}
            placeholder="Variance reason (required when variance is not zero)"
          />
          <TextInput
            testID="till-close-approval"
            value={approvalRef}
            onChangeText={setApprovalRef}
            placeholder="Manager approval reference"
          />
          <Pressable testID="till-close" onPress={() => void close()}>
            <Text>Close session & issue Z-report</Text>
          </Pressable>
        </View>
      ) : null}
      {zReport !== null ? (
        <Text testID="session-z-report">Z-report issued: {zReport.zNumber}</Text>
      ) : null}
      {error !== null ? <Text testID="session-error">{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16 },
  title: { fontSize: 20, fontWeight: 'bold' },
});
