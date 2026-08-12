import { describe, expect, it } from 'vitest'

import { design, frame, text, type RawNodeSpec, type StyleEntrySpec } from '../testing/builders.js'
import { fileKey, type FileKey } from '../figma/client.js'
import { fixtureClient } from '../figma/fixtureClient.js'
import { acquireSnapshot } from '../figma/snapshot.js'
import { fromSnapshot } from '../canonical/adapter.js'
import type { CanonicalDoc, CanonicalNode } from '../canonical/document.js'
import type { NodePath } from '../identity/nodeIdentity.js'
import { canonicalNodeOwnFields } from '../canonical/nodeOwnFields.js'
import { diffSnapshots } from './compare.js'
import { changedOwnFields, OWN_FIELD_ROWS, shownFieldsOf } from './present.js'
import { SNAPSHOT_DIFF_CATEGORIES, SnapshotDiffError, type SnapshotDiffErrorDetail } from './types.js'
import { decodeSnapshotDiffEnvelopeWire, snapshotDiffEnvelope } from './wire.js'

const KEY = fileKey('SYNTHETICFILEKEY0001')
const now = () => '2026-01-01T00:00:00.000Z'
const BEFORE_VERSION = '1000000000000000001'
const AFTER_VERSION = '1000000000000000002'

interface DocOptions {
  readonly version?: string
  readonly styles?: Record<string, StyleEntrySpec>
  readonly geometry?: 'paths'
  readonly key?: FileKey
}

const docOf = async (roots: ReadonlyArray<RawNodeSpec>, options: DocOptions = {}): Promise<CanonicalDoc> =>
  fromSnapshot(
    await acquireSnapshot({
      client: fixtureClient(design(roots, options.styles ?? {}, options.version ?? BEFORE_VERSION)),
      fileKey: options.key ?? KEY,
      roots: roots.map((root) => root.id),
      now,
      ...(options.geometry === undefined ? {} : { geometry: options.geometry }),
    }),
  )

type Wire = ReturnType<typeof decodeSnapshotDiffEnvelopeWire>
type RootWire = Wire['compared'][number]

const NODE_ARRAYS = [
  'changed',
  'movedWithinParent',
  'movedRoot',
  'movementUnknown',
  'descendantsChanged',
  'added',
  'removed',
  'enteredScope',
  'leftScope',
  'unobserved',
] as const

const ascending = (ids: ReadonlyArray<string>): boolean => ids.every((id, index) => index === 0 || ids[index - 1]! < id)

/**
 * What must hold for every result, whatever was compared: the counts add up,
 * each count equals the list beside it, and every list is in id order. Run
 * on every case below, so a scenario that breaks the arithmetic is caught
 * even when the scenario's own assertions are about something else.
 */
const expectInvariants = (wire: Wire): void => {
  const numeric = (counts: RootWire['counts']) => {
    const moved = counts.movedWithinParent + counts.movedWithParent + counts.movedRoot + counts.movementUnknown
    return counts.identical + counts.descendantsChanged + moved + counts.changed
  }
  for (const root of wire.compared) {
    const c = root.counts
    expect(c.nodesAfter, `${root.rootId} after`).toBe(
      numeric(c) + c.added + c.enteredScope + c.unobservedAfter + c.becameRepresentable,
    )
    expect(c.nodesBefore, `${root.rootId} before`).toBe(
      numeric(c) - c.arrived + c.departed + c.removed + c.leftScope + c.unobservedBefore + c.becameUnrepresentable,
    )
    expect(c.changed).toBe(root.changed.length)
    expect(c.movedWithinParent).toBe(root.movedWithinParent.length)
    expect(c.movedWithParent).toBe(root.movedWithParent.reduce((sum, group) => sum + group.sourceIds.length, 0))
    expect(c.movedRoot).toBe(root.movedRoot.length)
    expect(c.movementUnknown).toBe(root.movementUnknown.length)
    expect(c.descendantsChanged).toBe(root.descendantsChanged.length)
    expect(c.added).toBe(root.added.length)
    expect(c.removed).toBe(root.removed.length)
    expect(c.enteredScope).toBe(root.enteredScope.length)
    expect(c.leftScope).toBe(root.leftScope.length)
    expect(c.unobservedBefore).toBe(root.unobserved.filter((entry) => entry.side === 'before').length)
    expect(c.unobservedAfter).toBe(root.unobserved.filter((entry) => entry.side === 'after').length)
    expect(c.arrived).toBe(root.arrived.length)
    expect(c.departed).toBe(root.departed.length)
    for (const category of SNAPSHOT_DIFF_CATEGORIES) {
      expect(c.byCategory[category]).toBe(root.changed.filter((node) => node.categories.includes(category)).length)
    }
    for (const name of NODE_ARRAYS) {
      expect(ascending(root[name].map((entry) => entry.sourceId)), `${root.rootId}.${name} order`).toBe(true)
    }
    expect(ascending(root.arrived.map((entry) => entry.sourceId))).toBe(true)
    expect(ascending(root.departed.map((entry) => entry.sourceId))).toBe(true)
    expect(ascending(root.movedWithParent.map((group) => group.parentId))).toBe(true)
    for (const group of root.movedWithParent) expect(ascending(group.sourceIds)).toBe(true)
  }
  expect(ascending(wire.compared.map((root) => root.rootId))).toBe(true)
  expect(ascending(wire.rejections.map((entry) => entry.sourceId))).toBe(true)
  const sum = (pick: (counts: RootWire['counts']) => number): number =>
    wire.compared.reduce((total, root) => total + pick(root.counts), 0)
  expect(wire.total.nodesBefore).toBe(sum((c) => c.nodesBefore))
  expect(wire.total.nodesAfter).toBe(sum((c) => c.nodesAfter))
  expect(wire.total.identical).toBe(sum((c) => c.identical))
  expect(wire.total.changed).toBe(sum((c) => c.changed))
  expect(wire.total.arrived).toBe(wire.total.departed)
}

/** Diffs two documents and returns what a consumer would decode from the CLI's bytes. */
const wireOf = (before: CanonicalDoc, after: CanonicalDoc): Wire => {
  const diff = diffSnapshots(before, after)
  // Through real JSON, so an `undefined` that slipped into the payload
  // disappears here and fails the decode, as it would for a consumer.
  const wire = decodeSnapshotDiffEnvelopeWire(JSON.parse(JSON.stringify(snapshotDiffEnvelope(diff))))
  expectInvariants(wire)
  return wire
}

const compare = async (
  before: ReadonlyArray<RawNodeSpec>,
  after: ReadonlyArray<RawNodeSpec>,
  options: DocOptions = {},
): Promise<Wire> =>
  wireOf(await docOf(before, options), await docOf(after, { ...options, version: AFTER_VERSION }))

const rootOf = (wire: Wire, rootId: string): RootWire => {
  const root = wire.compared.find((entry) => entry.rootId === rootId)
  if (root === undefined) throw new Error(`no compared root ${rootId}`)
  return root
}

const ids = (entries: ReadonlyArray<{ readonly sourceId: string }>): string[] => entries.map((entry) => entry.sourceId)

const changedNode = (root: RootWire, sourceId: string): RootWire['changed'][number] => {
  const node = root.changed.find((entry) => entry.sourceId === sourceId)
  if (node === undefined) throw new Error(`${sourceId} is not in changed`)
  return node
}

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })

const detailOf = (run: () => unknown): SnapshotDiffErrorDetail => {
  try {
    run()
  } catch (error) {
    if (error instanceof SnapshotDiffError) return error.detail
    throw error
  }
  throw new Error('expected a SnapshotDiffError')
}

/** A page whose header pushes everything below it: the shape the comparison exists for. */
const stackedPage = (headerHeight: number): RawNodeSpec => {
  const pushed = headerHeight - 100
  return frame('1:1', 'page', box(0, 0, 400, 300 + pushed), {
    children: [
      frame('1:2', 'header', box(0, 0, 400, headerHeight)),
      frame('1:3', 'body', box(0, 100 + pushed, 400, 200), {
        children: [
          frame('1:4', 'card', box(10, 110 + pushed, 100, 50), {
            children: [text('1:5', 'label', 'Hello', { absoluteBoundingBox: box(20, 120 + pushed, 50, 20) })],
          }),
        ],
      }),
    ],
  })
}

describe('comparing a design with itself', () => {
  it('finds nothing, and says so the same way twice', async () => {
    const doc = await docOf([stackedPage(100)])
    const first = diffSnapshots(doc, doc)
    const second = diffSnapshots(doc, doc)
    const wire = wireOf(doc, doc)

    const root = rootOf(wire, '1:1')
    expect(root.counts.identical).toBe(5)
    for (const name of NODE_ARRAYS) expect(root[name]).toEqual([])
    expect(root.movedWithParent).toEqual([])
    expect(wire.rejections).toEqual([])
    expect(JSON.stringify(snapshotDiffEnvelope(first))).toBe(JSON.stringify(snapshotDiffEnvelope(second)))
  })

  it('still tells two acquisitions apart when nothing in the design changed', async () => {
    // A snapshot id covers fields the canonical document drops, so it can
    // move with no change to report. The hash of the comparison names which
    // two acquisitions were compared, not only what was found.
    const before = await docOf([stackedPage(100)])
    const after = await docOf([stackedPage(100)], { version: AFTER_VERSION })
    const same = wireOf(before, before)
    const reacquired = wireOf(before, after)

    expect(rootOf(reacquired, '1:1').counts.identical).toBe(5)
    expect(reacquired.before.snapshotId).not.toBe(reacquired.after.snapshotId)
    expect(reacquired.diffHash).not.toBe(same.diffHash)
    expect(reacquired.diffHash).toMatch(/^snapshot-diff:v1:sha256:[0-9a-f]{64}$/)
  })

  it('does not depend on the order keys arrived in', async () => {
    const reversedKeys = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reversedKeys)
        : typeof value === 'object' && value !== null
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([key, member]) => [key, reversedKeys(member)]),
            )
          : value
    const before = await docOf([stackedPage(100)])
    const after = await docOf([stackedPage(110)], { version: AFTER_VERSION })
    const shuffled = await docOf([reversedKeys(stackedPage(110)) as RawNodeSpec], { version: AFTER_VERSION })

    expect(JSON.stringify(snapshotDiffEnvelope(diffSnapshots(before, shuffled)))).toBe(
      JSON.stringify(snapshotDiffEnvelope(diffSnapshots(before, after))),
    )
  })
})

describe('a node that was pushed is not a node that was changed', () => {
  it('separates the header that grew from what it carried along (REG-DIFF-019)', async () => {
    const wire = await compare([stackedPage(100)], [stackedPage(110)])
    const root = rootOf(wire, '1:1')

    // The designer touched the header. The page grew with it.
    expect(ids(root.changed)).toEqual(['1:1', '1:2'])
    expect(changedNode(root, '1:2').categories).toEqual(['box'])
    expect(changedNode(root, '1:2').changes).toEqual([
      { category: 'box', fieldPath: 'box.height', before: 100, after: 110 },
    ])
    expect(changedNode(root, '1:2').movement).toBeNull()

    // The body moved inside the page: its offset from the page changed.
    expect(ids(root.movedWithinParent)).toEqual(['1:3'])
    expect(root.movedWithinParent[0]?.relativeBox.before.y).toBe(100)
    expect(root.movedWithinParent[0]?.relativeBox.after.y).toBe(110)
    expect(root.movedWithinParent[0]?.parentLayout.mode).toBe('NONE')

    // Everything inside the body kept its place in its own parent.
    expect(root.movedWithParent).toEqual([
      { parentId: '1:3', sourceIds: ['1:4'] },
      { parentId: '1:4', sourceIds: ['1:5'] },
    ])
    expect(root.counts.movedWithParent).toBe(2)
    expect(root.counts.identical).toBe(0)
  })

  it('calls it movement within the parent when the parent moved and the child stayed', async () => {
    // The child's absolute box is identical, so its content hash is too —
    // and its offset from the parent still changed by ten.
    const page = (panelX: number): RawNodeSpec =>
      frame('1:1', 'page', box(0, 0, 400, 300), {
        children: [
          frame('1:2', 'panel', box(panelX, 0, 200, 100), {
            children: [frame('1:3', 'pin', box(50, 50, 10, 10))],
          }),
        ],
      })
    const root = rootOf(await compare([page(0)], [page(10)]), '1:1')

    expect(ids(root.movedWithinParent)).toEqual(['1:2', '1:3'])
    const pin = root.movedWithinParent[1]
    expect(pin?.box.before).toEqual(pin?.box.after)
    expect(pin?.relativeBox.before.x).toBe(50)
    expect(pin?.relativeBox.after.x).toBe(40)
  })

  it('reports a root that moved on the canvas apart from anything inside it', async () => {
    const page = (x: number): RawNodeSpec =>
      frame('1:1', 'page', box(x, 0, 400, 300), {
        children: [frame('1:2', 'header', box(x, 0, 400, 100))],
      })
    const root = rootOf(await compare([page(0)], [page(500)]), '1:1')

    expect(ids(root.movedRoot)).toEqual(['1:1'])
    expect(root.movedRoot[0]?.box).toEqual({ before: box(0, 0, 400, 300), after: box(500, 0, 400, 300) })
    expect(root.movedWithParent).toEqual([{ parentId: '1:1', sourceIds: ['1:2'] }])
    expect(root.changed).toEqual([])
  })
})

describe('position that cannot be judged', () => {
  const page = (child: Partial<RawNodeSpec>): RawNodeSpec =>
    frame('1:1', 'page', box(0, 0, 400, 300), {
      children: [{ id: '1:2', type: 'FRAME', name: 'floating', ...child }],
    })

  it('says unknown when the box is there on one side only', async () => {
    const root = rootOf(await compare([page({ absoluteBoundingBox: box(10, 10, 20, 20) })], [page({})]), '1:1')
    const node = changedNode(root, '1:2')

    expect(node.categories).toEqual(['box'])
    expect(node.changes).toEqual([{ category: 'box', fieldPath: 'box', before: box(10, 10, 20, 20), after: null }])
    expect(node.movement?.kind).toBe('unknown')
    expect(node.movement?.missing).toBe('box')
  })

  it('reports nothing when the box is missing on both sides and nothing else differs', async () => {
    // What can be observed is the same before and after. Listing it as
    // unknown would put every box-less node into every comparison.
    const root = rootOf(await compare([page({})], [page({})]), '1:1')

    expect(root.counts.identical).toBe(2)
    expect(root.movementUnknown).toEqual([])
    expect(root.changed).toEqual([])
  })

  it('says unknown when only the parent box went missing, even though the child did not move on the page', async () => {
    const nested = (parentBox: RawNodeSpec['absoluteBoundingBox']): RawNodeSpec =>
      frame('1:1', 'page', box(0, 0, 400, 300), {
        children: [
          {
            id: '1:2',
            type: 'FRAME',
            name: 'holder',
            ...(parentBox === undefined ? {} : { absoluteBoundingBox: parentBox }),
            children: [frame('1:3', 'item', box(30, 30, 10, 10))],
          },
        ],
      })
    const root = rootOf(await compare([nested(box(10, 10, 100, 100))], [nested(undefined)]), '1:1')

    expect(ids(root.movementUnknown)).toEqual(['1:3'])
    expect(root.movementUnknown[0]?.missing).toBe('parent-box')
    expect(root.movementUnknown[0]?.relativeBox).toEqual({ before: box(20, 20, 10, 10), after: null })
  })
})

describe('nodes that came, went, or changed place in the tree', () => {
  it('reports a child redrawn with a new id as one removal and one addition', async () => {
    const page = (childId: string): RawNodeSpec =>
      frame('1:1', 'page', box(0, 0, 400, 300), { children: [frame(childId, 'badge', box(0, 0, 10, 10))] })
    const before = await docOf([page('1:2')])
    const after = await docOf([page('1:9')], { version: AFTER_VERSION })
    const root = rootOf(wireOf(before, after), '1:1')

    // The trap this guards: the hashes do not cover ids, so the page's
    // subtree hash is unchanged and a comparison that trusted it would
    // report nothing at all.
    expect(before.roots[0]?.subtreeHash).toBe(after.roots[0]?.subtreeHash)
    expect(ids(root.removed)).toEqual(['1:2'])
    expect(ids(root.added)).toEqual(['1:9'])
    expect(changedNode(root, '1:1').changes).toEqual([
      { category: 'children', fieldPath: 'children', before: ['1:2'], after: ['1:9'] },
    ])
    expect(root.counts.identical).toBe(0)
  })

  it('reports a node moved under another parent as a change of parent, even at the same coordinates', async () => {
    const page = (under: 'left' | 'right'): RawNodeSpec => {
      const item = frame('1:4', 'item', box(10, 10, 10, 10))
      return frame('1:1', 'page', box(0, 0, 400, 300), {
        children: [
          frame('1:2', 'left', box(0, 0, 100, 100), { children: under === 'left' ? [item] : [] }),
          frame('1:3', 'right', box(100, 0, 100, 100), { children: under === 'right' ? [item] : [] }),
        ],
      })
    }
    const root = rootOf(await compare([page('left')], [page('right')]), '1:1')

    expect(ids(root.changed)).toEqual(['1:2', '1:3', '1:4'])
    expect(changedNode(root, '1:4').changes).toEqual([
      { category: 'parent', fieldPath: 'parentId', before: '1:2', after: '1:3' },
    ])
    expect(changedNode(root, '1:4').movement?.kind).toBe('reparented')
    expect(changedNode(root, '1:4').movement?.relativeBox).toEqual({
      before: box(10, 10, 10, 10),
      after: box(-90, 10, 10, 10),
    })
    expect(changedNode(root, '1:2').categories).toEqual(['children'])
    expect(changedNode(root, '1:3').categories).toEqual(['children'])
  })

  it('counts a node moved to another compared root once, and records the transfer on both', async () => {
    const pages = (under: '1:1' | '2:1'): RawNodeSpec[] => {
      const item = frame('9:1', 'item', box(10, 10, 20, 20), {
        children: [frame('9:2', 'dot', box(12, 12, 4, 4))],
      })
      return [
        frame('1:1', 'small', box(0, 0, 100, 100), { children: under === '1:1' ? [item] : [] }),
        frame('2:1', 'large', box(0, 0, 100, 100), { children: under === '2:1' ? [item] : [] }),
      ]
    }
    const wire = await compare(pages('1:1'), pages('2:1'))
    const from = rootOf(wire, '1:1')
    const to = rootOf(wire, '2:1')

    expect(to.arrived).toEqual([
      { sourceId: '9:1', fromRootId: '1:1' },
      { sourceId: '9:2', fromRootId: '1:1' },
    ])
    expect(from.departed).toEqual([
      { sourceId: '9:1', toRootId: '2:1' },
      { sourceId: '9:2', toRootId: '2:1' },
    ])
    // The child kept its parent, its place and its fields: nothing to list
    // for it, and it still changed root. The transfer is its only trace.
    expect(ids(to.changed)).toEqual(['2:1', '9:1'])
    expect(to.counts.identical).toBe(1)
    expect(from.removed).toEqual([])
    expect(wire.total.arrived).toBe(2)
  })

  it('does not call a node removed when it moved under a root only the newer snapshot acquired', async () => {
    const item = frame('9:1', 'item', box(10, 10, 20, 20))
    const shared = (children: RawNodeSpec[]): RawNodeSpec => frame('1:1', 'shared', box(0, 0, 100, 100), { children })
    const wire = await compare(
      [shared([item])],
      [shared([]), frame('3:1', 'new-root', box(0, 0, 100, 100), { children: [item] })],
    )
    const root = rootOf(wire, '1:1')

    expect(wire.roots).toEqual({ common: ['1:1'], beforeOnly: [], afterOnly: ['3:1'] })
    expect(root.removed).toEqual([])
    expect(root.leftScope).toEqual([
      { sourceId: '9:1', name: 'item', type: 'FRAME', parentId: '1:1', nodePath: '0/0', otherRootId: '3:1' },
    ])
    // The root nobody shares is reported as a root and nothing beneath it is counted.
    expect(wire.compared.map((entry) => entry.rootId)).toEqual(['1:1'])
  })

  it('does not call a node added when it came from a root only the older snapshot acquired', async () => {
    const item = frame('9:1', 'item', box(10, 10, 20, 20))
    const shared = (children: RawNodeSpec[]): RawNodeSpec => frame('1:1', 'shared', box(0, 0, 100, 100), { children })
    const wire = await compare(
      [shared([]), frame('2:1', 'old-root', box(0, 0, 100, 100), { children: [item] })],
      [shared([item])],
    )

    expect(wire.roots).toEqual({ common: ['1:1'], beforeOnly: ['2:1'], afterOnly: [] })
    expect(rootOf(wire, '1:1').added).toEqual([])
    expect(ids(rootOf(wire, '1:1').enteredScope)).toEqual(['9:1'])
    expect(rootOf(wire, '1:1').enteredScope[0]?.otherRootId).toBe('2:1')
  })
})

describe('nodes the adapter could not represent', () => {
  const page = (widget: RawNodeSpec): RawNodeSpec => frame('1:1', 'page', box(0, 0, 400, 300), { children: [widget] })
  const widget = (type: string): RawNodeSpec => ({
    id: '1:2',
    type,
    name: 'widget',
    absoluteBoundingBox: box(0, 0, 50, 50),
    children: [frame('1:3', 'inner', box(5, 5, 10, 10))],
  })

  it('lists a node that became unrepresentable apart from removals, and its children as unobserved', async () => {
    const wire = await compare([page(widget('FRAME'))], [page(widget('STICKY'))])
    const root = rootOf(wire, '1:1')

    expect(root.removed).toEqual([])
    expect(wire.rejections.map((entry) => [entry.sourceId, entry.before.state, entry.after.state])).toEqual([
      ['1:2', 'node', 'rejected'],
    ])
    expect(root.counts.becameUnrepresentable).toBe(1)
    // Nothing below a rejection is read, so the child is not known to be gone.
    expect(root.unobserved).toEqual([
      { sourceId: '1:3', name: 'inner', type: 'FRAME', parentId: '1:2', nodePath: '0/0/0', side: 'before', under: '1:2' },
    ])
    expect(ids(root.descendantsChanged)).toEqual(['1:1'])
  })

  it('lists a node that became representable, and what appeared beneath it', async () => {
    const wire = await compare([page(widget('STICKY'))], [page(widget('FRAME'))])
    const root = rootOf(wire, '1:1')

    expect(root.added).toEqual([])
    expect(root.counts.becameRepresentable).toBe(1)
    expect(root.unobserved.map((entry) => [entry.sourceId, entry.side, entry.under])).toEqual([['1:3', 'after', '1:2']])
  })

  it('keeps an unchanged rejection in the list, so an unobservable part is never silent', async () => {
    const wire = await compare([page(widget('STICKY'))], [page(widget('STICKY'))])

    expect(wire.rejections.map((entry) => [entry.before.state, entry.after.state])).toEqual([['rejected', 'rejected']])
    expect(rootOf(wire, '1:1').counts.identical).toBe(1)
    expect(wire.before.rejectionCount).toBe(1)
  })

  it('notices a rejection whose detail changed, which the subtree hash does not', async () => {
    const before = await docOf([page(widget('STICKY'))])
    const after = await docOf([page(widget('CONNECTOR'))], { version: AFTER_VERSION })
    const wire = wireOf(before, after)
    const [entry] = wire.rejections

    // The stand-in hash for a rejected child covers its id and reason only.
    expect(before.roots[0]?.subtreeHash).toBe(after.roots[0]?.subtreeHash)
    expect(entry?.before.state === 'rejected' && entry.after.state === 'rejected').toBe(true)
    if (entry?.before.state === 'rejected' && entry.after.state === 'rejected') {
      expect(entry.before.reason).toBe(entry.after.reason)
      expect(entry.before.detail).not.toBe(entry.after.detail)
    }
    expect(ids(rootOf(wire, '1:1').descendantsChanged)).toEqual(['1:1'])
    expect(rootOf(wire, '1:1').counts.identical).toBe(0)
  })

  it('keeps a rejected child in its parent’s child list, where the canonical node leaves it out', async () => {
    const withSticky = (stickyFirst: boolean): RawNodeSpec => {
      const sticky: RawNodeSpec = { id: '1:8', type: 'STICKY', name: 'note' }
      const kept = frame('1:9', 'kept', box(0, 0, 10, 10))
      return frame('1:1', 'page', box(0, 0, 400, 300), { children: stickyFirst ? [sticky, kept] : [kept, sticky] })
    }
    const root = rootOf(await compare([withSticky(true)], [withSticky(false)]), '1:1')

    expect(changedNode(root, '1:1').changes).toEqual([
      { category: 'children', fieldPath: 'children', before: ['1:8', '1:9'], after: ['1:9', '1:8'] },
    ])
  })
})

describe('every combination of where an id can be', () => {
  type Place = 'N-in' | 'N-out' | 'R-in' | 'R-out' | 'absent'
  const PLACES: ReadonlyArray<Place> = ['N-in', 'N-out', 'R-in', 'R-out', 'absent']
  const PROBE = '9:9'

  /** One shared root, and one root only this side acquired. The probe goes where the place says. */
  const rootsFor = (side: 'before' | 'after', place: Place): RawNodeSpec[] => {
    const probe: RawNodeSpec = {
      id: PROBE,
      type: place.startsWith('N') ? 'FRAME' : 'STICKY',
      name: 'probe',
      absoluteBoundingBox: box(0, 0, 10, 10),
    }
    return [
      frame('1:1', 'shared', box(0, 0, 100, 100), { children: place.endsWith('-in') ? [probe] : [] }),
      frame(side === 'before' ? '2:1' : '3:1', 'own', box(0, 0, 100, 100), {
        children: place.endsWith('-out') ? [probe] : [],
      }),
    ]
  }

  const expected = (before: Place, after: Place): { readonly array: string | undefined; readonly rejection: boolean } => {
    const isIn = (place: Place) => place.endsWith('-in')
    const isNode = (place: Place) => place.startsWith('N')
    const isRejection = (place: Place) => place.startsWith('R')
    if (!isIn(before) && !isIn(after)) return { array: undefined, rejection: false }
    if (isRejection(before) || isRejection(after)) return { array: undefined, rejection: true }
    if (isNode(before) && isNode(after)) {
      if (isIn(before) && isIn(after)) return { array: undefined, rejection: false }
      return { array: isIn(before) ? 'leftScope' : 'enteredScope', rejection: false }
    }
    return { array: isNode(before) ? 'removed' : 'added', rejection: false }
  }

  for (const before of PLACES) {
    for (const after of PLACES) {
      it(`${before} then ${after}`, async () => {
        const wire = await compare(rootsFor('before', before), rootsFor('after', after))
        const root = rootOf(wire, '1:1')
        const want = expected(before, after)

        const foundIn = NODE_ARRAYS.filter((name) => ids(root[name]).includes(PROBE))
        expect(foundIn).toEqual(want.array === undefined ? [] : [want.array])
        expect(wire.rejections.some((entry) => entry.sourceId === PROBE)).toBe(want.rejection)
        expect(root.counts.becameUnrepresentable).toBe(before === 'N-in' && after.startsWith('R') ? 1 : 0)
        expect(root.counts.becameRepresentable).toBe(after === 'N-in' && before.startsWith('R') ? 1 : 0)
        // Nothing under a root only one side acquired is ever compared or counted.
        expect(wire.compared.map((entry) => entry.rootId)).toEqual(['1:1'])
        expect(wire.roots).toEqual({ common: ['1:1'], beforeOnly: ['2:1'], afterOnly: ['3:1'] })
      })
    }
  }
})

describe('what changed on a node, field by field', () => {
  interface FieldCase {
    readonly label: string
    /** The hash-input keys this case exercises. */
    readonly ownFields: ReadonlyArray<string>
    readonly before: Partial<RawNodeSpec>
    readonly after: Partial<RawNodeSpec>
    readonly categories: ReadonlyArray<string>
    readonly fieldPaths: ReadonlyArray<string>
    readonly options?: DocOptions
  }

  const red = { type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }
  const blue = { type: 'SOLID', color: { r: 0, g: 0, b: 1, a: 1 } }
  const textNode: Partial<RawNodeSpec> = { type: 'TEXT', characters: 'Hello', style: { fontSize: 16 } }
  const styles = { '9:1': { name: 'body/regular' }, '9:2': { name: 'body/strong' } }

  const CASES: ReadonlyArray<FieldCase> = [
    { label: 'name', ownFields: ['name'], before: {}, after: { name: 'renamed' }, categories: ['name'], fieldPaths: ['name'] },
    { label: 'type', ownFields: ['type'], before: {}, after: { type: 'GROUP' }, categories: ['type'], fieldPaths: ['type'] },
    {
      label: 'own visibility',
      ownFields: ['selfVisible', 'effectiveVisible'],
      before: {},
      after: { visible: false },
      categories: ['visibility'],
      fieldPaths: ['rendered', 'selfVisible'],
    },
    {
      label: 'size',
      ownFields: ['geometry'],
      before: {},
      after: { absoluteBoundingBox: box(10, 10, 120, 100) },
      categories: ['box'],
      fieldPaths: ['box.width'],
    },
    {
      label: 'render bounds',
      ownFields: ['renderBounds'],
      before: { absoluteRenderBounds: box(10, 10, 100, 100) },
      after: { absoluteRenderBounds: box(6, 6, 108, 108) },
      categories: ['render-bounds'],
      fieldPaths: ['renderBounds.height', 'renderBounds.offsetX', 'renderBounds.offsetY', 'renderBounds.width'],
    },
    {
      label: 'render bounds appearing',
      ownFields: ['renderBounds'],
      before: {},
      after: { absoluteRenderBounds: box(10, 10, 100, 100) },
      categories: ['render-bounds'],
      fieldPaths: ['renderBounds'],
    },
    { label: 'rotation', ownFields: ['rotation'], before: {}, after: { rotation: 0.5 }, categories: ['rotation'], fieldPaths: ['rotation'] },
    { label: 'opacity', ownFields: ['opacity'], before: { opacity: 1 }, after: { opacity: 0.5 }, categories: ['compositing'], fieldPaths: ['opacity'] },
    {
      label: 'blend mode',
      ownFields: ['blendMode'],
      before: { blendMode: 'NORMAL' },
      after: { blendMode: 'MULTIPLY' },
      categories: ['compositing'],
      fieldPaths: ['blendMode'],
    },
    {
      label: 'layout spacing',
      ownFields: ['layout'],
      before: { layoutMode: 'VERTICAL', itemSpacing: 10 },
      after: { layoutMode: 'VERTICAL', itemSpacing: 20 },
      categories: ['layout'],
      fieldPaths: ['layout.itemSpacing'],
    },
    {
      label: 'one side of the padding',
      ownFields: ['layout'],
      before: { paddingLeft: 10 },
      after: { paddingLeft: 20 },
      categories: ['layout'],
      fieldPaths: ['layout.padding.left'],
    },
    {
      label: 'constraints appearing',
      ownFields: ['layout'],
      before: {},
      after: { constraints: { horizontal: 'LEFT', vertical: 'TOP' } },
      categories: ['layout'],
      fieldPaths: ['layout.constraints'],
    },
    {
      label: 'one constraint',
      ownFields: ['layout'],
      before: { constraints: { horizontal: 'LEFT', vertical: 'TOP' } },
      after: { constraints: { horizontal: 'RIGHT', vertical: 'TOP' } },
      categories: ['layout'],
      fieldPaths: ['layout.constraints.horizontal'],
    },
    { label: 'fills', ownFields: ['fills'], before: { fills: [red] }, after: { fills: [blue] }, categories: ['fills'], fieldPaths: ['fills'] },
    { label: 'strokes', ownFields: ['strokes'], before: { strokes: [red] }, after: { strokes: [blue] }, categories: ['strokes'], fieldPaths: ['strokes'] },
    { label: 'stroke weight', ownFields: ['strokeWeight'], before: { strokeWeight: 1 }, after: { strokeWeight: 2 }, categories: ['strokes'], fieldPaths: ['strokeWeight'] },
    {
      label: 'per-side stroke weights appearing',
      ownFields: ['individualStrokeWeights'],
      before: {},
      after: { individualStrokeWeights: { top: 1, right: 0, bottom: 0, left: 0 } },
      categories: ['strokes'],
      fieldPaths: ['individualStrokeWeights'],
    },
    {
      label: 'one stroke side',
      ownFields: ['individualStrokeWeights'],
      before: { individualStrokeWeights: { top: 1, right: 0, bottom: 0, left: 0 } },
      after: { individualStrokeWeights: { top: 2, right: 0, bottom: 0, left: 0 } },
      categories: ['strokes'],
      fieldPaths: ['individualStrokeWeights.top'],
    },
    {
      label: 'stroke alignment',
      ownFields: ['strokeAlign'],
      before: { strokeAlign: 'INSIDE' },
      after: { strokeAlign: 'CENTER' },
      categories: ['strokes'],
      fieldPaths: ['strokeAlign'],
    },
    { label: 'corner radius', ownFields: ['cornerRadius'], before: { cornerRadius: 4 }, after: { cornerRadius: 8 }, categories: ['corners'], fieldPaths: ['cornerRadius'] },
    {
      label: 'per-corner radii',
      ownFields: ['rectangleCornerRadii'],
      before: { rectangleCornerRadii: [1, 2, 3, 4] },
      after: { rectangleCornerRadii: [1, 2, 3, 8] },
      categories: ['corners'],
      fieldPaths: ['rectangleCornerRadii'],
    },
    {
      label: 'effects',
      ownFields: ['effects'],
      before: {},
      after: { effects: [{ type: 'DROP_SHADOW', radius: 4, offset: { x: 0, y: 2 }, color: { r: 0, g: 0, b: 0, a: 1 } }] },
      categories: ['effects'],
      fieldPaths: ['effects'],
    },
    {
      label: 'component reference',
      ownFields: ['componentId'],
      before: { type: 'INSTANCE', componentId: '7:1' },
      after: { type: 'INSTANCE', componentId: '7:2' },
      categories: ['component'],
      fieldPaths: ['componentId'],
    },
    {
      label: 'characters',
      ownFields: ['text'],
      before: textNode,
      after: { ...textNode, characters: 'World' },
      categories: ['text'],
      fieldPaths: ['characters'],
    },
    {
      label: 'text style',
      ownFields: ['text'],
      before: { ...textNode, styles: { text: '9:1' } },
      after: { ...textNode, styles: { text: '9:2' } },
      categories: ['text'],
      fieldPaths: ['textStyle'],
      options: { styles },
    },
    {
      label: 'one typography value',
      ownFields: ['text'],
      before: textNode,
      after: { ...textNode, style: { fontSize: 18 } },
      categories: ['text'],
      fieldPaths: ['typography.fontSize'],
    },
    {
      // The flags' keys come from the design. A field path built from them
      // would make the set of paths depend on the data, so they move as one.
      label: 'opentype flags, as one value',
      ownFields: ['text'],
      before: { ...textNode, style: { fontSize: 16, opentypeFlags: { PALT: 1 } } },
      after: { ...textNode, style: { fontSize: 16, opentypeFlags: { PALT: 1, LIGA: 0 } } },
      categories: ['text'],
      fieldPaths: ['typography.opentypeFlags'],
    },
    {
      label: 'character overrides',
      ownFields: ['text'],
      before: textNode,
      after: { ...textNode, characterStyleOverrides: [0, 1], styleOverrideTable: { '1': { textDecoration: 'UNDERLINE' } } },
      categories: ['text'],
      fieldPaths: ['characterOverrideRuns', 'hasCharacterOverrides'],
    },
    {
      // Text has no outline of its own (`absent`); a frame has one that was
      // not acquired (`unknown`). The type change carries that with it.
      label: 'text disappearing with the type',
      ownFields: ['type', 'text', 'vectorGeometry'],
      before: textNode,
      after: { type: 'FRAME' },
      categories: ['type', 'text', 'vector'],
      fieldPaths: [
        'type',
        'characterOverrideRuns',
        'characters',
        'hasCharacterOverrides',
        'typography',
        'vectorGeometry.kind',
        'vectorGeometry.reason',
      ],
    },
    {
      label: 'a redrawn vector',
      ownFields: ['vectorGeometry'],
      before: { type: 'VECTOR', fillGeometry: [{ path: 'M0 0L10 0', windingRule: 'NONZERO' }] },
      after: { type: 'VECTOR', fillGeometry: [{ path: 'M0 0L20 0', windingRule: 'NONZERO' }] },
      categories: ['vector'],
      fieldPaths: ['vectorGeometry.geometryHash'],
      options: { geometry: 'paths' },
    },
  ]

  const page = (over: Partial<RawNodeSpec>): RawNodeSpec =>
    frame('1:1', 'page', box(0, 0, 400, 300), {
      children: [{ id: '1:2', type: 'FRAME', name: 'subject', absoluteBoundingBox: box(10, 10, 100, 100), ...over }],
    })

  for (const fieldCase of CASES) {
    it(fieldCase.label, async () => {
      const wire = await compare([page(fieldCase.before)], [page(fieldCase.after)], fieldCase.options)
      const node = changedNode(rootOf(wire, '1:1'), '1:2')

      expect(node.categories).toEqual(fieldCase.categories)
      expect(node.changes.map((change) => change.fieldPath)).toEqual(fieldCase.fieldPaths)
      for (const change of node.changes) expect(change.before).not.toEqual(change.after)
    })
  }

  it('exercises every key of the hash input, so none can change without the diff saying where', () => {
    const exercised = new Set(CASES.flatMap((fieldCase) => fieldCase.ownFields))
    const expectedKeys = OWN_FIELD_ROWS.map((row) => row.key).filter((key) => key !== 'schemaVersion')
    expect([...exercised].sort()).toEqual([...expectedKeys].sort())
  })

  it('shows values in the shape the slice uses, absent ones as null', async () => {
    const wire = await compare([page({ fills: [red] })], [page({ fills: [blue] })])
    const [change] = changedNode(rootOf(wire, '1:1'), '1:2').changes

    expect(change?.before).toEqual([
      { kind: 'raw', paint: { kind: 'solid', visible: true, opacity: null, blendMode: null, rgba: [1, 0, 0, 1] } },
    ])
  })

  it('reports a node hidden by an ancestor as rendered-only, so it reads apart from one hidden itself', async () => {
    const tree = (groupVisible: boolean): RawNodeSpec =>
      frame('1:1', 'page', box(0, 0, 400, 300), {
        children: [
          frame('1:2', 'group', box(0, 0, 100, 100), {
            visible: groupVisible,
            children: [frame('1:3', 'leaf', box(0, 0, 10, 10))],
          }),
        ],
      })
    const root = rootOf(await compare([tree(true)], [tree(false)]), '1:1')

    expect(changedNode(root, '1:2').changes.map((change) => change.fieldPath)).toEqual(['rendered', 'selfVisible'])
    expect(changedNode(root, '1:3').changes).toEqual([
      { category: 'visibility', fieldPath: 'rendered', before: true, after: false },
    ])
  })

  it('does not report render bounds for a node that only moved', async () => {
    // Stored render bounds are absolute, so they differ for any node that
    // moves. Measured from the node's own box they did not change here.
    const tree = (x: number): RawNodeSpec =>
      frame('1:1', 'page', box(0, 0, 400, 300), {
        children: [
          {
            id: '1:2',
            type: 'FRAME',
            name: 'shadowed',
            absoluteBoundingBox: box(x, 0, 100, 100),
            absoluteRenderBounds: box(x - 4, -4, 108, 108),
          },
        ],
      })
    const root = rootOf(await compare([tree(0)], [tree(30)]), '1:1')

    expect(root.changed).toEqual([])
    expect(ids(root.movedWithinParent)).toEqual(['1:2'])
  })

  it('lists a node’s changes by category and then by field path', async () => {
    const wire = await compare(
      [page({ fills: [red], paddingLeft: 10, paddingTop: 10, name: 'subject' })],
      [page({ fills: [blue], paddingLeft: 20, paddingTop: 20, name: 'renamed' })],
    )
    const node = changedNode(rootOf(wire, '1:1'), '1:2')

    expect(node.categories).toEqual(['name', 'layout', 'fills'])
    expect(node.changes.map((change) => change.fieldPath)).toEqual([
      'name',
      'layout.padding.left',
      'layout.padding.top',
      'fills',
    ])
    expect(rootOf(wire, '1:1').counts.byCategory.layout).toBe(1)
  })
})

describe('the table that ties the diff to the hash', () => {
  const sample = async (): Promise<CanonicalNode> => {
    const doc = await docOf([frame('1:1', 'page', box(0, 0, 10, 10))])
    const [node] = doc.roots
    if (node === undefined) throw new Error('no root')
    return node
  }

  it('has every key of the hash input exactly once', async () => {
    const keys = Object.keys(canonicalNodeOwnFields(await sample()) as Record<string, unknown>)
    const rows = OWN_FIELD_ROWS.map((row) => row.key)

    expect(new Set(rows).size).toBe(rows.length)
    expect([...rows].sort()).toEqual([...keys].sort())
  })

  it('names only fields that are actually shown, and only declared categories', async () => {
    const shown = Object.keys(shownFieldsOf(await sample()))
    const named = OWN_FIELD_ROWS.flatMap((row) => row.shownAs)

    expect(new Set(named).size).toBe(named.length)
    expect([...named].sort()).toEqual([...shown].sort())
    for (const row of OWN_FIELD_ROWS) {
      if (row.category !== undefined) expect(SNAPSHOT_DIFF_CATEGORIES).toContain(row.category)
    }
  })

  it('stops instead of reporting nothing when the hash input differs and no shown field does', async () => {
    // Hand-built on purpose: two nodes whose paths differ while their path
    // hash agrees cannot come out of the adapter. It stands for any future
    // case where the shown form loses something the hash input still has.
    const doc = await docOf(
      [
        frame('1:1', 'page', box(0, 0, 10, 10), {
          children: [{ id: '1:2', type: 'VECTOR', name: 'mark', fillGeometry: [{ path: 'M0 0L10 0', windingRule: 'NONZERO' }] }],
        }),
      ],
      { geometry: 'paths' },
    )
    const node = doc.roots[0]?.children[0]
    if (node === undefined || node.vectorGeometry.kind !== 'known') throw new Error('expected a vector with paths')
    const tampered: CanonicalNode = {
      ...node,
      vectorGeometry: { ...node.vectorGeometry, fill: [{ path: 'M0 0L99 0', windingRule: 'NONZERO' }] },
    }

    expect(detailOf(() => changedOwnFields(node.sourceId, node, tampered))).toEqual({
      kind: 'change-serialization-mismatch',
      sourceId: '1:2',
      ownField: 'vectorGeometry',
    })
  })
})

describe('pairs that are not compared', () => {
  const page = (): RawNodeSpec => frame('1:1', 'page', box(0, 0, 400, 300), { children: [frame('1:2', 'a', box(0, 0, 10, 10))] })

  it('refuses two different files', async () => {
    const other = await docOf([page()], { key: fileKey('SYNTHETICFILEKEY0002') })
    expect(detailOf(() => diffSnapshots(other, { ...other, provenance: { ...other.provenance, fileKey: 'SYNTHETICFILEKEY0001' } }))).toEqual({
      kind: 'file-mismatch',
      before: 'SYNTHETICFILEKEY0002',
      after: 'SYNTHETICFILEKEY0001',
    })
  })

  it('refuses a pair where only one side asked for vector paths', async () => {
    // Without paths every shape reads as unknown; against a side that has
    // them, every vector would look redrawn.
    const without = await docOf([page()])
    const withPaths = await docOf([page()], { geometry: 'paths' })
    const error = (() => {
      try {
        diffSnapshots(without, withPaths)
      } catch (caught) {
        return caught
      }
      return undefined
    })()

    expect(error).toBeInstanceOf(SnapshotDiffError)
    expect((error as SnapshotDiffError).detail).toEqual({ kind: 'geometry-mode-mismatch', before: 'none', after: 'paths' })
    // The kind leads the message: a caller reading stderr branches on it.
    expect((error as SnapshotDiffError).message.startsWith('geometry-mode-mismatch: ')).toBe(true)
    expect((error as SnapshotDiffError).name).toBe('SnapshotDiffError')
  })

  it('refuses a pair acquired by different adapters', async () => {
    const doc = await docOf([page()])
    const other = { ...doc, provenance: { ...doc.provenance, adapter: { name: 'figma-rest', version: '2' } } }
    expect(detailOf(() => diffSnapshots(doc, other))).toEqual({
      kind: 'adapter-mismatch',
      before: { name: 'figma-rest', version: '1' },
      after: { name: 'figma-rest', version: '2' },
    })
  })

  it('refuses documents normalized under another schema version', async () => {
    const doc = await docOf([page()])
    const other = { ...doc, provenance: { ...doc.provenance, schemaVersion: doc.provenance.schemaVersion + 1 } }
    expect(detailOf(() => diffSnapshots(doc, other)).kind).toBe('canonical-schema-mismatch')
    expect(detailOf(() => diffSnapshots(other, other)).kind).toBe('canonical-schema-mismatch')
  })

  it('refuses a snapshot whose roots are nested, naming every place the id appears', async () => {
    const inner = frame('1:2', 'a', box(0, 0, 10, 10))
    const nested = await docOf([frame('1:1', 'page', box(0, 0, 400, 300), { children: [inner] }), inner])
    const flat = await docOf([page()])

    expect(detailOf(() => diffSnapshots(flat, nested))).toEqual({
      kind: 'duplicate-source-id',
      side: 'after',
      sourceId: '1:2',
      nodePaths: ['0/0', '1'],
    })
    // The older side is reported first when both are at fault.
    expect(detailOf(() => diffSnapshots(nested, nested))).toMatchObject({ kind: 'duplicate-source-id', side: 'before' })
  })

  it('refuses a document whose rejection cannot be placed', async () => {
    const doc = await docOf([frame('1:1', 'page', box(0, 0, 400, 300), { children: [{ id: '1:8', type: 'STICKY', name: 'note' }] })])
    const [rejection] = doc.rejections
    if (rejection === undefined) throw new Error('expected a rejection')
    const broken = { ...doc, rejections: [{ ...rejection, path: '7/0' as NodePath }] }

    expect(detailOf(() => diffSnapshots(doc, broken))).toEqual({
      kind: 'invalid-canonical-document',
      side: 'after',
      nodePath: '7/0',
    })
  })
})

describe('render bounds on a node that has no box of its own', () => {
  const page = (bounds: RawNodeSpec['absoluteRenderBounds']): RawNodeSpec =>
    frame('1:1', 'page', box(0, 0, 400, 300), {
      children: [{ id: '1:2', type: 'FRAME', name: 'unboxed', ...(bounds === undefined ? {} : { absoluteRenderBounds: bounds }) }],
    })

  it('shows them as they are, marked as not measured from a box, when they differ', async () => {
    // With no box there is nothing to measure from, so "it moved" and "what
    // it draws changed" cannot be told apart. The values say so themselves
    // rather than being reported as an offset that was never computed.
    const root = rootOf(await compare([page(box(0, 0, 10, 10))], [page(box(5, 0, 10, 10))]), '1:1')

    expect(changedNode(root, '1:2').changes).toEqual([
      {
        category: 'render-bounds',
        fieldPath: 'renderBounds',
        before: { state: 'unanchored', absolute: box(0, 0, 10, 10) },
        after: { state: 'unanchored', absolute: box(5, 0, 10, 10) },
      },
    ])
    expect(changedNode(root, '1:2').movement).toBeNull()
  })

  it('reports nothing when they are the same on both sides', async () => {
    const root = rootOf(await compare([page(box(0, 0, 10, 10))], [page(box(0, 0, 10, 10))]), '1:1')
    expect(root.counts.identical).toBe(2)
  })

  const boxed = (): RawNodeSpec =>
    frame('1:1', 'page', box(0, 0, 400, 300), {
      children: [frame('1:2', 'unboxed', box(0, 0, 10, 10), { absoluteRenderBounds: box(-2, -2, 14, 14) })],
    })

  it('does not call them changed when only the box they would be measured from went missing', async () => {
    // Whether a field changed is read from the hash input, where the bounds
    // are the same rectangle on both sides. That they can no longer be
    // expressed as an offset is a consequence of the box, which is reported.
    const root = rootOf(await compare([boxed()], [page(box(-2, -2, 14, 14))]), '1:1')

    expect(changedNode(root, '1:2').categories).toEqual(['box'])
  })

  it('shows both forms when the box went missing and the bounds changed too', async () => {
    const root = rootOf(await compare([boxed()], [page(box(0, 0, 10, 10))]), '1:1')
    const renderBounds = changedNode(root, '1:2').changes.find((change) => change.category === 'render-bounds')

    expect(changedNode(root, '1:2').categories).toEqual(['box', 'render-bounds'])
    expect(renderBounds).toEqual({
      category: 'render-bounds',
      fieldPath: 'renderBounds',
      before: { state: 'known', offsetX: -2, offsetY: -2, width: 14, height: 14 },
      after: { state: 'unanchored', absolute: box(0, 0, 10, 10) },
    })
  })
})

describe('rotation does not change how position is compared', () => {
  // The boxes are axis-aligned bounding boxes. For a rotated node their
  // offset is not a position in the parent's own coordinates — the documents
  // carry no transform — but it is computed the same way and labelled as
  // what it is.
  const page = (y: number, rotation: number): RawNodeSpec =>
    frame('1:1', 'page', box(0, 0, 400, 300), {
      children: [frame('1:2', 'tilted', box(10, y, 40, 40), { rotation })],
    })

  it('classifies a rotated node that moved by the offset between the two boxes', async () => {
    const root = rootOf(await compare([page(10, 0.5)], [page(30, 0.5)]), '1:1')

    expect(ids(root.movedWithinParent)).toEqual(['1:2'])
    expect(root.movedWithinParent[0]?.relativeBox).toEqual({ before: box(10, 10, 40, 40), after: box(10, 30, 40, 40) })
    expect(root.changed).toEqual([])
  })

  it('reports a change of rotation as a change, with the movement beside it', async () => {
    const root = rootOf(await compare([page(10, 0.5)], [page(30, 0.25)]), '1:1')
    const node = changedNode(root, '1:2')

    expect(node.categories).toEqual(['rotation'])
    expect(node.movement?.kind).toBe('within-parent')
    expect(root.movedWithinParent).toEqual([])
  })
})

describe('what does not carry meaning does not change the result', () => {
  const small = (): RawNodeSpec => frame('1:1', 'small', box(0, 0, 100, 100), { children: [frame('1:2', 'a', box(0, 0, 10, 10))] })
  const large = (aWidth: number): RawNodeSpec =>
    frame('2:1', 'large', box(0, 0, 200, 100), { children: [frame('2:2', 'a', box(0, 0, aWidth, 10))] })

  it('ignores the order roots were asked for and answered in', async () => {
    // Roots are a set. Which was named first is not a fact about the design.
    const before = await docOf([small(), large(10)])
    const inOrder = await docOf([small(), large(20)], { version: AFTER_VERSION })
    const reversed = await docOf([large(20), small()], { version: AFTER_VERSION })

    expect(JSON.stringify(snapshotDiffEnvelope(diffSnapshots(before, reversed)))).toBe(
      JSON.stringify(snapshotDiffEnvelope(diffSnapshots(before, inOrder))),
    )
  })

  it('keeps the order of children, which does', async () => {
    const page = (order: ReadonlyArray<string>): RawNodeSpec =>
      frame('1:1', 'page', box(0, 0, 100, 100), {
        children: order.map((id) => frame(id, `item-${id}`, box(0, 0, 10, 10))),
      })
    const root = rootOf(await compare([page(['1:2', '1:3'])], [page(['1:3', '1:2'])]), '1:1')

    expect(changedNode(root, '1:1').changes).toEqual([
      { category: 'children', fieldPath: 'children', before: ['1:2', '1:3'], after: ['1:3', '1:2'] },
    ])
  })
})

describe('two snapshots that share no root', () => {
  it('compares nothing and says which roots each side had, without failing', async () => {
    // Not an error: the two acquisitions are of the same file. There is
    // simply nothing they both looked at, and the result says that.
    const wire = await compare(
      [frame('1:1', 'old', box(0, 0, 100, 100), { children: [frame('1:2', 'a', box(0, 0, 10, 10))] })],
      [frame('3:1', 'new', box(0, 0, 100, 100), { children: [frame('1:2', 'a', box(0, 0, 10, 10))] })],
    )

    expect(wire.roots).toEqual({ common: [], beforeOnly: ['1:1'], afterOnly: ['3:1'] })
    expect(wire.compared).toEqual([])
    expect(wire.rejections).toEqual([])
    expect(wire.total.nodesBefore).toBe(0)
    expect(wire.total.nodesAfter).toBe(0)
    expect(Object.values(wire.total.byCategory).every((count) => count === 0)).toBe(true)
    expect(wire.before.nodeCount).toBe(2)
  })
})

describe('ids inside a component instance', () => {
  // `I<instance>;<node>` is one opaque id. Two instances of the same
  // component share everything after the semicolon, so a match made on that
  // part would pair a node with its counterpart in a different instance.
  const page = (instanceId: string, labelWidth: number): RawNodeSpec =>
    frame('1:1', 'page', box(0, 0, 400, 300), {
      children: [
        {
          id: instanceId,
          type: 'INSTANCE',
          name: 'button',
          componentId: '7:1',
          absoluteBoundingBox: box(0, 0, 50, 20),
          children: [frame(`I${instanceId};7:2`, 'label', box(5, 5, labelWidth, 10))],
        },
      ],
    })

  it('are compared when the whole id is the same', async () => {
    const root = rootOf(await compare([page('5:1', 10)], [page('5:1', 20)]), '1:1')

    expect(ids(root.changed)).toEqual(['I5:1;7:2'])
    expect(root.removed).toEqual([])
    expect(root.added).toEqual([])
  })

  it('are a removal and an addition when only the part after the semicolon agrees', async () => {
    const root = rootOf(await compare([page('5:1', 10)], [page('5:9', 10)]), '1:1')

    expect(ids(root.removed)).toEqual(['5:1', 'I5:1;7:2'])
    expect(ids(root.added)).toEqual(['5:9', 'I5:9;7:2'])
  })
})

describe('a parent with no box on either side', () => {
  // The offset from the parent cannot be computed before or after. What is
  // left to compare is the position on the page — the same evidence on both
  // sides, so a node that did not move there is not listed as unknown.
  const page = (itemX: number): RawNodeSpec =>
    frame('1:1', 'page', box(0, 0, 400, 300), {
      children: [{ id: '1:2', type: 'FRAME', name: 'holder', children: [frame('1:3', 'item', box(itemX, 30, 10, 10))] }],
    })

  it('reports nothing for a child that stayed where it was on the page', async () => {
    const root = rootOf(await compare([page(30)], [page(30)]), '1:1')

    expect(root.counts.identical).toBe(3)
    expect(root.movementUnknown).toEqual([])
  })

  it('says unknown for a child that moved on the page', async () => {
    const root = rootOf(await compare([page(30)], [page(50)]), '1:1')

    expect(ids(root.movementUnknown)).toEqual(['1:3'])
    expect(root.movementUnknown[0]?.relativeBox).toEqual({ before: null, after: null })
    expect(root.movementUnknown[0]?.box).toEqual({ before: box(30, 30, 10, 10), after: box(50, 30, 10, 10) })
    expect(ids(root.descendantsChanged)).toEqual(['1:1', '1:2'])
  })
})

describe('a pair acquired by adapters of different names', () => {
  it('is refused like a pair of different versions', async () => {
    const doc = await docOf([frame('1:1', 'page', box(0, 0, 400, 300))])
    const other = { ...doc, provenance: { ...doc.provenance, adapter: { name: 'other-source', version: '1' } } }

    expect(detailOf(() => diffSnapshots(doc, other))).toEqual({
      kind: 'adapter-mismatch',
      before: { name: 'figma-rest', version: '1' },
      after: { name: 'other-source', version: '1' },
    })
  })
})
