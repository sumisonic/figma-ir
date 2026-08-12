/**
 * Slot-specific numeric rounding.
 *
 * Figma returns values like `12.000001`. Rounded per slot, because the right
 * precision differs by what the number means: a pixel does not need the same
 * resolution as a ratio.
 */

/** Decimal places per slot kind. */
export const PRECISION = {
  /** Lengths in px. */
  px: 2,
  /** Ratios and opacity (0..1). */
  ratio: 4,
  /** Angles in degrees. */
  angle: 2,
} as const

export type SlotKind = keyof typeof PRECISION

export class RoundingError extends Error {
  readonly _tag = 'RoundingError'
  constructor(message: string) {
    super(message)
    this.name = 'RoundingError'
  }
}

/**
 * Shifts a number by a power of ten without going through multiplication.
 *
 * `1.005 * 100` is `100.49999999999999`, which rounds the wrong way, so the
 * shift is done on the decimal exponent instead. Splitting the string form
 * first matters: a value whose default representation is already exponential --
 * `2.5e-16`, the residue a rotation keeps after being rotated back -- would
 * otherwise become the text `2.5e-16e2`, which is not a number at all.
 */
const shiftExponent = (value: number, by: number): number => {
  const [mantissa, exponent] = String(value).split('e')
  return Number(`${mantissa as string}e${Number(exponent ?? 0) + by}`)
}

/**
 * Rounds to `decimals` places, half away from zero, normalizing `-0` to `0`.
 *
 * The sign is separated before rounding, because `Math.round` breaks ties
 * toward positive infinity: it sends `1.5` to `2` but `-1.5` to `-1`. Left
 * alone, a coordinate would round differently depending on which side of the
 * origin it sat on, and `round(-x) === -round(x)` would not hold.
 */
export const roundTo = (value: number, decimals: number): number => {
  if (!Number.isFinite(value)) throw new RoundingError(`cannot round non-finite number ${String(value)}`)
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 15) {
    throw new RoundingError(`decimals must be an integer in 0..15, got ${String(decimals)}`)
  }

  // A number this large has no fractional part left to round; shifting it would
  // overflow to Infinity and throw on a value that needed no work.
  if (Math.abs(value) >= Number.MAX_SAFE_INTEGER) return value

  const shifted = shiftExponent(value, decimals)
  if (!Number.isFinite(shifted)) throw new RoundingError(`rounding overflowed for ${String(value)}`)

  const magnitude = Math.round(Math.abs(shifted))
  const signed = shifted < 0 ? -magnitude : magnitude
  const rounded = shiftExponent(signed, -decimals)
  if (!Number.isFinite(rounded)) throw new RoundingError(`rounding overflowed for ${String(value)}`)
  return Object.is(rounded, -0) ? 0 : rounded
}

/** Rounds using the precision registered for a slot kind. */
export const roundSlot = (value: number, kind: SlotKind): number => roundTo(value, PRECISION[kind])

export const roundPx = (value: number): number => roundSlot(value, 'px')
export const roundRatio = (value: number): number => roundSlot(value, 'ratio')
export const roundAngle = (value: number): number => roundSlot(value, 'angle')
