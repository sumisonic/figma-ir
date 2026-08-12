/**
 * Parameter parsing for rules.
 *
 * Strict: a key a rule does not recognise is an error rather than something
 * quietly ignored. A project that misspells `breakpoints` should be told, not
 * left with a check that silently passes everything because it was configured
 * with nothing.
 */
import { RuleConfigError } from './types.js'

export const asObject = (ruleId: string, raw: unknown): Record<string, unknown> => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RuleConfigError(ruleId, 'params must be an object')
  }
  return raw as Record<string, unknown>
}

export const noExtraKeys = (ruleId: string, raw: Record<string, unknown>, allowed: ReadonlyArray<string>): void => {
  const known = new Set(allowed)
  const extra = Object.keys(raw).filter((key) => !known.has(key))
  if (extra.length > 0) {
    throw new RuleConfigError(ruleId, `unknown parameter(s): ${extra.sort().join(', ')}`)
  }
}

export const requireString = (ruleId: string, raw: Record<string, unknown>, key: string): string => {
  const value = raw[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuleConfigError(ruleId, `"${key}" must be a non-empty string`)
  }
  return value
}

export const requireStringArray = (
  ruleId: string,
  raw: Record<string, unknown>,
  key: string,
): ReadonlyArray<string> => {
  const value = raw[key]
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== 'string')) {
    throw new RuleConfigError(ruleId, `"${key}" must be a non-empty array of strings`)
  }
  return value as ReadonlyArray<string>
}

/**
 * An optional list, where writing an empty one is a legitimate thing to say.
 *
 * `exemptPurposes: []` is how a project states that it has no exemptions yet,
 * and rejecting it as "empty" would force it to delete the key and lose the
 * comment above it explaining what would go there.
 */
export const optionalStringArray = (
  ruleId: string,
  raw: Record<string, unknown>,
  key: string,
): ReadonlyArray<string> => {
  const value = raw[key]
  if (value === undefined) return []
  // `null` is what YAML gives for a key written with nothing after it, which is
  // far more often an unfinished edit than a considered "none". Treating it as
  // an empty list would repair a mistake into a silently weaker check.
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new RuleConfigError(ruleId, `"${key}" must be an array of strings`)
  }
  return value as ReadonlyArray<string>
}

export const requireNumberRecord = (
  ruleId: string,
  raw: Record<string, unknown>,
  key: string,
): ReadonlyMap<string, number> => {
  const value = raw[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RuleConfigError(ruleId, `"${key}" must be an object of name to number`)
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) throw new RuleConfigError(ruleId, `"${key}" must not be empty`)
  const result = new Map<string, number>()
  for (const [name, entry] of entries) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      throw new RuleConfigError(ruleId, `"${key}.${name}" must be a finite number`)
    }
    result.set(name, entry)
  }
  return result
}
