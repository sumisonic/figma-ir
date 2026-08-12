import { describe, expect, it } from 'vitest'

import { decodeFactConfig } from './config.js'
import { FactConfigError } from './pattern.js'
import { FACTS_SCHEMA_VERSION } from './types.js'

const BREAKPOINTS = [
  { slot: 'sm', designWidthPx: 375 },
  { slot: 'xl', designWidthPx: 1440 },
]

describe('decodeFactConfig refuses a configuration that would do nothing (REG-CONF-017)', () => {
  it('accepts a complete declaration and an empty one', () => {
    expect(decodeFactConfig(undefined)).toEqual({})
    expect(decodeFactConfig({})).toEqual({})
    const config = decodeFactConfig({
      responsive: { namePattern: '{section}_{width}', breakpoints: BREAKPOINTS, explicit: [{ nodeId: '9:9', section: 'home', breakpoint: 'xl' }] },
      styleNames: { pattern: '{group}/{purpose}/{breakpoint}/{language}', allowed: { breakpoint: ['sm', 'xl'], language: ['ja'] } },
    })
    expect(config.responsive?.breakpoints).toEqual(BREAKPOINTS)
    expect(config.styleNames?.allowed).toEqual({ breakpoint: ['sm', 'xl'], language: ['ja'] })
  })

  const refused: ReadonlyArray<[string, unknown, RegExp]> = [
    ['a misspelled top-level key', { stylenames: {} }, /unknown key/],
    ['a misspelled key inside styleNames', { styleNames: { pattern: '{a}', alowed: {} } }, /unknown key/],
    ['a key inside responsive that is not one', { responsive: { namePattern: '{section}_{width}', breakpoints: BREAKPOINTS, pattern: 'x' } }, /unknown key/],
    ['no breakpoints', { responsive: { namePattern: '{section}_{width}', breakpoints: [] } }, /non-empty list/],
    ['a slot declared twice', { responsive: { namePattern: '{section}_{width}', breakpoints: [BREAKPOINTS[0], { slot: 'sm', designWidthPx: 768 }] } }, /declared twice/],
    ['a width declared twice', { responsive: { namePattern: '{section}_{width}', breakpoints: [BREAKPOINTS[0], { slot: 'md', designWidthPx: 375 }] } }, /declared twice/],
    ['a width that is not a positive number', { responsive: { namePattern: '{section}_{width}', breakpoints: [{ slot: 'sm', designWidthPx: '375' }] } }, /positive number/],
    ['a pattern with neither width nor breakpoint', { responsive: { namePattern: '{section}', breakpoints: BREAKPOINTS } }, /\{width\} or \{breakpoint\}/],
    ['an explicit entry for a slot that is not declared', { responsive: { namePattern: '{section}_{width}', breakpoints: BREAKPOINTS, explicit: [{ nodeId: '9:9', section: 'home', breakpoint: 'md' }] } }, /not a declared slot/],
    ['the same node declared twice', { responsive: { namePattern: '{section}_{width}', breakpoints: BREAKPOINTS, explicit: [{ nodeId: '9:9', section: 'home', breakpoint: 'sm' }, { nodeId: '9:9', section: 'home', breakpoint: 'xl' }] } }, /declared twice/],
    ['an allowed list that is not a list', { styleNames: { pattern: '{a}', allowed: { a: 'x' } } }, /list of strings/],
    ['an empty allowed list', { styleNames: { pattern: '{a}', allowed: { a: [] } } }, /empty vocabulary/],
    ['an allowed list for a segment the pattern lacks', { styleNames: { pattern: '{a}', allowed: { b: ['x'] } } }, /\{b\}/],
    ['a style pattern that cannot match', { styleNames: { pattern: '{a}{b}' } }, /touch/],
  ]
  it('refuses a vocabulary key that would otherwise vanish into the prototype', () => {
    const raw = JSON.parse('{"styleNames":{"pattern":"{a}","allowed":{"__proto__":["x"]}}}') as unknown
    expect(() => decodeFactConfig(raw)).toThrow(FactConfigError)
    expect(() => decodeFactConfig(raw)).toThrow(/__proto__/)
  })

  it('stamps the facts with the version that carries the declarations', async () => {
    expect(FACTS_SCHEMA_VERSION).toBe(5)
  })

  for (const [label, raw, message] of refused) {
    it(`refuses ${label}`, () => {
      expect(() => decodeFactConfig(raw)).toThrow(FactConfigError)
      expect(() => decodeFactConfig(raw)).toThrow(message)
    })
  }
})
