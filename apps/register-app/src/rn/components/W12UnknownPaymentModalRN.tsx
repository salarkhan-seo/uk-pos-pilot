/**
 * W-12 Unknown Payment Modal — React Native (Build-07, Objective 2).
 *
 * The blocking modal shown when a card attempt comes back `unknown`.
 * The message is rendered VERBATIM (it is the exact W-12 text from
 * the API — never paraphrased) and the four resolution actions from
 * `UNKNOWN_RESOLUTION_ACTIONS` are offered. The two manager actions
 * need an approval reference before they can be submitted — the
 * controller enforces that server-side too; the modal enforces it
 * locally so the cashier cannot submit an empty reference.
 *
 * The modal renders as an overlay `View`, not RN `Modal`, so it
 * works in the headless test harness and on the tablet without a
 * portal; a real app can swap the wrapper for `Modal` without
 * changing the actions.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  UNKNOWN_RESOLUTION_ACTIONS,
  type UnknownResolutionAction,
} from '../../sell/split-tender';

export interface W12UnknownPaymentModalRNProps {
  /** Verbatim W-12 blocking text (UNKNOWN_PAYMENT_MESSAGE). */
  message: string;
  /** The unknown payment attempt id, when known. */
  attemptId: string | null;
  onResolve: (action: UnknownResolutionAction, approvalRef?: string) => void;
}

export function W12UnknownPaymentModalRN(props: W12UnknownPaymentModalRNProps): React.JSX.Element {
  const [approvalRef, setApprovalRef] = useState('');

  return (
    <View testID="w12-modal" style={styles.overlay}>
      <Text testID="w12-message" style={styles.message}>
        {props.message}
      </Text>
      {props.attemptId !== null ? (
        <Text testID="w12-attempt-id">Attempt: {props.attemptId}</Text>
      ) : null}
      <Text testID="w12-instruction">
        Do not hand over goods on card until this payment is resolved.
      </Text>
      {UNKNOWN_RESOLUTION_ACTIONS.map((entry) => {
        const needsApproval =
          entry.action === 'manager_void_or_retry' || entry.action === 'manager_standalone_reference';
        const disabled = needsApproval && approvalRef.trim() === '';
        return (
          <Pressable
            key={entry.action}
            testID={`w12-action-${entry.action}`}
            disabled={disabled}
            onPress={() =>
              props.onResolve(entry.action, needsApproval ? approvalRef.trim() : undefined)
            }
          >
            <Text>{entry.label}</Text>
          </Pressable>
        );
      })}
      <TextInput
        testID="w12-approval-ref"
        value={approvalRef}
        onChangeText={setApprovalRef}
        placeholder="Manager approval reference (needed for manager actions)"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, padding: 16, backgroundColor: '#fff' },
  message: { fontSize: 20, fontWeight: 'bold' },
});
