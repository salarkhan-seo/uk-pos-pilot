/**
 * Sell Screen — React Native (Build-07, Objective 2).
 *
 * Thin view over `SellController` + `StripeTerminalNativeBridge`.
 * The component holds NO pricing, basket, age-gate or payment state
 * of its own: lines and totals are read from the controller on every
 * render (a local `version` counter forces a re-render after each
 * mutation, because the controllers are mutable classes with no
 * subscription mechanism). Local state is limited to input text
 * (search query), the async search results, the last card outcome,
 * and transient error/busy flags.
 *
 * Card checkout is a host callback — the host owns PaymentIntent
 * creation (the API) and the bridge call, and returns the
 * `CardPaymentOutcome`. When the outcome is 'unknown' the component
 * reports it via `onUnknownPayment` so the host can lock the
 * register on the W-12 modal; the screen never hands over goods
 * itself.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { offlineBannerFor } from '../../offline/offline-guards';
import type { SellController } from '../../sell/sell-controller';
import type { CatalogCacheEntry } from '../../storage/storage-adapter';
import type { CardPaymentOutcome } from '../stripe-terminal-contract';
import type { StripeTerminalNativeBridge } from '../stripe-terminal-bridge';
import { formatPence } from '../format';

export interface SellScreenRNProps {
  sell: SellController;
  bridge: StripeTerminalNativeBridge;
  isOnline: () => boolean;
  /** Host-owned card flow (API intent + bridge). Returns the bridge outcome. */
  onCardCheckout: (amountPence: bigint) => Promise<CardPaymentOutcome>;
  /** Host-owned offline cash checkout (SellController.checkoutOfflineCash). */
  onCashCheckout: () => Promise<{ idempotencyKey: string; totalPence: bigint }>;
  /** Called when a card outcome is 'unknown' — the host locks the register (W-12). */
  onUnknownPayment: (paymentIntentId: string | null, outcome: CardPaymentOutcome) => void;
}

export function SellScreenRN(props: SellScreenRNProps): React.JSX.Element {
  const { sell, bridge, isOnline } = props;
  const [, setVersion] = useState(0);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CatalogCacheEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastOutcome, setLastOutcome] = useState<CardPaymentOutcome | null>(null);

  const refresh = (): void => setVersion((v) => v + 1);
  const lines = sell.listLines();
  const total = sell.basketTotalPence;
  const online = isOnline();
  const ageBlocked = !sell.ageGate.isSatisfied(lines);
  const reader = bridge.status();
  const readerReady = reader.status === 'ready';

  const runSearch = async (): Promise<void> => {
    setError(null);
    try {
      const found = await sell.search(query);
      // Keep the full catalog entries — the age-gate flag
      // (requiresChallenge25) must survive into addLine.
      setResults(found);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const addResult = (variantId: string): void => {
    const entry = results.find((r) => r.variantId === variantId);
    if (entry === undefined) {
      return;
    }
    try {
      sell.addLine(entry, 1n);
      setError(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const checkoutCash = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await props.onCashCheckout();
      setLastOutcome(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const checkoutCard = async (): Promise<void> => {
    if (!online) {
      setError(offlineBannerFor('card_payment'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const outcome = await props.onCardCheckout(total);
      setLastOutcome(outcome);
      if (outcome.outcome === 'unknown') {
        props.onUnknownPayment(outcome.paymentIntentId, outcome);
      }
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View testID="sell-screen" style={styles.screen}>
      <Text testID="sell-title" style={styles.title}>
        Sell
      </Text>
      <View testID="sell-search-row">
        <TextInput
          testID="sell-search-input"
          value={query}
          onChangeText={setQuery}
          placeholder="Search SKU or name"
        />
        <Pressable testID="sell-search-button" onPress={() => void runSearch()}>
          <Text>Search</Text>
        </Pressable>
      </View>
      {results.map((result) => (
        <Pressable
          key={result.variantId}
          testID={`sell-search-result-${result.sku}`}
          onPress={() => addResult(result.variantId)}
        >
          <Text>
            {result.name} — {formatPence(result.pricePence)}
          </Text>
        </Pressable>
      ))}
      {lines.map((line, index) => (
        <Text key={`${line.variantId}-${index}`} testID={`sell-line-${index}`}>
          {line.name} × {line.quantity.toString()} — {formatPence(line.lineTotalPence)}
        </Text>
      ))}
      <Text testID="sell-total">Total: {formatPence(total)}</Text>
      {ageBlocked ? (
        <Text testID="sell-age-gate-banner">
          Age verification required before checkout — confirm Challenge 25 or log a refusal.
        </Text>
      ) : null}
      {!online ? <Text testID="sell-card-offline-banner">{offlineBannerFor('card_payment')}</Text> : null}
      <Text testID="sell-reader-status">
        Reader: {reader.model} — {reader.status}
      </Text>
      {error !== null ? <Text testID="sell-error">{error}</Text> : null}
      {lastOutcome !== null ? (
        <Text testID="sell-card-outcome">
          Card {lastOutcome.outcome}
          {lastOutcome.outcome !== 'succeeded' ? `: ${lastOutcome.reason}` : ''}
        </Text>
      ) : null}
      <Pressable testID="sell-checkout-cash" disabled={busy || total <= 0n} onPress={() => void checkoutCash()}>
        <Text>Cash checkout</Text>
      </Pressable>
      <Pressable
        testID="sell-checkout-card"
        disabled={busy || total <= 0n || !online || !readerReady}
        onPress={() => void checkoutCard()}
      >
        <Text>Card checkout</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16 },
  title: { fontSize: 24, fontWeight: 'bold' },
});
