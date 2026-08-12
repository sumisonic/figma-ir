import { describe, expect, it } from 'vitest'

import { FACTS_SCHEMA_VERSION } from './types.js'

import { unsafeUnwrap, type Untrusted } from '../text/untrusted.js'
import { design, frame, pageWithShuffledZOrder, text, variantsWithAutoNames, type RawNodeSpec } from '../testing/builders.js'
import { fileKey } from '../figma/client.js'
import type { SourceId } from '../identity/nodeIdentity.js'
import { fixtureClient } from '../figma/fixtureClient.js'
import { acquireSnapshot } from '../figma/snapshot.js'
import { fromSnapshot } from '../canonical/adapter.js'
import { deriveFacts, readingOrder } from './derive.js'
import { FactConfigError } from './pattern.js'
import { styleNamePart, type FactConfig, type SlotObservation, type StyleNameParts } from './types.js'

const KEY = fileKey('SYNTHETICFILEKEY0001')
const now = () => '2026-01-01T00:00:00.000Z'

const docFrom = async (roots: ReadonlyArray<RawNodeSpec>, styles: Parameters<typeof design>[1] = {}) =>
  fromSnapshot(
    await acquireSnapshot({
      client: fixtureClient(design(roots, styles)),
      fileKey: KEY,
      roots: roots.map((root) => root.id),
      now,
    }),
  )

const RESPONSIVE: FactConfig = {
  responsive: {
    namePattern: '{section}_{width}',
    breakpoints: [
      { slot: 'sm', designWidthPx: 375 },
      { slot: 'xl', designWidthPx: 1440 },
    ],
  },
}

const STYLE_CONFIG: NonNullable<FactConfig['styleNames']> = {
  pattern: '{group}/{purpose}/{breakpoint}/{language}',
  allowed: { breakpoint: ['sm', 'md', 'lg', 'xl'], language: ['ja', 'en', 'all'] },
}

describe('reading order (REG-ORDER-002)', () => {
  it('sorts by position, not by the layer array', async () => {
    // The witness lists its children footer-first: the array is paint order,
    // and a consumer that trusted it produced sections in a shuffled sequence.
    const doc = await docFrom([pageWithShuffledZOrder()])
    const root = doc.roots[0]!
    const arrayOrder = root.children.map((child) => unsafeUnwrap(child.name))
    const reading = readingOrder(root).map((child) => unsafeUnwrap(child.name))
    expect(arrayOrder).toEqual(['footer', 'header', 'body'])
    expect(reading).toEqual(['header', 'body', 'footer'])
  })

  it('gives every rendered node an index within its parent', async () => {
    const facts = deriveFacts(await docFrom([pageWithShuffledZOrder()]))
    const indices = [...facts.nodes.values()].filter((fact) => fact.rendered).map((fact) => fact.visualOrderIndex)
    expect(indices.every((index) => index >= 0)).toBe(true)
  })

  it('keeps hidden nodes in the index but out of the order', async () => {
    const doc = await docFrom([
      frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, {
        children: [
          text('1:2', 'shown', 'a', { absoluteBoundingBox: { x: 0, y: 10, width: 1, height: 1 } }),
          text('1:3', 'hidden', 'b', { visible: false, absoluteBoundingBox: { x: 0, y: 0, width: 1, height: 1 } }),
        ],
      }),
    ])
    const facts = deriveFacts(doc)
    expect(facts.nodes.has('1:3' as never)).toBe(true)
    expect(facts.nodes.get('1:3' as never)?.visualOrderIndex).toBe(-1)
    expect(facts.roots[0]?.children).toEqual(['1:2'])
  })

  it('flags siblings that overlap, where "before" is not a fact about the geometry', async () => {
    const overlapping = frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, {
      children: [
        frame('1:2', 'a', { x: 0, y: 0, width: 50, height: 50 }),
        frame('1:3', 'b', { x: 10, y: 10, width: 50, height: 50 }),
      ],
    })
    const facts = deriveFacts(await docFrom([overlapping]))
    expect(facts.nodes.get('1:2' as never)?.visualOrderReliable).toBe(false)
    // The index is still produced: deterministic and useful for display.
    expect(facts.nodes.get('1:2' as never)?.visualOrderIndex).toBe(0)
  })

  it('trusts the order of a stacked layout', async () => {
    const facts = deriveFacts(await docFrom([pageWithShuffledZOrder()]))
    expect(facts.nodes.get('1:2' as never)?.visualOrderReliable).toBe(true)
  })

  it('flags rotated siblings', async () => {
    const doc = await docFrom([
      frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, {
        children: [
          frame('1:2', 'a', { x: 0, y: 0, width: 10, height: 10 }, { rotation: 15 }),
          frame('1:3', 'b', { x: 0, y: 40, width: 10, height: 10 }),
        ],
      }),
    ])
    expect(deriveFacts(doc).nodes.get('1:2' as never)?.visualOrderReliable).toBe(false)
  })
})

describe('relative box rounding (REG-FACT-009)', () => {
  it('re-rounds the subtraction so IEEE noise never reaches a slice', async () => {
    // Absolute x 40.3 in a parent at 10.1: both are valid px-slot values,
    // but their difference is 30.199999999999996 in IEEE arithmetic, and
    // noise of this kind was once written verbatim into a slice, breaking
    // the per-slot rounding contract.
    const doc = await docFrom([
      frame('1:1', 'root', { x: 10.1, y: -20.33, width: 200, height: 100 }, {
        children: [frame('1:2', 'cell', { x: 40.3, y: -20.13, width: 50, height: 30 })],
      }),
    ])
    const relative = deriveFacts(doc).nodes.get('1:2' as never)?.relativeBox
    expect(relative?.x).toBe(30.2)
    expect(relative?.y).toBe(0.2)
  })
})

describe('text style facts', () => {
  const styled = (styleId: string, family = 'Example Sans') =>
    frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, {
      children: [
        text('1:2', 'label', 'x', { styles: { text: styleId }, style: { fontFamily: family, fontWeight: 500, fontSize: 16 } }),
      ],
    })

  it('parses a declared convention into its named segments, in pattern order', async () => {
    const facts = deriveFacts(await docFrom([styled('9:1')], { '9:1': { name: 'main/title/sm/all' } }), {
      styleNames: STYLE_CONFIG,
    })
    const style = facts.textStyles.get('9:1')
    expect(style?.parsed.kind).toBe('known')
    const parts = (style?.parsed as { value: StyleNameParts }).value
    expect(parts.map((part) => [part.segment, unsafeUnwrap(part.value)])).toEqual([
      ['group', 'main'],
      ['purpose', 'title'],
      ['breakpoint', 'sm'],
      ['language', 'all'],
    ])
    expect(unsafeUnwrap(styleNamePart(parts, 'purpose') as Untrusted)).toBe('title')
  })

  it('takes any grammar the project writes down: two segments, another separator', async () => {
    const facts = deriveFacts(await docFrom([styled('9:1')], { '9:1': { name: 'heading-lg' } }), {
      styleNames: { pattern: '{role}-{size}', allowed: { size: ['sm', 'lg'] } },
    })
    const parts = (facts.textStyles.get('9:1')?.parsed as { value: StyleNameParts }).value
    expect(parts.map((part) => [part.segment, unsafeUnwrap(part.value)])).toEqual([
      ['role', 'heading'],
      ['size', 'lg'],
    ])
  })

  it('refuses a value outside a segment\'s declared vocabulary', async () => {
    const facts = deriveFacts(await docFrom([styled('9:1')], { '9:1': { name: 'main/title/xxl/all' } }), {
      styleNames: STYLE_CONFIG,
    })
    expect(facts.textStyles.get('9:1')?.parsed.kind).toBe('unknown')
  })

  it('marks a name outside the convention unknown rather than normalizing it (REG-STYLE-006)', async () => {
    // A misnamed style is a message for the designer; tidying it here would
    // delete the message.
    const facts = deriveFacts(await docFrom([styled('9:1')], { '9:1': { name: 'main/title/sm' } }), {
      styleNames: STYLE_CONFIG,
    })
    expect(facts.textStyles.get('9:1')?.parsed.kind).toBe('unknown')
  })

  it('collects the distinct fonts used under one style name (REG-STYLE-005)', async () => {
    // One style name, two font declarations: invisible from any single node.
    const doc = await docFrom(
      [
        frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, {
          children: [
            text('1:2', 'a', 'x', { styles: { text: '9:1' }, style: { fontFamily: 'Example Sans', fontWeight: 500, fontSize: 16 } }),
            text('1:3', 'b', 'y', { styles: { text: '9:1' }, style: { fontFamily: 'Example Serif', fontWeight: 500, fontSize: 16 } }),
          ],
        }),
      ],
      { '9:1': { name: 'main/body/sm/ja' } },
    )
    const style = deriveFacts(doc, { styleNames: STYLE_CONFIG }).textStyles.get('9:1')
    expect(style?.fonts).toHaveLength(2)
    expect(style?.fonts.map((font) => unsafeUnwrap(font.family)).sort()).toEqual(['Example Sans', 'Example Serif'])
  })

  it('records nothing about names when no convention is configured', async () => {
    const facts = deriveFacts(await docFrom([styled('9:1')], { '9:1': { name: 'whatever/shape' } }))
    expect([...facts.textStyles.values()].every((style) => style.parsed.kind === 'absent')).toBe(true)
  })

  it('keeps the distinction between no style and a broken reference', async () => {
    const doc = await docFrom([
      frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, {
        children: [
          text('1:2', 'styled', 'a', { styles: { text: '9:9' } }),
          text('1:3', 'plain', 'b'),
        ],
      }),
    ])
    const facts = deriveFacts(doc)
    expect(facts.nodes.get('1:2' as never)?.textStyle?.kind).toBe('unresolved')
    expect(facts.nodes.get('1:3' as never)?.textStyle).toBeUndefined()
  })
})

describe('the artboard convention is whatever the project declares', () => {
  const pair = (names: readonly [string, string]) => [
    frame('1:1', names[0], { x: 0, y: 0, width: 375, height: 100 }, { children: [frame('1:2', 'contents', { x: 0, y: 0, width: 375, height: 100 })] }),
    frame('2:1', names[1], { x: 500, y: 0, width: 1440, height: 100 }, { children: [frame('2:2', 'contents', { x: 500, y: 0, width: 1440, height: 100 })] }),
  ]
  const breakpoints = [
    { slot: 'sm', designWidthPx: 375 },
    { slot: 'xl', designWidthPx: 1440 },
  ]

  it('groups by a breakpoint name in the artboard name, with no width anywhere in it', async () => {
    const facts = deriveFacts(await docFrom(pair(['Home / sm', 'Home / xl'])), {
      responsive: { namePattern: '{section} / {breakpoint}', breakpoints },
    })
    expect(facts.responsiveGroups.map((group) => group.members.map((member) => member.breakpoint))).toEqual([['sm', 'xl']])
    expect(facts.diagnostics).toEqual([])
  })

  it('accepts both a width and a breakpoint when they agree, and reports a name that contradicts itself', async () => {
    const agreeing = deriveFacts(await docFrom(pair(['home_sm_375', 'home_xl_1440'])), {
      responsive: { namePattern: '{section}_{breakpoint}_{width}', breakpoints },
    })
    expect(agreeing.responsiveGroups[0]?.members.map((member) => member.designWidthPx)).toEqual([375, 1440])
    const contradicting = deriveFacts(await docFrom(pair(['home_sm_1440', 'home_xl_1440'])), {
      responsive: { namePattern: '{section}_{breakpoint}_{width}', breakpoints },
    })
    expect(contradicting.responsiveGroups[0]?.members.map((member) => member.breakpoint)).toEqual(['xl'])
    expect(contradicting.diagnostics.map((diagnostic) => diagnostic.reason)).toEqual(['UNKNOWN_GROUPING'])
    expect(contradicting.diagnostics[0]?.detail).toContain('declared as xl')
  })

  it('refuses a pattern that could not match, when the configuration loads (REG-CONF-017)', async () => {
    const doc = await docFrom(pair(['a', 'b']))
    expect(() => deriveFacts(doc, { responsive: { namePattern: '{section}_{witdh}', breakpoints } })).toThrow(FactConfigError)
    expect(() => deriveFacts(doc, { responsive: { namePattern: '{section}', breakpoints } })).toThrow(/\{width\} or \{breakpoint\}/)
    expect(() => deriveFacts(doc, { styleNames: { pattern: '{a}{b}' } })).toThrow(FactConfigError)
  })

  it('says nothing, and claims nothing, when no convention is declared', async () => {
    const facts = deriveFacts(await docFrom(pair(['whatever', 'Frame 7'])))
    expect(facts.responsiveGroups).toEqual([])
    expect(facts.diagnostics).toEqual([])
    expect(facts.roots).toHaveLength(2)
    expect([...facts.textStyles.values()].every((style) => style.parsed.kind === 'absent')).toBe(true)
  })
})

describe('roots', () => {
  it('reports the width a rule can check against an expectation', async () => {
    const facts = deriveFacts(await docFrom(variantsWithAutoNames()), RESPONSIVE)
    const widths = facts.roots.map((root) => (root.width as { value: number }).value).sort((a, b) => a - b)
    expect(widths).toEqual([375, 1440])
  })
})

describe('responsive groups (REG-RESP-003)', () => {
  it('groups the breakpoint variants by the declared naming convention', async () => {
    const facts = deriveFacts(await docFrom(variantsWithAutoNames()), RESPONSIVE)
    expect(facts.responsiveGroups).toHaveLength(1)
    const group = facts.responsiveGroups[0]
    expect(unsafeUnwrap(group?.section as Untrusted)).toBe('nav')
    expect(group?.members.map((member) => member.breakpoint)).toEqual(['sm', 'xl'])
  })

  it('corresponds the designer-named paths and reports the rest', async () => {
    // Most container names are editor-generated and differ per variant
    // (Frame 101 vs Frame 205); only designer-named paths line up.
    const facts = deriveFacts(await docFrom(variantsWithAutoNames()), RESPONSIVE)
    const group = facts.responsiveGroups[0]!
    const paths = group.slots.map((slot) => slot.namePath.map(unsafeUnwrap).join('/'))
    expect(paths).toContain('logo')
    expect(paths).not.toContain('Frame 101/label')
    expect(group.coverage.unresolvedPaths).toBeGreaterThan(0)
  })

  it('puts every breakpoint of one element side by side', async () => {
    const facts = deriveFacts(await docFrom(variantsWithAutoNames()), RESPONSIVE)
    const logo = facts.responsiveGroups[0]?.slots.find(
      (slot) => slot.namePath.map(unsafeUnwrap).join('/') === 'logo',
    )
    const sm = (logo?.byBreakpoint.get('sm') as { value: SlotObservation }).value
    const xl = (logo?.byBreakpoint.get('xl') as { value: SlotObservation }).value
    // The recorded rework came from measuring one breakpoint and inferring the
    // rest. Here the answers arrive together.
    expect(sm.box?.width).toBe(100)
    expect(xl.box?.width).toBe(140)
  })

  it('carries what a rule needs, not a geometry summary', async () => {
    // The rules that read slots compare layout, typography and paint across
    // breakpoints; a comparison can only find a difference in a field somebody
    // kept. If SlotObservation regressed to a geometry summary, this fails.
    const roots = [
      frame('1:1', 'nav_375', { x: 0, y: 0, width: 375, height: 100 }, {
        layoutMode: 'VERTICAL',
        children: [text('1:2', 'title', 'Menu', { styles: { text: '9:1' } })],
      }),
      frame('2:1', 'nav_1440', { x: 0, y: 0, width: 1440, height: 100 }, {
        layoutMode: 'HORIZONTAL',
        children: [text('2:2', 'title', 'Menu', { styles: { text: '9:1' } })],
      }),
    ]
    const facts = deriveFacts(await docFrom(roots, { '9:1': { name: 'main/title/sm/all' } }), RESPONSIVE)
    const slot = facts.responsiveGroups[0]?.slots.find(
      (entry) => entry.namePath.map(unsafeUnwrap).join('/') === 'title',
    )
    const sm = (slot?.byBreakpoint.get('sm') as { value: SlotObservation }).value
    expect(sm.nodeType).toBe('TEXT')
    expect(sm.typography?.fontSize).toBeGreaterThan(0)
    expect(sm.textStyle?.kind).toBe('token')
    expect(Array.isArray(sm.fills)).toBe(true)
    expect(sm.layout.padding).toBeDefined()
    // And the roots themselves differ in layout mode across breakpoints —
    // exactly the "stacked at sm, columns at xl" fact a consumer reads here.
    const rootSlotSm = facts.nodes.get('1:1' as never)
    expect(rootSlotSm).toBeDefined()
  })

  it('refuses to call a missing path "absent", because renaming looks the same', async () => {
    const roots = [
      frame('1:1', 'nav_375', { x: 0, y: 0, width: 375, height: 100 }, {
        children: [text('1:2', 'label', 'a')],
      }),
      frame('2:1', 'nav_1440', { x: 0, y: 0, width: 1440, height: 100 }, {
        children: [text('2:2', 'label', 'a'), text('2:3', 'extra', 'b')],
      }),
    ]
    const facts = deriveFacts(await docFrom(roots), RESPONSIVE)
    const group = facts.responsiveGroups[0]
    // 'extra' exists in one member only. From names alone, a removed element
    // and a renamed container are the same observation, so no absence claim.
    expect(group?.slots.map((slot) => slot.namePath.map(unsafeUnwrap).join('/'))).toEqual(['label'])
    expect(
      facts.diagnostics.some(
        (diagnostic) => diagnostic.reason === 'UNKNOWN_GROUPING' && diagnostic.detail.includes('extra'),
      ),
    ).toBe(true)
    expect(group?.coverage).toEqual({ correspondedPaths: 1, unresolvedPaths: 1 })
  })

  it('refuses to pair elements whose name repeats', async () => {
    const twins = (prefix: string, width: number) =>
      frame(`${prefix}:1`, `nav_${width}`, { x: 0, y: 0, width, height: 100 }, {
        children: [text(`${prefix}:2`, 'item', 'a'), text(`${prefix}:3`, 'item', 'b')],
      })
    const facts = deriveFacts(await docFrom([twins('1', 375), twins('2', 1440)]), RESPONSIVE)
    // Pairing the first 'item' in one tree with the first in another looks
    // authoritative and is a coincidence away from being wrong.
    expect(facts.responsiveGroups[0]?.slots).toHaveLength(0)
    expect(facts.diagnostics.some((diagnostic) => diagnostic.reason === 'AMBIGUOUS_NODE_MATCH')).toBe(true)
  })

  it('reports an undeclared artboard width instead of inventing a breakpoint', async () => {
    const facts = deriveFacts(
      await docFrom([frame('1:1', 'nav_666', { x: 0, y: 0, width: 666, height: 10 })]),
      RESPONSIVE,
    )
    expect(facts.responsiveGroups).toHaveLength(0)
    expect(facts.diagnostics[0]?.reason).toBe('UNKNOWN_GROUPING')
  })

  it('derives nothing when no convention is configured', async () => {
    expect(deriveFacts(await docFrom(variantsWithAutoNames())).responsiveGroups).toEqual([])
  })
})

describe('name paths survive the characters designers actually use', () => {
  it('does not confuse two different paths that share a joined form', async () => {
    // Editor-generated names contain spaces, so ["Frame 232","x"] and
    // ["Frame","232 x"] must not collide.
    const member = (prefix: string, width: number, nesting: 'split' | 'merged') =>
      frame(`${prefix}:1`, `nav_${width}`, { x: 0, y: 0, width, height: 100 }, {
        children:
          nesting === 'split'
            ? [frame(`${prefix}:2`, 'Frame 232', { x: 0, y: 0, width: 10, height: 10 }, { children: [text(`${prefix}:3`, 'x', 'a')] })]
            : [frame(`${prefix}:4`, 'Frame', { x: 0, y: 0, width: 10, height: 10 }, { children: [text(`${prefix}:5`, '232 x', 'a')] })],
      })
    const facts = deriveFacts(await docFrom([member('1', 375, 'split'), member('2', 1440, 'merged')]), RESPONSIVE)
    expect(facts.responsiveGroups[0]?.slots).toEqual([])
  })

  it('round-trips a path containing separators', async () => {
    const member = (prefix: string, width: number) =>
      frame(`${prefix}:1`, `nav_${width}`, { x: 0, y: 0, width, height: 10 }, {
        children: [text(`${prefix}:2`, 'a/b c', 'x')],
      })
    const facts = deriveFacts(await docFrom([member('1', 375), member('2', 1440)]), RESPONSIVE)
    expect(facts.responsiveGroups[0]?.slots[0]?.namePath.map(unsafeUnwrap)).toEqual(['a/b c'])
  })
})

describe('determinism', () => {
  it('produces an identical index on repeated derivations', async () => {
    const doc = await docFrom(variantsWithAutoNames())
    const serialize = (index: ReturnType<typeof deriveFacts>): string =>
      JSON.stringify({
        nodes: [...index.nodes.keys()],
        styles: [...index.textStyles.keys()],
        groups: index.responsiveGroups.map((group) => ({
          section: unsafeUnwrap(group.section),
          slots: group.slots.map((slot) => slot.namePath.map(unsafeUnwrap)),
        })),
        diagnostics: index.diagnostics,
      })
    expect(serialize(deriveFacts(doc, RESPONSIVE))).toBe(serialize(deriveFacts(doc, RESPONSIVE)))
  })

  it('carries the canonical hash it was derived from', async () => {
    const doc = await docFrom([pageWithShuffledZOrder()])
    expect(deriveFacts(doc).canonicalHash).toBe(doc.canonicalHash)
  })
})

describe('facts schema version (REG-CANON-013)', () => {
  it('rose with the observation contract', () => {
    expect(FACTS_SCHEMA_VERSION).toBe(5)
  })
})

describe('observed child overflow (REG-FACT-016)', () => {
  const factsOf = async (root: RawNodeSpec) => {
    const doc = fromSnapshot(
      await acquireSnapshot({ client: fixtureClient(design([root], {})), fileKey: KEY, roots: [root.id], now }),
    )
    return deriveFacts(doc).nodes.get(root.id as SourceId)?.observedChildOverflow
  }

  it('measures how far in-flow children spill past the box, per side, naming them', async () => {
    // A 100-wide row drawn with its second card reaching 30 past the right
    // edge and 5 below: the design draws the spill.
    const overflow = await factsOf(
      frame('1:1', 'row', { x: 0, y: 0, width: 100, height: 50 }, {
        layoutMode: 'HORIZONTAL',
        children: [
          frame('1:2', 'card', { x: 0, y: 0, width: 60, height: 50 }),
          frame('1:3', 'card', { x: 70, y: 0, width: 60, height: 55 }),
        ],
      }),
    )
    expect(overflow).toEqual({
      kind: 'known',
      value: { leftPx: 0, rightPx: 30, topPx: 0, bottomPx: 5, sourceIds: ['1:3'] },
    })
  })

  it('re-rounds the spill: the difference of two rounded values is not rounded (REG-FACT-009)', async () => {
    // 10.1 + 20.2 - 30 is 0.30000000000000426 in IEEE arithmetic.
    const overflow = await factsOf(
      frame('1:1', 'row', { x: 0, y: 0, width: 30, height: 10 }, {
        children: [frame('1:2', 'card', { x: 10.1, y: 0, width: 20.2, height: 10 })],
      }),
    )
    expect(overflow).toEqual({ kind: 'known', value: { leftPx: 0, rightPx: 0.3, topPx: 0, bottomPx: 0, sourceIds: ['1:2'] } })
  })

  it('ignores absolutely positioned and hidden children, and reports zero when nothing spills', async () => {
    const overflow = await factsOf(
      frame('1:1', 'row', { x: 0, y: 0, width: 100, height: 100 }, {
        layoutMode: 'HORIZONTAL',
        children: [
          frame('1:2', 'in', { x: 10, y: 10, width: 50, height: 50 }),
          frame('1:3', 'badge', { x: 90, y: -10, width: 30, height: 30 }, { layoutPositioning: 'ABSOLUTE' }),
          frame('1:4', 'old', { x: 0, y: 0, width: 500, height: 500 }, { visible: false }),
        ],
      }),
    )
    expect(overflow).toEqual({ kind: 'known', value: { leftPx: 0, rightPx: 0, topPx: 0, bottomPx: 0, sourceIds: [] } })
  })

  it('is unknown when the box or a child box is missing: a partial spill is not a smaller spill', async () => {
    const overflow = await factsOf(
      frame('1:1', 'row', { x: 0, y: 0, width: 100, height: 100 }, {
        children: [
          frame('1:2', 'in', { x: 10, y: 10, width: 50, height: 50 }),
          { id: '1:3', type: 'FRAME', name: 'boxless' },
        ],
      }),
    )
    expect(overflow).toEqual({ kind: 'unknown', reason: 'GEOMETRY_MISSING' })
  })
})
