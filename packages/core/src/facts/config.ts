/**
 * The fact configuration, validated from outside the type system.
 *
 * A configuration file is where a project declares its conventions, and a
 * declaration that is silently ignored — a misspelled key, a breakpoint
 * listed twice, an `allowed` list that is not a list — is worse than none:
 * the project believes something is being checked (REG-CONF-017). Every key
 * is known, every value has the shape it needs, and the patterns compile,
 * or the file is refused.
 */
import { compileArtboardPattern, compileNamePattern, FactConfigError } from './pattern.js'
import type { FactConfig, ResponsiveConfig, StyleNameConfig } from './types.js'

const asRecord = (value: unknown, where: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FactConfigError(`${where}: expected an object`)
  }
  return value as Record<string, unknown>
}

const noExtraKeys = (record: Record<string, unknown>, allowed: ReadonlyArray<string>, where: string): void => {
  const extra = Object.keys(record).filter((key) => !allowed.includes(key))
  if (extra.length > 0) throw new FactConfigError(`${where}: unknown key(s): ${extra.sort().join(', ')}`)
}

const nonEmptyString = (value: unknown, where: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new FactConfigError(`${where}: expected a non-empty string`)
  return value
}

const uniqueStrings = (value: unknown, where: string): ReadonlyArray<string> => {
  if (!Array.isArray(value)) throw new FactConfigError(`${where}: expected a list of strings`)
  const strings = value.map((entry, index) => nonEmptyString(entry, `${where}[${index}]`))
  const seen = new Set<string>()
  for (const entry of strings) {
    if (seen.has(entry)) throw new FactConfigError(`${where}: "${entry}" is listed twice`)
    seen.add(entry)
  }
  return strings
}

const decodeResponsive = (raw: unknown): ResponsiveConfig => {
  const where = 'responsive'
  const record = asRecord(raw, where)
  noExtraKeys(record, ['namePattern', 'breakpoints', 'explicit'], where)
  const namePattern = nonEmptyString(record['namePattern'], `${where}.namePattern`)
  if (!Array.isArray(record['breakpoints']) || record['breakpoints'].length === 0) {
    throw new FactConfigError(`${where}.breakpoints: expected a non-empty list`)
  }
  const slots = new Set<string>()
  const widths = new Set<number>()
  const breakpoints = record['breakpoints'].map((entryRaw, index) => {
    const at = `${where}.breakpoints[${index}]`
    const entry = asRecord(entryRaw, at)
    noExtraKeys(entry, ['slot', 'designWidthPx'], at)
    const slot = nonEmptyString(entry['slot'], `${at}.slot`)
    const designWidthPx = entry['designWidthPx']
    if (typeof designWidthPx !== 'number' || !Number.isFinite(designWidthPx) || designWidthPx <= 0) {
      throw new FactConfigError(`${at}.designWidthPx: expected a positive number`)
    }
    // Two slots at one width, or one slot at two widths, cannot be told apart
    // when a name is resolved; refused here rather than resolved by order.
    if (slots.has(slot)) throw new FactConfigError(`${at}: slot "${slot}" is declared twice`)
    if (widths.has(designWidthPx)) throw new FactConfigError(`${at}: width ${designWidthPx} is declared twice`)
    slots.add(slot)
    widths.add(designWidthPx)
    return { slot, designWidthPx }
  })
  compileArtboardPattern(namePattern, breakpoints.map((entry) => entry.slot))
  if (record['explicit'] === undefined) return { namePattern, breakpoints }
  if (!Array.isArray(record['explicit'])) throw new FactConfigError(`${where}.explicit: expected a list`)
  const declared = new Set<string>()
  const explicit = record['explicit'].map((entryRaw, index) => {
    const at = `${where}.explicit[${index}]`
    const entry = asRecord(entryRaw, at)
    noExtraKeys(entry, ['nodeId', 'section', 'breakpoint'], at)
    const nodeId = nonEmptyString(entry['nodeId'], `${at}.nodeId`)
    const section = nonEmptyString(entry['section'], `${at}.section`)
    const breakpoint = nonEmptyString(entry['breakpoint'], `${at}.breakpoint`)
    if (!slots.has(breakpoint)) throw new FactConfigError(`${at}.breakpoint: "${breakpoint}" is not a declared slot`)
    // The second declaration would win in silence otherwise.
    if (declared.has(nodeId)) throw new FactConfigError(`${at}: node ${nodeId} is declared twice`)
    declared.add(nodeId)
    return { nodeId, section, breakpoint }
  })
  return { namePattern, breakpoints, explicit }
}

const decodeStyleNames = (raw: unknown): StyleNameConfig => {
  const where = 'styleNames'
  const record = asRecord(raw, where)
  noExtraKeys(record, ['pattern', 'allowed'], where)
  const pattern = nonEmptyString(record['pattern'], `${where}.pattern`)
  if (record['allowed'] === undefined) {
    compileNamePattern(pattern, { where: `${where}.pattern` })
    return { pattern }
  }
  const allowedRecord = asRecord(record['allowed'], `${where}.allowed`)
  // A null prototype, so a key like `__proto__` from a parsed document
  // becomes an own property the pattern check can see and refuse, instead
  // of a setter call that leaves no trace (REG-CONF-017).
  const allowed: Record<string, ReadonlyArray<string>> = Object.create(null) as Record<string, ReadonlyArray<string>>
  for (const segment of Object.keys(allowedRecord).sort()) {
    const values = uniqueStrings(allowedRecord[segment], `${where}.allowed.${segment}`)
    if (values.length === 0) throw new FactConfigError(`${where}.allowed.${segment}: an empty vocabulary matches nothing`)
    allowed[segment] = values
  }
  compileNamePattern(pattern, { where: `${where}.pattern`, vocabulary: allowed })
  return { pattern, allowed }
}

/**
 * Validates a configuration document and returns it typed.
 *
 * Also the right thing to call on a typed object built in code: the checks
 * that matter (duplicates, empty lists, patterns that compile) are not
 * expressible in the type.
 */
export const decodeFactConfig = (raw: unknown): FactConfig => {
  if (raw === undefined) return {}
  const record = asRecord(raw, 'config')
  noExtraKeys(record, ['responsive', 'styleNames'], 'config')
  return {
    ...(record['responsive'] === undefined ? {} : { responsive: decodeResponsive(record['responsive']) }),
    ...(record['styleNames'] === undefined ? {} : { styleNames: decodeStyleNames(record['styleNames']) }),
  }
}
