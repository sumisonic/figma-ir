import { describe, expect, it } from 'vitest'

import { unsafeUnwrap, type Untrusted } from '../text/untrusted.js'
import { DENORMAL_ROTATION, design, frame, pageWithShuffledZOrder, text, type RawNodeSpec } from '../testing/builders.js'
import { fileKey } from '../figma/client.js'
import { fixtureClient, type FixtureData } from '../figma/fixtureClient.js'
import { acquireSnapshot } from '../figma/snapshot.js'
import { fromSnapshot, indexBySourceId, walkNodes } from './adapter.js'

const KEY = fileKey('SYNTHETICFILEKEY0001')
const now = () => '2026-01-01T00:00:00.000Z'

const docFrom = async (data: FixtureData, roots?: ReadonlyArray<string>) =>
  fromSnapshot(
    await acquireSnapshot({
      client: fixtureClient(data),
      fileKey: KEY,
      roots: roots ?? Object.keys(data.nodes.nodes),
      now,
    }),
  )

const single = async (root: RawNodeSpec, styles: Parameters<typeof design>[1] = {}) =>
  docFrom(design([root], styles))

describe('fromSnapshot — structure', () => {
  it('converts a tree and keeps every node addressable', async () => {
    const doc = await docFrom(design([pageWithShuffledZOrder()]))
    const nodes = [...walkNodes(doc)]
    expect(nodes).toHaveLength(4)
    expect(indexBySourceId(doc).size).toBe(nodes.length)
    expect(doc.rejections).toEqual([])
  })

  it('keeps instance-child ids intact', async () => {
    const doc = await single(
      frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, {
        children: [{ id: 'I1:2;3:4', type: 'TEXT', name: 'inside', characters: 'x' }],
      }),
    )
    const child = [...walkNodes(doc)].find((node) => (node.sourceId as string).startsWith('I'))
    expect(child?.sourceId as string).toBe('I1:2;3:4')
  })
})

describe('fromSnapshot — geometry', () => {
  it('rounds away float noise so two fetches of one design agree', async () => {
    const doc = await single(
      frame('1:1', 'root', { x: 744.0001220703125, y: -370.0000074, width: 375.0000074168711, height: 800 }),
    )
    expect(doc.roots[0]?.geometry).toEqual({ x: 744, y: -370, width: 375, height: 800 })
  })

  it('survives a rotation whose text form is exponential (REG-ROUND-001)', async () => {
    // Designers produce these by nudging an element back to straight; the
    // string form is "2.15...e-16" and naive exponent-appending breaks on it.
    const doc = await single(
      frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, { rotation: DENORMAL_ROTATION }),
    )
    expect(doc.roots[0]?.rotation).toBe(0)
  })
})

describe('fromSnapshot — text is data', () => {
  it('captures characters verbatim, including trailing space', async () => {
    // The trailing space is part of what the designer typed and is not ours
    // to tidy up.
    const doc = await single(
      frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, {
        children: [text('1:2', 'label', 'MENU ')],
      }),
    )
    const node = [...walkNodes(doc)].find((entry) => entry.text !== undefined)
    expect(unsafeUnwrap(node?.text?.characters as Untrusted)).toBe('MENU ')
  })

  it('records the type style needed for a styleKey mapping', async () => {
    const doc = await single(
      frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, {
        children: [
          text('1:2', 'label', 'x', {
            style: { fontFamily: 'Example Sans', fontWeight: 900, fontSize: 30, letterSpacing: 1.8 },
          }),
        ],
      }),
    )
    const node = [...walkNodes(doc)].find((entry) => entry.text !== undefined)
    expect(node?.text?.style.fontSize).toBe(30)
    expect(unsafeUnwrap(node?.text?.style.fontFamily as Untrusted)).toBe('Example Sans')
  })

  it('keeps leadingTrim, which changes the rendered text box height', async () => {
    // A real page trimmed to cap height: fontSize 20, lineHeight 35, but a
    // 15px-tall box. Dropping the field left a 7px systematic offset in a
    // faithful-looking render with nothing in the IR to explain it.
    const doc = await single(
      frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, {
        children: [
          text('1:2', 'label', 'x', {
            style: {
              fontFamily: 'Example Sans',
              fontSize: 20,
              lineHeightPx: 35,
              leadingTrim: 'CAP_HEIGHT',
              opentypeFlags: { PALT: 1 },
            },
          }),
        ],
      }),
    )
    const node = [...walkNodes(doc)].find((entry) => entry.text !== undefined)
    expect(node?.text?.style.leadingTrim).toBe('CAP_HEIGHT')
    // Proportional alternates change advance widths, hence line breaks: a
    // pilot rediscovered a declared palt by measuring the render.
    expect(node?.text?.style.opentypeFlags).toEqual({ PALT: 1 })
  })

  it('scans text without deciding anything', async () => {
    const doc = await single(
      frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, {
        children: [text('1:2', 'label', 'ordinary body copy')],
      }),
    )
    const node = [...walkNodes(doc)].find((entry) => entry.text !== undefined)
    expect(node?.text?.scan.suspectedInjection).toBe(false)
  })
})

describe('fromSnapshot — style slots', () => {
  const withFill = (styles?: Record<string, string>, fills?: ReadonlyArray<Record<string, unknown>>) =>
    frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, {
      ...(styles === undefined ? {} : { styles }),
      fills: fills ?? [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }],
    })

  it('prefers the style reference over the resolved colour', async () => {
    const doc = await single(withFill({ fill: '9:1' }), { '9:1': { name: 'brand/primary', styleType: 'FILL' } })
    const fill = doc.roots[0]?.fills[0]
    expect(fill?.kind).toBe('token')
    expect(unsafeUnwrap((fill as { name: Untrusted }).name)).toBe('brand/primary')
  })

  it('emits raw paint where no style is referenced', async () => {
    const doc = await single(withFill())
    expect(doc.roots[0]?.fills[0]?.kind).toBe('raw')
  })

  it('marks a dangling style reference unresolved rather than falling back to the colour', async () => {
    // Hard-coding a value where a broken token was is how a design system
    // quietly stops being one.
    const doc = await single(withFill({ fill: '9:9' }))
    const fill = doc.roots[0]?.fills[0]
    expect(fill?.kind).toBe('unresolved')
    expect((fill as { reason: string }).reason).toBe('NO_TOKEN_MAPPING')
  })
})

describe('text styles are the point', () => {
  it('keeps the four-level style name a styleKey mapping needs', async () => {
    const doc = await single(
      frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, {
        children: [text('1:2', 'label', 'x', { styles: { text: '9:1' } })],
      }),
      { '9:1': { name: 'main/title/sm/all' } },
    )
    const node = [...walkNodes(doc)].find((entry) => entry.text !== undefined)
    expect(node?.text?.styleRef?.kind).toBe('token')
    expect(unsafeUnwrap((node?.text?.styleRef as { name: Untrusted }).name)).toBe('main/title/sm/all')
  })

  it('marks a dangling text style unresolved rather than treating it as unstyled', async () => {
    const doc = await single(
      frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, {
        children: [text('1:2', 'label', 'x', { styles: { text: '9:9' } })],
      }),
    )
    const node = [...walkNodes(doc)].find((entry) => entry.text !== undefined)
    expect(node?.text?.styleRef).toEqual({ kind: 'unresolved', styleId: '9:9', reason: 'NO_TOKEN_MAPPING' })
  })
})

describe('visibility is recorded twice on purpose', () => {
  const tree = (childVisible: boolean) =>
    frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, {
      visible: false,
      children: [text('1:2', 'copy', 'x', { visible: childVisible })],
    })

  it("keeps the node's own declaration alongside the resolved value", async () => {
    const doc = await single(tree(true))
    const child = doc.roots[0]?.children[0]
    expect(child?.selfVisible).toBe(true)
    expect(child?.effectiveVisible).toBe(false)
  })

  it('notices a designer hiding a node under an already-hidden ancestor', async () => {
    // With only effectiveVisible, both trees resolve to false everywhere and
    // the change is invisible to every hash in the system.
    const shown = await single(tree(true))
    const hidden = await single(tree(false))
    expect(hidden.canonicalHash).not.toBe(shown.canonicalHash)
  })
})

describe('unsupported nodes leave a trace', () => {
  const withChild = (childType: string) =>
    frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, {
      children: [{ id: '1:2', type: childType, name: 'child' }],
    })

  it('records a rejection instead of dropping the branch', async () => {
    const doc = await single(withChild('SLICE'))
    expect(doc.rejections).toHaveLength(1)
    expect(doc.rejections[0]?.reason).toBe('UNSUPPORTED_NODE_TYPE')
    expect(doc.roots[0]?.children).toHaveLength(0)
  })

  it('tells a person who handed in a section as a root where the roots are (REG-DISC-018)', async () => {
    const asRoot = await single({ id: '1:1', type: 'SECTION', name: 'group' })
    expect(asRoot.roots).toEqual([])
    expect(asRoot.rejections[0]?.reason).toBe('UNSUPPORTED_NODE_TYPE')
    expect(asRoot.rejections[0]?.detail).toContain('list-frames')
    // Deeper in a tree, a section is not one list-frames reaches; the plain
    // statement stands, as it does for every other unsupported type.
    const asChild = await single(withChild('SECTION'))
    expect(asChild.rejections[0]?.detail).not.toContain('list-frames')
    const other = await single(withChild('SLICE'))
    expect(other.rejections[0]?.detail).not.toContain('list-frames')
  })

  it('distinguishes a branch with a rejected child from one with no child at all', async () => {
    // Otherwise "equal subtree hash means nothing to regenerate" becomes
    // advice to skip a branch we know is incomplete.
    const rejected = await single(withChild('SLICE'))
    const empty = await single(frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, { children: [] }))
    expect(rejected.roots[0]?.subtreeHash).not.toBe(empty.roots[0]?.subtreeHash)
  })
})

describe('paint is recorded, not composed', () => {
  const gradient = (handles: ReadonlyArray<{ x: number; y: number }>) =>
    frame('1:1', 'bg', { x: 0, y: 0, width: 100, height: 100 }, {
      fills: [
        {
          type: 'GRADIENT_LINEAR',
          gradientStops: [
            { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
            { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
          ],
          gradientHandlePositions: handles,
        },
      ],
    })

  it('distinguishes gradients that differ only in direction', async () => {
    const down = await single(gradient([{ x: 0, y: 0 }, { x: 0, y: 1 }]))
    const across = await single(gradient([{ x: 0, y: 0 }, { x: 1, y: 0 }]))
    expect(across.canonicalHash).not.toBe(down.canonicalHash)
  })

  it('keeps paint opacity separate from the colour alpha', async () => {
    const doc = await single(
      frame('1:1', 'bg', { x: 0, y: 0, width: 100, height: 100 }, {
        fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 0.5 }, opacity: 0.5 }],
      }),
    )
    const paint = (doc.roots[0]?.fills[0] as { value: { rgba: readonly number[]; opacity: number } }).value
    // 0.25 would be the product; recording it would destroy the distinction
    // between a translucent colour and a faded paint.
    expect(paint.rgba[3]).toBe(0.5)
    expect(paint.opacity).toBe(0.5)
  })

  it('keeps a hidden paint rather than silently discarding it', async () => {
    const doc = await single(
      frame('1:1', 'bg', { x: 0, y: 0, width: 100, height: 100 }, {
        fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, visible: false }],
      }),
    )
    expect((doc.roots[0]?.fills[0] as { value: { visible: boolean } }).value.visible).toBe(false)
  })
})

describe('border and corner facts survive', () => {
  it('keeps the weight a border needs', async () => {
    const doc = await single(
      frame('1:1', 'line', { x: 0, y: 0, width: 100, height: 100 }, {
        strokeWeight: 2,
        strokeAlign: 'INSIDE',
        cornerRadius: 4,
        strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }],
      }),
    )
    const node = doc.roots[0]
    expect(node?.strokeWeight).toBe(2)
    expect(node?.strokeAlign).toBe('INSIDE')
    expect(node?.cornerRadius).toBe(4)
  })
})

describe('per-side strokes and per-range text overrides survive (REG-CANON-013)', () => {
  it('keeps individual stroke weights as declared, beside the single weight, with no expansion either way', async () => {
    const doc = await single(
      frame('1:1', 'cta', { x: 0, y: 0, width: 100, height: 40 }, {
        strokeWeight: 1,
        individualStrokeWeights: { top: 0, right: 0, bottom: 1.004, left: 0 },
        strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }],
      }),
    )
    const node = doc.roots[0]
    expect(node?.strokeWeight).toBe(1)
    expect(node?.individualStrokeWeights).toEqual({ top: 0, right: 0, bottom: 1, left: 0 })
    const uniform = await single(
      frame('1:1', 'cta', { x: 0, y: 0, width: 100, height: 40 }, {
        strokeWeight: 1,
        strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }],
      }),
    )
    // "one number" and "four numbers" are different facts, so different hashes.
    expect(uniform.roots[0]?.individualStrokeWeights).toBeUndefined()
    expect(uniform.roots[0]?.contentHash).not.toBe(node?.contentHash)
  })

  it('drops a per-side record missing a side rather than filling it in', async () => {
    const doc = await single(
      frame('1:1', 'cta', { x: 0, y: 0, width: 100, height: 40 }, {
        individualStrokeWeights: { top: 0, right: 0, bottom: 1 } as never,
      }),
    )
    expect(doc.roots[0]?.individualStrokeWeights).toBeUndefined()
  })

  it('records the base decoration, defaulting to NONE as documented, and fails closed on a value outside the set', async () => {
    const styled = (over: Record<string, unknown>) =>
      single(
        frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, {
          children: [text('1:2', 'label', 'Read more', { style: over })],
        }),
      )
    const textOf = (doc: Awaited<ReturnType<typeof styled>>) =>
      [...walkNodes(doc)].find((entry) => entry.text !== undefined)?.text
    expect(textOf(await styled({}))?.style.textDecoration).toBe('NONE')
    expect(textOf(await styled({ textDecoration: 'UNDERLINE' }))?.style.textDecoration).toBe('UNDERLINE')
    expect(textOf(await styled({ textDecoration: 'WAVY' }))?.style.textDecoration).toBe('unknown')
  })

  it('turns the override array into maximal runs, in array order, saying only what each entry says', async () => {
    const doc = await single(
      frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, {
        children: [
          text('1:2', 'label', 'Read more here', {
            // Trailing zeros are dropped by the source: the array is shorter
            // than the string, and the characters beyond it are base-styled.
            characterStyleOverrides: [0, 1, 1, 2, 0, 3, 3],
            styleOverrideTable: {
              // Listed out of order on purpose: the array is the only order.
              '3': { textDecoration: 'STRIKETHROUGH' },
              '1': { textDecoration: 'UNDERLINE' },
              '2': { fontWeight: 700 },
            },
          }),
        ],
      }),
    )
    const facts = [...walkNodes(doc)].find((entry) => entry.text !== undefined)?.text
    expect(facts?.hasCharacterOverrides).toBe(true)
    expect(facts?.characterOverrideRuns).toEqual([
      { start: 1, end: 3, overrideId: 1, textDecoration: 'UNDERLINE' },
      // The entry exists and says nothing about decoration: unstated, not inherited.
      { start: 3, end: 4, overrideId: 2, textDecoration: 'unstated' },
      { start: 5, end: 7, overrideId: 3, textDecoration: 'STRIKETHROUGH' },
    ])
  })

  it('reports an id the table does not define as unknown, never as the base style', async () => {
    const doc = await single(
      frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, {
        children: [text('1:2', 'label', 'ab', { characterStyleOverrides: [0, 7], styleOverrideTable: {} })],
      }),
    )
    const facts = [...walkNodes(doc)].find((entry) => entry.text !== undefined)?.text
    expect(facts?.characterOverrideRuns).toEqual([{ start: 1, end: 2, overrideId: 7, textDecoration: 'unknown' }])
  })

  it('keeps a malformed override reference as a run, never as the base style', async () => {
    const doc = await single(
      frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, {
        children: [
          text('1:2', 'label', 'abcd', {
            characterStyleOverrides: [-1, 1.5, 'x', 0] as never,
            styleOverrideTable: { '1': { textDecoration: 'UNDERLINE' } },
          }),
        ],
      }),
    )
    const facts = [...walkNodes(doc)].find((entry) => entry.text !== undefined)?.text
    // Each is "styled somehow, by a reference the table cannot answer":
    // unknown, with the reference kept as written (or absent when it was not a number).
    expect(facts?.characterOverrideRuns).toEqual([
      { start: 0, end: 1, overrideId: -1, textDecoration: 'unknown' },
      { start: 1, end: 2, overrideId: 1.5, textDecoration: 'unknown' },
      { start: 2, end: 3, overrideId: undefined, textDecoration: 'unknown' },
    ])
    expect(facts?.hasCharacterOverrides).toBe(true)
  })

  it('yields no runs for an empty array or one that is all zeros', async () => {
    for (const overrides of [[], [0, 0, 0]]) {
      const doc = await single(
        frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, {
          children: [text('1:2', 'label', 'abc', { characterStyleOverrides: overrides, styleOverrideTable: {} })],
        }),
      )
      const facts = [...walkNodes(doc)].find((entry) => entry.text !== undefined)?.text
      expect(facts?.characterOverrideRuns).toEqual([])
      expect(facts?.hasCharacterOverrides).toBe(false)
    }
  })

  it('orders opentype flags by key, so the same flags are the same object whatever the source listed first', async () => {
    const label = (flags: Record<string, number>) =>
      single(
        frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, {
          children: [text('1:2', 'label', 'ab', { style: { opentypeFlags: flags } })],
        }),
      )
    const first = [...walkNodes(await label({ PALT: 1, KERN: 0 }))].find((entry) => entry.text !== undefined)?.text
    const second = [...walkNodes(await label({ KERN: 0, PALT: 1 }))].find((entry) => entry.text !== undefined)?.text
    expect(Object.keys(first?.style.opentypeFlags ?? {})).toEqual(['KERN', 'PALT'])
    // Not only equal as values: the same bytes under a plain JSON.stringify.
    expect(JSON.stringify(first?.style.opentypeFlags)).toBe(JSON.stringify(second?.style.opentypeFlags))
  })

  it('hashes the runs: an underline on one word is a different design', async () => {
    const label = (overrides: ReadonlyArray<number>) =>
      single(
        frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, {
          children: [
            text('1:2', 'label', 'ab', {
              characterStyleOverrides: overrides,
              styleOverrideTable: { '1': { textDecoration: 'UNDERLINE' } },
            }),
          ],
        }),
      )
    expect((await label([0, 1])).canonicalHash).not.toBe((await label([1, 1])).canonicalHash)
  })
})

describe('layout is recorded verbatim', () => {
  it('keeps Figma vocabulary rather than translating it here', async () => {
    const doc = await single(
      frame('1:1', 'stack', { x: 0, y: 0, width: 100, height: 100 }, {
        layoutMode: 'VERTICAL',
        layoutSizingHorizontal: 'FIXED',
        layoutSizingVertical: 'HUG',
        paddingTop: 40,
      }),
    )
    expect(doc.roots[0]?.layout.mode).toBe('VERTICAL')
    expect(doc.roots[0]?.layout.sizingVertical).toBe('HUG')
    expect(doc.roots[0]?.layout.padding.top).toBe(40)
  })

  it('says "unstated" when Figma declared no positioning', async () => {
    // The presence of layoutAlign is not a declaration that the node flows;
    // inferring one would be translation, and that belongs to the next layer.
    const doc = await single(
      frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, { layoutAlign: 'STRETCH' }),
    )
    expect(doc.roots[0]?.layout.positioning).toBe('unstated')
    expect(doc.roots[0]?.layout.layoutAlign).toBe('STRETCH')
  })

  it('says UNSPECIFIED for sizing outside auto-layout instead of guessing FIXED', async () => {
    const doc = await single(frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }))
    expect(doc.roots[0]?.layout.sizingHorizontal).toBe('UNSPECIFIED')
  })

  it('marks an unrecognised axis alignment as unknown instead of passing it off as a known one (REG-CANON-010)', async () => {
    // The projection layer branches on these values. A future API value cast
    // into the closed union would silently take the wrong branch; `unknown`
    // makes it fail closed instead.
    const doc = await single(
      frame('1:1', 'stack', { x: 0, y: 0, width: 100, height: 100 }, {
        layoutMode: 'HORIZONTAL',
        primaryAxisAlignItems: 'SPACE_EVENLY',
        counterAxisAlignItems: 'STRETCH',
      }),
    )
    expect(doc.roots[0]?.layout.primaryAxisAlign).toBe('unknown')
    expect(doc.roots[0]?.layout.counterAxisAlign).toBe('unknown')
  })

  it('validates the remaining layout enums the projection branches on (REG-CANON-010)', async () => {
    const doc = await single(
      frame('1:1', 'stack', { x: 0, y: 0, width: 100, height: 100 }, {
        layoutMode: 'HORIZONTAL',
        counterAxisAlignContent: 'SPACE_BETWEEN',
        primaryAxisSizingMode: 'AUTO',
        counterAxisSizingMode: 'MYSTERY',
      }),
    )
    expect(doc.roots[0]?.layout.counterAxisAlignContent).toBe('SPACE_BETWEEN')
    expect(doc.roots[0]?.layout.primaryAxisSizingMode).toBe('AUTO')
    expect(doc.roots[0]?.layout.counterAxisSizingMode).toBe('unknown')

    const bare = await single(frame('2:1', 'bare', { x: 0, y: 0, width: 10, height: 10 }))
    // Absence stays absence: these have no documented default worth inventing.
    expect(bare.roots[0]?.layout.counterAxisAlignContent).toBeUndefined()
    expect(bare.roots[0]?.layout.primaryAxisSizingMode).toBeUndefined()
  })

  it('keeps the declared axis alignments and defaults absence to MIN', async () => {
    const doc = await single(
      frame('1:1', 'stack', { x: 0, y: 0, width: 100, height: 100 }, {
        layoutMode: 'HORIZONTAL',
        primaryAxisAlignItems: 'SPACE_BETWEEN',
        counterAxisAlignItems: 'BASELINE',
      }),
    )
    expect(doc.roots[0]?.layout.primaryAxisAlign).toBe('SPACE_BETWEEN')
    expect(doc.roots[0]?.layout.counterAxisAlign).toBe('BASELINE')

    const bare = await single(frame('2:1', 'bare', { x: 0, y: 0, width: 10, height: 10 }))
    expect(bare.roots[0]?.layout.primaryAxisAlign).toBe('MIN')
  })

  it('keeps constraints for nodes outside auto-layout', async () => {
    const doc = await single(
      frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, {
        constraints: { horizontal: 'LEFT_RIGHT', vertical: 'TOP' },
      }),
    )
    expect(doc.roots[0]?.layout.constraints).toEqual({ horizontal: 'LEFT_RIGHT', vertical: 'TOP' })
  })
})

describe('vector paths are a request, not a default (REG-ACQ-015)', () => {
  const ICON = frame('1:1', 'root', { x: 0, y: 0, width: 100, height: 100 }, {
    children: [
      frame('1:2', 'glyph', { x: 0, y: 0, width: 24, height: 24 }, {
        type: 'VECTOR',
        fillGeometry: [{ path: 'M0 0h24v24H0z', windingRule: 'NONZERO' }],
        strokeGeometry: [],
      }),
      text('1:3', 'label', 'Go', { fillGeometry: [{ path: 'M1 1', windingRule: 'NONZERO' }] }),
    ],
  })
  const withMode = async (geometry: 'none' | 'paths') =>
    fromSnapshot(
      await acquireSnapshot({ client: fixtureClient(design([ICON], {})), fileKey: KEY, roots: ['1:1'], now, geometry }),
    )
  const nodeOf = (doc: Awaited<ReturnType<typeof withMode>>, id: string) =>
    [...walkNodes(doc)].find((node) => (node.sourceId as string) === id)

  it('reads as unknown, never as empty, when the acquisition did not ask', async () => {
    const doc = await withMode('none')
    expect(doc.provenance.geometry).toBe('none')
    expect(nodeOf(doc, '1:2')?.vectorGeometry).toEqual({ kind: 'unknown', reason: 'GEOMETRY_NOT_ACQUIRED' })
    // The fixture behaves like the API: nothing to read even if the design had it.
    expect(nodeOf(doc, '1:1')?.vectorGeometry).toEqual({ kind: 'unknown', reason: 'GEOMETRY_NOT_ACQUIRED' })
  })

  it('carries the paths and an exact-match hash when asked, and stays absent on text', async () => {
    const doc = await withMode('paths')
    expect(doc.provenance.geometry).toBe('paths')
    const glyph = nodeOf(doc, '1:2')?.vectorGeometry
    expect(glyph?.kind).toBe('known')
    if (glyph?.kind === 'known') {
      expect(glyph.fill).toEqual([{ path: 'M0 0h24v24H0z', windingRule: 'NONZERO' }])
      expect(glyph.stroke).toEqual([])
      expect(glyph.geometryHash).toMatch(/^geometry:v1:sha256:/)
    }
    // A frame with no paths in the response draws nothing: known and empty.
    expect(nodeOf(doc, '1:1')?.vectorGeometry).toMatchObject({ kind: 'known', fill: [], stroke: [] })
    // Text outlines are font output, not a drawing.
    expect(nodeOf(doc, '1:3')?.vectorGeometry).toEqual({ kind: 'absent' })
  })

  it('refuses to read a drawing in part: one entry it cannot read makes the whole shape unknown', async () => {
    const doc = fromSnapshot(
      await acquireSnapshot({
        client: fixtureClient(
          design(
            [
              frame('1:1', 'blob', { x: 0, y: 0, width: 24, height: 24 }, {
                type: 'VECTOR',
                fillGeometry: [{ path: 'M0 0h1', windingRule: 'NONZERO' }, { path: 'M1 1' }] as never,
              }),
            ],
            {},
          ),
        ),
        fileKey: KEY,
        roots: ['1:1'],
        now,
        geometry: 'paths',
      }),
    )
    expect(doc.roots[0]?.vectorGeometry).toEqual({ kind: 'unknown', reason: 'INCOMPLETE_EXECUTION' })
  })

  it('refuses a geometry mode the request cannot express', async () => {
    await expect(
      acquireSnapshot({ client: fixtureClient(design([ICON], {})), fileKey: KEY, roots: ['1:1'], now, geometry: 'all' as never }),
    ).rejects.toThrow(/geometry must be none or paths/)
  })

  it('changes the hash with the winding rule and with the order of the paths, not only with the path text', async () => {
    const drawing = (id: string, fill: ReadonlyArray<{ path: string; windingRule: string }>) =>
      frame(id, 'blob', { x: 0, y: 0, width: 24, height: 24 }, { type: 'VECTOR', fillGeometry: fill })
    const a = { path: 'M0 0h1', windingRule: 'NONZERO' }
    const b = { path: 'M0 0h2', windingRule: 'NONZERO' }
    const doc = fromSnapshot(
      await acquireSnapshot({
        client: fixtureClient(
          design([drawing('1:1', [a, b]), drawing('2:1', [b, a]), drawing('3:1', [{ ...a, windingRule: 'EVENODD' }, b])], {}),
        ),
        fileKey: KEY,
        roots: ['1:1', '2:1', '3:1'],
        now,
        geometry: 'paths',
      }),
    )
    const hashOf = (id: string) => {
      const geometry = nodeOf(doc, id)?.vectorGeometry
      return geometry?.kind === 'known' ? geometry.geometryHash : undefined
    }
    expect(hashOf('2:1')).not.toBe(hashOf('1:1'))
    expect(hashOf('3:1')).not.toBe(hashOf('1:1'))
  })

  it('gives the same hash to the same drawing at another size, and a different one to a different drawing', async () => {
    const drawing = (id: string, width: number, path: string) =>
      frame(id, 'blob', { x: 0, y: 0, width, height: width }, {
        type: 'VECTOR',
        fillGeometry: [{ path, windingRule: 'NONZERO' }],
      })
    const doc = fromSnapshot(
      await acquireSnapshot({
        client: fixtureClient(design([drawing('1:1', 24, 'M0 0h1'), drawing('2:1', 48, 'M0 0h1'), drawing('3:1', 24, 'M0 0h2')], {})),
        fileKey: KEY,
        roots: ['1:1', '2:1', '3:1'],
        now,
        geometry: 'paths',
      }),
    )
    const hashOf = (id: string) => {
      const geometry = nodeOf(doc, id)?.vectorGeometry
      return geometry?.kind === 'known' ? geometry.geometryHash : undefined
    }
    // Exact match on the path data: the box is not part of it, the path is.
    expect(hashOf('2:1')).toBe(hashOf('1:1'))
    expect(hashOf('3:1')).not.toBe(hashOf('1:1'))
    // The node itself is different, box included.
    expect(nodeOf(doc, '2:1')?.contentHash).not.toBe(nodeOf(doc, '1:1')?.contentHash)
  })
})

describe('schema versions rise together when the subset grows (REG-CANON-013)', () => {
  it('stamps the canonical version on the document hash and its provenance', async () => {
    const doc = await single(frame('1:1', 'root', { x: 0, y: 0, width: 10, height: 10 }))
    expect(doc.canonicalHash).toMatch(/^canonical:v3:sha256:/)
    expect(doc.provenance.schemaVersion).toBe(3)
  })
})

describe('canonicalHash covers the declared subset and nothing else', () => {
  it('ignores fields the document deliberately drops', async () => {
    const base = pageWithShuffledZOrder()
    const withExtras = {
      ...base,
      // A change to an interaction is not a change to the static design.
      interactions: [{ trigger: { type: 'ON_CLICK' } }],
      scrollBehavior: 'SCROLLS',
    } as RawNodeSpec
    expect((await single(withExtras)).canonicalHash).toBe((await single(base)).canonicalHash)
  })

  it('ignores acquisition time', async () => {
    const data = design([pageWithShuffledZOrder()])
    const early = fromSnapshot(
      await acquireSnapshot({ client: fixtureClient(data), fileKey: KEY, roots: ['1:1'], now }),
    )
    const late = fromSnapshot(
      await acquireSnapshot({
        client: fixtureClient(data),
        fileKey: KEY,
        roots: ['1:1'],
        now: () => '2027-06-06T06:06:06.000Z',
      }),
    )
    expect(late.canonicalHash).toBe(early.canonicalHash)
  })

  it('ignores a file version bump that did not touch the requested roots', async () => {
    // The file-wide version moves when any page changes, including pages we
    // never asked for. Letting it into the hash would make saving an unrelated
    // page look like a change to this design — the distinction between "the
    // design changed" and "the file was touched" is the point of this hash.
    const data = design([pageWithShuffledZOrder()])
    const moved = design([pageWithShuffledZOrder()], {}, '1000000000000000777')
    const original = fromSnapshot(
      await acquireSnapshot({ client: fixtureClient(data), fileKey: KEY, roots: ['1:1'], now }),
    )
    const bumped = fromSnapshot(
      await acquireSnapshot({ client: fixtureClient(moved), fileKey: KEY, roots: ['1:1'], now }),
    )
    expect(bumped.canonicalHash).toBe(original.canonicalHash)
    // The provenance still records which version each came from.
    expect(bumped.provenance.sourceVersion).not.toBe(original.provenance.sourceVersion)
  })

  it('changes when the design changes', async () => {
    const renamed = { ...pageWithShuffledZOrder(), name: 'renamed' } as RawNodeSpec
    expect((await single(renamed)).canonicalHash).not.toBe((await single(pageWithShuffledZOrder())).canonicalHash)
  })

  it('lets an unchanged branch be recognised by its subtree hash', async () => {
    const first = await single(pageWithShuffledZOrder())
    const second = await single(pageWithShuffledZOrder())
    expect(second.roots[0]?.subtreeHash).toBe(first.roots[0]?.subtreeHash)
  })
})
