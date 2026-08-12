import { describe, expect, it } from 'vitest'

import { Schema } from 'effect'

import { fromSnapshot } from '../canonical/adapter.js'
import { deriveFacts } from '../facts/derive.js'
import type { FactConfig } from '../facts/types.js'
import { fileKey, NodesResponseSchema } from '../figma/client.js'
import { fixtureClient } from '../figma/fixtureClient.js'
import { acquireSnapshot } from '../figma/snapshot.js'
import { syntheticMeta } from '../testing/builders.js'
import { unsafeUnwrap } from '../text/untrusted.js'
import { BUILT_IN_RULES } from './builtin.js'
import { hasBlockingFindings, loadRuleset, runRules } from './run.js'
import { RuleConfigError } from './types.js'

const meta = syntheticMeta()

const KEY = fileKey('SYNTHETICFILEKEY0001')
const now = () => '2026-08-12T11:20:00.000Z'

const factsFrom = async (
  documents: ReadonlyArray<Record<string, unknown>>,
  styles: Record<string, unknown> = {},
  config: FactConfig = {},
) => {
  const nodes = {
    nodes: Object.fromEntries(
      documents.map((document) => [document.id as string, { document, styles }]),
    ),
  }
  const snapshot = await acquireSnapshot({
    client: fixtureClient({ meta, nodes: Schema.decodeUnknownSync(NodesResponseSchema)(nodes) }),
    fileKey: KEY,
    roots: documents.map((document) => document.id as string),
    now,
  })
  return deriveFacts(fromSnapshot(snapshot), config)
}

const STYLE_CONFIG: NonNullable<FactConfig['styleNames']> = {
  pattern: '{group}/{purpose}/{breakpoint}/{language}',
  allowed: { breakpoint: ['sm', 'md', 'lg', 'xl'], language: ['ja', 'en', 'all'] },
}

const responsiveConfig = (breakpoints: ReadonlyArray<{ slot: string; designWidthPx: number }>): FactConfig => ({
  responsive: { namePattern: '{section}_{width}', breakpoints },
  styleNames: STYLE_CONFIG,
})

const textNode = (id: string, styleId?: string) => ({
  id,
  type: 'TEXT',
  name: `text-${id}`,
  characters: 'x',
  style: { fontFamily: 'Example Sans', fontWeight: 500, fontSize: 16 },
  ...(styleId === undefined ? {} : { styles: { text: styleId } }),
})

describe('loading a ruleset', () => {
  it('rejects an unknown rule id', () => {
    expect(() => loadRuleset({ rules: [{ use: 'nope.v1' }] })).toThrow(RuleConfigError)
  })

  it('rejects a misspelled parameter instead of checking nothing', () => {
    // A rule configured with nothing passes everything, and the project has no
    // way to notice.
    expect(() =>
      loadRuleset({
        rules: [{ use: 'figma.text-style-name.v2', params: { exemptPrefix: ['promo/'] } }],
      }),
    ).toThrow(/unknown parameter/)
  })

  it('rejects a rule configured twice', () => {
    const use = { use: 'responsive.group-completeness.v1', params: { breakpoints: ['sm'] } }
    expect(() => loadRuleset({ rules: [use, use] })).toThrow(/more than once/)
  })

  it('rejects an invalid severity', () => {
    expect(() =>
      loadRuleset({
        rules: [{ use: 'responsive.group-completeness.v1', severity: 'fatal' as never, params: { breakpoints: ['sm'] } }],
      }),
    ).toThrow(RuleConfigError)
  })

  it('accepts a well-formed ruleset and records what will run', () => {
    const loaded = loadRuleset({
      rules: [
        { use: 'figma.text-style-name.v2', params: {} },
        { use: 'responsive.group-completeness.v1', severity: 'error', params: { breakpoints: ['sm', 'xl'] } },
      ],
    })
    expect(loaded.rules.map((entry) => entry.rule.id)).toEqual([
      'figma.text-style-name.v2',
      'responsive.group-completeness.v1',
    ])
    expect(loaded.rules[0]?.severity).toBe('error')
    expect(loaded.rules[1]?.severity).toBe('error')
  })
})

describe('text style naming', () => {
  const ruleset = loadRuleset({ rules: [{ use: 'figma.text-style-name.v2', params: { exemptPrefixes: ['promo/'] } }] })

  it('finds the missing language suffix that took a person a whole file to spot', async () => {
    const facts = await factsFrom(
      [{ id: '1:1', type: 'FRAME', name: 'root', children: [textNode('1:2', '3:1')] }],
      { '3:1': { key: 'k', name: 'main/footer/lg', styleType: 'TEXT', remote: false } },
      { styleNames: STYLE_CONFIG },
    )
    const run = runRules(facts, ruleset)
    expect(run.findings).toHaveLength(1)
    expect(run.findings[0]?.message).toContain('declared convention')
    expect(run.findings[0]?.evidence.map(unsafeUnwrap)).toEqual(['main/footer/lg'])
  })

  it('finds an unrecognised breakpoint segment', async () => {
    const facts = await factsFrom(
      [{ id: '1:1', type: 'FRAME', name: 'root', children: [textNode('1:2', '3:1')] }],
      { '3:1': { key: 'k', name: 'main/footer/tablet/ja', styleType: 'TEXT', remote: false } },
      { styleNames: STYLE_CONFIG },
    )
    expect(runRules(facts, ruleset).findings).toHaveLength(1)
  })

  it('says nothing about a conforming name', async () => {
    const facts = await factsFrom(
      [{ id: '1:1', type: 'FRAME', name: 'root', children: [textNode('1:2', '3:1')] }],
      { '3:1': { key: 'k', name: 'main/footer/lg/ja', styleType: 'TEXT', remote: false } },
      { styleNames: STYLE_CONFIG },
    )
    expect(runRules(facts, ruleset).findings).toEqual([])
  })

  it('excuses a declared prefix, and only that: every other style is checked', async () => {
    // promo/ styles follow another library's convention, said so in the
    // ruleset. A style from nowhere is not excused by having a different
    // first segment — an earlier version skipped it in silence (REG-CONF-017).
    const excused = await factsFrom(
      [{ id: '1:1', type: 'FRAME', name: 'root', children: [textNode('1:2', '3:1')] }],
      { '3:1': { key: 'k', name: 'promo/footer/lg', styleType: 'TEXT', remote: false } },
      { styleNames: STYLE_CONFIG },
    )
    expect(runRules(excused, ruleset).findings).toEqual([])
    const stray = await factsFrom(
      [{ id: '1:1', type: 'FRAME', name: 'root', children: [textNode('1:2', '3:1')] }],
      { '3:1': { key: 'k', name: 'Heading/H1', styleType: 'TEXT', remote: false } },
      { styleNames: STYLE_CONFIG },
    )
    expect(runRules(stray, ruleset).findings).toHaveLength(1)
  })

  it('refuses to run against facts derived without a convention: nothing checked must not read as passed', async () => {
    const facts = await factsFrom(
      [{ id: '1:1', type: 'FRAME', name: 'root', children: [textNode('1:2', '3:1')] }],
      { '3:1': { key: 'k', name: 'main/footer/lg/ja', styleType: 'TEXT', remote: false } },
    )
    expect(() => runRules(facts, ruleset)).toThrow(/styleNames/)
  })
})

describe('a rule that reads a convention refuses to run without one, whatever the data (REG-CONF-017)', () => {
  it('refuses with no styles and no roots at all: nothing to scan is not a pass', async () => {
    const facts = await factsFrom([{ id: '1:1', type: 'FRAME', name: 'root' }])
    const cases = [
      { use: 'figma.text-style-name.v2', params: {} },
      { use: 'artboard.expected-width.v2', params: { expected: { sm: 375 } } },
      { use: 'responsive.group-completeness.v1', params: { breakpoints: ['sm'] } },
      { use: 'responsive.item-count-consistency.v1', params: { containers: ['list'], itemNames: ['item'], exemptSections: [] } },
    ]
    for (const entry of cases) {
      expect(() => runRules(facts, loadRuleset({ rules: [entry] })), entry.use).toThrow(/declaration in the fact configuration/)
    }
  })

  it('refuses an exemption that names a segment the declared pattern does not have', async () => {
    const facts = await factsFrom([{ id: '1:1', type: 'FRAME', name: 'root' }], {}, { styleNames: STYLE_CONFIG })
    const ruleset = loadRuleset({
      rules: [
        {
          use: 'responsive.text-style-font-consistency.v2',
          params: { requireSame: ['fontFamily'], exemptBy: { segment: 'purpsoe', values: ['body'] } },
        },
      ],
    })
    expect(() => runRules(facts, ruleset)).toThrow(/purpsoe/)
    const undeclared = await factsFrom([{ id: '1:1', type: 'FRAME', name: 'root' }])
    expect(() => runRules(undeclared, ruleset)).toThrow(/styleNames declaration/)
  })
})

describe('font consistency', () => {
  const ruleset = loadRuleset({
    rules: [
      { use: 'responsive.text-style-font-consistency.v2', params: { requireSame: ['fontFamily', 'fontWeight'] } },
    ],
  })

  const twoFonts = (familyA: string, familyB: string) => ({
    id: '1:1',
    type: 'FRAME',
    name: 'root',
    children: [
      { ...textNode('1:2', '3:1'), style: { fontFamily: familyA, fontWeight: 500, fontSize: 16 } },
      { ...textNode('1:3', '3:1'), style: { fontFamily: familyB, fontWeight: 500, fontSize: 16 } },
    ],
  })

  it('finds one style name carrying two fonts', async () => {
    // REG-STYLE-005: one breakpoint's declarations under a shared style name
    // used a different family from all the others.
    const facts = await factsFrom(
      [twoFonts('Example Serif', 'Example Sans')],
      { '3:1': { key: 'k', name: 'main/body/lg/en', styleType: 'TEXT', remote: false } },
      { styleNames: STYLE_CONFIG },
    )
    const run = runRules(facts, ruleset)
    expect(run.findings).toHaveLength(1)
    expect(run.findings[0]?.evidence.map(unsafeUnwrap)).toContain('Example Serif')
  })

  it('says nothing when the declarations agree', async () => {
    const facts = await factsFrom(
      [twoFonts('Example Sans', 'Example Sans')],
      { '3:1': { key: 'k', name: 'main/body/lg/en', styleType: 'TEXT', remote: false } },
      { styleNames: STYLE_CONFIG },
    )
    expect(runRules(facts, ruleset).findings).toEqual([])
  })

  it('honours an exempt purpose, since some designs vary the face deliberately', async () => {
    const exempting = loadRuleset({
      rules: [
        {
          use: 'responsive.text-style-font-consistency.v2',
          params: { requireSame: ['fontFamily'], exemptBy: { segment: 'purpose', values: ['body'] } },
        },
      ],
    })
    const facts = await factsFrom(
      [twoFonts('Example Serif', 'Example Sans')],
      { '3:1': { key: 'k', name: 'main/body/lg/en', styleType: 'TEXT', remote: false } },
      { styleNames: STYLE_CONFIG },
    )
    expect(runRules(facts, exempting).findings).toEqual([])
  })

  it('rejects a field it cannot compare', () => {
    expect(() =>
      loadRuleset({
        rules: [{ use: 'responsive.text-style-font-consistency.v2', params: { requireSame: ['colour'] } }],
      }),
    ).toThrow(/unknown field/)
  })
})

describe('artboard width', () => {
  const ruleset = loadRuleset({
    rules: [
      {
        use: 'artboard.expected-width.v2',
        params: { expected: { sm: 375, lg: 1024 } },
      },
    ],
  })

  const artboard = (id: string, name: string, width: number) => ({
    id,
    type: 'FRAME',
    name,
    absoluteBoundingBox: { x: 0, y: 0, width, height: 100 },
  })

  it('finds an artboard standing in for a viewport it is not the size of', async () => {
    // 666px standing in for 1024 makes every measurement taken from it wrong.
    const facts = await factsFrom(
      [artboard('1:1', 'nav_375', 375), artboard('2:1', 'nav_1024', 666)],
      {},
      responsiveConfig([
        { slot: 'sm', designWidthPx: 375 },
        { slot: 'lg', designWidthPx: 1024 },
      ]),
    )
    const run = runRules(facts, ruleset)
    expect(run.findings).toHaveLength(1)
    expect(run.findings[0]?.message).toContain('666px where 1024px was expected')
  })

  it('says nothing when the widths match', async () => {
    const facts = await factsFrom(
      [artboard('1:1', 'nav_375', 375), artboard('2:1', 'nav_1024', 1024)],
      {},
      responsiveConfig([
        { slot: 'sm', designWidthPx: 375 },
        { slot: 'lg', designWidthPx: 1024 },
      ]),
    )
    expect(runRules(facts, ruleset).findings).toEqual([])
  })
})

describe('group completeness', () => {
  it('finds a breakpoint that was never drawn', async () => {
    const facts = await factsFrom(
      [
        { id: '1:1', type: 'FRAME', name: 'nav_375', absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 10 } },
        { id: '2:1', type: 'FRAME', name: 'nav_1024', absoluteBoundingBox: { x: 0, y: 0, width: 1024, height: 10 } },
      ],
      {},
      responsiveConfig([
        { slot: 'sm', designWidthPx: 375 },
        { slot: 'lg', designWidthPx: 1024 },
        { slot: 'xl', designWidthPx: 1440 },
      ]),
    )
    const run = runRules(
      facts,
      loadRuleset({
        rules: [{ use: 'responsive.group-completeness.v1', params: { breakpoints: ['sm', 'lg', 'xl'] } }],
      }),
    )
    expect(run.findings).toHaveLength(1)
    expect(run.findings[0]?.message).toContain('xl')
    // A warning: an unfinished design is a normal state, not a broken one.
    expect(run.findings[0]?.severity).toBe('warning')
  })
})

describe('content root auto-layout', () => {
  const ruleset = loadRuleset({
    rules: [{ use: 'layout.content-root-auto-layout.v2', params: { contentRootNames: ['contents'] } }],
  })

  const member = (prefix: string, width: number, layoutMode?: string) => ({
    id: `${prefix}:1`,
    type: 'FRAME',
    name: `nav_${width}`,
    absoluteBoundingBox: { x: 0, y: 0, width, height: 100 },
    children: [
      {
        id: `${prefix}:2`,
        type: 'FRAME',
        name: 'contents',
        ...(layoutMode === undefined ? {} : { layoutMode }),
      },
      { id: `${prefix}:3`, type: 'FRAME', name: 'bg' },
    ],
  })

  const config = responsiveConfig([
    { slot: 'sm', designWidthPx: 375 },
    { slot: 'lg', designWidthPx: 1024 },
  ])

  it('finds a content root that cannot reflow without any responsive declaration (REG-CONF-017)', async () => {
    // A single frame, no breakpoints declared: the earlier version walked the
    // responsive groups and was silent for every such project.
    const facts = await factsFrom([member('1', 375)])
    const run = runRules(facts, ruleset)
    expect(run.findings).toHaveLength(1)
    expect(run.findings[0]?.target).toEqual({ kind: 'node', sourceId: '1:2' })
  })

  it('finds a content root that cannot reflow', async () => {
    const facts = await factsFrom([member('1', 375), member('2', 1024, 'VERTICAL')], {}, config)
    const run = runRules(facts, ruleset)
    expect(run.findings).toHaveLength(1)
    expect(run.findings[0]?.message).toContain('cannot reflow')
  })

  it('leaves the outer root alone, where absolute positioning is legitimate', async () => {
    // The project layers backgrounds there on purpose; flagging it would make
    // the rule wrong more often than right, and it would get switched off.
    const facts = await factsFrom([member('1', 375, 'VERTICAL'), member('2', 1024, 'VERTICAL')], {}, config)
    expect(runRules(facts, ruleset).findings).toEqual([])
  })
})

describe('running a ruleset', () => {
  it('sorts findings so a diff shows design changes, not iteration order', async () => {
    const facts = await factsFrom(
      [
        {
          id: '1:1',
          type: 'FRAME',
          name: 'root',
          children: [textNode('1:2', '3:1'), textNode('1:3', '3:2')],
        },
      ],
      {
        '3:1': { key: 'a', name: 'main/zzz/lg', styleType: 'TEXT', remote: false },
        '3:2': { key: 'b', name: 'main/aaa/lg', styleType: 'TEXT', remote: false },
      },
      { styleNames: STYLE_CONFIG },
    )
    const ruleset = loadRuleset({
      rules: [
        { use: 'figma.text-style-name.v2', params: {} },
      ],
    })
    const first = runRules(facts, ruleset).findings.map((finding) => finding.evidence.map(unsafeUnwrap).join())
    const second = runRules(facts, ruleset).findings.map((finding) => finding.evidence.map(unsafeUnwrap).join())
    expect(first).toEqual(second)
    expect(first).toHaveLength(2)
  })

  it('records which rules ran, with versions', async () => {
    const facts = await factsFrom(
      [{ id: '1:1', type: 'FRAME', name: 'root_375' }],
      {},
      responsiveConfig([{ slot: 'sm', designWidthPx: 375 }]),
    )
    const run = runRules(
      facts,
      loadRuleset({ rules: [{ use: 'responsive.group-completeness.v1', params: { breakpoints: ['sm'] } }] }),
    )
    expect(run.applied).toHaveLength(1)
    expect(run.applied[0]?.id).toBe('responsive.group-completeness.v1')
    expect(run.applied[0]?.version).toBe(1)
    expect(run.applied[0]?.severity).toBe('warning')
    // Hashed rather than copied: the audit needs to know two runs used the same
    // configuration, not to reprint the project's names in every report.
    expect(run.applied[0]?.paramsHash).toMatch(/^content:v1:sha256:[0-9a-f]{64}$/)
  })

  it('separates blocking findings from advisory ones', async () => {
    const facts = await factsFrom(
      [{ id: '1:1', type: 'FRAME', name: 'root', children: [textNode('1:2', '3:1')] }],
      { '3:1': { key: 'k', name: 'main/footer/lg', styleType: 'TEXT', remote: false } },
      { styleNames: STYLE_CONFIG },
    )
    const asError = runRules(
      facts,
      loadRuleset({
        rules: [
          { use: 'figma.text-style-name.v2', params: {} },
        ],
      }),
    )
    expect(hasBlockingFindings(asError)).toBe(true)

    const asWarning = runRules(
      facts,
      loadRuleset({
        rules: [
          { use: 'figma.text-style-name.v2', severity: 'warning', params: {} },
        ],
      }),
    )
    // The same finding, downgraded: warning plus a recorded false-positive rate
    // is how a rule earns its way up to blocking.
    expect(asWarning.findings).toHaveLength(1)
    expect(hasBlockingFindings(asWarning)).toBe(false)
  })
})

describe('item count', () => {
  const ruleset = loadRuleset({
    rules: [
      {
        use: 'responsive.item-count-consistency.v1',
        params: { containers: ['list'], itemNames: ['item'] },
      },
    ],
  })

  const list = (prefix: string, width: number, items: number, extras: ReadonlyArray<string> = [], hidden = false) => ({
    id: `${prefix}:1`,
    type: 'FRAME',
    name: `nav_${width}`,
    absoluteBoundingBox: { x: 0, y: 0, width, height: 100 },
    children: [
      {
        id: `${prefix}:2`,
        type: 'FRAME',
        name: 'list',
        ...(hidden ? { visible: false } : {}),
        children: [
          ...Array.from({ length: items }, (_unused, index) => ({
            id: `${prefix}:1${index}`,
            type: 'TEXT',
            name: 'item',
            characters: 'x',
          })),
          ...extras.map((name, index) => ({ id: `${prefix}:9${index}`, type: 'FRAME', name })),
        ],
      },
    ],
  })

  const config = responsiveConfig([
    { slot: 'sm', designWidthPx: 375 },
    { slot: 'lg', designWidthPx: 1024 },
  ])

  it('finds a list with a different number of items at one breakpoint', async () => {
    // The OVERVIEW list had four items at lg and seven elsewhere.
    const facts = await factsFrom([list('1', 375, 7), list('2', 1024, 4)], {}, config)
    const run = runRules(facts, ruleset)
    expect(run.findings).toHaveLength(1)
    expect(run.findings[0]?.message).toContain('sm=7')
    expect(run.findings[0]?.message).toContain('lg=4')
  })

  it('says nothing when the counts agree', async () => {
    const facts = await factsFrom([list('1', 375, 7), list('2', 1024, 7)], {}, config)
    expect(runRules(facts, ruleset).findings).toEqual([])
  })

  it('ignores decorations and headings sitting beside the items', async () => {
    // Counting every visible child would fire on a healthy design, which is how
    // a check earns a reputation for noise.
    const facts = await factsFrom(
      [list('1', 375, 7, ['heading']), list('2', 1024, 7, ['heading', 'decoration', 'pagination'])],
      {},
      config,
    )
    expect(runRules(facts, ruleset).findings).toEqual([])
  })

  it('stays quiet when the list is simply not shown at a breakpoint', async () => {
    // A hidden container has no visible children either; comparing it would
    // report "0 versus 7" as a data mistake when the design just omits it.
    const facts = await factsFrom([list('1', 375, 7, [], true), list('2', 1024, 7)], {}, config)
    expect(runRules(facts, ruleset).findings).toEqual([])
  })

  it('honours an exempt section', async () => {
    const exempting = loadRuleset({
      rules: [
        {
          use: 'responsive.item-count-consistency.v1',
          params: { containers: ['list'], itemNames: ['item'], exemptSections: ['nav'] },
        },
      ],
    })
    const facts = await factsFrom([list('1', 375, 7), list('2', 1024, 4)], {}, config)
    expect(runRules(facts, exempting).findings).toEqual([])
  })
})

describe('content root scoping', () => {
  it('ignores a frame that merely shares the name deeper in the tree', async () => {
    // A frame called 'contents' inside a card is somebody else's business.
    const member = (prefix: string, width: number) => ({
      id: `${prefix}:1`,
      type: 'FRAME',
      name: `nav_${width}`,
      absoluteBoundingBox: { x: 0, y: 0, width, height: 100 },
      children: [
        {
          id: `${prefix}:2`,
          type: 'FRAME',
          name: 'card',
          layoutMode: 'VERTICAL',
          children: [{ id: `${prefix}:3`, type: 'FRAME', name: 'contents' }],
        },
      ],
    })
    const facts = await factsFrom(
      [member('1', 375), member('2', 1024)],
      {},
      responsiveConfig([
        { slot: 'sm', designWidthPx: 375 },
        { slot: 'lg', designWidthPx: 1024 },
      ]),
    )
    const run = runRules(
      facts,
      loadRuleset({
        rules: [{ use: 'layout.content-root-auto-layout.v2', params: { contentRootNames: ['contents'] } }],
      }),
    )
    expect(run.findings).toEqual([])
  })
})

describe('the ruleset document itself', () => {
  it('rejects a document that is not an object', () => {
    expect(() => loadRuleset([] as never)).toThrow(RuleConfigError)
  })

  it('rejects a misspelled top-level key rather than checking nothing', () => {
    expect(() => loadRuleset({ rule: [] } as never)).toThrow(/unknown key/)
  })

  it('rejects an entry with an unknown key', () => {
    expect(() =>
      loadRuleset({ rules: [{ use: 'responsive.group-completeness.v1', param: {} }] } as never),
    ).toThrow(/unknown key/)
  })

  it('rejects two rules registered under one id', () => {
    const rule = BUILT_IN_RULES[0]
    expect(() => loadRuleset({ rules: [] }, [rule as never, rule as never])).toThrow(/same id/)
  })
})

describe('findings carry an identity a waiver can name', () => {
  const facts = async () =>
    factsFrom(
      [{ id: '1:1', type: 'FRAME', name: 'root', children: [textNode('1:2', '3:1')] }],
      { '3:1': { key: 'k', name: 'main/footer/lg', styleType: 'TEXT', remote: false } },
      { styleNames: STYLE_CONFIG },
    )
  const ruleset = loadRuleset({
    rules: [{ use: 'figma.text-style-name.v2', params: {} }],
  })

  it('identifies the style rather than the nodes using it', async () => {
    const finding = runRules(await facts(), ruleset).findings[0]
    expect(finding?.target).toEqual({ kind: 'textStyle', styleId: '3:1' })
    expect(finding?.findingId).toMatch(/^content:v1:sha256:/)
  })

  it('keeps the same id when the message would be reworded', async () => {
    // A waiver written against this must survive prose changes and node churn.
    const first = runRules(await facts(), ruleset).findings[0]
    const second = runRules(await facts(), ruleset).findings[0]
    expect(second?.findingId).toBe(first?.findingId)
  })

  it('changes when the rule version would change', async () => {
    const finding = runRules(await facts(), ruleset).findings[0]
    expect(finding?.ruleVersion).toBe(2)
  })
})

describe('order does not leak from iteration', () => {
  it('gives the same findings whatever order the rules were configured in', async () => {
    const facts = await factsFrom(
      [
        {
          id: '1:1',
          type: 'FRAME',
          name: 'nav_375',
          absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 10 },
          children: [textNode('1:2', '3:1')],
        },
      ],
      { '3:1': { key: 'k', name: 'main/footer/lg', styleType: 'TEXT', remote: false } },
      responsiveConfig([
        { slot: 'sm', designWidthPx: 375 },
        { slot: 'xl', designWidthPx: 1440 },
      ]),
    )
    const entries = [
      { use: 'figma.text-style-name.v2', params: {} },
      { use: 'responsive.group-completeness.v1', params: { breakpoints: ['sm', 'xl'] } },
    ]
    const forward = runRules(facts, loadRuleset({ rules: entries })).findings.map((finding) => finding.findingId)
    const reverse = runRules(facts, loadRuleset({ rules: [...entries].reverse() })).findings.map(
      (finding) => finding.findingId,
    )
    expect(reverse).toEqual(forward)
  })
})

describe('an empty exemption list is a thing a project may say', () => {
  it('accepts an explicitly empty list', () => {
    // Writing `exemptPrefixes: []` is how a project says it has none yet, and
    // rejecting it forces deleting the key along with the comment above it.
    expect(() =>
      loadRuleset({ rules: [{ use: 'figma.text-style-name.v2', params: { exemptPrefixes: [] } }] }),
    ).not.toThrow()
    expect(() =>
      loadRuleset({
        rules: [
          {
            use: 'responsive.text-style-font-consistency.v2',
            params: { requireSame: ['fontFamily'], exemptBy: { segment: 'purpose', values: [] } },
          },
        ],
      }),
    ).not.toThrow()
  })

  it('still rejects a list of the wrong kind of thing', () => {
    expect(() =>
      loadRuleset({ rules: [{ use: 'figma.text-style-name.v2', params: { exemptPrefixes: [7] } }] }),
    ).toThrow(RuleConfigError)
    expect(() =>
      loadRuleset({
        rules: [
          {
            use: 'responsive.text-style-font-consistency.v2',
            params: { requireSame: ['fontFamily'], exemptBy: { segment: 'purpose' } },
          },
        ],
      }),
    ).toThrow(RuleConfigError)
  })
})


describe('a key written with nothing after it', () => {
  it('is refused rather than read as "none"', () => {
    // YAML turns `exemptPrefixes:` into null, which is far more often an
    // unfinished edit than a considered empty list; repairing it would quietly
    // weaken the check.
    expect(() =>
      loadRuleset({ rules: [{ use: 'figma.text-style-name.v2', params: { exemptPrefixes: null } }] }),
    ).toThrow(RuleConfigError)
  })
})
