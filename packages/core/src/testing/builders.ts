/**
 * Builders for synthetic test input.
 *
 * Tests construct the smallest input that demonstrates their claim — a witness
 * — rather than pointing into a large captured design and inheriting its
 * accidents. Everything here is deliberately plain: a builder returns the raw
 * REST-shaped objects the pipeline consumes, so a test reads as "given this
 * design, this must hold".
 *
 * The vocabulary is synthetic on purpose. Names like `example-web`, fonts like
 * `Example Sans`: nothing in here identifies a real project, which is what
 * allows this package to be public.
 */
import { Schema } from 'effect'

import { NodesResponseSchema, type FileMeta, type NodesResponse } from '../figma/client.js'
import type { FixtureData } from '../figma/fixtureClient.js'

/** A file version that reads as obviously synthetic. */
export const SYNTHETIC_VERSION = '1000000000000000001'

export const syntheticMeta = (version: string = SYNTHETIC_VERSION): FileMeta => ({
  name: 'example-web',
  lastModified: '2026-01-01T00:00:00Z',
  version,
})

/** A raw node as the REST API shapes it. Fields are optional until a test needs them. */
export interface RawNodeSpec {
  readonly id: string
  readonly type: string
  readonly name: string
  readonly visible?: boolean
  readonly rotation?: number
  readonly opacity?: number
  readonly characters?: string
  readonly style?: Record<string, unknown>
  readonly styles?: Record<string, string>
  readonly fills?: ReadonlyArray<Record<string, unknown>>
  readonly strokes?: ReadonlyArray<Record<string, unknown>>
  readonly effects?: ReadonlyArray<Record<string, unknown>>
  readonly strokeWeight?: number
  readonly individualStrokeWeights?: { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number }
  readonly fillGeometry?: ReadonlyArray<{ readonly path: string; readonly windingRule: string }>
  readonly strokeGeometry?: ReadonlyArray<{ readonly path: string; readonly windingRule: string }>
  readonly blendMode?: string
  readonly characterStyleOverrides?: ReadonlyArray<number>
  readonly styleOverrideTable?: Record<string, Record<string, unknown>>
  readonly strokeAlign?: string
  readonly cornerRadius?: number
  readonly layoutMode?: string
  readonly layoutSizingHorizontal?: string
  readonly layoutSizingVertical?: string
  readonly layoutPositioning?: string
  readonly layoutAlign?: string
  readonly primaryAxisAlignItems?: string
  readonly counterAxisAlignItems?: string
  readonly counterAxisAlignContent?: string
  readonly primaryAxisSizingMode?: string
  readonly counterAxisSizingMode?: string
  readonly counterAxisSpacing?: number
  readonly layoutWrap?: string
  readonly clipsContent?: boolean
  readonly overflowDirection?: string
  readonly itemSpacing?: number
  readonly paddingTop?: number
  readonly paddingRight?: number
  readonly paddingBottom?: number
  readonly paddingLeft?: number
  readonly constraints?: { readonly horizontal: string; readonly vertical: string }
  readonly componentId?: string
  readonly absoluteBoundingBox?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly children?: ReadonlyArray<RawNodeSpec>
}

/** Shorthand: a frame at a position. */
export const frame = (
  id: string,
  name: string,
  box: { x: number; y: number; width: number; height: number },
  over: Partial<RawNodeSpec> = {},
): RawNodeSpec => ({ id, type: 'FRAME', name, absoluteBoundingBox: box, ...over })

/** Shorthand: a text node. */
export const text = (id: string, name: string, characters: string, over: Partial<RawNodeSpec> = {}): RawNodeSpec => ({
  id,
  type: 'TEXT',
  name,
  characters,
  style: { fontFamily: 'Example Sans', fontWeight: 500, fontSize: 16, ...(over.style ?? {}) },
  ...over,
})

export interface StyleEntrySpec {
  readonly name: string
  readonly styleType?: string
}

const decodeNodes = Schema.decodeUnknownSync(NodesResponseSchema)

/**
 * Assembles a nodes response the way the API returns one: each requested root
 * carries its document and the styles referenced beneath it.
 *
 * The result is decoded through the same transport schema the real client
 * uses. A builder that bypassed it could hand a test an input the pipeline
 * would never see — `document: null`, a style without a key — and the test
 * would then be exercising a situation that cannot occur. Tests that *want*
 * a malformed response construct it by hand, deliberately.
 */
export const nodesResponse = (
  roots: ReadonlyArray<RawNodeSpec>,
  styles: Record<string, StyleEntrySpec> = {},
): NodesResponse => {
  const styleMap = Object.fromEntries(
    Object.entries(styles).map(([id, spec]) => [
      id,
      { key: `key-${id}`, name: spec.name, styleType: spec.styleType ?? 'TEXT', remote: false },
    ]),
  )
  return decodeNodes({
    nodes: Object.fromEntries(roots.map((root) => [root.id, { document: root, styles: styleMap }])),
  })
}

/** The whole fixture a test hands to the replay client. */
export const design = (
  roots: ReadonlyArray<RawNodeSpec>,
  styles: Record<string, StyleEntrySpec> = {},
  version: string = SYNTHETIC_VERSION,
): FixtureData => ({ meta: syntheticMeta(version), nodes: nodesResponse(roots, styles) })

/**
 * A page whose paint order disagrees with its reading order (REG-ORDER-002).
 *
 * The children are listed footer-first: exactly the shape that broke consumers
 * which trusted the array. Reading order by geometry is header, body, footer.
 */
export const pageWithShuffledZOrder = (idPrefix = '1'): RawNodeSpec =>
  frame(`${idPrefix}:1`, 'page_375', { x: 0, y: 0, width: 375, height: 900 }, {
    children: [
      frame(`${idPrefix}:4`, 'footer', { x: 0, y: 700, width: 375, height: 200 }),
      frame(`${idPrefix}:2`, 'header', { x: 0, y: 0, width: 375, height: 100 }),
      frame(`${idPrefix}:3`, 'body', { x: 0, y: 100, width: 375, height: 600 }),
    ],
  })

/**
 * Breakpoint variants where most containers carry editor-generated names that
 * differ per variant (REG-RESP-003). Only the designer-named paths correspond.
 */
export const variantsWithAutoNames = (): ReadonlyArray<RawNodeSpec> => [
  frame('1:1', 'nav_375', { x: 0, y: 0, width: 375, height: 200 }, {
    children: [
      frame('1:2', 'Frame 101', { x: 0, y: 0, width: 375, height: 100 }, {
        children: [text('1:3', 'label', 'Menu')],
      }),
      frame('1:4', 'logo', { x: 0, y: 100, width: 100, height: 50 }),
    ],
  }),
  frame('2:1', 'nav_1440', { x: 0, y: 0, width: 1440, height: 200 }, {
    children: [
      frame('2:2', 'Frame 205', { x: 0, y: 0, width: 1440, height: 100 }, {
        children: [text('2:3', 'label', 'Menu')],
      }),
      frame('2:4', 'logo', { x: 0, y: 100, width: 140, height: 60 }),
    ],
  }),
]

/**
 * A rotation whose string form is exponential (REG-ROUND-001).
 *
 * Designers produce these by nudging an element back to straight; nobody
 * writing "a rotation" by hand imagines one.
 */
export const DENORMAL_ROTATION = 2.1527280150485926e-16

/**
 * A page with enough nodes that its slice exceeds a pipe buffer
 * (REG-CLI-008: the CLI once truncated its own stdout at 65,536 bytes).
 * Size is the point here, so the content is mechanical.
 */
export const largePage = (sections = 40, itemsPerSection = 10): RawNodeSpec => ({
  id: '1:1',
  type: 'FRAME',
  name: 'page_375',
  absoluteBoundingBox: { x: 0, y: 0, width: 375, height: sections * 200 },
  children: Array.from({ length: sections }, (_unused, s) => ({
    id: `1:${100 + s}`,
    type: 'FRAME',
    name: `section-${s}`,
    absoluteBoundingBox: { x: 0, y: s * 200, width: 375, height: 200 },
    children: Array.from({ length: itemsPerSection }, (_u, i) => ({
      id: `1:${1000 + s * 100 + i}`,
      type: 'TEXT',
      name: `item-${s}-${i}`,
      characters: `Sample copy for section ${s}, item ${i}. `.repeat(3),
      style: { fontFamily: 'Example Sans', fontWeight: 400, fontSize: 14 },
      absoluteBoundingBox: { x: 0, y: s * 200 + i * 18, width: 375, height: 18 },
    })),
  })),
})
