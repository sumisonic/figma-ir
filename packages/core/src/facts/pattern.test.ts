import { describe, expect, it } from 'vitest'

import { compileNamePattern, FactConfigError, matchNamePattern } from './pattern.js'

const where = 'test.pattern'

describe('compileNamePattern refuses a pattern that could not mean what it says (REG-CONF-017)', () => {
  const cases: ReadonlyArray<[string, string]> = [
    ['', 'empty'],
    ['plain', 'no placeholder'],
    ['{a}{b}', 'touch'],
    ['{a}/{a}', 'more than once'],
    ['{1a}', 'not a valid placeholder'],
    ['{font-size}', 'not a valid placeholder'],
    ['{a}/{', 'unbalanced'],
    ['{a}}/{b}', 'unbalanced'],
  ]
  for (const [pattern, expected] of cases) {
    it(`rejects "${pattern}" (${expected})`, () => {
      expect(() => compileNamePattern(pattern, { where })).toThrow(FactConfigError)
      expect(() => compileNamePattern(pattern, { where })).toThrow(new RegExp(expected))
    })
  }

  it('rejects a vocabulary that is empty, has an empty value, or lists a value twice', () => {
    expect(() => compileNamePattern('{a}', { where, vocabulary: { a: [] } })).toThrow(/empty/)
    expect(() => compileNamePattern('{a}', { where, vocabulary: { a: ['x', ''] } })).toThrow(/empty value/)
    expect(() => compileNamePattern('{a}', { where, vocabulary: { a: ['x', 'x'] } })).toThrow(/twice/)
  })

  it('rejects a placeholder the caller does not allow, a missing required one, and a vocabulary for a segment that is not there', () => {
    expect(() => compileNamePattern('{section}_{colour}', { where, allowedSegments: ['section', 'width'] })).toThrow(
      /colour/,
    )
    expect(() => compileNamePattern('{width}', { where, requiredSegments: ['section'] })).toThrow(/must contain/)
    expect(() => compileNamePattern('{a}/{b}', { where, vocabulary: { c: ['x'] } })).toThrow(/\{c\}/)
  })
})

describe('the complexity bounds sit exactly where they say (REG-CONF-017)', () => {
  it('allows eight placeholders and refuses nine', () => {
    const eight = Array.from({ length: 8 }, (_, i) => `{s${i}}`).join('/')
    expect(compileNamePattern(eight, { where }).segments).toHaveLength(8)
    expect(() => compileNamePattern(`${eight}/{s8}`, { where })).toThrow(/more than 8/)
  })

  it('allows a 200-character pattern and refuses 201', () => {
    const filler = 'x'.repeat(200 - '{a}'.length)
    expect(() => compileNamePattern(`{a}${filler}`, { where })).not.toThrow()
    expect(() => compileNamePattern(`{a}${filler}x`, { where })).toThrow(/longer than 200/)
  })

  it('matches a 512-character name and treats a longer one as no match', () => {
    const compiled = compileNamePattern('{a}', { where })
    expect(matchNamePattern(compiled, 'n'.repeat(512))?.[0]?.value).toHaveLength(512)
    expect(matchNamePattern(compiled, 'n'.repeat(513))).toBeUndefined()
  })
})

describe('matchNamePattern', () => {
  it('lets a closed vocabulary pin the split when the separator occurs inside an open segment', () => {
    // Shortest-match alone would read `program` + `detail_sm`; the slot list
    // says `sm` is the only thing the second segment can be.
    const compiled = compileNamePattern('{section}_{breakpoint}', {
      where,
      vocabulary: { breakpoint: ['sm', 'md'] },
    })
    expect(matchNamePattern(compiled, 'program_detail_sm')).toEqual([
      { segment: 'section', value: 'program_detail' },
      { segment: 'breakpoint', value: 'sm' },
    ])
    expect(matchNamePattern(compiled, 'program_detail_xl')).toBeUndefined()
  })

  it('matches digits only where digits were asked for', () => {
    const compiled = compileNamePattern('{section}_{width}', { where, vocabulary: { width: 'digits' } })
    expect(matchNamePattern(compiled, 'nav_375')).toEqual([
      { segment: 'section', value: 'nav' },
      { segment: 'width', value: '375' },
    ])
    expect(matchNamePattern(compiled, 'nav_wide')).toBeUndefined()
  })

  it('takes the whole name, treats literals literally, and never matches an empty segment', () => {
    const compiled = compileNamePattern('{a}.{b} (v{n})', { where, vocabulary: { n: 'digits' } })
    expect(matchNamePattern(compiled, 'x.y (v2)')).toEqual([
      { segment: 'a', value: 'x' },
      { segment: 'b', value: 'y' },
      { segment: 'n', value: '2' },
    ])
    // "." and "(" are not regex here; an empty segment is not a match.
    expect(matchNamePattern(compiled, 'xZy (v2)')).toBeUndefined()
    expect(matchNamePattern(compiled, '.y (v2)')).toBeUndefined()
    expect(matchNamePattern(compiled, 'x.y (v2) extra')).toBeUndefined()
  })

  it('returns segments in pattern order, whatever order the vocabulary was written in', () => {
    const compiled = compileNamePattern('{group}/{purpose}/{breakpoint}/{language}', {
      where,
      vocabulary: { language: ['ja', 'en'], breakpoint: ['sm', 'xl'] },
    })
    expect(matchNamePattern(compiled, 'main/title/xl/en')?.map((part) => part.segment)).toEqual([
      'group',
      'purpose',
      'breakpoint',
      'language',
    ])
    expect(matchNamePattern(compiled, 'main/title/xl')).toBeUndefined()
  })
})
