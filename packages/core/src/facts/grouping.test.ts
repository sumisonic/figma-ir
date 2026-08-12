import { describe, expect, it } from 'vitest'

import { unsafeUnwrap, type Untrusted } from '../text/untrusted.js'
import { design, frame, type RawNodeSpec } from '../testing/builders.js'
import { fileKey } from '../figma/client.js'
import { fixtureClient } from '../figma/fixtureClient.js'
import { acquireSnapshot } from '../figma/snapshot.js'
import { fromSnapshot } from '../canonical/adapter.js'
import { loadRuleset, runRules } from '../rules/run.js'
import { isInfrastructureReason, isSemanticReason } from '../diagnostics/reason.js'
import { deriveFacts } from './derive.js'
import { isUnmarkedArtboard, resolveUnmarkedSlot } from './pattern.js'
import type { FactConfig } from './types.js'

const KEY = fileKey('SYNTHETICFILEKEY0001')
const now = () => '2026-01-01T00:00:00.000Z'

/**
 * A page at four widths where the widest artboard was renamed by hand and no
 * longer parses (REG-RESP-004). Three of four follow `page_{width}`; the
 * fourth is `page_xl_final`, the shape a person produces mid-redesign.
 */
const fourVariants = (): ReadonlyArray<RawNodeSpec> => [
  frame('1:1', 'page_375', { x: 0, y: 0, width: 375, height: 800 }),
  frame('2:1', 'page_768', { x: 400, y: 0, width: 768, height: 800 }),
  frame('3:1', 'page_1024', { x: 1200, y: 0, width: 1024, height: 800 }),
  frame('4:1', 'page_xl_final', { x: 2300, y: 0, width: 1440, height: 800 }),
]

const CONFIG: FactConfig = {
  responsive: {
    namePattern: '{section}_{width}',
    breakpoints: [
      { slot: 'sm', designWidthPx: 375 },
      { slot: 'md', designWidthPx: 768 },
      { slot: 'lg', designWidthPx: 1024 },
      { slot: 'xl', designWidthPx: 1440 },
    ],
  },
}

const factsFrom = async (config: FactConfig) => {
  const roots = fourVariants()
  const doc = fromSnapshot(
    await acquireSnapshot({
      client: fixtureClient(design(roots)),
      fileKey: KEY,
      roots: roots.map((root) => root.id),
      now,
    }),
  )
  return deriveFacts(doc, config)
}

// The state is the reason code. The detail beside it is for a person and is
// not compared here: a consumer that had to match its wording would break
// when a sentence was improved.
const NOT_ROOT = 'EXPLICIT_NODE_NOT_ROOT'
const REJECTED = 'EXPLICIT_NODE_REJECTED'
const ABSENT = 'EXPLICIT_NODE_ABSENT'
const NOT_APPLIED: ReadonlyArray<string> = [NOT_ROOT, REJECTED, ABSENT]

type Declaration = NonNullable<NonNullable<FactConfig['responsive']>['explicit']>[number]

const declaring = (explicit: ReadonlyArray<Declaration>): FactConfig => ({
  responsive: { ...(CONFIG.responsive as NonNullable<FactConfig['responsive']>), explicit },
})

/** Facts for a file of which only some roots were acquired, as a run on one section is. */
const factsOfPart = async (
  file: ReadonlyArray<RawNodeSpec>,
  acquired: ReadonlyArray<string>,
  config: FactConfig,
) =>
  deriveFacts(
    fromSnapshot(
      await acquireSnapshot({ client: fixtureClient(design(file)), fileKey: KEY, roots: acquired, now }),
    ),
    config,
  )

const notApplied = (facts: Awaited<ReturnType<typeof factsFrom>>) =>
  facts.diagnostics
    .filter((diagnostic) => NOT_APPLIED.includes(diagnostic.reason))
    .map((diagnostic) => [diagnostic.reason, diagnostic.sourceIds])

describe('an artboard that does not follow the convention (REG-RESP-004)', () => {
  it('groups the three that match and leaves out the one that does not', async () => {
    const facts = await factsFrom(CONFIG)
    const group = facts.responsiveGroups.find((entry) => unsafeUnwrap(entry.section as Untrusted) === 'page')
    // Reading `_xl_final` as "this is the 1440 one" would mean inventing the
    // mapping; the pattern simply does not match, so it is not a member.
    expect(group?.members.map((member) => member.breakpoint)).toEqual(['sm', 'md', 'lg'])
  })

  it('reports the missing breakpoint rather than proceeding with three', async () => {
    // The incident this exists for: implementing from three breakpoints and
    // discovering the fourth later. Here it surfaces before any code is written.
    const facts = await factsFrom(CONFIG)
    const run = runRules(
      facts,
      loadRuleset({
        rules: [{ use: 'responsive.group-completeness.v1', params: { breakpoints: ['sm', 'md', 'lg', 'xl'] } }],
      }),
    )
    expect(run.findings).toHaveLength(1)
    expect(run.findings[0]?.message).toContain('xl')
    expect(run.findings[0]?.severity).toBe('warning')
  })

  it('groups all four once the project declares the exception', async () => {
    // The fix is the project saying what its naming actually is — a node id
    // and a breakpoint, one line — not the IR guessing.
    const facts = await factsFrom({
      responsive: {
        ...(CONFIG.responsive as NonNullable<FactConfig['responsive']>),
        explicit: [{ nodeId: '4:1', section: 'page', breakpoint: 'xl' }],
      },
    })
    const group = facts.responsiveGroups.find((entry) => unsafeUnwrap(entry.section as Untrusted) === 'page')
    expect(group?.members.map((member) => member.breakpoint)).toEqual(['sm', 'md', 'lg', 'xl'])
    expect(group?.members.find((member) => member.breakpoint === 'xl')?.designWidthPx).toBe(1440)
  })

  it('stops reporting the missing breakpoint once it is declared', async () => {
    const facts = await factsFrom({
      responsive: {
        ...(CONFIG.responsive as NonNullable<FactConfig['responsive']>),
        explicit: [{ nodeId: '4:1', section: 'page', breakpoint: 'xl' }],
      },
    })
    const run = runRules(
      facts,
      loadRuleset({
        rules: [{ use: 'responsive.group-completeness.v1', params: { breakpoints: ['sm', 'md', 'lg', 'xl'] } }],
      }),
    )
    expect(run.findings).toEqual([])
  })

  it('rejects a declaration naming a breakpoint the config does not have, when the config loads (REG-CONF-017)', async () => {
    await expect(
      factsFrom({
        responsive: {
          ...(CONFIG.responsive as NonNullable<FactConfig['responsive']>),
          explicit: [{ nodeId: '4:1', section: 'page', breakpoint: 'xxl' }],
        },
      }),
    ).rejects.toThrow(/not a declared slot/)
  })

  it('reports a declaration that found no root: a configuration that did nothing says so (REG-CONF-017)', async () => {
    const facts = await factsFrom({
      responsive: {
        ...(CONFIG.responsive as NonNullable<FactConfig['responsive']>),
        explicit: [{ nodeId: '99:99', section: 'page', breakpoint: 'sm' }],
      },
    })
    // Said, and said as what it is: the reason was `CONFIG_ERROR` until
    // REG-CONF-020 took it out of the family that means the run is broken.
    expect(notApplied(facts)).toEqual([[ABSENT, ['99:99']]])
  })

  it('checks the widths of the members it did group', async () => {
    const facts = await factsFrom(CONFIG)
    const run = runRules(
      facts,
      loadRuleset({
        rules: [
          {
            use: 'artboard.expected-width.v2',
            params: { expected: { sm: 375, md: 768, lg: 1024 } },
          },
        ],
      }),
    )
    expect(run.findings).toEqual([])
  })
})

describe('a declaration that found no root in this snapshot (REG-CONF-020)', () => {
  // The configuration describes the whole file; this run acquired one root.
  const forTheWholeFile: ReadonlyArray<Declaration> = [
    { nodeId: '98:1', section: 'other', breakpoint: 'sm' },
    { nodeId: '4:1', section: 'page', breakpoint: 'xl' },
    { nodeId: '100:1', section: 'other', breakpoint: 'md' },
  ]

  it('is not a broken run: acquiring part of a file leaves no infrastructure reason behind', async () => {
    const facts = await factsOfPart(fourVariants(), ['1:1'], declaring(forTheWholeFile))
    expect(facts.diagnostics.filter((diagnostic) => isInfrastructureReason(diagnostic.reason))).toEqual([])
    expect(NOT_APPLIED.every(isSemanticReason)).toBe(true)
  })

  it('says each of them in words too, for the person reading the report', async () => {
    const file: ReadonlyArray<RawNodeSpec> = [
      frame('1:1', 'page_375', { x: 0, y: 0, width: 375, height: 800 }, {
        children: [
          frame('1:2', 'inner', { x: 0, y: 0, width: 100, height: 100 }),
          { id: '1:3', type: 'SLICE', name: 'export' },
        ],
      }),
    ]
    const facts = await factsOfPart(
      file,
      ['1:1'],
      declaring([
        { nodeId: '9:9', section: 'page', breakpoint: 'sm' },
        { nodeId: '1:3', section: 'page', breakpoint: 'lg' },
        { nodeId: '1:2', section: 'page', breakpoint: 'xl' },
      ]),
    )
    const detailOf = (reason: string) => facts.diagnostics.find((diagnostic) => diagnostic.reason === reason)?.detail
    // Not which words: only that each names its state, and that the last
    // admits what a snapshot cannot tell.
    expect(detailOf(NOT_ROOT)).toContain('below a root')
    expect(detailOf(REJECTED)).toContain('rejected')
    expect(detailOf(ABSENT)).toContain('not in this snapshot')
    expect(detailOf(ABSENT)).toContain('mistyped')
  })

  it('reports them in one entry per reason however many there are, ids in code-unit order', async () => {
    const facts = await factsOfPart(fourVariants(), ['1:1'], declaring(forTheWholeFile))
    // `100:1` before `4:1` before `98:1`: by code unit, not by number.
    expect(notApplied(facts)).toEqual([[ABSENT, ['100:1', '4:1', '98:1']]])
  })

  it('does not depend on the order the declarations were written in', async () => {
    const written = await factsOfPart(fourVariants(), ['1:1'], declaring(forTheWholeFile))
    const reversed = await factsOfPart(fourVariants(), ['1:1'], declaring([...forTheWholeFile].reverse()))
    expect(reversed.diagnostics).toEqual(written.diagnostics)
  })

  it('tells a node below a root, a rejected node and a node that is not there apart', async () => {
    const file: ReadonlyArray<RawNodeSpec> = [
      frame('1:1', 'page_375', { x: 0, y: 0, width: 375, height: 800 }, {
        children: [
          frame('1:2', 'inner', { x: 0, y: 0, width: 100, height: 100 }),
          { id: '1:3', type: 'SLICE', name: 'export' },
        ],
      }),
      { id: '5:1', type: 'SECTION', name: 'group' },
    ]
    const facts = await factsOfPart(
      file,
      ['1:1', '5:1'],
      declaring([
        { nodeId: '9:9', section: 'page', breakpoint: 'sm' },
        { nodeId: '5:1', section: 'page', breakpoint: 'md' },
        { nodeId: '1:3', section: 'page', breakpoint: 'lg' },
        { nodeId: '1:2', section: 'page', breakpoint: 'xl' },
      ]),
    )
    // What the snapshot can prove comes first; what it cannot tell from a
    // mistyped id comes last.
    expect(notApplied(facts)).toEqual([
      [NOT_ROOT, ['1:2']],
      [REJECTED, ['1:3', '5:1']],
      [ABSENT, ['9:9']],
    ])
  })

  it('says nothing when every declaration found its root', async () => {
    const facts = await factsFrom(declaring([{ nodeId: '4:1', section: 'page', breakpoint: 'xl' }]))
    expect(notApplied(facts)).toEqual([])
  })

  it('leaves the declarations that did apply applied', async () => {
    const facts = await factsOfPart(
      fourVariants(),
      ['1:1', '4:1'],
      declaring([
        { nodeId: '4:1', section: 'page', breakpoint: 'xl' },
        { nodeId: '98:1', section: 'other', breakpoint: 'sm' },
      ]),
    )
    const group = facts.responsiveGroups.find((entry) => unsafeUnwrap(entry.section as Untrusted) === 'page')
    expect(group?.members.map((member) => member.breakpoint)).toEqual(['sm', 'xl'])
    expect(notApplied(facts)).toEqual([[ABSENT, ['98:1']]])
  })
})

/**
 * A file that marks its small artboards and leaves the wide ones bare
 * (REG-RESP-021): `page_sm` beside `page`, and beside both a frame that is
 * not a view at all.
 */
const oneMarked = (wide: Partial<RawNodeSpec> = {}): ReadonlyArray<RawNodeSpec> => [
  frame('1:1', 'page_sm', { x: 0, y: 0, width: 375, height: 800 }),
  frame('2:1', 'page', { x: 400, y: 0, width: 1440, height: 800 }, wide),
  frame('3:1', 'cover', { x: 2000, y: 0, width: 100, height: 100 }),
]

const MARKED_ONLY: NonNullable<FactConfig['responsive']> = {
  namePattern: '{section}_{breakpoint}',
  breakpoints: [
    { slot: 'sm', designWidthPx: 375 },
    { slot: 'xl', designWidthPx: 1440 },
  ],
}
const UNMARKED: FactConfig = { responsive: { ...MARKED_ONLY, unmarked: { slot: 'xl' } } }

const factsOfFile = (file: ReadonlyArray<RawNodeSpec>, config: FactConfig) =>
  factsOfPart(file, file.map((root) => root.id), config)

const membersOf = (facts: Awaited<ReturnType<typeof factsFrom>>, section: string) =>
  facts.responsiveGroups
    .find((entry) => unsafeUnwrap(entry.section as Untrusted) === section)
    ?.members.map((member) => [member.breakpoint, member.rootId])

describe('a breakpoint whose artboards carry no marker (REG-RESP-021)', () => {
  it('cannot be grouped by the pattern alone: the bare name is not described', async () => {
    const facts = await factsOfFile(oneMarked(), { responsive: MARKED_ONLY })
    expect(membersOf(facts, 'page')).toEqual([['sm', '1:1']])
    expect(facts.declared.responsive?.unmarked).toBeUndefined()
  })

  it('joins its marked sibling once the project says which slot the bare names are', async () => {
    const facts = await factsOfFile(oneMarked(), UNMARKED)
    // The whole name is the section: there is no marker to take off it.
    expect(membersOf(facts, 'page')).toEqual([
      ['sm', '1:1'],
      ['xl', '2:1'],
    ])
    expect(facts.declared.responsive?.unmarked).toBe('xl')
  })

  it('leaves out a bare name of any other width, and has nothing to say about it', async () => {
    const facts = await factsOfFile(oneMarked(), UNMARKED)
    // A page holds more than views under plain names. The declared width
    // is what keeps them out; a name alone would have let them in.
    expect(facts.responsiveGroups.map((group) => unsafeUnwrap(group.section as Untrusted))).toEqual(['page'])
    expect(facts.diagnostics).toEqual([])
  })

  it('takes a frame that is not a view when it is exactly that wide: a test, not a guarantee', async () => {
    const file: ReadonlyArray<RawNodeSpec> = [
      ...oneMarked(),
      frame('4:1', 'banner', { x: 4000, y: 0, width: 1440, height: 100 }),
    ]
    const facts = await factsOfFile(file, UNMARKED)
    // Nothing here can know it is not a view. What it does is leave a
    // group of one, which is where the completeness rule finds it.
    expect(membersOf(facts, 'banner')).toEqual([['xl', '4:1']])
    const run = runRules(
      facts,
      loadRuleset({ rules: [{ use: 'responsive.group-completeness.v1', params: { breakpoints: ['sm', 'xl'] } }] }),
    )
    // One finding: `page` has both of its breakpoints, the stray has one.
    expect(run.findings.map((finding) => [finding.message, finding.sourceIds])).toEqual([
      ['responsive group is missing breakpoint(s): sm', ['4:1']],
    ])
  })

  it('cannot tell such a frame from the view when it carries a section\'s name and the view is not there', async () => {
    // The limit, stated so it is not mistaken for a promise: the name is
    // the section's and the width is the slot's, which is all a view has.
    const file: ReadonlyArray<RawNodeSpec> = [
      frame('1:1', 'page_sm', { x: 0, y: 0, width: 375, height: 800 }),
      frame('2:1', 'page', { x: 400, y: 0, width: 1440, height: 100 }),
    ]
    const facts = await factsOfFile(file, UNMARKED)
    expect(membersOf(facts, 'page')).toEqual([
      ['sm', '1:1'],
      ['xl', '2:1'],
    ])
    const run = runRules(
      facts,
      loadRuleset({ rules: [{ use: 'responsive.group-completeness.v1', params: { breakpoints: ['sm', 'xl'] } }] }),
    )
    expect(run.findings).toEqual([])
  })

  it('does not depend on the order of the roots', async () => {
    const forward = await factsOfFile(oneMarked(), UNMARKED)
    const backward = await factsOfFile([...oneMarked()].reverse(), UNMARKED)
    expect(membersOf(backward, 'page')).toEqual(membersOf(forward, 'page'))
  })

  it('takes the declared width exactly, after the rounding a snapshot applies', async () => {
    const at = async (width: number) =>
      membersOf(await factsOfFile(oneMarked({ absoluteBoundingBox: { x: 400, y: 0, width, height: 800 } }), UNMARKED), 'page')
    // Residue the source leaves on a round number is the same width.
    expect(await at(1440.004)).toEqual([
      ['sm', '1:1'],
      ['xl', '2:1'],
    ])
    // A hundredth off is another width, and a pixel off certainly is: near
    // is not a declaration.
    expect(await at(1440.01)).toEqual([['sm', '1:1']])
    expect(await at(1439)).toEqual([['sm', '1:1']])
  })

  it('leaves the gap for the completeness rule to report when the bare one is off', async () => {
    const facts = await factsOfFile(oneMarked({ absoluteBoundingBox: { x: 400, y: 0, width: 1439, height: 800 } }), UNMARKED)
    const run = runRules(
      facts,
      loadRuleset({ rules: [{ use: 'responsive.group-completeness.v1', params: { breakpoints: ['sm', 'xl'] } }] }),
    )
    expect(run.findings).toHaveLength(1)
    expect(run.findings[0]?.message).toContain('xl')
  })

  it('asks the question only of a name a pattern could have been asked about', () => {
    const xl = { slot: 'xl', designWidthPx: 1440 }
    // The bounds a name pattern matches within: not empty, and no longer
    // than the longest name a pattern is ever run against.
    expect(isUnmarkedArtboard('', 1440, xl)).toBe(false)
    expect(isUnmarkedArtboard('a'.repeat(512), 1440, xl)).toBe(true)
    expect(isUnmarkedArtboard('a'.repeat(513), 1440, xl)).toBe(false)
    // And only with a width to check: none is not the declared one.
    expect(isUnmarkedArtboard('page', undefined, xl)).toBe(false)
    expect(isUnmarkedArtboard('page', 1440, xl)).toBe(true)
    // Both sides are rounded, the declared width as much as the measured.
    expect(isUnmarkedArtboard('page', 1440, { slot: 'xl', designWidthPx: 1440.004 })).toBe(true)
    expect(isUnmarkedArtboard('page', 1440, { slot: 'xl', designWidthPx: 1440.01 })).toBe(false)
  })

  it('refuses to look up a slot the table does not have', () => {
    const table = new Map([['xl', 1440]])
    expect(resolveUnmarkedSlot(undefined, table, 'unmarked')).toBeUndefined()
    expect(resolveUnmarkedSlot({ slot: 'xl' }, table, 'unmarked')).toEqual({ slot: 'xl', designWidthPx: 1440 })
    expect(() => resolveUnmarkedSlot({ slot: 'md' }, table, 'unmarked')).toThrow(/unmarked\.slot: "md" is not a declared slot/)
  })

  it('does not guess for a root without a box', async () => {
    const file: ReadonlyArray<RawNodeSpec> = [
      frame('1:1', 'page_sm', { x: 0, y: 0, width: 375, height: 800 }),
      { id: '2:1', type: 'FRAME', name: 'page' },
    ]
    expect(membersOf(await factsOfFile(file, UNMARKED), 'page')).toEqual([['sm', '1:1']])
  })

  it('gives way to a declaration by node id', async () => {
    const facts = await factsOfFile(oneMarked(), {
      responsive: { ...MARKED_ONLY, unmarked: { slot: 'xl' }, explicit: [{ nodeId: '2:1', section: 'other', breakpoint: 'sm' }] },
    })
    expect(membersOf(facts, 'other')).toEqual([['sm', '2:1']])
    expect(membersOf(facts, 'page')).toEqual([['sm', '1:1']])
  })

  it('gives way to the pattern: a marked name is what it says, whatever its width', async () => {
    const file: ReadonlyArray<RawNodeSpec> = [frame('1:1', 'page_sm', { x: 0, y: 0, width: 1440, height: 800 })]
    const facts = await factsOfFile(file, UNMARKED)
    expect(membersOf(facts, 'page')).toEqual([['sm', '1:1']])
    expect(membersOf(facts, 'page_sm')).toBeUndefined()
  })

  it('does not rescue a name the pattern matched and found wrong', async () => {
    const file: ReadonlyArray<RawNodeSpec> = [frame('1:1', 'page_640', { x: 0, y: 0, width: 1440, height: 800 })]
    const facts = await factsOfFile(file, {
      responsive: { ...MARKED_ONLY, namePattern: '{section}_{width}', unmarked: { slot: 'xl' } },
    })
    expect(facts.responsiveGroups).toEqual([])
    expect(facts.diagnostics.map((diagnostic) => [diagnostic.reason, diagnostic.sourceIds])).toEqual([
      ['UNKNOWN_GROUPING', ['1:1']],
    ])
  })

  it('reports two bare roots of one name rather than picking one', async () => {
    const file: ReadonlyArray<RawNodeSpec> = [
      ...oneMarked(),
      frame('4:1', 'page', { x: 4000, y: 0, width: 1440, height: 800 }),
    ]
    const facts = await factsOfFile(file, UNMARKED)
    expect(facts.diagnostics.map((diagnostic) => [diagnostic.reason, diagnostic.sourceIds])).toEqual([
      ['AMBIGUOUS_NODE_MATCH', ['2:1', '4:1']],
    ])
  })
})
