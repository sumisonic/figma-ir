import { describe, expect, it } from 'vitest'

import { PRECISION, RoundingError, roundAngle, roundPx, roundRatio, roundTo } from './rounding.js'

describe('roundTo', () => {
  it('cleans up the float noise Figma actually returns', () => {
    expect(roundPx(12.000001)).toBe(12)
    expect(roundPx(11.999999)).toBe(12)
  })

  it('rounds half away from zero at the boundary rather than following binary float error', () => {
    // 1.005 * 100 is 100.49999999999999 in binary floating point, so the naive
    // multiply-and-round gives 1.00 here.
    expect(roundTo(1.005, 2)).toBe(1.01)
  })

  it('normalizes a negative zero result', () => {
    expect(Object.is(roundPx(-0.001), 0)).toBe(true)
  })

  it('keeps precision per slot kind', () => {
    expect(PRECISION.px).toBe(2)
    expect(PRECISION.ratio).toBe(4)
    expect(PRECISION.angle).toBe(2)
    expect(roundRatio(0.123456)).toBe(0.1235)
    expect(roundAngle(45.006)).toBe(45.01)
  })

  it('is idempotent', () => {
    const once = roundPx(3.14159)
    expect(roundPx(once)).toBe(once)
  })

  it('rejects non-finite input and out-of-range precision', () => {
    expect(() => roundPx(Number.NaN)).toThrow(RoundingError)
    expect(() => roundTo(1, -1)).toThrow(RoundingError)
    expect(() => roundTo(1, 16)).toThrow(RoundingError)
  })

  it('leaves integers alone', () => {
    expect(roundPx(375)).toBe(375)
    expect(roundPx(0)).toBe(0)
  })
})

describe('roundTo — sign symmetry', () => {
  it('breaks ties away from zero on both sides', () => {
    expect(roundTo(1.005, 2)).toBe(1.01)
    expect(roundTo(-1.005, 2)).toBe(-1.01)
    expect(roundTo(0.5, 0)).toBe(1)
    expect(roundTo(-0.5, 0)).toBe(-1)
  })

  it('satisfies round(-x) === -round(x), up to the sign of zero', () => {
    // The one asymmetry is deliberate: -0 is normalized to 0, because a
    // negative zero that survives into a hash makes two identical designs
    // look different.
    const negate = (value: number): number => (value === 0 ? 0 : -value)
    for (const value of [0.125, 1.005, 2.675, 45.006, 375.4449, 1e-3, 12.000001]) {
      expect(roundTo(-value, 2)).toBe(negate(roundTo(value, 2)))
      expect(roundTo(-value, 4)).toBe(negate(roundTo(value, 4)))
    }
  })

  it('normalizes a negative zero result on both paths', () => {
    expect(Object.is(roundTo(-0.001, 2), 0)).toBe(true)
    expect(Object.is(roundTo(-0, 2), 0)).toBe(true)
  })

  it('is idempotent for both signs', () => {
    for (const value of [-2.675, -0.001, 0, 0.001, 2.675]) {
      const once = roundPx(value)
      expect(roundPx(once)).toBe(once)
    }
  })
})

describe('roundTo — numbers whose text form is already exponential (REG-ROUND-001)', () => {
  it('rounds a denormal-scale rotation', () => {
    // Designers produce these by nudging an element back to straight. The
    // string form is exponential, and appending an exponent to it produces
    // "2.15...e-16e2" — not a number. Every conversion of a real page failed
    // on exactly this before the fix.
    expect(roundTo(2.5e-16, 2)).toBe(0)
    expect(roundAngle(2.5e-16)).toBe(0)
  })

  it('handles very small and very large magnitudes', () => {
    expect(roundTo(1e-7, 2)).toBe(0)
    expect(roundTo(-1e-7, 2)).toBe(0)
    expect(roundTo(1.5e-3, 2)).toBe(0)
    expect(roundTo(1e21, 2)).toBe(1e21)
    expect(roundTo(-1e21, 2)).toBe(-1e21)
  })

  it('keeps rounding exact for values near the precision boundary', () => {
    expect(roundTo(1.234e-2, 4)).toBe(0.0123)
    expect(roundTo(9.999e-3, 2)).toBe(0.01)
  })
})

describe('roundTo — magnitudes with nothing left to round', () => {
  it('returns a value already beyond fractional precision unchanged', () => {
    // Shifting it would overflow to Infinity and throw on a number that needed
    // no work done to it.
    expect(roundTo(Number.MAX_VALUE, 2)).toBe(Number.MAX_VALUE)
    expect(roundTo(-Number.MAX_VALUE, 2)).toBe(-Number.MAX_VALUE)
    expect(roundTo(Number.MAX_SAFE_INTEGER, 2)).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('still rounds everything below that', () => {
    expect(roundTo(Number.MAX_SAFE_INTEGER - 1 + 0.004, 2)).toBeLessThan(Number.MAX_SAFE_INTEGER)
    expect(roundTo(Number.MIN_VALUE, 2)).toBe(0)
  })
})
