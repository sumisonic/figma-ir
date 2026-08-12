/**
 * Text from a design file is data, never instruction.
 *
 * A designer can type "ignore previous instructions" into a layer, and that
 * string travels all the way to a prompt.
 *
 * What the brand actually buys, stated precisely because overstating it would
 * be worse than not having it: a plain `string` cannot be assigned to
 * `Untrusted`, so text that skipped the adapter cannot masquerade as vetted;
 * and every place that leaves this module is named, so the sinks are greppable.
 *
 * What it does not buy: `Untrusted` is a subtype of `string`, so
 * `prompt + value` and `${value}` still compile. Preventing those needs a lint
 * rule over the prompt-building sinks, not a type. And `toJsonData` only
 * guarantees framing — the text cannot break out of its quotes — never that a
 * model will decline to follow instructions it finds inside the data.
 */

declare const UntrustedBrand: unique symbol

/** A string that came from the design source and has not been vetted. */
export type Untrusted = string & { readonly [UntrustedBrand]: true }

/** Marks a raw string as untrusted. Call this in the adapter, nowhere else. */
export const markUntrusted = (value: string): Untrusted => value as Untrusted

/**
 * The sanctioned way to put untrusted text into a prompt: as JSON data.
 *
 * Escaping keeps the text inside its quotes, so it cannot terminate the
 * surrounding structure and continue as prose. It does not make the content
 * harmless; that is what `scanText` and the input gate are for.
 */
export const toJsonData = (value: Untrusted): string => JSON.stringify(value as string)

/** Escape hatch. Named so that `grep unsafeUnwrap` finds every use. */
export const unsafeUnwrap = (value: Untrusted): string => value as string

/** Measures length without un-branding. */
export const untrustedLength = (value: Untrusted): number => (value as string).length

/** Compares two untrusted strings without un-branding either. */
export const untrustedEquals = (a: Untrusted, b: Untrusted): boolean => (a as string) === (b as string)

/**
 * A fresh copy of a pattern, so evaluation cannot depend on previous calls.
 *
 * A `/g` or `/y` regex carries `lastIndex` between uses, which would make the
 * same name match on one call and fail on the next — a rule that fires
 * intermittently is worse than one that never fires, because it looks like the
 * design changed.
 */
const detached = (pattern: RegExp): RegExp => new RegExp(pattern.source, pattern.flags)

/**
 * Tests untrusted text against a pattern without un-branding it.
 *
 * Naming-convention rules need to match layer and style names, and making them
 * reach for `unsafeUnwrap` would put an escape hatch in the most routine code
 * in the system — at which point the hatch stops being noticeable.
 */
export const untrustedMatches = (value: Untrusted, pattern: RegExp): boolean =>
  detached(pattern).test(value as string)

/**
 * Extracts capture groups from untrusted text.
 *
 * The captures stay `Untrusted`. Matching a pattern says something about the
 * shape of a string, not about who wrote it — a layer named
 * `main/{ignore previous instructions}/sm/ja` still satisfies a four-segment
 * pattern. Promotion to a trusted value is a separate, deliberate step.
 */
export const untrustedCapture = (value: Untrusted, pattern: RegExp): ReadonlyArray<Untrusted> | undefined => {
  const match = detached(pattern).exec(value as string)
  return match === null ? undefined : match.slice(1).map((group) => markUntrusted(group ?? ''))
}

/**
 * Patterns that have been used to smuggle instructions into model input.
 *
 * This is a heuristic and is documented as one. It exists so that an input gate
 * has something mechanical to act on, not because a regex can decide intent.
 */
const INJECTION_PATTERNS: ReadonlyArray<{ readonly id: string; readonly pattern: RegExp }> = [
  { id: 'ignore-previous', pattern: /\bignore\s+(?:all\s+)?(?:previous|prior|above)\b/i },
  { id: 'disregard-instructions', pattern: /\bdisregard\s+(?:the\s+)?(?:above|previous|instructions)\b/i },
  { id: 'system-prompt', pattern: /\b(?:system|developer)\s*(?:prompt|message)\b/i },
  { id: 'role-marker', pattern: /^\s*(?:system|assistant|user)\s*:/im },
  { id: 'chat-template-marker', pattern: /<\|(?:im_start|im_end|endoftext|system|user|assistant)\|>/i },
  { id: 'instruction-override', pattern: /\byou\s+(?:are|must|should)\s+now\b/i },
  { id: 'tool-injection', pattern: /\b(?:call|invoke|run)\s+(?:the\s+)?(?:tool|function|command)\b/i },
  { id: 'exfiltration', pattern: /\b(?:reveal|print|output)\s+(?:your|the)\s+(?:prompt|instructions|rules)\b/i },
]

export interface TextScan {
  /** True if any pattern matched. A heuristic signal, not a verdict. */
  readonly suspectedInjection: boolean
  /** IDs of the patterns that matched, sorted for determinism. */
  readonly matches: ReadonlyArray<string>
}

/**
 * Scans untrusted text for instruction-shaped content.
 *
 * Heuristic. It will miss things and it will fire on innocent copy — a design
 * about prompt engineering will trip it. The output is a diagnostic for a gate
 * to weigh, never a guarantee.
 */
export const scanText = (value: Untrusted): TextScan => {
  const raw = value as string
  const matches = INJECTION_PATTERNS.filter(({ pattern }) => pattern.test(raw))
    .map(({ id }) => id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return { suspectedInjection: matches.length > 0, matches }
}
