import { describe, expect, it } from 'vitest'

import {
  acquireSnapshot,
  deriveFacts,
  fileKey,
  fixtureClient,
  fromSnapshot,
  type FactIndex,
  type CanonicalDoc,
} from '@figma-ir/core'
import { design, frame, text, type RawNodeSpec } from '@figma-ir/core/testing'

import { projectWeb } from './project.js'
import { decodeProjectionEnvelopeWire, decodeProjectionWire } from './wire.js'
import { projectionEnvelope, projectionToJson } from './wire.js'

const KEY = fileKey('SYNTHETICFILEKEY0001')
const now = () => '2026-01-01T00:00:00.000Z'

const docFrom = async (roots: ReadonlyArray<RawNodeSpec>): Promise<{ doc: CanonicalDoc; facts: FactIndex }> => {
  const doc = fromSnapshot(
    await acquireSnapshot({
      client: fixtureClient(design(roots, {})),
      fileKey: KEY,
      roots: roots.map((root) => root.id),
      now,
    }),
  )
  return { doc, facts: deriveFacts(doc) }
}

const cell = (id: string, x: number, y: number, w: number, h: number): RawNodeSpec =>
  frame(id, `cell${id}`, { x, y, width: w, height: h }, {
    layoutSizingHorizontal: 'FIXED',
    layoutSizingVertical: 'FIXED',
  })

/** A wrap container whose children sit exactly where Figma would put them. */
const wrapContainer = (
  over: Partial<RawNodeSpec>,
  cells: ReadonlyArray<RawNodeSpec>,
  size: { width: number; height: number },
): RawNodeSpec =>
  frame('1:1', 'row', { x: 0, y: 0, ...size }, {
    layoutMode: 'HORIZONTAL',
    layoutWrap: 'WRAP',
    counterAxisAlignItems: 'MIN',
    layoutSizingHorizontal: 'FIXED',
    layoutSizingVertical: 'HUG',
    children: cells,
    ...over,
  })

const projectionOf = async (root: RawNodeSpec) => {
  const { doc, facts } = await docFrom([root])
  return projectWeb({ doc, facts, request: { roots: [root.id] } })
}

const wrapOf = async (root: RawNodeSpec) => {
  const artifact = await projectionOf(root)
  const node = artifact.nodes.find((entry) => (entry.sourceId as string) === root.id)
  return { artifact, wrap: node?.wrap }
}

describe('the wrap plan, two-input', () => {
  it('confirms a packed row: declared gap, start distribution, derived capacity', async () => {
    // Eight 30×20 cells in a 110 row, gap 10, line gap 5 → three columns,
    // rows at 0/25/50, last row short.
    const cells = [0, 40, 80, 0, 40, 80, 0, 40].map((x, i) =>
      cell(`2:${i}`, x, Math.floor(i / 3) * 25, 30, 20),
    )
    const { artifact, wrap } = await wrapOf(
      wrapContainer({ itemSpacing: 10, counterAxisSpacing: 5 }, cells, { width: 110, height: 70 }),
    )
    expect(wrap).toBeDefined()
    expect(wrap!.rule.packingGapPx).toEqual({ kind: 'known', value: 10 })
    expect(wrap!.rule.fullLineDistribution).toEqual({ kind: 'known', value: 'start' })
    // Declared start packs every line the same way: the partial row is known.
    expect(wrap!.rule.partialLineDistribution).toEqual({ kind: 'known', value: 'start' })
    expect(wrap!.rule.lineGapPx).toEqual({ kind: 'known', value: 5 })
    expect(wrap!.rule.track).toEqual({ kind: 'known', value: { mainPx: 30, crossPx: 20 } })
    expect(wrap!.observed.lines.map((line) => line.childIds.length)).toEqual([3, 3, 2])
    expect(Object.values(wrap!.verification).every((v) => v.kind === 'consistent')).toBe(true)
    expect(artifact.diagnostics).toEqual([])
  })

  it('confirms space-between while refusing to repeat the inert itemSpacing', async () => {
    // The trap that cost a rework: itemSpacing says 20 (two cells plus 20
    // would not fit the 130 row), the children sit 10 apart, because
    // space-between packs at zero and distributes the rest.
    const cells = [0, 70, 0, 70, 0, 70].map((x, i) => cell(`2:${i}`, x, Math.floor(i / 2) * 25, 60, 20))
    const { wrap } = await wrapOf(
      wrapContainer({ itemSpacing: 20, counterAxisSpacing: 5, primaryAxisAlignItems: 'SPACE_BETWEEN' }, cells, {
        width: 130,
        height: 75,
      }),
    )
    expect(wrap!.rule.packingGapPx).toEqual({ kind: 'known', value: 0 })
    expect(wrap!.rule.fullLineDistribution).toEqual({ kind: 'known', value: 'space-between' })
    // No partial row was observed, and space-between says nothing about one.
    expect(wrap!.rule.partialLineDistribution).toEqual({ kind: 'unknown', reason: 'PARTIAL_LINE_UNOBSERVED' })
    expect(Object.values(wrap!.verification).every((v) => v.kind === 'consistent')).toBe(true)
  })

  it('keeps an ambiguous partial row unknown rather than picking a winner', async () => {
    // A lone trailing cell at x=0 is explained by both start and
    // space-between; the snapshot cannot break the tie.
    const cells = [
      cell('2:0', 0, 0, 60, 20),
      cell('2:1', 70, 0, 60, 20),
      cell('2:2', 0, 25, 60, 20),
      cell('2:3', 70, 25, 60, 20),
      cell('2:4', 0, 50, 60, 20),
    ]
    const { wrap } = await wrapOf(
      wrapContainer({ itemSpacing: 20, counterAxisSpacing: 5, primaryAxisAlignItems: 'SPACE_BETWEEN' }, cells, {
        width: 130,
        height: 75,
      }),
    )
    expect(wrap!.rule.partialLineDistribution).toEqual({ kind: 'unknown', reason: 'PARTIAL_LINE_UNOBSERVED' })
    expect(wrap!.verification.inlinePositions.kind).toBe('consistent')
  })

  it('pins the partial row down when exactly one candidate explains it — even as the only line', async () => {
    // Two cells in a three-capacity row, spread to the edges: only
    // space-between reproduces 0 and 80 (start puts the second at 40, end
    // puts the first at 40, center puts them at 20 and 60).
    const cells = [cell('2:0', 0, 0, 30, 20), cell('2:1', 80, 0, 30, 20)]
    const { wrap } = await wrapOf(
      wrapContainer({ itemSpacing: 10, counterAxisSpacing: 5, primaryAxisAlignItems: 'SPACE_BETWEEN' }, cells, {
        width: 110,
        height: 20,
      }),
    )
    expect(wrap!.rule.partialLineDistribution).toEqual({ kind: 'known', value: 'space-between' })
    expect(Object.values(wrap!.verification).every((v) => v.kind === 'consistent')).toBe(true)
  })

  it('counts an exactly-fitting track without losing a column to IEEE noise', async () => {
    // inner 60 = 2 × 30 with no gap: the capacity boundary is exact.
    const cells = [cell('2:0', 0, 0, 30, 20), cell('2:1', 30, 0, 30, 20)]
    const { wrap } = await wrapOf(
      wrapContainer({ itemSpacing: 0, counterAxisSpacing: 5 }, cells, { width: 60, height: 20 }),
    )
    expect(wrap!.observed.lines).toHaveLength(1)
    expect(wrap!.verification.lineMembership.kind).toBe('consistent')
  })

  it('claims nothing from a container whose children were cut out of the slice', async () => {
    const cells = [0, 40, 80].map((x, i) => cell(`2:${i}`, x, 0, 30, 20))
    const root = wrapContainer({ itemSpacing: 10, counterAxisSpacing: 5 }, cells, { width: 110, height: 20 })
    const { doc, facts } = await docFrom([root])
    const artifact = projectWeb({ doc, facts, request: { roots: ['1:1'], maxDepth: 0 } })
    const node = artifact.nodes.find((entry) => (entry.sourceId as string) === '1:1')!
    expect(node.wrap).toBeUndefined()
    expect(node.container.kind).toBe('flex')
    if (node.container.kind === 'flex') {
      expect(node.container.mainGapPx).toEqual({ kind: 'unknown', reason: 'DEPTH_LIMIT_EXCEEDED' })
    }
  })

  it('demotes the rule and raises a mandatory diagnostic when the prediction misses', async () => {
    // Same as the space-between case, but one child sits 10px off. The
    // declaration no longer explains the geometry: nothing about this row
    // may travel as known, whatever a ruleset says.
    const cells = [0, 60, 0, 70, 0, 70].map((x, i) => cell(`2:${i}`, x, Math.floor(i / 2) * 25, 60, 20))
    const { artifact, wrap } = await wrapOf(
      wrapContainer({ itemSpacing: 20, counterAxisSpacing: 5, primaryAxisAlignItems: 'SPACE_BETWEEN' }, cells, {
        width: 130,
        height: 75,
      }),
    )
    expect(wrap!.verification.inlinePositions.kind).toBe('contradicted')
    expect(wrap!.rule.fullLineDistribution).toEqual({ kind: 'unknown', reason: 'GEOMETRY_CONTRADICTION' })
    expect(wrap!.rule.packingGapPx).toEqual({ kind: 'unknown', reason: 'GEOMETRY_CONTRADICTION' })
    const diagnostic = artifact.diagnostics.find((d) => d.reason === 'GEOMETRY_CONTRADICTION')
    // The evidence names the check, the row and the child, with both numbers.
    expect(diagnostic?.evidence).toMatchObject({ kind: 'wrap-inline', row: 0, childSourceId: '2:1', observedPx: 60, predictedPx: 70 })
  })

  it('offers no wrap plan for non-uniform children', async () => {
    const cells = [cell('2:0', 0, 0, 30, 20), cell('2:1', 40, 0, 60, 20)]
    const { wrap } = await wrapOf(wrapContainer({ itemSpacing: 10 }, cells, { width: 110, height: 20 }))
    expect(wrap).toBeUndefined()
  })
})

describe('plans outside auto-layout', () => {
  it('projects an absolute collage as exactly what it is: nothing to translate', async () => {
    const collage = frame('1:1', 'group', { x: 0, y: 0, width: 400, height: 300 }, {
      children: [
        frame('2:1', 'piece-a', { x: 12, y: 30, width: 100, height: 80 }),
        frame('2:2', 'piece-b', { x: 90, y: 15, width: 200, height: 120 }),
      ],
    })
    const artifact = await projectionOf(collage)
    const root = artifact.nodes.find((node) => (node.sourceId as string) === '1:1')!
    expect(root.container).toEqual({ kind: 'non-flex' })
    expect(root.wrap).toBeUndefined()
    const piece = artifact.nodes.find((node) => (node.sourceId as string) === '2:1')!
    expect(piece.widthPlan).toEqual({ kind: 'unknown', reason: 'UNSUPPORTED_LAYOUT' })
    // No contradiction diagnostics: not translating is not an error.
    expect(artifact.diagnostics).toEqual([])
  })

  it('verifies a stack: a declared gap the children contradict is demoted, loudly', async () => {
    const stack = (ys: ReadonlyArray<number>) =>
      frame('1:1', 'stack', { x: 0, y: 0, width: 200, height: 300 }, {
        layoutMode: 'VERTICAL',
        itemSpacing: 8,
        children: ys.map((y, i) => cell(`2:${i}`, 0, y, 200, 40)),
      })
    const good = await projectionOf(stack([0, 48, 96]))
    const goodRoot = good.nodes.find((node) => (node.sourceId as string) === '1:1')!
    expect(goodRoot.container.kind).toBe('flex')
    if (goodRoot.container.kind === 'flex') expect(goodRoot.container.mainGapPx).toEqual({ kind: 'known', value: 8 })
    expect(good.diagnostics).toEqual([])

    const bad = await projectionOf(stack([0, 48, 120]))
    const badRoot = bad.nodes.find((node) => (node.sourceId as string) === '1:1')!
    if (badRoot.container.kind === 'flex') {
      expect(badRoot.container.mainGapPx).toEqual({ kind: 'unknown', reason: 'GEOMETRY_CONTRADICTION' })
    }
    expect(bad.diagnostics.some((d) => d.reason === 'GEOMETRY_CONTRADICTION')).toBe(true)
  })

  it('demotes a stretch claim the geometry contradicts', async () => {
    const column = frame('1:1', 'stack', { x: 0, y: 0, width: 200, height: 300 }, {
      layoutMode: 'VERTICAL',
      children: [
        frame('2:1', 'bar', { x: 0, y: 0, width: 190, height: 40 }, {
          layoutSizingHorizontal: 'FILL',
          layoutSizingVertical: 'FIXED',
        }),
      ],
    })
    const artifact = await projectionOf(column)
    const bar = artifact.nodes.find((node) => (node.sourceId as string) === '2:1')!
    expect(bar.widthPlan).toEqual({ kind: 'unknown', reason: 'GEOMETRY_CONTRADICTION' })
    expect(artifact.diagnostics.find((d) => d.reason === 'GEOMETRY_CONTRADICTION')?.evidence).toEqual({
      kind: 'axis-size',
      axis: 'width',
      plan: 'stretch',
      observedPx: 190,
      predictedPx: 200,
    })
  })

  it('refuses the flex reading for an absolutely positioned child', async () => {
    const column = frame('1:1', 'stack', { x: 0, y: 0, width: 200, height: 300 }, {
      layoutMode: 'VERTICAL',
      children: [
        frame('2:1', 'floater', { x: 10, y: 10, width: 50, height: 50 }, {
          layoutPositioning: 'ABSOLUTE',
          layoutSizingHorizontal: 'FILL',
          layoutSizingVertical: 'FIXED',
        }),
      ],
    })
    const artifact = await projectionOf(column)
    const floater = artifact.nodes.find((node) => (node.sourceId as string) === '2:1')!
    expect(floater.widthPlan).toEqual({ kind: 'unknown', reason: 'UNSUPPORTED_LAYOUT' })
  })

  it('translates FILL by the parent axis: flex on main, stretch on cross', async () => {
    const column = frame('1:1', 'stack', { x: 0, y: 0, width: 200, height: 300 }, {
      layoutMode: 'VERTICAL',
      children: [
        frame('2:1', 'bar', { x: 0, y: 0, width: 200, height: 40 }, {
          layoutSizingHorizontal: 'FILL',
          layoutSizingVertical: 'FIXED',
        }),
      ],
    })
    const artifact = await projectionOf(column)
    const bar = artifact.nodes.find((node) => (node.sourceId as string) === '2:1')!
    expect(bar.widthPlan).toEqual({ kind: 'stretch' })
    expect(bar.heightPlan).toEqual({ kind: 'fixed', px: 40 })
  })
})

describe('a stack, one claim at a time (REG-PROJ-014)', () => {
  const flexOf = (artifact: Awaited<ReturnType<typeof projectionOf>>, id = '1:1') => {
    const node = artifact.nodes.find((entry) => (entry.sourceId as string) === id)!
    if (node.container.kind !== 'flex') throw new Error(`${id} is ${node.container.kind}`)
    return node.container
  }
  const evidenceOf = (artifact: Awaited<ReturnType<typeof projectionOf>>) =>
    artifact.diagnostics.map((diagnostic) => diagnostic.evidence)
  const column = (ys: ReadonlyArray<number>, over: Partial<RawNodeSpec> = {}, height = 300) =>
    frame('1:1', 'stack', { x: 0, y: 0, width: 200, height }, {
      layoutMode: 'VERTICAL',
      itemSpacing: 8,
      children: ys.map((y, i) => cell(`2:${i}`, 0, y, 200, 40)),
      ...over,
    })

  it('demotes only the gap when the gap is wrong, and names the pair', async () => {
    const artifact = await projectionOf(column([0, 48, 120]))
    const container = flexOf(artifact)
    expect(container.mainGapPx).toEqual({ kind: 'unknown', reason: 'GEOMETRY_CONTRADICTION' })
    expect(container.mainAlign).toEqual({ kind: 'known', value: 'start' })
    expect(evidenceOf(artifact)).toEqual([
      { kind: 'stack-gap', axis: 'y', beforeSourceId: '2:1', afterSourceId: '2:2', observedPx: 32, predictedPx: 8 },
    ])
  })

  it('demotes only the alignment when the origin is wrong, and says where the children start', async () => {
    // Declared centred in a 300px column: three 40px cells with 8px gaps span
    // 136px, so they should start at 82. They start at 0 — the gaps are right.
    const artifact = await projectionOf(column([0, 48, 96], { primaryAxisAlignItems: 'CENTER' }))
    const container = flexOf(artifact)
    expect(container.mainAlign).toEqual({ kind: 'unknown', reason: 'GEOMETRY_CONTRADICTION' })
    expect(container.mainGapPx).toEqual({ kind: 'known', value: 8 })
    expect(evidenceOf(artifact)).toEqual([
      {
        kind: 'stack-origin',
        axis: 'y',
        distribution: 'center',
        childSourceId: '2:0',
        observedPx: 0,
        predictedPx: 82,
        notRenderedChildCount: 0,
      },
    ])
  })

  it('keeps a correct alignment known when only the gaps are wrong: the origin is checked on the span', async () => {
    // Declared end-aligned with 8px gaps in a 300px column. The gaps are
    // 20px, so the three cells span 160 and end at 300 as declared; the
    // origin (140) is right, the gaps are not.
    const artifact = await projectionOf(column([140, 200, 260], { primaryAxisAlignItems: 'MAX' }))
    const container = flexOf(artifact)
    expect(container.mainAlign).toEqual({ kind: 'known', value: 'end' })
    expect(container.mainGapPx).toEqual({ kind: 'unknown', reason: 'GEOMETRY_CONTRADICTION' })
    expect(evidenceOf(artifact).map((evidence) => evidence?.kind)).toEqual(['stack-gap'])
  })

  it('leaves a single visible child under space-between with an unverified gap and a verified origin', async () => {
    // One visible child of three, declared space-between: the packing gap has
    // nothing to be observed on, and the child sits at the start, which is
    // where space-between puts a lone child.
    const stack = frame('1:1', 'stack', { x: 0, y: 0, width: 200, height: 300 }, {
      layoutMode: 'VERTICAL',
      primaryAxisAlignItems: 'SPACE_BETWEEN',
      children: [
        cell('2:0', 0, 0, 200, 40),
        { ...cell('2:1', 0, 130, 200, 40), visible: false },
        { ...cell('2:2', 0, 260, 200, 40), visible: false },
      ],
    })
    const artifact = await projectionOf(stack)
    const container = flexOf(artifact)
    expect(container.mainGapPx).toEqual({ kind: 'unknown', reason: 'GAP_UNOBSERVED' })
    expect(container.mainAlign).toEqual({ kind: 'known', value: 'space-between' })
    expect(artifact.diagnostics).toEqual([])
  })

  it('confirms a centred stack whose origin is where the span predicts', async () => {
    const artifact = await projectionOf(column([82, 130, 178], { primaryAxisAlignItems: 'CENTER' }))
    expect(flexOf(artifact).mainAlign).toEqual({ kind: 'known', value: 'center' })
    expect(artifact.diagnostics).toEqual([])
  })

  it('keeps a lone child\'s gap unverified: there is nothing to observe it on', async () => {
    const artifact = await projectionOf(column([0]))
    const container = flexOf(artifact)
    expect(container.mainGapPx).toEqual({ kind: 'unknown', reason: 'GAP_UNOBSERVED' })
    expect(container.mainAlign).toEqual({ kind: 'known', value: 'start' })
    expect(artifact.diagnostics).toEqual([])
  })

  it('takes both claims down under space-between, and counts the hidden children as a fact', async () => {
    // Two visible cells declared space-between in a 300px column should sit
    // at 0 and 260. They sit at 0 and 100 — where they would if the hidden
    // third cell had been part of the distribution. The count is offered;
    // the conclusion is the reader's.
    const stack = frame('1:1', 'stack', { x: 0, y: 0, width: 200, height: 300 }, {
      layoutMode: 'VERTICAL',
      primaryAxisAlignItems: 'SPACE_BETWEEN',
      children: [
        cell('2:0', 0, 0, 200, 40),
        cell('2:1', 0, 100, 200, 40),
        cell('2:2', 0, 260, 200, 40),
      ].map((node, i) => (i === 2 ? { ...node, visible: false } : node)),
    })
    const artifact = await projectionOf(stack)
    const container = flexOf(artifact)
    expect(container.mainAlign).toEqual({ kind: 'unknown', reason: 'GEOMETRY_CONTRADICTION' })
    expect(container.mainGapPx).toEqual({ kind: 'unknown', reason: 'GEOMETRY_CONTRADICTION' })
    expect(evidenceOf(artifact)).toEqual([
      {
        kind: 'stack-origin',
        axis: 'y',
        distribution: 'space-between',
        childSourceId: '2:1',
        observedPx: 100,
        predictedPx: 260,
        notRenderedChildCount: 1,
      },
    ])
  })

  it('names the child that breaks the cross-axis claim', async () => {
    const stack = frame('1:1', 'stack', { x: 0, y: 0, width: 200, height: 300 }, {
      layoutMode: 'VERTICAL',
      itemSpacing: 8,
      counterAxisAlignItems: 'CENTER',
      children: [cell('2:0', 50, 0, 100, 40), cell('2:1', 0, 48, 100, 40)],
    })
    const artifact = await projectionOf(stack)
    expect(flexOf(artifact).crossAlign).toEqual({ kind: 'unknown', reason: 'GEOMETRY_CONTRADICTION' })
    expect(evidenceOf(artifact)).toEqual([
      { kind: 'stack-cross', axis: 'x', align: 'center', childSourceId: '2:1', observedPx: 0, predictedPx: 50 },
    ])
  })
})

describe('the intrinsic cross-size duty (REG-PROJ-014)', () => {
  const rowWith = (child: RawNodeSpec, over: Partial<RawNodeSpec> = {}) =>
    frame('1:1', 'row', { x: 0, y: 0, width: 300, height: 100 }, {
      layoutMode: 'HORIZONTAL',
      children: [child],
      ...over,
    })
  const label = (over: Partial<RawNodeSpec> = {}) =>
    frame('2:1', 'label', { x: 0, y: 0, width: 80, height: 20 }, {
      layoutSizingHorizontal: 'FIXED',
      layoutSizingVertical: 'HUG',
      ...over,
    })
  const dutiesOf = async (root: RawNodeSpec) =>
    (await projectionOf(root)).obligations.filter((obligation) => obligation.claim === 'preserveIntrinsicCrossSize')

  it('is issued for a HUG child on the parent\'s cross axis, naming the axis', async () => {
    expect(await dutiesOf(rowWith(label()))).toEqual([
      { projectionFactId: '2:1#preserveIntrinsicCrossSize', sourceId: '2:1', claim: 'preserveIntrinsicCrossSize', axis: 'height' },
    ])
  })

  it('is issued in a column, under a wrap container, and for text alike', async () => {
    const column = frame('1:1', 'column', { x: 0, y: 0, width: 300, height: 100 }, {
      layoutMode: 'VERTICAL',
      children: [label({ layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'FIXED' })],
    })
    expect((await dutiesOf(column)).map((duty) => (duty.claim === 'preserveIntrinsicCrossSize' ? duty.axis : ''))).toEqual(['width'])
    const wrapped = rowWith(label(), { layoutWrap: 'WRAP' })
    expect((await dutiesOf(wrapped)).map((duty) => duty.projectionFactId)).toEqual(['2:1#preserveIntrinsicCrossSize'])
    const withText = rowWith(text('2:1', 'label', 'Read more', { layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'HUG' }))
    expect((await dutiesOf(withText)).map((duty) => duty.projectionFactId)).toEqual(['2:1#preserveIntrinsicCrossSize'])
  })

  it('is issued for the HUG sibling only when HUG and FILL are mixed', async () => {
    const row = frame('1:1', 'row', { x: 0, y: 0, width: 300, height: 100 }, {
      layoutMode: 'HORIZONTAL',
      children: [
        label(),
        frame('2:2', 'stretchy', { x: 80, y: 0, width: 80, height: 100 }, {
          layoutSizingHorizontal: 'FIXED',
          layoutSizingVertical: 'FILL',
        }),
      ],
    })
    expect((await dutiesOf(row)).map((duty) => duty.projectionFactId)).toEqual(['2:1#preserveIntrinsicCrossSize'])
  })

  it('is not issued on the main axis, for an absolute child, or outside auto-layout', async () => {
    // HUG along the row's main axis: a flex item does not stretch there.
    expect(await dutiesOf(rowWith(label({ layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'FIXED' })))).toEqual([])
    expect(await dutiesOf(rowWith(label({ layoutPositioning: 'ABSOLUTE' })))).toEqual([])
    expect(await dutiesOf(rowWith(label(), { layoutMode: 'NONE' }))).toEqual([])
  })
})

describe('the artifact', () => {
  const subject = () =>
    wrapContainer(
      { itemSpacing: 10, counterAxisSpacing: 20 },
      [0, 40, 80].map((x, i) => cell(`2:${i}`, x, 0, 30, 20)),
      { width: 110, height: 20 },
    )

  it('emits an obligation for every known claim, none for unknown ones', async () => {
    const artifact = await projectionOf(subject())
    const ids = artifact.obligations.map((obligation) => obligation.projectionFactId)
    expect(ids).toContain('1:1#container')
    expect(ids).toContain('1:1#wrap')
    expect(ids).toContain('2:0#width')
    // The container's height is HUG → intrinsic is known, so it obliges too.
    expect(ids).toContain('1:1#height')
  })

  it('carries the projection version on its hash and its versions', async () => {
    const artifact = await projectionOf(subject())
    expect(artifact.projectionHash).toMatch(/^projection:v2:sha256:/)
    expect(artifact.schemaVersion).toBe(2)
    expect(artifact.translatorVersion).toBe(2)
  })

  it('decodes an artifact that carries evidence and the cross-size duty, round trip intact', async () => {
    // A stack whose gap is wrong and whose child hugs the cross axis: one
    // contradiction with evidence, one preserveIntrinsicCrossSize obligation.
    const stack = frame('1:1', 'stack', { x: 0, y: 0, width: 200, height: 300 }, {
      layoutMode: 'VERTICAL',
      itemSpacing: 8,
      children: [
        frame('2:0', 'a', { x: 0, y: 0, width: 80, height: 40 }, { layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'FIXED' }),
        cell('2:1', 0, 60, 200, 40),
      ],
    })
    const artifact = await projectionOf(stack)
    expect(artifact.diagnostics.map((d) => d.evidence?.kind)).toEqual(['stack-gap'])
    expect(artifact.obligations.some((o) => o.claim === 'preserveIntrinsicCrossSize')).toBe(true)
    const json = projectionToJson(artifact)
    expect(() => decodeProjectionWire(json)).not.toThrow()
    expect(JSON.parse(JSON.stringify(json))).toEqual(json)
  })

  it('refuses a contradiction without evidence, and evidence on any other reason', async () => {
    const json = projectionToJson(await projectionOf(subject())) as { diagnostics: unknown[] }
    const withHole = {
      ...json,
      diagnostics: [{ reason: 'GEOMETRY_CONTRADICTION', detail: 'x', sourceIds: ['1:1'], evidence: null }],
    }
    expect(() => decodeProjectionWire(withHole)).toThrow()
    const misplaced = {
      ...json,
      diagnostics: [
        {
          reason: 'GEOMETRY_MISSING',
          detail: 'x',
          sourceIds: ['1:1'],
          evidence: { kind: 'wrap-partial-row', row: 0 },
        },
      ],
    }
    expect(() => decodeProjectionWire(misplaced)).toThrow()
  })

  it('is deterministic: same input, same hash, same bytes', async () => {
    const first = await projectionOf(subject())
    const second = await projectionOf(subject())
    expect(second.projectionHash).toBe(first.projectionHash)
    expect(JSON.stringify(projectionEnvelope(second))).toBe(JSON.stringify(projectionEnvelope(first)))
  })

  it('decodes through its wire contract, unknown keys rejected', async () => {
    const artifact = await projectionOf(subject())
    expect(() => decodeProjectionWire(projectionToJson(artifact))).not.toThrow()
    expect(() => decodeProjectionEnvelopeWire(projectionEnvelope(artifact))).not.toThrow()
    const json = projectionToJson(artifact) as Record<string, unknown>
    json['surprise'] = 1
    expect(() => decodeProjectionWire(json)).toThrow()
  })

  it('survives the JSON round trip byte-for-byte', async () => {
    const artifact = await projectionOf(subject())
    const json = projectionToJson(artifact)
    expect(JSON.parse(JSON.stringify(json))).toEqual(json)
  })
})
