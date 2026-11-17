/**
 * Age Verification Gate — Challenge 25 (Build-04, Objective 1).
 *
 * Blocks checkout of any line whose variant requires Challenge 25
 * until the cashier confirms verification (recording
 * `verified_age_threshold`, e.g. 25) or logs a refusal. The gate
 * NEVER stores a customer date of birth — there is no DOB field on
 * any type in this file, and the refusal log records only the
 * threshold, the reason, and the time. This mirrors the API invariant
 * ("Age verification stores the verified age, never a date of birth").
 */
export interface AgeRestrictedLine {
  variantId: string;
  sku: string;
  requiresChallenge25: boolean;
}

export interface AgeRefusal {
  variantId: string;
  sku: string;
  reason: string;
  refusedAt: string;
}

export class AgeVerificationGate {
  private verifiedThreshold: number | null = null;
  private verifiedAt: string | null = null;
  private readonly refusals: AgeRefusal[] = [];

  /** Lines in the basket that need Challenge 25 verification. */
  requiredLines(lines: readonly AgeRestrictedLine[]): AgeRestrictedLine[] {
    return lines.filter((line) => line.requiresChallenge25);
  }

  /** True when every Challenge 25 line in the basket is covered by a verification. */
  isSatisfied(lines: readonly AgeRestrictedLine[]): boolean {
    return this.requiredLines(lines).length === 0 || this.verifiedThreshold !== null;
  }

  /**
   * Confirm Challenge 25 verification. Records ONLY the verified age
   * threshold (25) and the confirmation time — never a date of birth.
   */
  confirm(verifiedAgeThreshold = 25): { verifiedAgeThreshold: number } {
    if (verifiedAgeThreshold < 25) {
      throw new Error('Challenge 25 verification requires a threshold of at least 25');
    }
    this.verifiedThreshold = verifiedAgeThreshold;
    this.verifiedAt = new Date().toISOString();
    return { verifiedAgeThreshold };
  }

  /** Log a refusal (customer could not / would not verify). */
  refuse(line: AgeRestrictedLine, reason: string): AgeRefusal {
    const refusal: AgeRefusal = {
      variantId: line.variantId,
      sku: line.sku,
      reason,
      refusedAt: new Date().toISOString(),
    };
    this.refusals.push(refusal);
    return refusal;
  }

  get verifiedAgeThreshold(): number | null {
    return this.verifiedThreshold;
  }

  /**
   * When the current verification was confirmed (ISO timestamp), or
   * null when nothing is verified. Sent to the API with the sale so
   * the server can persist the verification event (Build-09).
   */
  get verifiedAtIso(): string | null {
    return this.verifiedAt;
  }

  listRefusals(): AgeRefusal[] {
    return [...this.refusals];
  }

  reset(): void {
    this.verifiedThreshold = null;
    this.verifiedAt = null;
  }
}
