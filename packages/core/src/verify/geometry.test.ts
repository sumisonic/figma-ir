import { describe, expect, it } from 'vitest'

import { design, frame, text, type RawNodeSpec } from '../testing/builders.js'
import { fileKey } from '../figma/client.js'
import { fixtureClient } from '../figma/fixtureClient.js'
import { acquireSnapshot } from '../figma/snapshot.js'
import { fromSnapshot } from '../canonical/adapter.js'
import { deriveFacts } from '../facts/derive.js'
import { cutSlice } from '../slice/cut.js'
import { decodeMeasuredGeometry, diffGeometry, geometryReportFails, GeometryError } from './geometry.js'

const KEY = fileKey('SYNTHETICFILEKEY0001')
const now = () => '2026-01-01T00:00:00.000Z'

const sliceFrom = async (roots: ReadonlyArray<RawNodeSpec>) => {
  const doc = fromSnapshot(
    await acquireSnapshot({
      client: fixtureClient(design(roots, {})),
      fileKey: KEY,
      roots: roots.map((root) => root.id),
      now,
    }),
  )
  return cutSlice(doc, deriveFacts(doc), { roots: roots.map((root) => root.id) })
}

/** A root at an arbitrary page position with two children at known offsets. */
const PAGE = frame('1:1', 'root', { x: 10.1, y: -20, width: 200, height: 100 }, {
  children: [
    frame('1:2', 'a', { x: 10.1, y: -20, width: 60, height: 40 }),
    // 40.3 - 10.1 = 30.199999999999996 in IEEE arithmetic (REG-FACT-009):
    // the expected side must come out re-rounded.
    frame('1:3', 'b', { x: 40.3, y: -20, width: 50, height: 30 }),
  ],
})

const measuredFor = (entries: ReadonlyArray<Record<string, unknown>>, over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  designWidthPx: 375,
  viewportWidthPx: 375,
  rootSourceId: '1:1',
  entries,
  ...over,
})

describe('diffGeometry', () => {
  it('matches a faithful render, in root-relative design px', async () => {
    const slice = await sliceFrom([PAGE])
    const report = diffGeometry(
      slice,
      decodeMeasuredGeometry(
        measuredFor([
          { sourceId: '1:1', x: 0, y: 0, width: 200, height: 100 },
          { sourceId: '1:2', x: 0, y: 0, width: 60, height: 40 },
          { sourceId: '1:3', x: 30.2, y: 0, width: 50, height: 30 },
        ]),
      ),
    )
    expect(report.mismatches).toEqual([])
    expect(report.comparedCount).toBe(3)
    expect(report.matchedCount).toBe(3)
    expect(report.unmeasuredRendered).toEqual([])
    expect(geometryReportFails(report)).toBe(false)
  })

  it('scales measured values when the viewport could not shrink to the design width', async () => {
    // A 375 design measured at 500px viewport: every value is 4/3 larger.
    const slice = await sliceFrom([PAGE])
    const k = 500 / 375
    const report = diffGeometry(
      slice,
      decodeMeasuredGeometry(
        measuredFor(
          [
            { sourceId: '1:1', x: 0, y: 0, width: 200 * k, height: 100 * k },
            { sourceId: '1:3', x: 30.2 * k, y: 0, width: 50 * k, height: 30 * k },
          ],
          { viewportWidthPx: 500 },
        ),
      ),
      { allowScaling: true },
    )
    expect(report.mismatches).toEqual([])
    expect(report.matchedCount).toBe(2)
  })

  it('refuses to scale unless the caller owns the proportionality assumption', async () => {
    // Scaling by designWidth/viewportWidth assumes every length in the page is
    // proportional to viewport width — a property of one target encoding
    // (viewport-relative units such as vw), not of renders in general. A
    // silently scaled comparison of a fixed-px page would "verify" geometry
    // the page does not have.
    const slice = await sliceFrom([PAGE])
    const measured = decodeMeasuredGeometry(
      measuredFor([{ sourceId: '1:1', x: 0, y: 0, width: 266.67, height: 133.33 }], { viewportWidthPx: 500 }),
    )
    expect(() => diffGeometry(slice, measured)).toThrowError(/scal/i)
  })

  it('reports a drift beyond tolerance, per slot, with the delta', async () => {
    const slice = await sliceFrom([PAGE])
    const report = diffGeometry(
      slice,
      decodeMeasuredGeometry(measuredFor([{ sourceId: '1:3', x: 31.53, y: 0, width: 50, height: 30 }])),
    )
    expect(report.mismatches).toEqual([
      { sourceId: '1:3', slot: 'x', expectedPx: 30.2, measuredPx: 31.53, deltaPx: 1.33 },
    ])
    expect(report.matchedCount).toBe(0)
    expect(geometryReportFails(report)).toBe(true)
  })

  it('accepts a drift inside the tolerance', async () => {
    const slice = await sliceFrom([PAGE])
    const report = diffGeometry(
      slice,
      decodeMeasuredGeometry(measuredFor([{ sourceId: '1:3', x: 30.4, y: 0, width: 50, height: 30 }])),
    )
    expect(report.mismatches).toEqual([])
  })

  it('lists rendered nodes nothing was mapped to, so partial coverage reads as partial', async () => {
    const slice = await sliceFrom([PAGE])
    const report = diffGeometry(
      slice,
      decodeMeasuredGeometry(measuredFor([{ sourceId: '1:1', x: 0, y: 0, width: 200, height: 100 }])),
    )
    expect(report.unmeasuredRendered).toEqual(['1:2', '1:3'])
    // Coverage gaps inform; they do not fail the gate by default.
    expect(geometryReportFails(report)).toBe(false)
  })

  it('fails an empty measurement under required coverage — the original hole, stated directly', async () => {
    const slice = await sliceFrom([PAGE])
    const report = diffGeometry(slice, decodeMeasuredGeometry(measuredFor([])))
    expect(report.mismatches).toEqual([])
    expect(geometryReportFails(report)).toBe(false)
    expect(geometryReportFails(report, { requireCoverage: true })).toBe(true)
  })

  it('records the measuring conditions so a saved report is auditable alone', async () => {
    const slice = await sliceFrom([PAGE])
    const same = diffGeometry(slice, decodeMeasuredGeometry(measuredFor([])))
    expect(same.viewportWidthPx).toBe(375)
    expect(same.scaled).toBe(false)
    const scaled = diffGeometry(
      slice,
      decodeMeasuredGeometry(measuredFor([], { viewportWidthPx: 500 })),
      { allowScaling: true },
    )
    expect(scaled.viewportWidthPx).toBe(500)
    expect(scaled.scaled).toBe(true)
  })

  it('rejects the retired positional tolerance loudly', async () => {
    const slice = await sliceFrom([PAGE])
    const measured = decodeMeasuredGeometry(measuredFor([]))
    expect(() => diffGeometry(slice, measured, 0 as never)).toThrowError(/tolerancePx/)
  })

  it('fails on coverage gaps when coverage is required', async () => {
    // Scoring mode: without this, "zero mismatches" is achievable by
    // measuring nothing — the exact shape of the pilot's own blind spot.
    const slice = await sliceFrom([PAGE])
    const partial = diffGeometry(
      slice,
      decodeMeasuredGeometry(measuredFor([{ sourceId: '1:1', x: 0, y: 0, width: 200, height: 100 }])),
    )
    expect(geometryReportFails(partial, { requireCoverage: true })).toBe(true)

    const full = diffGeometry(
      slice,
      decodeMeasuredGeometry(
        measuredFor([
          { sourceId: '1:1', x: 0, y: 0, width: 200, height: 100 },
          { sourceId: '1:2', x: 0, y: 0, width: 60, height: 40 },
          { sourceId: '1:3', x: 30.2, y: 0, width: 50, height: 30 },
        ]),
      ),
    )
    expect(geometryReportFails(full, { requireCoverage: true })).toBe(false)
  })

  it('fails on a measured id the slice does not contain', async () => {
    const slice = await sliceFrom([PAGE])
    const report = diffGeometry(
      slice,
      decodeMeasuredGeometry(measuredFor([{ sourceId: '9:9', x: 0, y: 0, width: 1, height: 1 }])),
    )
    expect(report.unknownSourceIds).toEqual(['9:9'])
    expect(geometryReportFails(report)).toBe(true)
  })

  it('fails on a mapping to a node that has no geometry', async () => {
    const page = frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, {
      children: [text('1:2', 'label', 'hello')],
    })
    const slice = await sliceFrom([page])
    const report = diffGeometry(
      slice,
      decodeMeasuredGeometry(measuredFor([{ sourceId: '1:2', x: 0, y: 0, width: 10, height: 10 }])),
    )
    expect(report.withoutExpectedBox).toEqual(['1:2'])
    expect(geometryReportFails(report)).toBe(true)
  })

  it('refuses a root that is not in the slice', async () => {
    const slice = await sliceFrom([PAGE])
    expect(() =>
      diffGeometry(slice, decodeMeasuredGeometry(measuredFor([], { rootSourceId: '9:9' }))),
    ).toThrowError(GeometryError)
  })
})

describe('the text gates', () => {
  // A three-line label: 90px tall at a 30px line height. The browser's
  // per-line rounding can drift its y and height by fractions the design
  // cannot express; a changed wrap count is a different animal entirely.
  const LABELED = frame('1:1', 'root', { x: 0, y: 0, width: 375, height: 300 }, {
    children: [
      text('1:2', 'paragraph', 'three lines of copy', {
        absoluteBoundingBox: { x: 0, y: 20, width: 300, height: 90 },
        style: { fontFamily: 'Example Sans', fontSize: 15, lineHeightPx: 30, textAutoResize: 'HEIGHT' },
      }),
    ],
  })
  const measure = (y: number, height: number) =>
    decodeMeasuredGeometry(measuredFor([{ sourceId: '1:2', x: 0, y, width: 300, height }]))

  it('stays strict by default: looseness is something a contract opts into', async () => {
    const slice = await sliceFrom([LABELED])
    const report = diffGeometry(slice, measure(21.5, 90))
    expect(report.mismatches.map((m) => m.slot)).toEqual(['y'])
    expect(geometryReportFails(report)).toBe(true)
  })

  it('budgets vertical text drift and records every vertical measurement, passes included', async () => {
    const slice = await sliceFrom([LABELED])
    // Budget: 1 + 0.5 × 3 lines = 2.5px. A 1.5px y drift is explained.
    const report = diffGeometry(slice, measure(21.5, 90), {
      textTolerancePx: 1,
      textTolerancePerLinePx: 0.5,
    })
    expect(report.mismatches).toEqual([])
    // Both vertical slots are on the record — the exact height too — so the
    // contract can read a distribution, not a survivor list.
    expect(report.textMetricDeltas).toEqual([
      { sourceId: '1:2', slot: 'y', expectedPx: 20, measuredPx: 21.5, deltaPx: 1.5, boundPx: 2.5, classification: 'budget-pass' },
      { sourceId: '1:2', slot: 'height', expectedPx: 90, measuredPx: 90, deltaPx: 0, boundPx: 2.5, classification: 'strict-pass' },
    ])
    expect(report.matchedCount).toBe(1)
    expect(geometryReportFails(report)).toBe(false)
  })

  it('fails a drift beyond the budget, and says so in the record', async () => {
    const slice = await sliceFrom([LABELED])
    const report = diffGeometry(slice, measure(24, 90), {
      textTolerancePx: 1,
      textTolerancePerLinePx: 0.5,
    })
    expect(report.mismatches.map((m) => m.slot)).toEqual(['y'])
    expect(report.textMetricDeltas.find((d) => d.slot === 'y')?.classification).toBe('budget-fail')
    expect(geometryReportFails(report)).toBe(true)
  })

  it('never budgets x or width: a blanket allowance must not smuggle real mistakes', async () => {
    const slice = await sliceFrom([LABELED])
    const drifted = decodeMeasuredGeometry(
      measuredFor([{ sourceId: '1:2', x: 2, y: 20, width: 300, height: 90 }]),
    )
    const report = diffGeometry(slice, drifted, { textTolerancePx: 10, textTolerancePerLinePx: 10 })
    expect(report.mismatches.map((m) => m.slot)).toEqual(['x'])
    expect(geometryReportFails(report)).toBe(true)
  })

  it('reports a height jump of about a line as a wrap flip that no budget absorbs', async () => {
    const slice = await sliceFrom([LABELED])
    // 90 → 120: the paragraph wraps to four lines. Generous budgets must not
    // swallow this; it pushes everything below by a line.
    const report = diffGeometry(slice, measure(20, 120), {
      textTolerancePx: 50,
      textTolerancePerLinePx: 50,
    })
    expect(report.mismatches).toEqual([])
    expect(report.wrapFlips).toEqual([
      {
        sourceId: '1:2',
        expectedPx: 90,
        measuredPx: 120,
        deltaPx: 30,
        lineHeightPx: 30,
        lineDelta: 1,
        residualPx: 0,
      },
    ])
    expect(geometryReportFails(report)).toBe(true)
  })

  it('keeps a height anomaly that is not near a whole line out of the flip list: it is an ordinary mismatch', async () => {
    // +45px on a 30px line height sits between one and two lines: nothing
    // about wrapping explains it, so it must not be blamed on text rendering.
    const slice = await sliceFrom([LABELED])
    const report = diffGeometry(slice, measure(20, 135), {
      textTolerancePx: 1,
      textTolerancePerLinePx: 0.5,
    })
    expect(report.wrapFlips).toEqual([])
    expect(report.mismatches.map((m) => m.slot)).toEqual(['height'])
  })

  it('gives no budget to fixed-height text: its box does not drift with content', async () => {
    const fixed = frame('1:1', 'root', { x: 0, y: 0, width: 375, height: 300 }, {
      children: [
        text('1:2', 'clamped', 'clamped copy', {
          absoluteBoundingBox: { x: 0, y: 20, width: 300, height: 90 },
          style: { fontFamily: 'Example Sans', fontSize: 15, lineHeightPx: 30, textAutoResize: 'NONE' },
        }),
      ],
    })
    const slice = await sliceFrom([fixed])
    const report = diffGeometry(
      slice,
      decodeMeasuredGeometry(measuredFor([{ sourceId: '1:2', x: 0, y: 21.5, width: 300, height: 90 }])),
      { textTolerancePx: 10, textTolerancePerLinePx: 10 },
    )
    expect(report.mismatches.map((m) => m.slot)).toEqual(['y'])
    expect(report.textMetricDeltas).toEqual([])
  })

  it('refuses a text tolerance below the base tolerance', async () => {
    const slice = await sliceFrom([LABELED])
    expect(() => diffGeometry(slice, measure(20, 90), { tolerancePx: 1, textTolerancePx: 0.5 })).toThrowError(
      /base tolerance/,
    )
  })
})

describe('exclusions and element identity', () => {
  it('satisfies required coverage through verified exclusions', async () => {
    // The inside of a measured picture: a placeholder image with a vector
    // drawn over it, and an icon container made of nothing but vectors.
    const page = frame('1:1', 'root', { x: 0, y: 0, width: 200, height: 100 }, {
      children: [
        frame('1:2', 'photo', { x: 0, y: 0, width: 60, height: 40 }, {
          fills: [{ type: 'IMAGE', imageRef: 'img', scaleMode: 'FILL' }],
          children: [frame('1:3', 'overlay', { x: 10, y: 10, width: 20, height: 20 }, { type: 'VECTOR' })],
        }),
        frame('1:4', 'icon', { x: 100, y: 0, width: 24, height: 24 }, {
          children: [frame('1:5', 'glyph', { x: 102, y: 2, width: 20, height: 20 }, { type: 'BOOLEAN_OPERATION' })],
        }),
      ],
    })
    const slice = await sliceFrom([page])
    const report = diffGeometry(
      slice,
      decodeMeasuredGeometry(
        measuredFor(
          [
            { sourceId: '1:1', x: 0, y: 0, width: 200, height: 100 },
            { sourceId: '1:2', x: 0, y: 0, width: 60, height: 40 },
            { sourceId: '1:4', x: 100, y: 0, width: 24, height: 24 },
          ],
          {
            exclusions: [
              { sourceId: '1:3', kind: 'asset-internal' },
              { sourceId: '1:5', kind: 'asset-internal' },
            ],
          },
        ),
      ),
    )
    expect(report.unmeasuredRendered).toEqual([])
    expect(report.invalidExclusions).toEqual([])
    expect(geometryReportFails(report, { requireCoverage: true })).toBe(false)
  })

  it('rejects asset-internal for content under a measured card: a label is not part of a picture (REG-VERIFY-012)', async () => {
    const slice = await sliceFrom([PAGE])
    const report = diffGeometry(
      slice,
      decodeMeasuredGeometry(
        measuredFor([{ sourceId: '1:1', x: 0, y: 0, width: 200, height: 100 }], {
          exclusions: [{ sourceId: '1:2', kind: 'asset-internal' }],
        }),
      ),
    )
    expect(report.invalidExclusions).toEqual([{ sourceId: '1:2', reason: 'the measured ancestor is not an asset' }])
    expect(report.unmeasuredRendered).toContain('1:2')
    expect(geometryReportFails(report)).toBe(true)
  })

  it('rejects asset-internal under an image-backed card with a label in it: a fill does not make the children a picture (REG-VERIFY-012)', async () => {
    const page = frame('1:1', 'root', { x: 0, y: 0, width: 200, height: 100 }, {
      children: [
        frame('1:2', 'card', { x: 0, y: 0, width: 60, height: 40 }, {
          fills: [{ type: 'IMAGE', imageRef: 'img', scaleMode: 'FILL' }],
          children: [
            frame('1:3', 'overlay', { x: 10, y: 10, width: 20, height: 20 }, { type: 'VECTOR' }),
            text('1:4', 'label', 'Caption', { absoluteBoundingBox: { x: 10, y: 60, width: 100, height: 20 } }),
          ],
        }),
      ],
    })
    const report = diffGeometry(
      await sliceFrom([page]),
      decodeMeasuredGeometry(
        measuredFor(
          [
            { sourceId: '1:1', x: 0, y: 0, width: 200, height: 100 },
            { sourceId: '1:2', x: 0, y: 0, width: 60, height: 40 },
          ],
          { exclusions: [{ sourceId: '1:3', kind: 'asset-internal' }] },
        ),
      ),
    )
    expect(report.invalidExclusions).toEqual([{ sourceId: '1:3', reason: 'the measured ancestor is not an asset' }])
  })

  it('rejects asset-internal under a container whose children the slice cut short: it cannot vouch for what it did not see', async () => {
    const roots = [
      frame('1:1', 'root', { x: 0, y: 0, width: 200, height: 100 }, {
        children: [
          frame('1:2', 'icon', { x: 0, y: 0, width: 24, height: 24 }, {
            children: [
              frame('1:3', 'glyph', { x: 2, y: 2, width: 20, height: 20 }, { type: 'VECTOR' }),
              frame('1:4', 'other', { x: 2, y: 2, width: 20, height: 20 }, { type: 'VECTOR' }),
            ],
          }),
        ],
      }),
    ]
    const doc = fromSnapshot(
      await acquireSnapshot({ client: fixtureClient(design(roots, {})), fileKey: KEY, roots: ['1:1'], now }),
    )
    // Three nodes fit the budget: root, icon, one glyph. The other glyph is
    // cut, so the icon's child list — what "a container of nothing else"
    // would rely on — is incomplete.
    const slice = cutSlice(doc, deriveFacts(doc), { roots: ['1:1'], maxNodes: 3 })
    expect(slice.omitted.map((entry) => entry.reason)).toContain('max-nodes')
    const report = diffGeometry(
      slice,
      decodeMeasuredGeometry(
        measuredFor(
          [
            { sourceId: '1:1', x: 0, y: 0, width: 200, height: 100 },
            { sourceId: '1:2', x: 0, y: 0, width: 24, height: 24 },
          ],
          { exclusions: [{ sourceId: '1:3', kind: 'asset-internal' }] },
        ),
      ),
    )
    expect(report.invalidExclusions).toEqual([{ sourceId: '1:3', reason: 'the measured ancestor is not an asset' }])
  })

  it('accepts a collapse that satisfies the eligibility conditions', async () => {
    // A wrapper with nothing of its own around a single identical child.
    const wrapped = frame('1:1', 'root', { x: 0, y: 0, width: 200, height: 100 }, {
      children: [
        frame('1:2', 'wrapper', { x: 0, y: 0, width: 200, height: 100 }, {
          children: [frame('1:3', 'content', { x: 0, y: 0, width: 200, height: 100 })],
        }),
      ],
    })
    const slice = await sliceFrom([wrapped])
    const report = diffGeometry(
      slice,
      decodeMeasuredGeometry(
        measuredFor([
          { sourceId: '1:1', x: 0, y: 0, width: 200, height: 100 },
          { sourceId: '1:3', x: 0, y: 0, width: 200, height: 100 },
        ], {
          exclusions: [{ sourceId: '1:2', kind: 'collapsed-into', targetSourceId: '1:3' }],
        }),
      ),
    )
    expect(report.invalidExclusions).toEqual([])
    expect(report.unmeasuredRendered).toEqual([])
    expect(geometryReportFails(report, { requireCoverage: true })).toBe(false)
  })

  it('rejects a forged collapse: differing boxes are not one element', async () => {
    const slice = await sliceFrom([PAGE])
    const report = diffGeometry(
      slice,
      decodeMeasuredGeometry(
        measuredFor([{ sourceId: '1:1', x: 0, y: 0, width: 200, height: 100 }], {
          exclusions: [{ sourceId: '1:3', kind: 'collapsed-into', targetSourceId: '1:1' }],
        }),
      ),
    )
    expect(report.invalidExclusions).toEqual([{ sourceId: '1:3', reason: 'boxes differ' }])
    // The coverage gap stays open: a failed claim excuses nothing.
    expect(report.unmeasuredRendered).toContain('1:3')
    expect(geometryReportFails(report)).toBe(true)
  })

  it('rejects asset-internal for top-level content: nothing measured contains it', async () => {
    const slice = await sliceFrom([PAGE])
    const report = diffGeometry(
      slice,
      decodeMeasuredGeometry(
        measuredFor([{ sourceId: '1:2', x: 0, y: 0, width: 60, height: 40 }], {
          exclusions: [{ sourceId: '1:1', kind: 'asset-internal' }],
        }),
      ),
    )
    expect(report.invalidExclusions).toEqual([{ sourceId: '1:1', reason: 'no measured ancestor' }])
    expect(geometryReportFails(report)).toBe(true)
  })

  it('rejects mutual collapses: a chain must bottom out in something measured', async () => {
    const slice = await sliceFrom([PAGE])
    const report = diffGeometry(
      slice,
      decodeMeasuredGeometry(
        measuredFor([], {
          exclusions: [
            { sourceId: '1:2', kind: 'collapsed-into', targetSourceId: '1:3' },
            { sourceId: '1:3', kind: 'collapsed-into', targetSourceId: '1:2' },
          ],
        }),
      ),
    )
    expect(report.invalidExclusions.map((entry) => entry.reason)).toEqual([
      'collapse target was not measured',
      'collapse target was not measured',
    ])
    expect(geometryReportFails(report)).toBe(true)
  })

  it('fails an exclusion that names a node the slice does not contain', async () => {
    const slice = await sliceFrom([PAGE])
    const report = diffGeometry(
      slice,
      decodeMeasuredGeometry(measuredFor([], { exclusions: [{ sourceId: '9:9', kind: 'asset-internal' }] })),
    )
    expect(report.invalidExclusions).toEqual([{ sourceId: '9:9', reason: 'not in the slice' }])
    expect(geometryReportFails(report)).toBe(true)
  })

  it('demands element identities when a scored run asks for them', async () => {
    const slice = await sliceFrom([PAGE])
    const report = diffGeometry(
      slice,
      decodeMeasuredGeometry(
        measuredFor([
          { sourceId: '1:1', x: 0, y: 0, width: 200, height: 100, element: 'e1' },
          { sourceId: '1:2', x: 0, y: 0, width: 60, height: 40 },
        ]),
      ),
    )
    expect(report.entriesWithoutElement).toEqual(['1:2'])
    expect(geometryReportFails(report)).toBe(false)
    expect(geometryReportFails(report, { requireElements: true })).toBe(true)
  })

  it('refuses a node that is both measured and excluded', () => {
    expect(() =>
      decodeMeasuredGeometry(
        measuredFor([{ sourceId: '1:2', x: 0, y: 0, width: 1, height: 1 }], {
          exclusions: [{ sourceId: '1:2', kind: 'asset-internal' }],
        }),
      ),
    ).toThrowError(/both measured and excluded/)
  })

  it('refuses a collapse that names itself, or no target at all', () => {
    expect(() =>
      decodeMeasuredGeometry(measuredFor([], { exclusions: [{ sourceId: '1:2', kind: 'collapsed-into', targetSourceId: '1:2' }] })),
    ).toThrowError(/different node/)
    expect(() =>
      decodeMeasuredGeometry(measuredFor([], { exclusions: [{ sourceId: '1:2', kind: 'collapsed-into' }] })),
    ).toThrowError(/different node/)
  })

  it('fails when one element answers for two nodes without a collapse declaration', async () => {
    // The pilot's blind spot: a wrapper and its child measured off the same
    // DOM element read as 100% coverage while the hierarchy silently folded.
    const slice = await sliceFrom([PAGE])
    const report = diffGeometry(
      slice,
      decodeMeasuredGeometry(
        measuredFor([
          { sourceId: '1:1', x: 0, y: 0, width: 200, height: 100, element: 'e1' },
          { sourceId: '1:2', x: 0, y: 0, width: 60, height: 40, element: 'e2' },
          { sourceId: '1:3', x: 30.2, y: 0, width: 50, height: 30, element: 'e2' },
        ]),
      ),
    )
    expect(report.sharedElements).toEqual([{ element: 'e2', sourceIds: ['1:2', '1:3'] }])
    expect(geometryReportFails(report)).toBe(true)
  })
})

describe('decodeMeasuredGeometry', () => {
  it('refuses a duplicated sourceId rather than picking a measurement', () => {
    expect(() =>
      decodeMeasuredGeometry(
        measuredFor([
          { sourceId: '1:2', x: 0, y: 0, width: 1, height: 1 },
          { sourceId: '1:2', x: 5, y: 0, width: 1, height: 1 },
        ]),
      ),
    ).toThrowError(/twice/)
  })

  it('refuses non-finite numbers', () => {
    expect(() =>
      decodeMeasuredGeometry(measuredFor([{ sourceId: '1:2', x: Number.NaN, y: 0, width: 1, height: 1 }])),
    ).toThrowError(/finite/)
  })

  it('refuses a missing or wrong schema version', () => {
    expect(() => decodeMeasuredGeometry(measuredFor([], { schemaVersion: 3 }))).toThrowError(/schemaVersion/)
    expect(() => decodeMeasuredGeometry(measuredFor([], { schemaVersion: undefined }))).toThrowError(/schemaVersion/)
  })

  it('keeps version 2 fields and kinds out of a version 1 file', () => {
    expect(() =>
      decodeMeasuredGeometry(measuredFor([{ sourceId: '1:1', x: 0, y: 0, width: 1, height: 1, tagName: 'DIV' }])),
    ).toThrowError(/tagName is a schemaVersion 2 field/)
    expect(() =>
      decodeMeasuredGeometry(measuredFor([], { exclusions: [{ sourceId: '1:2', kind: 'derived-from-children' }] })),
    ).toThrowError(/requires schemaVersion 2/)
    expect(() =>
      decodeMeasuredGeometry(
        measuredFor([], { exclusions: [{ sourceId: '1:2', kind: 'native-control-internal', targetSourceId: '1:1' }] }),
      ),
    ).toThrowError(/requires schemaVersion 2/)
  })

  it('demands tagName on every version 2 entry, null included, and upper-cases it', () => {
    expect(() =>
      decodeMeasuredGeometry(measuredFor([{ sourceId: '1:1', x: 0, y: 0, width: 1, height: 1 }], { schemaVersion: 2 })),
    ).toThrowError(/tagName must be a non-empty string or null/)
    const decoded = decodeMeasuredGeometry(
      measuredFor(
        [
          { sourceId: '1:1', x: 0, y: 0, width: 1, height: 1, tagName: 'select' },
          { sourceId: '1:2', x: 0, y: 0, width: 1, height: 1, tagName: null },
        ],
        { schemaVersion: 2 },
      ),
    )
    expect(decoded.schemaVersion).toBe(2)
    expect(decoded.entries.map((entry) => entry.tagName)).toEqual(['SELECT', undefined])
  })
})

describe('measured geometry v2: derived-from-children (REG-VERIFY-012)', () => {
  /**
   * A wrapper the implementation gave no box: an auto-layout row with
   * padding 10 around two children, whose design box is exactly the
   * children's union plus that padding.
   */
  const rowAround = (box: { x: number; y: number; width: number; height: number }, over: Record<string, unknown> = {}) =>
    frame('1:1', 'root', { x: 0, y: 0, width: 300, height: 200 }, {
      children: [
        frame('1:2', 'row', box, {
          layoutMode: 'HORIZONTAL',
          paddingTop: 10,
          paddingRight: 10,
          paddingBottom: 10,
          paddingLeft: 10,
          ...over,
          children: [
            frame('1:3', 'a', { x: 30, y: 30, width: 100, height: 50 }),
            frame('1:4', 'b', { x: 140, y: 30, width: 60, height: 50 }),
          ],
        }),
      ],
    })
  const EXACT = { x: 20, y: 20, width: 190, height: 70 }
  const childEntries = [
    { sourceId: '1:1', x: 0, y: 0, width: 300, height: 200, tagName: 'DIV' },
    { sourceId: '1:3', x: 30, y: 30, width: 100, height: 50, tagName: 'DIV' },
    { sourceId: '1:4', x: 140, y: 30, width: 60, height: 50, tagName: 'DIV' },
  ]
  const derived = (entries: ReadonlyArray<Record<string, unknown>> = childEntries) =>
    decodeMeasuredGeometry(
      measuredFor(entries, { schemaVersion: 2, exclusions: [{ sourceId: '1:2', kind: 'derived-from-children' }] }),
    )

  it('accepts a frame that is exactly its measured children plus padding', async () => {
    const report = diffGeometry(await sliceFrom([rowAround(EXACT)]), derived())
    expect(report.invalidExclusions).toEqual([])
    expect(report.unmeasuredRendered).toEqual([])
    expect(report.measuredSchemaVersion).toBe(2)
    expect(geometryReportFails(report, { requireCoverage: true })).toBe(false)
  })

  it('rejects a frame with slack: room to align in is information a DOM without the box would drop', async () => {
    const report = diffGeometry(await sliceFrom([rowAround({ x: 20, y: 20, width: 220, height: 70 })]), derived())
    expect(report.invalidExclusions).toEqual([{ sourceId: '1:2', reason: 'the box is not its children plus padding' }])
    expect(report.unmeasuredRendered).toContain('1:2')
  })

  it('rejects a frame whose children were not all measured: a derivation needs every input', async () => {
    const report = diffGeometry(await sliceFrom([rowAround(EXACT)]), derived(childEntries.slice(0, 2)))
    expect(report.invalidExclusions).toEqual([{ sourceId: '1:2', reason: 'child 1:4 was not measured' }])
  })

  it('rejects a frame that is not auto-layout: coordinates alone do not derive a box', async () => {
    const report = diffGeometry(await sliceFrom([rowAround(EXACT, { layoutMode: 'NONE' })]), derived())
    expect(report.invalidExclusions).toEqual([{ sourceId: '1:2', reason: 'not an auto-layout frame' }])
  })

  it('rejects a frame that paints: a fill covers the padding, and nothing would paint it', async () => {
    const report = diffGeometry(
      await sliceFrom([rowAround(EXACT, { fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }] })]),
      derived(),
    )
    expect(report.invalidExclusions).toEqual([{ sourceId: '1:2', reason: 'the frame paints something of its own' }])
  })

  it('rejects a frame with an absolutely positioned child: it sits outside the derivation', async () => {
    const page = frame('1:1', 'root', { x: 0, y: 0, width: 300, height: 200 }, {
      children: [
        frame('1:2', 'row', EXACT, {
          layoutMode: 'HORIZONTAL',
          paddingTop: 10,
          paddingRight: 10,
          paddingBottom: 10,
          paddingLeft: 10,
          children: [
            frame('1:3', 'a', { x: 30, y: 30, width: 100, height: 50 }),
            frame('1:4', 'b', { x: 140, y: 30, width: 60, height: 50 }, { layoutPositioning: 'ABSOLUTE' }),
          ],
        }),
      ],
    })
    const report = diffGeometry(await sliceFrom([page]), derived())
    expect(report.invalidExclusions).toEqual([{ sourceId: '1:2', reason: 'child 1:4 is absolutely positioned' }])
  })

  it('rejects a frame whose children the slice budget cut off: the slice cannot vouch for them', async () => {
    const roots = [rowAround(EXACT)]
    const doc = fromSnapshot(
      await acquireSnapshot({ client: fixtureClient(design(roots, {})), fileKey: KEY, roots: ['1:1'], now }),
    )
    const slice = cutSlice(doc, deriveFacts(doc), { roots: ['1:1'], maxDepth: 1 })
    const report = diffGeometry(slice, derived(childEntries.slice(0, 1)))
    expect(report.invalidExclusions).toEqual([
      { sourceId: '1:2', reason: 'the children were cut short by the slice budget' },
    ])
  })
})

describe('measured geometry v2: derived-from-children, the declarations (REG-VERIFY-012)', () => {
  const rowAround = (over: Record<string, unknown>, children?: ReadonlyArray<RawNodeSpec>) =>
    frame('1:1', 'root', { x: 0, y: 0, width: 300, height: 200 }, {
      children: [
        frame('1:2', 'row', { x: 20, y: 20, width: 190, height: 70 }, {
          layoutMode: 'HORIZONTAL',
          paddingTop: 10,
          paddingRight: 10,
          paddingBottom: 10,
          paddingLeft: 10,
          ...over,
          children: children ?? [
            frame('1:3', 'a', { x: 30, y: 30, width: 100, height: 50 }),
            frame('1:4', 'b', { x: 140, y: 30, width: 60, height: 50 }),
          ],
        }),
      ],
    })
  const derived = (entries: ReadonlyArray<Record<string, unknown>>) =>
    decodeMeasuredGeometry(
      measuredFor(entries, { schemaVersion: 2, exclusions: [{ sourceId: '1:2', kind: 'derived-from-children' }] }),
    )
  const all = [
    { sourceId: '1:1', x: 0, y: 0, width: 300, height: 200, tagName: 'DIV' },
    { sourceId: '1:3', x: 30, y: 30, width: 100, height: 50, tagName: 'DIV' },
    { sourceId: '1:4', x: 140, y: 30, width: 60, height: 50, tagName: 'DIV' },
  ]

  it('accepts a known distribution: positions are compared, not mechanisms, and every child is verified on its own', async () => {
    // Space-between with the children on the padding edges: the union is the
    // frame, and each child's position is checked directly.
    const report = diffGeometry(await sliceFrom([rowAround({ primaryAxisAlignItems: 'SPACE_BETWEEN' })]), derived(all))
    expect(report.invalidExclusions).toEqual([])
    const passThrough = diffGeometry(await sliceFrom([rowAround({ blendMode: 'PASS_THROUGH' })]), derived(all))
    expect(passThrough.invalidExclusions).toEqual([])
  })

  it('fails closed on a layout value outside the known set', async () => {
    const report = diffGeometry(await sliceFrom([rowAround({ layoutWrap: 'SOMETHING_NEW' })]), derived(all))
    expect(report.invalidExclusions).toEqual([
      { sourceId: '1:2', reason: 'the frame declares a layout value outside the known set' },
    ])
  })

  it('rejects every way a frame carries something of its own', async () => {
    const cases: ReadonlyArray<[Record<string, unknown>, string]> = [
      [{ overflowDirection: 'HORIZONTAL_SCROLLING' }, 'the frame scrolls'],
      [{ clipsContent: true }, 'the frame clips'],
      // NORMAL on a container isolates its children's blending; only
      // PASS_THROUGH composites them as a wrapperless DOM would.
      [{ blendMode: 'NORMAL' }, 'the frame blends'],
      [{ blendMode: 'MULTIPLY' }, 'the frame blends'],
      [{ effects: [{ type: 'DROP_SHADOW', visible: true, radius: 4, color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 0, y: 2 } }] }, 'the frame has effects'],
      [{ opacity: 0.5 }, 'the frame has opacity'],
      [{ rotation: 5 }, 'the frame is rotated'],
    ]
    for (const [over, reason] of cases) {
      const report = diffGeometry(await sliceFrom([rowAround(over)]), derived(all))
      expect(report.invalidExclusions, reason).toEqual([{ sourceId: '1:2', reason }])
    }
  })

  it('rejects a rotated child and a frame with no rendered children', async () => {
    const rotated = diffGeometry(
      await sliceFrom([
        rowAround({}, [
          frame('1:3', 'a', { x: 30, y: 30, width: 100, height: 50 }),
          frame('1:4', 'b', { x: 140, y: 30, width: 60, height: 50 }, { rotation: 3 }),
        ]),
      ]),
      derived(all),
    )
    expect(rotated.invalidExclusions).toEqual([{ sourceId: '1:2', reason: 'child 1:4 is rotated' }])
    const empty = diffGeometry(await sliceFrom([rowAround({}, [])]), derived(all.slice(0, 1)))
    expect(empty.invalidExclusions).toEqual([{ sourceId: '1:2', reason: 'no rendered children' }])
  })
})

describe('measured geometry v2: native-control-internal (REG-VERIFY-012)', () => {
  /** A select whose displayed value the design draws as a text node inside it. */
  const page = (textBox = { x: 20, y: 20, width: 100, height: 20 }) =>
    frame('1:1', 'root', { x: 0, y: 0, width: 300, height: 100 }, {
      children: [
        frame('1:2', 'select', { x: 10, y: 10, width: 200, height: 40 }, {
          children: [text('1:3', 'value', 'Choose', { absoluteBoundingBox: textBox })],
        }),
        text('1:4', 'label', 'Sibling', { absoluteBoundingBox: { x: 220, y: 20, width: 60, height: 20 } }),
      ],
    })
  const withControl = (tagName: string | null, exclusion: Record<string, unknown> = { sourceId: '1:3', kind: 'native-control-internal', targetSourceId: '1:2' }) =>
    decodeMeasuredGeometry(
      measuredFor(
        [
          { sourceId: '1:1', x: 0, y: 0, width: 300, height: 100, tagName: 'DIV' },
          { sourceId: '1:2', x: 10, y: 10, width: 200, height: 40, tagName },
          { sourceId: '1:4', x: 220, y: 20, width: 60, height: 20, tagName: 'SPAN' },
        ],
        { schemaVersion: 2, exclusions: [exclusion] },
      ),
    )

  it('accepts text inside a measured native select', async () => {
    const report = diffGeometry(await sliceFrom([page()]), withControl('select'))
    expect(report.invalidExclusions).toEqual([])
    expect(report.unmeasuredRendered).toEqual([])
    expect(geometryReportFails(report, { requireCoverage: true })).toBe(false)
  })

  it('rejects the claim when the measured control is not a native select', async () => {
    for (const tagName of ['DIV', null]) {
      const report = diffGeometry(await sliceFrom([page()]), withControl(tagName))
      expect(report.invalidExclusions, String(tagName)).toEqual([
        { sourceId: '1:3', reason: 'the measured control is not a native select' },
      ])
    }
  })

  it('rejects text that is not inside the control, by tree or by box', async () => {
    const outsideTree = diffGeometry(
      await sliceFrom([page()]),
      decodeMeasuredGeometry(
        measuredFor(
          [
            { sourceId: '1:1', x: 0, y: 0, width: 300, height: 100, tagName: 'DIV' },
            { sourceId: '1:2', x: 10, y: 10, width: 200, height: 40, tagName: 'SELECT' },
          ],
          {
            schemaVersion: 2,
            exclusions: [{ sourceId: '1:4', kind: 'native-control-internal', targetSourceId: '1:2' }],
          },
        ),
      ),
    )
    expect(outsideTree.invalidExclusions).toEqual([{ sourceId: '1:4', reason: 'not inside the control' }])
    const outsideBox = diffGeometry(
      await sliceFrom([page({ x: 20, y: 45, width: 100, height: 20 })]),
      withControl('SELECT'),
    )
    expect(outsideBox.invalidExclusions).toEqual([{ sourceId: '1:3', reason: 'not inside the control box' }])
  })

  it('rejects a control the slice does not contain, or that was not measured', async () => {
    const missing = diffGeometry(
      await sliceFrom([page()]),
      withControl('SELECT', { sourceId: '1:3', kind: 'native-control-internal', targetSourceId: '9:9' }),
    )
    expect(missing.invalidExclusions).toEqual([{ sourceId: '1:3', reason: 'control not in the slice' }])
    const unmeasured = diffGeometry(
      await sliceFrom([page()]),
      decodeMeasuredGeometry(
        measuredFor([{ sourceId: '1:1', x: 0, y: 0, width: 300, height: 100, tagName: 'DIV' }], {
          schemaVersion: 2,
          exclusions: [{ sourceId: '1:3', kind: 'native-control-internal', targetSourceId: '1:2' }],
        }),
      ),
    )
    expect(unmeasured.invalidExclusions).toEqual([{ sourceId: '1:3', reason: 'control was not measured' }])
  })

  it('rejects a node that is not text: a native control renders its value, not a layout', async () => {
    const report = diffGeometry(
      await sliceFrom([page()]),
      decodeMeasuredGeometry(
        measuredFor(
          [{ sourceId: '1:1', x: 0, y: 0, width: 300, height: 100, tagName: 'SELECT' }],
          { schemaVersion: 2, exclusions: [{ sourceId: '1:2', kind: 'native-control-internal', targetSourceId: '1:1' }] },
        ),
      ),
    )
    expect(report.invalidExclusions).toEqual([{ sourceId: '1:2', reason: 'not a text node' }])
  })
})
