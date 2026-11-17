import { describe, expect, it } from 'vitest';
import { businessDate, businessDateFromTimestamp, isSameBusinessDate } from '../src/business-date';

describe('Europe/London business date', () => {
  it('23:30 UTC in summer is 00:30 BST the next day — London date, not UTC date', () => {
    // 2026-06-14T23:30:00Z = 2026-06-15 00:30 BST.
    expect(businessDateFromTimestamp('2026-06-14T23:30:00Z')).toBe('2026-06-15');
    expect(businessDate(new Date('2026-06-14T23:30:00Z'))).toBe('2026-06-15');
  });

  it('00:30 BST on 15 June is 15 June in London', () => {
    expect(businessDateFromTimestamp('2026-06-15T00:30:00+01:00')).toBe('2026-06-15');
  });

  it('00:30 UTC in winter is 00:30 GMT — same date', () => {
    expect(businessDateFromTimestamp('2026-01-15T00:30:00Z')).toBe('2026-01-15');
  });

  it('a UTC date and a London date differ across the midnight boundary', () => {
    const utcDate = new Date('2026-06-14T23:30:00Z').toISOString().slice(0, 10);
    expect(utcDate).toBe('2026-06-14');
    expect(businessDate('2026-06-14T23:30:00Z')).toBe('2026-06-15');
    expect(businessDate('2026-06-14T23:30:00Z')).not.toBe(utcDate);
  });

  it('spring-forward day: 00:30 UTC is still GMT, 01:30 UTC is already BST', () => {
    // BST begins 2026-03-29 at 01:00 UTC (clocks jump 01:00 GMT -> 02:00 BST).
    expect(businessDateFromTimestamp('2026-03-29T00:30:00Z')).toBe('2026-03-29');
    expect(businessDateFromTimestamp('2026-03-29T01:30:00Z')).toBe('2026-03-29');
  });

  it('autumn-back day: 23:30 UTC the day before is already 00:30 BST on the 25th', () => {
    // BST ends 2026-10-25 at 01:00 UTC; before that London is still BST.
    expect(businessDateFromTimestamp('2026-10-24T23:30:00Z')).toBe('2026-10-25');
    expect(businessDateFromTimestamp('2026-10-25T01:30:00Z')).toBe('2026-10-25');
  });

  it('isSameBusinessDate compares London dates, not instants', () => {
    expect(isSameBusinessDate('2026-06-14T23:30:00Z', '2026-06-15T00:30:00+01:00')).toBe(true);
    expect(isSameBusinessDate('2026-06-14T23:30:00Z', '2026-06-14T12:00:00Z')).toBe(false);
  });

  it('rejects an invalid date', () => {
    expect(() => businessDate('not-a-date')).toThrow(/invalid date/);
  });
});
