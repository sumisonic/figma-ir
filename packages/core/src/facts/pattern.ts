/**
 * Name patterns: the one place a project's naming convention is turned into
 * a matcher.
 *
 * A pattern is a template of literals and `{segment}` placeholders that must
 * match a whole name. Nothing here is inferred from the file: the project
 * writes the pattern down, and a name either follows it or does not. Both
 * the artboard convention (`{section}_{width}`) and the text style
 * convention (`{group}/{purpose}/{breakpoint}/{language}`) compile through
 * this module, so they are validated the same way and fail the same way —
 * loudly, at configuration time, never by matching nothing (REG-CONF-017).
 */

export class FactConfigError extends Error {
  readonly _tag = 'FactConfigError'
  constructor(message: string) {
    super(message)
    this.name = 'FactConfigError'
  }
}

const PLACEHOLDER = /\{([^{}]*)\}/g
// Identifier-shaped, because the name becomes a named capture group: a
// hyphen would pass a looser check here and fail inside RegExp, as a
// different error than the configuration contract promises.
const SEGMENT_NAME = /^[A-Za-z][A-Za-z0-9_]*$/
/**
 * Bounds that keep matching linear in practice. Each open segment is a
 * lazy `.+?`, and a long name full of separators against a pattern with
 * many open segments backtracks combinatorially; a name pattern that needs
 * more than this is not a name pattern.
 */
const MAX_PLACEHOLDERS = 8
const MAX_PATTERN_LENGTH = 200
const MAX_NAME_LENGTH = 512
const REGEX_METACHARACTERS = new Set(['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\', '/', '-'])

const escapeLiteral = (text: string): string =>
  [...text].map((character) => (REGEX_METACHARACTERS.has(character) ? `\\${character}` : character)).join('')

export interface CompiledPattern {
  readonly source: string
  /** Placeholder names, in pattern order. */
  readonly segments: ReadonlyArray<string>
  readonly regex: RegExp
}

export interface PatternOptions {
  /** What each placeholder may match. Absent means "the shortest text that lets the whole name match". */
  readonly vocabulary?: Readonly<Record<string, ReadonlyArray<string> | 'digits'>>
  /** Placeholder names the pattern may use; absent means any well-formed name. */
  readonly allowedSegments?: ReadonlyArray<string>
  /** Placeholders that must appear. */
  readonly requiredSegments?: ReadonlyArray<string>
  /** Where the pattern came from, for the error message. */
  readonly where: string
}

/**
 * Compiles a pattern, refusing one that could not mean what it says.
 *
 * A segment with a closed vocabulary is matched as the alternation of its
 * values, so a name like `program_detail_sm` splits into `program_detail`
 * and `sm` rather than into `program` and `detail_sm` — the separator may
 * appear inside an open segment, and the closed one is what pins the split.
 * Two placeholders with nothing between them cannot be told apart, so that
 * is an error rather than a guess.
 */
export const compileNamePattern = (pattern: string, options: PatternOptions): CompiledPattern => {
  const { where } = options
  if (pattern.length === 0) throw new FactConfigError(`${where}: the pattern is empty`)
  if (pattern.length > MAX_PATTERN_LENGTH) throw new FactConfigError(`${where}: the pattern is longer than ${MAX_PATTERN_LENGTH} characters`)
  const segments: string[] = []
  let regexSource = ''
  let cursor = 0
  let previousWasPlaceholder = false
  const literalOrThrow = (text: string): string => {
    if (text.includes('{') || text.includes('}')) throw new FactConfigError(`${where}: unbalanced braces in "${pattern}"`)
    return escapeLiteral(text)
  }
  for (const match of pattern.matchAll(PLACEHOLDER)) {
    const literal = pattern.slice(cursor, match.index)
    if (previousWasPlaceholder && literal.length === 0) {
      throw new FactConfigError(`${where}: two placeholders touch at {${match[1]}}; put a literal between them`)
    }
    regexSource += literalOrThrow(literal)
    const name = match[1] as string
    if (!SEGMENT_NAME.test(name)) throw new FactConfigError(`${where}: {${name}} is not a valid placeholder name`)
    if (segments.includes(name)) throw new FactConfigError(`${where}: {${name}} appears more than once`)
    if (options.allowedSegments !== undefined && !options.allowedSegments.includes(name)) {
      throw new FactConfigError(`${where}: {${name}} is not a placeholder this pattern may use (${options.allowedSegments.map((s) => `{${s}}`).join(', ')})`)
    }
    segments.push(name)
    if (segments.length > MAX_PLACEHOLDERS) throw new FactConfigError(`${where}: more than ${MAX_PLACEHOLDERS} placeholders`)
    const vocabulary = options.vocabulary?.[name]
    if (Array.isArray(vocabulary)) {
      if (vocabulary.length === 0) throw new FactConfigError(`${where}: the vocabulary for {${name}} is empty`)
      if (vocabulary.some((value) => value.length === 0)) throw new FactConfigError(`${where}: the vocabulary for {${name}} contains an empty value`)
      if (new Set(vocabulary).size !== vocabulary.length) throw new FactConfigError(`${where}: the vocabulary for {${name}} lists a value twice`)
    }
    regexSource +=
      vocabulary === 'digits'
        ? `(?<${name}>\\d+)`
        : vocabulary === undefined
          ? `(?<${name}>.+?)`
          : `(?<${name}>${[...vocabulary].sort((a, b) => b.length - a.length).map(escapeLiteral).join('|')})`
    cursor = (match.index as number) + match[0].length
    previousWasPlaceholder = true
  }
  regexSource += literalOrThrow(pattern.slice(cursor))
  if (segments.length === 0) throw new FactConfigError(`${where}: the pattern has no placeholder`)
  for (const required of options.requiredSegments ?? []) {
    if (!segments.includes(required)) throw new FactConfigError(`${where}: the pattern must contain {${required}}`)
  }
  for (const key of Object.keys(options.vocabulary ?? {})) {
    if (!segments.includes(key)) throw new FactConfigError(`${where}: a vocabulary is given for {${key}}, which the pattern does not contain`)
  }
  return { source: pattern, segments, regex: new RegExp(`^${regexSource}$`) }
}

/** The captured segments in pattern order, or undefined when the name does not follow the pattern. */
export const matchNamePattern = (
  compiled: CompiledPattern,
  name: string,
): ReadonlyArray<{ readonly segment: string; readonly value: string }> | undefined => {
  if (name.length > MAX_NAME_LENGTH) return undefined
  const match = compiled.regex.exec(name)
  if (match === null) return undefined
  return compiled.segments.map((segment) => ({ segment, value: match.groups?.[segment] as string }))
}

/**
 * The artboard convention: `{section}` plus `{width}` (design px) and/or
 * `{breakpoint}` (a declared slot). Shared with `list-frames`, so the two
 * cannot drift.
 */
export const compileArtboardPattern = (pattern: string, slots: ReadonlyArray<string>): CompiledPattern => {
  const compiled = compileNamePattern(pattern, {
    where: 'responsive.namePattern',
    allowedSegments: ['section', 'width', 'breakpoint'],
    requiredSegments: ['section'],
    vocabulary: {
      ...(pattern.includes('{width}') ? { width: 'digits' as const } : {}),
      ...(pattern.includes('{breakpoint}') ? { breakpoint: slots } : {}),
    },
  })
  if (!compiled.segments.includes('width') && !compiled.segments.includes('breakpoint')) {
    throw new FactConfigError('responsive.namePattern: the pattern must contain {width} or {breakpoint}')
  }
  return compiled
}

export type ResolvedArtboardName =
  | { readonly section: string; readonly slot: string; readonly designWidthPx: number }
  | { readonly problem: string }

/** What a root's name says about which breakpoint it is, checked against the declaration. */
export const resolveArtboardName = (
  pattern: CompiledPattern,
  name: string,
  widthToSlot: ReadonlyMap<number, string>,
  slotToWidth: ReadonlyMap<string, number>,
): ResolvedArtboardName | undefined => {
  const parts = matchNamePattern(pattern, name)
  if (parts === undefined) return undefined
  const value = (segment: string) => parts.find((part) => part.segment === segment)?.value
  const section = value('section') as string
  const width = value('width')
  const breakpoint = value('breakpoint')
  const fromWidth = width === undefined ? undefined : widthToSlot.get(Number(width))
  if (width !== undefined && fromWidth === undefined) {
    return { problem: `artboard width ${width} is not a declared breakpoint` }
  }
  if (breakpoint !== undefined && fromWidth !== undefined && fromWidth !== breakpoint) {
    return {
      problem: `the name says ${breakpoint} and width ${width}, which is declared as ${fromWidth}`,
    }
  }
  const slot = (breakpoint ?? fromWidth) as string
  return { section, slot, designWidthPx: slotToWidth.get(slot) as number }
}
