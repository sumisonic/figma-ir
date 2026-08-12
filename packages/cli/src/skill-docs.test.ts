import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  canonicalStringify,
  decodeMeasuredGeometry,
  decodeSnapshotDiffEnvelopeWire,
  hashCanonicalString,
  type CanonicalValue,
} from '@figma-ir/core'
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

/**
 * Every Markdown file under a directory, as `/`-separated paths relative to
 * it, in code-unit order.
 *
 * Read from disk rather than listed by hand. A list has to be remembered: a
 * reference document added without its line would quote commands that nothing
 * checks, and no test would say so.
 */
const markdownUnder = (directory: string): string[] =>
  readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort()

const DOCUMENTS = markdownUnder(root)

/**
 * Every invocation the CLI would refuse, in the documents under a directory,
 * and how many invocations each document makes.
 *
 * One function from the directory to the verdict, on purpose. A listing that
 * is only tested by itself can stop feeding the check, and nothing would fail.
 */
const checkInvocations = (directory: string): { refused: string[]; seen: Map<string, number> } => {
  const refused: string[] = []
  const seen = new Map<string, number>()
  for (const document of markdownUnder(directory)) {
    for (const { command, options } of invocations(readFileSync(resolve(directory, document), 'utf8'))) {
      seen.set(document, (seen.get(document) ?? 0) + 1)
      const spec = COMMANDS[command]
      if (spec === undefined) {
        refused.push(`${document}: ${command}`)
        continue
      }
      for (const name of options) {
        if (![...spec.values, ...spec.flags].includes(name)) refused.push(`${document}: ${command} --${name}`)
      }
    }
  }
  return { refused, seen }
}

/**
 * The documents that ship today. This is not the list of what is checked —
 * that is read from disk, above — but a floor under it. When the list decided
 * what was checked, a document removed by accident failed the run because it
 * could not be read; reading from disk alone would let it vanish quietly.
 * Leaving a new document out of this list costs nothing: it is checked anyway.
 */
const SHIPPED = [
  'figma-ir-implement/SKILL.md',
  'figma-ir-implement/reference/reading-the-slice.md',
  'figma-ir-implement/reference/reading-the-snapshot-diff.md',
  'figma-ir-implement/reference/projection-and-obligations.md',
  'figma-ir-implement/reference/verification.md',
  'figma-ir-implement/reference/run-record.md',
  'figma-ir-init/SKILL.md',
  'figma-ir-init/reference/profile-template.md',
  'figma-ir-init/reference/discovering-conventions.md',
]

describe('every document under skills/ is checked', () => {
  it('still finds every document that shipped, so one removed by accident is noticed', () => {
    for (const document of SHIPPED) expect(DOCUMENTS, document).toContain(document)
  })

  it('checks a document added in a directory below without being listed, and leaves other files out', () => {
    const directory = mkdtempSync(join(tmpdir(), 'skill-docs-'))
    try {
      mkdirSync(join(directory, 'a-skill', 'reference'), { recursive: true })
      writeFileSync(join(directory, 'a-skill', 'SKILL.md'), '```sh\nfigma-ir list-pages --file k\n```\n')
      writeFileSync(
        join(directory, 'a-skill', 'reference', 'added.md'),
        '```sh\nfigma-ir not-a-command\nfigma-ir list-pages --file k --made-up 1\n```\n',
      )
      // Not Markdown, so what it invents is nobody's document.
      writeFileSync(join(directory, 'a-skill', 'reference', 'notes.txt'), '```sh\nfigma-ir not-a-command\n```\n')

      expect(markdownUnder(directory)).toEqual(['a-skill/SKILL.md', 'a-skill/reference/added.md'])
      const { refused, seen } = checkInvocations(directory)
      expect(refused).toEqual([
        'a-skill/reference/added.md: not-a-command',
        'a-skill/reference/added.md: list-pages --made-up',
      ])
      expect(seen.get('a-skill/SKILL.md')).toBe(1)
      expect(seen.get('a-skill/reference/added.md')).toBe(2)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

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

  it('quotes a snapshot diff that decodes and hashes to what it says, and would notice a lost field, an unknown key or another version', () => {
    const examples = jsonFences(read('figma-ir-implement/reference/reading-the-snapshot-diff.md'))
    expect(examples.length).toBeGreaterThan(0)
    for (const example of examples) {
      expect(() => decodeSnapshotDiffEnvelopeWire(example)).not.toThrow()
      // A quoted result whose hash does not match its content would teach a
      // reader that the hash is decoration.
      const { diffHash, ...payload } = example as Record<string, unknown>
      expect(hashCanonicalString('snapshot-diff', 1, canonicalStringify(payload as CanonicalValue))).toBe(diffHash)
    }
    const example = examples[0] as Record<string, unknown>
    const withoutTotal = structuredClone(example)
    delete withoutTotal['total']
    expect(() => decodeSnapshotDiffEnvelopeWire(withoutTotal)).toThrow()
    expect(() => decodeSnapshotDiffEnvelopeWire({ ...example, note: 'extra' })).toThrow()
    expect(() => decodeSnapshotDiffEnvelopeWire({ ...example, schemaVersion: 2 })).toThrow()
  })

  it('names only commands and options the CLI takes, across every document, continuation lines included', () => {
    const { refused, seen } = checkInvocations(root)
    expect(refused).toEqual([])
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
