import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { decodeMeasuredGeometry } from '@figma-ir/core'
import { decodeConsumptionLedger } from '@figma-ir/web-projection'
import { describe, expect, it } from 'vitest'

import { COMMANDS } from './index.js'

/**
 * The skill's reference documents quote contracts. A quoted example that no
 * longer decodes is a document teaching the wrong thing, so the examples are
 * read out of the Markdown and decoded here.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../skills')
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8')
const jsonFences = (markdown: string): unknown[] =>
  [...markdown.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => JSON.parse(match[1] as string) as unknown)

/**
 * Every `figma-ir <command> ...` invocation in a document's shell code fences,
 * with continuation lines joined. Prose is not scanned: "the figma-ir
 * profile" is English, not a command.
 */
const invocations = (markdown: string): Array<{ command: string; options: string[] }> => {
  const fences = [...markdown.matchAll(/```sh\n([\s\S]*?)```/g)].map((match) => match[1] as string).join('\n')
  const joined = fences.replace(/\\\n\s*/g, ' ')
  return [...joined.matchAll(/figma-ir ([a-z-]+)([^\n]*)/g)]
    .filter((match) => match[1] !== 'help')
    .map((match) => ({
      command: match[1] as string,
      options: [...(match[2] as string).matchAll(/--([a-z-]+)/g)].map((option) => option[1] as string),
    }))
}

const DOCUMENTS = [
  'figma-ir-implement/SKILL.md',
  'figma-ir-implement/reference/reading-the-slice.md',
  'figma-ir-implement/reference/projection-and-obligations.md',
  'figma-ir-implement/reference/verification.md',
  'figma-ir-implement/reference/run-record.md',
  'figma-ir-init/SKILL.md',
  'figma-ir-init/reference/profile-template.md',
  'figma-ir-init/reference/discovering-conventions.md',
]

describe('the shipped skills quote contracts that decode', () => {
  it('quotes a measured-geometry file that decodes, and would notice a required field going missing', () => {
    const examples = jsonFences(read('figma-ir-implement/reference/verification.md'))
    expect(examples.length).toBeGreaterThan(0)
    for (const example of examples) expect(() => decodeMeasuredGeometry(example)).not.toThrow()
    const withoutTag = structuredClone(examples[0]) as { entries: Array<Record<string, unknown>> }
    delete withoutTag.entries[0]!['tagName']
    expect(() => decodeMeasuredGeometry(withoutTag)).toThrow(/tagName/)
  })

  it('quotes a consumption ledger that decodes, and would notice a wrong schema version', () => {
    const examples = jsonFences(read('figma-ir-implement/reference/projection-and-obligations.md'))
    expect(examples.length).toBeGreaterThan(0)
    for (const example of examples) expect(() => decodeConsumptionLedger(example)).not.toThrow()
    expect(() => decodeConsumptionLedger({ ...(examples[0] as object), schemaVersion: 2 })).toThrow(/schemaVersion/)
  })

  it('names only commands and options the CLI takes, across every document, continuation lines included', () => {
    const seen = new Map<string, number>()
    for (const document of DOCUMENTS) {
      for (const { command, options } of invocations(read(document))) {
        seen.set(document, (seen.get(document) ?? 0) + 1)
        expect(Object.keys(COMMANDS), `${document}: ${command}`).toContain(command)
        const spec = COMMANDS[command]!
        for (const name of options) {
          expect([...spec.values, ...spec.flags], `${document}: ${command} --${name}`).toContain(name)
        }
      }
    }
    // Each SKILL walks its own part of the pipeline; a total would let one
    // document's invocations stand in for another's, so the floor is per skill.
    expect(seen.get('figma-ir-implement/SKILL.md')).toBeGreaterThanOrEqual(8)
    expect(seen.get('figma-ir-init/SKILL.md')).toBeGreaterThanOrEqual(6)
  })

  it('would catch an option a document invents, even on a continuation line', () => {
    const planted = '```sh\nfigma-ir diff-geometry --snapshot s --roots r \\\n  --tolerance 0.25 --made-up 1\n```'
    const [call] = invocations(planted)
    expect(call?.options).toEqual(['snapshot', 'roots', 'tolerance', 'made-up'])
    const spec = COMMANDS['diff-geometry']!
    expect([...spec.values, ...spec.flags]).not.toContain('made-up')
  })

  it('exposes the command table frozen, so nothing can widen what the parser accepts', () => {
    expect(Object.isFrozen(COMMANDS)).toBe(true)
    expect(Object.isFrozen(COMMANDS['acquire'])).toBe(true)
    expect(Object.isFrozen(COMMANDS['acquire']!.values)).toBe(true)
  })
})
