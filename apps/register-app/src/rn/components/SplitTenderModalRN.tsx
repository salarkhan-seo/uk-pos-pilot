/**
 * Split Tender Modal — React Native (Build-07, Objective 2).
 *
 * Thin view over `SplitTenderController`. All tender arithmetic,
 * the 5-minute timeout, and the W-12 lock live in the controller;
 * this component only renders them and forwards the cashier's
 * choices. When the controller is locked on an unknown card payment
 * it renders `W12UnknownPaymentModalRN` instead of the tender form
 * — no further tender can be added while locked (the controller
 * throws, and the form is not rendered at all).
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  type SplitTenderController,
  type TenderKind,
  type UnknownResolutionAction,
} from '../../sell/split-tender';
import { formatPence, parsePenceInput } from '../format';
import { W12UnknownPaymentModalRN } from './W12UnknownPaymentModalRN';

export interface SplitTenderModalRNProps {
  split: SplitTenderController;
  /** Called after the controller accepts a tender (host refreshes the sale). */
  onTenderAdded?: (tender: { kind: TenderKind; amountPence: bigint }) => void;
  /** Called after the controller resolves an unknown payment. */
  onUnknownResolved?: (action: UnknownResolutionAction) => void;
}

const TENDER_KINDS: TenderKind[] = ['cash', 'card', 'gift_card', 'store_credit', 'loyalty_points'];

export function SplitTenderModalRN(props: SplitTenderModalRNProps): React.JSX.Element {
  const { split } = props;
  const [, setVersion] = useState(0);
  const [kind, setKind] = useState<TenderKind>('cash');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = (): void => setVersion((v) => v + 1);
  const locked = split.isLockedOnUnknown;

  if (locked) {
    return (
      <W12UnknownPaymentModalRN
        message={split.blockingModal ?? ''}
        attemptId={split.unknownPaymentAttemptId}
        onResolve={(action, approvalRef) => {
          try {
            split.resolveUnknown(action, approvalRef);
            props.onUnknownResolved?.(action);
            refresh();
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
      />
    );
  }

  const addTender = (): void => {
    const amountPence = parsePenceInput(amount);
    if (amountPence === null) {
      setError('Enter a tender amount, e.g. 12.34');
      return;
    }
    try {
      split.addTender({ kind, amountPence });
      props.onTenderAdded?.({ kind, amountPence });
      setAmount('');
      setError(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <View testID="split-tender-modal" style={styles.modal}>
      <Text testID="split-title" style={styles.title}>
        Split tender
      </Text>
      <Text testID="split-total">Total: {formatPence(split.total)}</Text>
      <Text testID="split-tendered">Tendered: {formatPence(split.tenderedTotal)}</Text>
      <Text testID="split-remaining">Remaining: {formatPence(split.remaining)}</Text>
      {split.isTimedOut() ? (
        <Text testID="split-timed-out">
          Split tender timed out after 5 minutes: the sale was unwound — start again from draft.
        </Text>
      ) : null}
      {split.listTenders().map((tender, index) => (
        <Text key={`${tender.kind}-${index}`} testID={`split-tender-${index}`}>
          {tender.kind}: {formatPence(tender.amountPence)}
        </Text>
      ))}
      {TENDER_KINDS.map((tenderKind) => (
        <Pressable
          key={tenderKind}
          testID={`split-kind-${tenderKind}`}
          onPress={() => setKind(tenderKind)}
        >
          <Text>
            {tenderKind}
            {kind === tenderKind ? ' (selected)' : ''}
          </Text>
        </Pressable>
      ))}
      <TextInput
        testID="split-amount-input"
        value={amount}
        onChangeText={setAmount}
        placeholder="Amount, e.g. 12.34"
      />
      {error !== null ? <Text testID="split-error">{error}</Text> : null}
      <Pressable
        testID="split-add-tender"
        disabled={split.isComplete || split.isTimedOut()}
        onPress={addTender}
      >
        <Text>Add tender</Text>
      </Pressable>
      {split.isComplete ? <Text testID="split-complete">Tender complete</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  modal: { flex: 1, padding: 16 },
  title: { fontSize: 20, fontWeight: 'bold' },
});
