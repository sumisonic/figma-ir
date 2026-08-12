/**
 * Comparing two canonical documents of the same design.
 *
 * Nodes are matched by source id and by nothing else. A node recreated with a
 * new id is one removal and one addition: guessing that the two are "the
 * same" is the correspondence problem, and an honest pair of facts is worth
 * more here than a confident wrong match.
 *
 * The content hash cannot answer "what changed" on its own. It covers
 * absolute coordinates, so growing one header by ten pixels changes the hash
 * of everything below it — the nodes the designer touched and the nodes that
 * were merely carried along look alike. Position is therefore compared
 * against the parent's box, which is what separates the two.
 *
 * Every node is visited. Equal subtree hashes do not license skipping a
 * branch: the hashes do not cover ids, so a child deleted and redrawn
 * identically leaves its parent's subtree hash untouched.
 */
import { canonicalStringify, compareCodeUnits } from '../determinism/canonical.js'
import { hashCanonicalString } from '../determinism/hash.js'
import { roundPx } from '../determinism/rounding.js'
import type { SourceId } from '../identity/nodeIdentity.js'
import { CANONICAL_SCHEMA_VERSION, type Box, type CanonicalDoc, type CanonicalNode } from '../canonical/document.js'
import type {
  CarriedGroup,
  ChangeRef,
  DiffCounts,
  MatchedNode,
  Movement,
  MovementKind,
  NodeSite,
  OneSidedNode,
  RejectionDiff,
  RejectionSide,
  RejectionSite,
  RootDiff,
  RootTransfer,
  ScopeTransition,
  SnapshotDiff,
  SnapshotRef,
  UnobservedNode,
} from './model.js'
import { categoriesOf, changedOwnFields, CHILDREN_CHANGE, PARENT_CHANGE, sortChanges } from './present.js'
import {
  SNAPSHOT_DIFF_CATEGORIES,
  SNAPSHOT_DIFF_SCHEMA_VERSION,
  SnapshotDiffError,
  type SnapshotDiffCategory,
} from './types.js'
import { snapshotDiffToJson } from './wire.js'

type Side = 'before' | 'after'

interface DocIndex {
  readonly doc: CanonicalDoc
  readonly rootIds: ReadonlyArray<string>
  readonly nodes: ReadonlyMap<SourceId, NodeSite>
  readonly rejections: ReadonlyMap<SourceId, RejectionSite>
  /** Rejection paths whose root or parent could not be recovered. */
  readonly unplaceable: ReadonlyArray<string>
  /** Ids that occur more than once, with every path they occur at. */
  readonly repeated: ReadonlyMap<SourceId, ReadonlyArray<string>>
}

const lastSegment = (path: string): number => Number(path.slice(path.lastIndexOf('/') + 1))

/**
 * Recovers the tree's structure from a document that does not store it.
 *
 * A canonical node has no parent pointer, and a rejection has neither a
 * parent nor a root: both are read back from the index path. The children of
 * a node are rebuilt the same way, because `children` omits the rejected
 * ones and a comparison of child lists has to see them.
 */
const indexDocument = (doc: CanonicalDoc): DocIndex => {
  const rootIds = [...doc.provenance.roots]
  const located = new Map<SourceId, { node: CanonicalNode; rootId: string; parentId: SourceId | undefined }>()
  const idByPath = new Map<string, SourceId>()
  const pathsById = new Map<SourceId, string[]>()
  const record = (id: SourceId, path: string): void => {
    const seen = pathsById.get(id)
    if (seen === undefined) pathsById.set(id, [path])
    else seen.push(path)
  }

  const visit = (node: CanonicalNode, parentId: SourceId | undefined, rootId: string): void => {
    record(node.sourceId, node.path as string)
    located.set(node.sourceId, { node, rootId, parentId })
    idByPath.set(node.path as string, node.sourceId)
    for (const child of node.children) visit(child, node.sourceId, rootId)
  }
  for (const root of doc.roots) visit(root, undefined, root.sourceId as string)

  const rejections = new Map<SourceId, RejectionSite>()
  const unplaceable: string[] = []
  for (const rejection of doc.rejections) {
    const path = rejection.path as string
    record(rejection.sourceId, path)
    const segments = path.split('/')
    const wellFormed = segments.every((segment) => /^\d+$/.test(segment))
    const rootId = wellFormed ? rootIds[Number(segments[0])] : undefined
    const parentId = segments.length === 1 ? undefined : idByPath.get(segments.slice(0, -1).join('/'))
    if (rootId === undefined || (segments.length > 1 && parentId === undefined)) {
      unplaceable.push(path)
      continue
    }
    rejections.set(rejection.sourceId, { rejection, rootId, parentId })
  }

  const slots = new Map<SourceId, Array<{ readonly index: number; readonly id: SourceId }>>()
  const place = (parentId: SourceId | undefined, path: string, id: SourceId): void => {
    if (parentId === undefined) return
    const siblings = slots.get(parentId)
    const slot = { index: lastSegment(path), id }
    if (siblings === undefined) slots.set(parentId, [slot])
    else siblings.push(slot)
  }
  for (const [id, entry] of located) place(entry.parentId, entry.node.path as string, id)
  for (const [id, site] of rejections) place(site.parentId, site.rejection.path as string, id)

  const nodes = new Map<SourceId, NodeSite>()
  for (const [id, entry] of located) {
    const childIds = (slots.get(id) ?? []).sort((a, b) => a.index - b.index).map((slot) => slot.id)
    nodes.set(id, { node: entry.node, rootId: entry.rootId, parentId: entry.parentId, childIds })
  }

  const repeated = new Map<SourceId, ReadonlyArray<string>>()
  for (const [id, paths] of pathsById) {
    if (paths.length > 1) repeated.set(id, [...paths].sort(compareCodeUnits))
  }
  return { doc, rootIds, nodes, rejections, unplaceable, repeated }
}

/**
 * Refuses pairs that cannot be compared honestly.
 *
 * Each of these would otherwise report the difference between two ways of
 * acquiring as a difference in the design: another file, paths requested on
 * one side only, a different adapter. Comparing with a warning attached does
 * not help, because the reader cannot tell which entries the warning is
 * about.
 */
const assertComparable = (before: CanonicalDoc, after: CanonicalDoc): void => {
  const b = before.provenance
  const a = after.provenance
  if (b.schemaVersion !== a.schemaVersion || b.schemaVersion !== CANONICAL_SCHEMA_VERSION) {
    throw new SnapshotDiffError({
      kind: 'canonical-schema-mismatch',
      before: b.schemaVersion,
      after: a.schemaVersion,
      expected: CANONICAL_SCHEMA_VERSION,
    })
  }
  if (b.fileKey !== a.fileKey) {
    throw new SnapshotDiffError({ kind: 'file-mismatch', before: b.fileKey, after: a.fileKey })
  }
  if (b.geometry !== a.geometry) {
    throw new SnapshotDiffError({ kind: 'geometry-mode-mismatch', before: b.geometry, after: a.geometry })
  }
  if (b.adapter.name !== a.adapter.name || b.adapter.version !== a.adapter.version) {
    throw new SnapshotDiffError({
      kind: 'adapter-mismatch',
      before: { name: b.adapter.name, version: b.adapter.version },
      after: { name: a.adapter.name, version: a.adapter.version },
    })
  }
}

/**
 * Structure problems, reported in a fixed order so the message does not
 * depend on traversal: the before side first, then by code unit.
 */
const assertWellFormed = (indexes: ReadonlyArray<readonly [Side, DocIndex]>): void => {
  for (const [side, index] of indexes) {
    const first = [...index.unplaceable].sort(compareCodeUnits)[0]
    if (first !== undefined) {
      throw new SnapshotDiffError({ kind: 'invalid-canonical-document', side, nodePath: first })
    }
  }
  for (const [side, index] of indexes) {
    const first = [...index.repeated.keys()].sort((x, y) => compareCodeUnits(x as string, y as string))[0]
    if (first !== undefined) {
      // A root nested inside another root is how this happens in practice:
      // the same node is then reachable twice, with a different parent each
      // time, and "the node with this id" stops naming one thing.
      throw new SnapshotDiffError({
        kind: 'duplicate-source-id',
        side,
        sourceId: first as string,
        nodePaths: index.repeated.get(first) ?? [],
      })
    }
  }
}

type Where =
  | { readonly kind: 'node'; readonly site: NodeSite; readonly inScope: boolean }
  | { readonly kind: 'rejection'; readonly site: RejectionSite; readonly inScope: boolean }
  | { readonly kind: 'absent' }

const locate = (index: DocIndex, common: ReadonlySet<string>, id: SourceId): Where => {
  const node = index.nodes.get(id)
  if (node !== undefined) return { kind: 'node', site: node, inScope: common.has(node.rootId) }
  const rejection = index.rejections.get(id)
  if (rejection !== undefined) return { kind: 'rejection', site: rejection, inScope: common.has(rejection.rootId) }
  return { kind: 'absent' }
}

/**
 * The offset between two axis-aligned boxes, rounded as a derived number
 * (REG-FACT-009). The same calculation the facts layer calls `relativeBox`.
 */
const relativeBox = (box: Box | undefined, parentBox: Box | undefined): Box | undefined =>
  box === undefined || parentBox === undefined
    ? undefined
    : { x: roundPx(box.x - parentBox.x), y: roundPx(box.y - parentBox.y), width: box.width, height: box.height }

const parentNodeOf = (index: DocIndex, site: NodeSite): CanonicalNode | undefined =>
  site.parentId === undefined ? undefined : index.nodes.get(site.parentId)?.node

/**
 * Classifies a node's change of position, or reports that it cannot be.
 *
 * `undefined` means no change was observed. That includes a box missing on
 * both sides: what can be seen is the same before and after, and calling it
 * "unknown" would put every box-less node into every comparison.
 */
const movementOf = (
  beforeIndex: DocIndex,
  afterIndex: DocIndex,
  before: NodeSite,
  after: NodeSite,
): Movement | undefined => {
  const boxBefore = before.node.geometry
  const boxAfter = after.node.geometry
  const parentBefore = parentNodeOf(beforeIndex, before)
  const parentAfter = parentNodeOf(afterIndex, after)
  const relativeBefore = relativeBox(boxBefore, parentBefore?.geometry)
  const relativeAfter = relativeBox(boxAfter, parentAfter?.geometry)
  const movement = (kind: MovementKind, missing?: 'box' | 'parent-box'): Movement => ({
    kind,
    missing,
    box: { before: boxBefore, after: boxAfter },
    relativeBox: { before: relativeBefore, after: relativeAfter },
    afterParent: parentAfter,
  })

  // Offsets against two different parents are not comparable, so a node that
  // changed parent is reported with both and classified as neither.
  if (before.parentId !== after.parentId) return movement('reparented')
  if ((boxBefore === undefined) !== (boxAfter === undefined)) return movement('unknown', 'box')
  if (boxBefore === undefined || boxAfter === undefined) return undefined

  const absoluteMoved = boxBefore.x !== boxAfter.x || boxBefore.y !== boxAfter.y
  if (before.parentId === undefined) return absoluteMoved ? movement('root') : undefined

  if (relativeBefore !== undefined && relativeAfter !== undefined) {
    // Checked before the absolute position: a child that stayed put on the
    // page while its parent's origin moved has moved within that parent.
    if (relativeBefore.x !== relativeAfter.x || relativeBefore.y !== relativeAfter.y) return movement('within-parent')
    return absoluteMoved ? movement('with-parent') : undefined
  }
  if (relativeBefore === undefined && relativeAfter === undefined) {
    return absoluteMoved ? movement('unknown', 'parent-box') : undefined
  }
  // The parent's box is there on one side only. An unchanged absolute
  // position does not mean an unchanged position in the parent.
  return movement('unknown', 'parent-box')
}

const sameIds = (a: ReadonlyArray<SourceId>, b: ReadonlyArray<SourceId>): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index])

interface RootAccumulator {
  nodesBefore: number
  nodesAfter: number
  identical: number
  becameUnrepresentable: number
  becameRepresentable: number
  readonly changed: MatchedNode[]
  readonly movedWithinParent: MatchedNode[]
  readonly carried: Map<SourceId, SourceId[]>
  readonly movedRoot: MatchedNode[]
  readonly movementUnknown: MatchedNode[]
  readonly descendantsChanged: MatchedNode[]
  readonly added: OneSidedNode[]
  readonly removed: OneSidedNode[]
  readonly enteredScope: ScopeTransition[]
  readonly leftScope: ScopeTransition[]
  readonly unobserved: UnobservedNode[]
  readonly arrived: RootTransfer[]
  readonly departed: RootTransfer[]
}

const emptyAccumulator = (): RootAccumulator => ({
  nodesBefore: 0,
  nodesAfter: 0,
  identical: 0,
  becameUnrepresentable: 0,
  becameRepresentable: 0,
  changed: [],
  movedWithinParent: [],
  carried: new Map(),
  movedRoot: [],
  movementUnknown: [],
  descendantsChanged: [],
  added: [],
  removed: [],
  enteredScope: [],
  leftScope: [],
  unobserved: [],
  arrived: [],
  departed: [],
})

const compareIds = (a: SourceId, b: SourceId): number => compareCodeUnits(a as string, b as string)

const carriedGroupsOf = (carried: ReadonlyMap<SourceId, ReadonlyArray<SourceId>>): ReadonlyArray<CarriedGroup> =>
  [...carried.entries()]
    .sort((a, b) => compareIds(a[0], b[0]))
    .map(([parentId, sourceIds]) => ({ parentId, sourceIds: [...sourceIds].sort(compareIds) }))

/**
 * Counts are read off the arrays that are emitted, never tallied on a second
 * path: a count that could disagree with the list beside it is worse than no
 * count. `identical` has no list, so it is the one number carried through.
 */
const countsOf = (root: RootAccumulator, movedWithParent: ReadonlyArray<CarriedGroup>): DiffCounts => {
  const byCategory = Object.fromEntries(SNAPSHOT_DIFF_CATEGORIES.map((category) => [category, 0])) as Record<
    SnapshotDiffCategory,
    number
  >
  for (const node of root.changed) {
    for (const category of categoriesOf(node.changes)) byCategory[category] += 1
  }
  return {
    nodesBefore: root.nodesBefore,
    nodesAfter: root.nodesAfter,
    identical: root.identical,
    descendantsChanged: root.descendantsChanged.length,
    movedWithinParent: root.movedWithinParent.length,
    movedWithParent: movedWithParent.reduce((sum, group) => sum + group.sourceIds.length, 0),
    movedRoot: root.movedRoot.length,
    movementUnknown: root.movementUnknown.length,
    changed: root.changed.length,
    added: root.added.length,
    removed: root.removed.length,
    enteredScope: root.enteredScope.length,
    leftScope: root.leftScope.length,
    unobservedBefore: root.unobserved.filter((entry) => entry.side === 'before').length,
    unobservedAfter: root.unobserved.filter((entry) => entry.side === 'after').length,
    becameUnrepresentable: root.becameUnrepresentable,
    becameRepresentable: root.becameRepresentable,
    arrived: root.arrived.length,
    departed: root.departed.length,
    byCategory,
  }
}

const NUMERIC_COUNTS = [
  'nodesBefore',
  'nodesAfter',
  'identical',
  'descendantsChanged',
  'movedWithinParent',
  'movedWithParent',
  'movedRoot',
  'movementUnknown',
  'changed',
  'added',
  'removed',
  'enteredScope',
  'leftScope',
  'unobservedBefore',
  'unobservedAfter',
  'becameUnrepresentable',
  'becameRepresentable',
  'arrived',
  'departed',
] as const

const sumCounts = (all: ReadonlyArray<DiffCounts>): DiffCounts => {
  const numbers = Object.fromEntries(
    NUMERIC_COUNTS.map((key) => [key, all.reduce((sum, counts) => sum + counts[key], 0)]),
  ) as Record<(typeof NUMERIC_COUNTS)[number], number>
  const byCategory = Object.fromEntries(
    SNAPSHOT_DIFF_CATEGORIES.map((category) => [
      category,
      all.reduce((sum, counts) => sum + counts.byCategory[category], 0),
    ]),
  ) as Record<SnapshotDiffCategory, number>
  return { ...numbers, byCategory }
}

const snapshotRefOf = (index: DocIndex): SnapshotRef => ({
  snapshotId: index.doc.provenance.snapshotId,
  canonicalHash: index.doc.canonicalHash,
  fileKey: index.doc.provenance.fileKey,
  sourceVersion: index.doc.provenance.sourceVersion,
  geometry: index.doc.provenance.geometry,
  adapter: { name: index.doc.provenance.adapter.name, version: index.doc.provenance.adapter.version },
  roots: [...index.rootIds],
  nodeCount: index.nodes.size,
  rejectionCount: index.rejections.size,
})

const rejectionSideOf = (where: Where): RejectionSide =>
  where.kind === 'absent'
    ? { state: 'absent' }
    : where.kind === 'node'
      ? { state: 'node', site: where.site, inComparedRoot: where.inScope }
      : { state: 'rejected', site: where.site, inComparedRoot: where.inScope }

/**
 * The nearest ancestor on this side that the other side could not represent.
 *
 * A node below such an ancestor is absent from the other document because
 * nothing below a rejection is ever read, not because it was deleted — so it
 * is neither added nor removed, only unobserved.
 */
const hiddenUnder = (index: DocIndex, other: DocIndex, site: NodeSite): SourceId | undefined => {
  let parentId = site.parentId
  while (parentId !== undefined) {
    if (other.rejections.has(parentId)) return parentId
    parentId = index.nodes.get(parentId)?.parentId
  }
  return undefined
}

/**
 * Compares two documents of the same file.
 *
 * Takes canonical documents rather than snapshots: both sides are then
 * normalized by the same code at the time of comparison, so a snapshot saved
 * by an older build cannot differ from a newer one merely by how it was read.
 */
export const diffSnapshots = (before: CanonicalDoc, after: CanonicalDoc): SnapshotDiff => {
  assertComparable(before, after)
  const beforeIndex = indexDocument(before)
  const afterIndex = indexDocument(after)
  assertWellFormed([
    ['before', beforeIndex],
    ['after', afterIndex],
  ])

  const inAfter = new Set(afterIndex.rootIds)
  const inBefore = new Set(beforeIndex.rootIds)
  const commonRoots = beforeIndex.rootIds.filter((id) => inAfter.has(id)).sort(compareCodeUnits)
  const beforeOnly = beforeIndex.rootIds.filter((id) => !inAfter.has(id)).sort(compareCodeUnits)
  const afterOnly = afterIndex.rootIds.filter((id) => !inBefore.has(id)).sort(compareCodeUnits)
  const common = new Set(commonRoots)

  const allIds = [
    ...new Set<SourceId>([
      ...beforeIndex.nodes.keys(),
      ...beforeIndex.rejections.keys(),
      ...afterIndex.nodes.keys(),
      ...afterIndex.rejections.keys(),
    ]),
  ].sort(compareIds)

  // Matched nodes first, in id order, so that a defect in the comparison is
  // reported for the same node whatever order the documents were walked in.
  const matched = new Map<SourceId, MatchedNode>()
  for (const id of allIds) {
    const b = beforeIndex.nodes.get(id)
    const a = afterIndex.nodes.get(id)
    if (b === undefined || a === undefined || !common.has(b.rootId) || !common.has(a.rootId)) continue
    const changes: ChangeRef[] =
      b.node.contentHash === a.node.contentHash ? [] : [...changedOwnFields(id, b.node, a.node)]
    if (!sameIds(b.childIds, a.childIds)) changes.push(CHILDREN_CHANGE)
    if (b.parentId !== a.parentId) changes.push(PARENT_CHANGE)
    matched.set(id, {
      sourceId: id,
      before: b,
      after: a,
      changes: sortChanges(changes),
      movement: movementOf(beforeIndex, afterIndex, b, a),
    })
  }

  // "Identical" is decided bottom-up and without the subtree hash. That hash
  // skips ids, and it skips a rejection's detail — so both a redrawn child
  // and a rejection whose reason was reworded would pass as unchanged.
  const identicalMemo = new Map<SourceId, boolean>()
  const identical = (id: SourceId): boolean => {
    const known = identicalMemo.get(id)
    if (known !== undefined) return known
    const node = matched.get(id)
    let result: boolean
    if (node === undefined) {
      const b = beforeIndex.rejections.get(id)
      const a = afterIndex.rejections.get(id)
      result =
        b !== undefined &&
        a !== undefined &&
        b.rejection.reason === a.rejection.reason &&
        b.rejection.detail === a.rejection.detail
    } else {
      result = node.changes.length === 0 && node.movement === undefined && node.after.childIds.every(identical)
    }
    identicalMemo.set(id, result)
    return result
  }

  const roots = new Map<string, RootAccumulator>(commonRoots.map((rootId) => [rootId, emptyAccumulator()]))
  const rootOf = (rootId: string): RootAccumulator => {
    const root = roots.get(rootId)
    if (root === undefined) throw new Error(`snapshot diff: ${rootId} is not a compared root`)
    return root
  }

  for (const site of beforeIndex.nodes.values()) if (common.has(site.rootId)) rootOf(site.rootId).nodesBefore += 1
  for (const site of afterIndex.nodes.values()) if (common.has(site.rootId)) rootOf(site.rootId).nodesAfter += 1

  const rejections: RejectionDiff[] = []

  for (const id of allIds) {
    const node = matched.get(id)
    if (node !== undefined) {
      // A matched node is classified once, under the root it is in now.
      const root = rootOf(node.after.rootId)
      if (node.before.rootId !== node.after.rootId) {
        root.arrived.push({ sourceId: id, otherRootId: node.before.rootId })
        rootOf(node.before.rootId).departed.push({ sourceId: id, otherRootId: node.after.rootId })
      }
      if (node.changes.length > 0) root.changed.push(node)
      else if (node.movement !== undefined) {
        const kind = node.movement.kind
        if (kind === 'within-parent') root.movedWithinParent.push(node)
        else if (kind === 'root') root.movedRoot.push(node)
        else if (kind === 'unknown') root.movementUnknown.push(node)
        else if (kind === 'with-parent' && node.after.parentId !== undefined) {
          const group = root.carried.get(node.after.parentId)
          if (group === undefined) root.carried.set(node.after.parentId, [id])
          else group.push(id)
        } else {
          // `reparented` always comes with a parent change, and a parent
          // change is a change: reaching here means the two disagree.
          throw new Error(`snapshot diff: ${id as string} has movement ${kind} and no change to account for it`)
        }
      } else if (identical(id)) root.identical += 1
      else root.descendantsChanged.push(node)
      continue
    }

    const b = locate(beforeIndex, common, id)
    const a = locate(afterIndex, common, id)
    const beforeIn = b.kind !== 'absent' && b.inScope
    const afterIn = a.kind !== 'absent' && a.inScope
    if (!beforeIn && !afterIn) continue

    if (b.kind === 'rejection' || a.kind === 'rejection') {
      rejections.push({ sourceId: id, before: rejectionSideOf(b), after: rejectionSideOf(a) })
      // Counted where the node was a node, so the per-root totals add up.
      if (b.kind === 'node' && b.inScope) rootOf(b.site.rootId).becameUnrepresentable += 1
      if (a.kind === 'node' && a.inScope) rootOf(a.site.rootId).becameRepresentable += 1
      continue
    }

    if (b.kind === 'node' && a.kind === 'node') {
      // One side is under a root only that side acquired. The fields are not
      // compared: that root is outside what the two documents share.
      if (b.inScope) {
        rootOf(b.site.rootId).leftScope.push({ sourceId: id, site: b.site, otherRootId: a.site.rootId })
      } else {
        rootOf(a.site.rootId).enteredScope.push({ sourceId: id, site: a.site, otherRootId: b.site.rootId })
      }
      continue
    }

    if (b.kind === 'node') {
      const under = hiddenUnder(beforeIndex, afterIndex, b.site)
      const root = rootOf(b.site.rootId)
      if (under === undefined) root.removed.push({ sourceId: id, site: b.site })
      else root.unobserved.push({ sourceId: id, site: b.site, side: 'before', under })
    } else if (a.kind === 'node') {
      const under = hiddenUnder(afterIndex, beforeIndex, a.site)
      const root = rootOf(a.site.rootId)
      if (under === undefined) root.added.push({ sourceId: id, site: a.site })
      else root.unobserved.push({ sourceId: id, site: a.site, side: 'after', under })
    }
  }

  const compared: RootDiff[] = commonRoots.map((rootId) => {
    const root = rootOf(rootId)
    const movedWithParent = carriedGroupsOf(root.carried)
    return {
      rootId,
      counts: countsOf(root, movedWithParent),
      changed: root.changed,
      movedWithinParent: root.movedWithinParent,
      movedWithParent,
      movedRoot: root.movedRoot,
      movementUnknown: root.movementUnknown,
      descendantsChanged: root.descendantsChanged,
      added: root.added,
      removed: root.removed,
      enteredScope: root.enteredScope,
      leftScope: root.leftScope,
      unobserved: root.unobserved,
      arrived: root.arrived,
      departed: root.departed,
    }
  })

  const unhashed = {
    schemaVersion: SNAPSHOT_DIFF_SCHEMA_VERSION,
    canonicalSchemaVersion: CANONICAL_SCHEMA_VERSION,
    before: snapshotRefOf(beforeIndex),
    after: snapshotRefOf(afterIndex),
    roots: { common: commonRoots, beforeOnly, afterOnly },
    total: sumCounts(compared.map((root) => root.counts)),
    compared,
    rejections,
  }
  // Hashed over the bytes a consumer receives, so equal hashes mean equal
  // output and not merely the same two inputs.
  return {
    ...unhashed,
    diffHash: hashCanonicalString(
      'snapshot-diff',
      SNAPSHOT_DIFF_SCHEMA_VERSION,
      canonicalStringify(snapshotDiffToJson(unhashed)),
    ),
  }
}
