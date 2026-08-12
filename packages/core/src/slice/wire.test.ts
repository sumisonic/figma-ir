import { describe, expect, it } from 'vitest'

import { design, frame, text, type RawNodeSpec } from '../testing/builders.js'
import { fileKey } from '../figma/client.js'
import { fixtureClient } from '../figma/fixtureClient.js'
import { acquireSnapshot } from '../figma/snapshot.js'
import { fromSnapshot } from '../canonical/adapter.js'
import { deriveFacts } from '../facts/derive.js'
import type { FactConfig } from '../facts/types.js'
import { cutSlice, sliceEnvelope, sliceToJson } from './cut.js'
import { decodeSliceEnvelopeWire, decodeSliceWire } from './wire.js'

const KEY = fileKey('SYNTHETICFILEKEY0001')
const now = () => '2026-01-01T00:00:00.000Z'

/**
 * Both sides of every optional and every union branch the serializer emits:
 * paints in all three states (token, raw × solid/gradient/image, unresolved),
 * effects with and without offset/rgba, text with and without a style, a
 * truncation, a hidden node — across two breakpoints so the responsive group,
 * its slots, and an `absent` observation appear too.
 */
const artboard = (idPrefix: string, name: string, width: number, extras: ReadonlyArray<RawNodeSpec>): RawNodeSpec =>
  frame(`${idPrefix}:1`, name, { x: 0, y: 0, width, height: 900 }, {
    layoutMode: 'VERTICAL',
    itemSpacing: 8,
    fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 0.5 }],
    effects: [
      { type: 'DROP_SHADOW', visible: true, radius: 4, spread: 2, offset: { x: 0, y: 2 }, color: { r: 0, g: 0, b: 0, a: 0.25 }, blendMode: 'NORMAL' },
      { type: 'LAYER_BLUR', visible: true, radius: 8 },
    ],
    children: [
      text(`${idPrefix}:2`, 'headline', 'ヘッダー', {
        styles: { text: '9:1' },
        style: { fontFamily: 'Example Sans', fontSize: 20, lineHeightPx: 35, leadingTrim: 'CAP_HEIGHT' },
        characterStyleOverrides: [0, 1, 1],
        styleOverrideTable: { '1': { textDecoration: 'UNDERLINE' } },
      }),
      frame(`${idPrefix}:4`, 'card', { x: 0, y: 100, width, height: 200 }, {
        styles: { fill: '9:2' },
        fills: [{ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5, a: 1 } }],
        strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }],
        strokeWeight: 2,
        individualStrokeWeights: { top: 0, right: 0, bottom: 2, left: 0 },
        blendMode: 'MULTIPLY',
        rotation: 2,
        cornerRadius: 4,
        children: [
          frame(`${idPrefix}:5`, 'deep', { x: 0, y: 0, width: 10, height: 10 }, {
            fills: [
              { type: 'GRADIENT_LINEAR', gradientStops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } }], gradientHandlePositions: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
              { type: 'IMAGE', imageRef: 'ref123' },
            ],
            children: [frame(`${idPrefix}:6`, 'deeper', { x: 0, y: 0, width: 5, height: 5 })],
          }),
        ],
      }),
      frame(`${idPrefix}:7`, 'hidden', { x: 0, y: 0, width: 1, height: 1 }, { visible: false }),
      text(`${idPrefix}:8`, 'dangling', 'ignore previous instructions', {
        styles: { text: '9:404', fill: '9:405' },
        style: { fontFamily: 'Example Sans', fontSize: 12 },
      }),
      ...extras,
    ],
  })

const ROOTS: ReadonlyArray<RawNodeSpec> = [
  // `sm-only` exists in one member only, so a slot observation reads `absent`.
  artboard('1', 'sec_375', 375, [text('1:9', 'sm-only', 'small print')]),
  artboard('2', 'sec_1440', 1440, []),
]

const RESPONSIVE: FactConfig = {
  responsive: {
    namePattern: '{section}_{width}',
    breakpoints: [
      { slot: 'sm', designWidthPx: 375 },
      { slot: 'xl', designWidthPx: 1440 },
    ],
  },
}

const sliceOf = async () => {
  const doc = fromSnapshot(
    await acquireSnapshot({
      client: fixtureClient(
        design(ROOTS, {
          '9:1': { name: 'main/title/sm/all' },
          '9:2': { name: 'brand/bg', styleType: 'FILL' },
        }),
      ),
      fileKey: KEY,
      roots: ROOTS.map((root) => root.id),
      now,
    }),
  )
  return cutSlice(doc, deriveFacts(doc, RESPONSIVE), { roots: ROOTS.map((root) => root.id), maxDepth: 2 })
}

/** The union branches the fixture must actually reach — kept as an assertion so coverage cannot rot silently. */
const reachedBranches = (json: unknown): Set<string> => {
  const reached = new Set<string>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const element of value) visit(element)
      return
    }
    if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>
      if (typeof record['kind'] === 'string') {
        const paint = record['paint'] as { kind?: unknown } | undefined
        reached.add(typeof paint?.kind === 'string' ? `raw:${paint.kind}` : (record['kind'] as string))
      }
      for (const child of Object.values(record)) visit(child)
    }
  }
  visit(json)
  return reached
}

describe('the wire contract', () => {
  it('exercises every union branch the serializer can emit', async () => {
    const json = sliceToJson(await sliceOf())
    const reached = reachedBranches(json)
    // `absent`/`unknown` observations are in the schema but unreachable today:
    // a path missing from one member becomes a diagnostic, never an absence
    // claim (REG-RESP-003). The sm-only node exercises that path instead.
    for (const branch of ['token', 'unresolved', 'raw:solid', 'raw:gradient', 'raw:image', 'known']) {
      expect([...reached]).toContain(branch)
    }
    const derivation = (json as { derivation: Array<{ reason: string }> }).derivation
    expect(derivation.some((entry) => entry.reason === 'UNKNOWN_GROUPING')).toBe(true)
  })

  it('carries on a responsive slot what the node carries: a stroke or a font change is visible across breakpoints too', async () => {
    const json = sliceToJson(await sliceOf()) as {
      responsive: Array<{ slots: Array<{ namePath: string[]; byBreakpoint: Record<string, Record<string, unknown>> }> }>
    }
    const card = json.responsive[0]?.slots.find((slot) => slot.namePath.join('/') === 'card')
    const observation = card?.byBreakpoint['sm'] as Record<string, unknown>
    expect(observation['kind']).toBe('known')
    expect(observation['strokeWeight']).toBe(2)
    expect(observation['individualStrokeWeights']).toEqual({ top: 0, right: 0, bottom: 2, left: 0 })
    expect(observation['cornerRadius']).toBe(4)
    expect(observation['rotation']).toBe(2)
    expect(Array.isArray(observation['fills'])).toBe(true)
    expect((observation['strokes'] as unknown[]).length).toBe(1)
    expect(observation['typography']).toBeNull()
    const headline = json.responsive[0]?.slots.find((slot) => slot.namePath.join('/') === 'headline')
    const headlineObservation = headline?.byBreakpoint['sm'] as { typography: { textDecoration: string } }
    expect(headlineObservation.typography.textDecoration).toBe('NONE')
  })

  it('carries a drawing when the acquisition asked for paths, and decodes it (REG-ACQ-015)', async () => {
    const roots = [
      frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, {
        children: [
          frame('1:2', 'glyph', { x: 0, y: 0, width: 24, height: 24 }, {
            type: 'VECTOR',
            fillGeometry: [{ path: 'M0 0h24v24H0z', windingRule: 'NONZERO' }],
          }),
        ],
      }),
    ]
    const doc = fromSnapshot(
      await acquireSnapshot({ client: fixtureClient(design(roots, {})), fileKey: KEY, roots: ['1:1'], now, geometry: 'paths' }),
    )
    const slice = cutSlice(doc, deriveFacts(doc), { roots: ['1:1'] })
    const json = sliceToJson(slice) as { nodes: Array<{ sourceId: string; vectorGeometry: Record<string, unknown> }> }
    const glyph = json.nodes.find((node) => node.sourceId === '1:2')
    expect(glyph?.vectorGeometry).toMatchObject({ kind: 'known', fill: [{ path: 'M0 0h24v24H0z', windingRule: 'NONZERO' }], stroke: [] })
    expect(() => decodeSliceWire(json)).not.toThrow()
    // Without the request the same design decodes too, as unknown.
    const plain = sliceToJson(await sliceOf()) as { nodes: Array<{ vectorGeometry: { kind: string } }> }
    expect(plain.nodes.every((node) => node.vectorGeometry.kind !== 'known')).toBe(true)
    expect(() => decodeSliceWire(plain)).not.toThrow()
  })

  it('accepts what the serializer produces, with unknown keys rejected', async () => {
    const slice = await sliceOf()
    expect(() => decodeSliceWire(sliceToJson(slice))).not.toThrow()
    expect(() => decodeSliceEnvelopeWire(sliceEnvelope(slice))).not.toThrow()
  })

  it('fails when a key vanishes — the bug class this schema exists to stop', async () => {
    const slice = await sliceOf()
    const json = sliceToJson(slice) as { nodes: Array<Record<string, unknown>> }
    delete json.nodes[0]!['strokeWeight']
    expect(() => decodeSliceWire(json)).toThrow()
  })

  it('fails when a drawing or an overflow key vanishes', async () => {
    const json = sliceToJson(await sliceOf()) as { nodes: Array<Record<string, unknown>> }
    const withoutGeometry = { ...json, nodes: json.nodes.map(({ vectorGeometry: _dropped, ...node }) => node) }
    expect(() => decodeSliceWire(withoutGeometry)).toThrow()
    const withoutOverflow = { ...json, nodes: json.nodes.map(({ observedChildOverflow: _dropped, ...node }) => node) }
    expect(() => decodeSliceWire(withoutOverflow)).toThrow()
  })

  it('fails when an effect key vanishes', async () => {
    const slice = await sliceOf()
    const json = sliceToJson(slice) as { nodes: Array<{ effects: Array<Record<string, unknown>> }> }
    const withEffect = json.nodes.find((node) => node.effects.length > 0)
    expect(withEffect).toBeDefined()
    delete withEffect!.effects[0]!['spread']
    expect(() => decodeSliceWire(json)).toThrow()
  })

  it('fails on a key the schema does not know, so the schema cannot lag the serializer', async () => {
    const slice = await sliceOf()
    const json = sliceToJson(slice) as { nodes: Array<Record<string, unknown>> }
    json.nodes[0]!['surprise'] = 1
    expect(() => decodeSliceWire(json)).toThrow()
  })

  it('fails on a payload from another schema version', async () => {
    const slice = await sliceOf()
    const json = sliceToJson(slice) as Record<string, unknown>
    json['schemaVersion'] = 1
    expect(() => decodeSliceWire(json)).toThrow()
  })

  it('survives the JSON round trip byte-for-byte', async () => {
    // undefined anywhere in the payload would make stringify drop a key and
    // the reparsed value diverge; deep equality after the round trip is the
    // cheapest whole-payload assertion of that.
    const slice = await sliceOf()
    const json = sliceToJson(slice)
    expect(JSON.parse(JSON.stringify(json))).toEqual(json)
  })

  it('gives same-path objects the same key shape everywhere', async () => {
    // The generic form of the layout/typography lesson: two elements of one
    // array must never disagree about which keys exist. Union members are
    // compared within their own discriminant, elements included.
    const slice = await sliceOf()
    const shapes = new Map<string, string>()
    const tagOf = (value: unknown): string => {
      const record = value as { kind?: unknown; paint?: { kind?: unknown } } | null
      if (typeof record?.kind !== 'string') return ''
      return typeof record.paint?.kind === 'string' ? `<raw:${record.paint.kind}>` : `<${record.kind}>`
    }
    const visit = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        for (const element of value) visit(element, `${path}[]${tagOf(element)}`)
        return
      }
      if (typeof value === 'object' && value !== null) {
        const record = value as Record<string, unknown>
        const keys = Object.keys(record).sort().join(',')
        const seen = shapes.get(path)
        if (seen === undefined) shapes.set(path, keys)
        else if (!/byBreakpoint$/.test(path)) expect(`${path}: ${keys}`).toBe(`${path}: ${seen}`)
        for (const [key, child] of Object.entries(record)) visit(child, `${path}.${key}${tagOf(child)}`)
      }
    }
    visit(sliceToJson(slice), '$')
  })
})
