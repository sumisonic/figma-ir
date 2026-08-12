/**
 * The wire contract for a snapshot diff, stated as a schema.
 *
 * Built like the slice's: every key required, absence as `null`, unknown keys
 * refused on decode. The serializer below writes each field by name, and the
 * tests decode what it writes — so a key that goes missing on either side
 * fails loudly instead of shipping a payload whose shape depends on its
 * values.
 *
 * One thing the schema does not check: the shape of a change's `before` and
 * `after`. That depends on the field path, and it is guaranteed by the
 * functions that write those values and by a test per path, not by decoding.
 *
 * Keys are emitted in the order written here. The CLI prints with
 * `JSON.stringify`, which keeps insertion order, so the order is part of
 * "same input, same bytes".
 */
import { Schema } from 'effect'

import type { CanonicalValue } from '../determinism/canonical.js'
import type { SourceId } from '../identity/nodeIdentity.js'
import { unsafeUnwrap } from '../text/untrusted.js'
import type { Box, LayoutFacts } from '../canonical/document.js'
import type {
  CarriedGroup,
  DiffCounts,
  MatchedNode,
  NodeSite,
  OneSidedNode,
  RejectionDiff,
  RejectionSide,
  RootDiff,
  RootTransfer,
  ScopeTransition,
  SnapshotDiff,
  SnapshotRef,
  UnobservedNode,
} from './model.js'
import { categoriesOf, shownFieldsOf, valueAt } from './present.js'
import { SNAPSHOT_DIFF_CATEGORIES, SNAPSHOT_DIFF_SCHEMA_VERSION } from './types.js'

const NullOr = Schema.NullOr

const BoxWire = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
})
const BoxPairWire = Schema.Struct({ before: BoxWire, after: BoxWire })
const NullableBoxPairWire = Schema.Struct({ before: NullOr(BoxWire), after: NullOr(BoxWire) })

const CategoryWire = Schema.Literals(SNAPSHOT_DIFF_CATEGORIES)

const nodeRefFields = {
  sourceId: Schema.String,
  name: Schema.String,
  type: Schema.String,
  parentId: NullOr(Schema.String),
  nodePath: Schema.String,
}

const ParentLayoutWire = Schema.Struct({
  mode: Schema.String,
  wrap: Schema.String,
  primaryAxisAlign: Schema.String,
  counterAxisAlign: Schema.String,
  itemSpacing: NullOr(Schema.Number),
  counterAxisSpacing: NullOr(Schema.Number),
  padding: Schema.Struct({
    top: Schema.Number,
    right: Schema.Number,
    bottom: Schema.Number,
    left: Schema.Number,
  }),
})

const PlacementWire = Schema.Struct({
  positioning: Schema.String,
  layoutAlign: NullOr(Schema.String),
  layoutGrow: NullOr(Schema.Number),
  constraints: NullOr(Schema.Struct({ horizontal: Schema.String, vertical: Schema.String })),
})

const ChangeWire = Schema.Struct({
  category: CategoryWire,
  fieldPath: Schema.String,
  before: Schema.Json,
  after: Schema.Json,
})

const MovementWire = Schema.Struct({
  kind: Schema.Literals(['with-parent', 'within-parent', 'root', 'reparented', 'unknown']),
  missing: NullOr(Schema.Literals(['box', 'parent-box'])),
  box: NullableBoxPairWire,
  relativeBox: NullableBoxPairWire,
  parentLayout: NullOr(ParentLayoutWire),
  placement: NullOr(PlacementWire),
})

const NodeRefWire = Schema.Struct(nodeRefFields)

const ChangedNodeWire = Schema.Struct({
  ...nodeRefFields,
  categories: Schema.Array(CategoryWire),
  changes: Schema.Array(ChangeWire),
  movement: NullOr(MovementWire),
})

const MovedWithinParentWire = Schema.Struct({
  ...nodeRefFields,
  box: BoxPairWire,
  relativeBox: BoxPairWire,
  parentLayout: ParentLayoutWire,
  placement: PlacementWire,
})

const CarriedGroupWire = Schema.Struct({
  parentId: Schema.String,
  sourceIds: Schema.Array(Schema.String),
})

const MovedRootWire = Schema.Struct({ ...nodeRefFields, box: BoxPairWire })

const MovementUnknownWire = Schema.Struct({
  ...nodeRefFields,
  missing: Schema.Literal('parent-box'),
  box: BoxPairWire,
  relativeBox: NullableBoxPairWire,
})

const ScopeTransitionWire = Schema.Struct({ ...nodeRefFields, otherRootId: Schema.String })

const UnobservedWire = Schema.Struct({
  ...nodeRefFields,
  side: Schema.Literals(['before', 'after']),
  under: Schema.String,
})

const RejectionSideWire = Schema.Union([
  Schema.Struct({
    state: Schema.Literal('rejected'),
    rootId: Schema.String,
    parentId: NullOr(Schema.String),
    nodePath: Schema.String,
    reason: Schema.String,
    detail: Schema.String,
    inComparedRoot: Schema.Boolean,
  }),
  Schema.Struct({
    state: Schema.Literal('node'),
    rootId: Schema.String,
    parentId: NullOr(Schema.String),
    nodePath: Schema.String,
    inComparedRoot: Schema.Boolean,
  }),
  Schema.Struct({ state: Schema.Literal('absent') }),
])

const RejectionWire = Schema.Struct({
  sourceId: Schema.String,
  before: RejectionSideWire,
  after: RejectionSideWire,
})

const CountsWire = Schema.Struct({
  nodesBefore: Schema.Number,
  nodesAfter: Schema.Number,
  identical: Schema.Number,
  descendantsChanged: Schema.Number,
  movedWithinParent: Schema.Number,
  movedWithParent: Schema.Number,
  movedRoot: Schema.Number,
  movementUnknown: Schema.Number,
  changed: Schema.Number,
  added: Schema.Number,
  removed: Schema.Number,
  enteredScope: Schema.Number,
  leftScope: Schema.Number,
  unobservedBefore: Schema.Number,
  unobservedAfter: Schema.Number,
  becameUnrepresentable: Schema.Number,
  becameRepresentable: Schema.Number,
  arrived: Schema.Number,
  departed: Schema.Number,
  // Spelled out rather than a record: a record would accept a result with a
  // category missing, and "no changes of this kind" must read as 0, not as
  // an absent key.
  byCategory: Schema.Struct({
    name: Schema.Number,
    type: Schema.Number,
    visibility: Schema.Number,
    box: Schema.Number,
    'render-bounds': Schema.Number,
    rotation: Schema.Number,
    compositing: Schema.Number,
    layout: Schema.Number,
    text: Schema.Number,
    fills: Schema.Number,
    strokes: Schema.Number,
    corners: Schema.Number,
    effects: Schema.Number,
    component: Schema.Number,
    vector: Schema.Number,
    children: Schema.Number,
    parent: Schema.Number,
  }),
})

const RootDiffWire = Schema.Struct({
  rootId: Schema.String,
  counts: CountsWire,
  changed: Schema.Array(ChangedNodeWire),
  movedWithinParent: Schema.Array(MovedWithinParentWire),
  movedWithParent: Schema.Array(CarriedGroupWire),
  movedRoot: Schema.Array(MovedRootWire),
  movementUnknown: Schema.Array(MovementUnknownWire),
  descendantsChanged: Schema.Array(NodeRefWire),
  added: Schema.Array(NodeRefWire),
  removed: Schema.Array(NodeRefWire),
  enteredScope: Schema.Array(ScopeTransitionWire),
  leftScope: Schema.Array(ScopeTransitionWire),
  unobserved: Schema.Array(UnobservedWire),
  arrived: Schema.Array(Schema.Struct({ sourceId: Schema.String, fromRootId: Schema.String })),
  departed: Schema.Array(Schema.Struct({ sourceId: Schema.String, toRootId: Schema.String })),
})

const SnapshotRefWire = Schema.Struct({
  snapshotId: Schema.String,
  canonicalHash: Schema.String,
  fileKey: Schema.String,
  sourceVersion: Schema.String,
  geometry: Schema.Literals(['none', 'paths']),
  adapter: Schema.Struct({ name: Schema.String, version: Schema.String }),
  roots: Schema.Array(Schema.String),
  nodeCount: Schema.Number,
  rejectionCount: Schema.Number,
})

export const SnapshotDiffWire = Schema.Struct({
  // A literal, not a number: a payload from another schema version must fail
  // the decode rather than read as this one with a different shape.
  schemaVersion: Schema.Literal(SNAPSHOT_DIFF_SCHEMA_VERSION),
  canonicalSchemaVersion: Schema.Number,
  before: SnapshotRefWire,
  after: SnapshotRefWire,
  roots: Schema.Struct({
    common: Schema.Array(Schema.String),
    beforeOnly: Schema.Array(Schema.String),
    afterOnly: Schema.Array(Schema.String),
  }),
  total: CountsWire,
  compared: Schema.Array(RootDiffWire),
  rejections: Schema.Array(RejectionWire),
})

export const SnapshotDiffEnvelopeWire = Schema.Struct({
  ...SnapshotDiffWire.fields,
  diffHash: Schema.String,
})

/** Decodes a value against the wire contract, rejecting unknown keys. */
export const decodeSnapshotDiffWire = (value: unknown) =>
  Schema.decodeUnknownSync(SnapshotDiffWire)(value, { onExcessProperty: 'error', errors: 'all' })

export const decodeSnapshotDiffEnvelopeWire = (value: unknown) =>
  Schema.decodeUnknownSync(SnapshotDiffEnvelopeWire)(value, { onExcessProperty: 'error', errors: 'all' })

type Json = { readonly [key: string]: CanonicalValue }

/**
 * The five fields every listed node leads with.
 *
 * Typed, and written out by name wherever an entry carries them: an entry
 * assembled by spreading would pass the decode today and still be the
 * pattern that has dropped keys from this project's output before.
 */
type NodeRefJson = {
  readonly sourceId: string
  readonly name: string
  readonly type: string
  readonly parentId: string | null
  readonly nodePath: string
}

const boxToJson = (box: Box | undefined): CanonicalValue =>
  box === undefined ? null : { x: box.x, y: box.y, width: box.width, height: box.height }

const boxPairToJson = (pair: { readonly before: Box | undefined; readonly after: Box | undefined }): Json => ({
  before: boxToJson(pair.before),
  after: boxToJson(pair.after),
})

/**
 * The name leaves as a plain string here and nowhere earlier: this is the
 * boundary where typed values become bytes. It is still text a designer
 * typed, and a consumer that concatenates it into a prompt has undone the
 * framing JSON gave it.
 */
const nodeRefToJson = (sourceId: SourceId, site: NodeSite): NodeRefJson => ({
  sourceId: sourceId as string,
  name: unsafeUnwrap(site.node.name),
  type: site.node.type,
  parentId: site.parentId === undefined ? null : (site.parentId as string),
  nodePath: site.node.path as string,
})

const parentLayoutToJson = (layout: LayoutFacts): Json => ({
  mode: layout.mode,
  wrap: layout.wrap,
  primaryAxisAlign: layout.primaryAxisAlign,
  counterAxisAlign: layout.counterAxisAlign,
  itemSpacing: layout.itemSpacing ?? null,
  counterAxisSpacing: layout.counterAxisSpacing ?? null,
  padding: {
    top: layout.padding.top,
    right: layout.padding.right,
    bottom: layout.padding.bottom,
    left: layout.padding.left,
  },
})

const placementToJson = (layout: LayoutFacts): Json => ({
  positioning: layout.positioning,
  layoutAlign: layout.layoutAlign ?? null,
  layoutGrow: layout.layoutGrow ?? null,
  constraints:
    layout.constraints === undefined
      ? null
      : { horizontal: layout.constraints.horizontal, vertical: layout.constraints.vertical },
})

/**
 * The context `within-parent` reports: how the parent lays its children out,
 * and how this child takes part. Read on the after side — it is the design
 * the reader is about to implement.
 */
const layoutContextOf = (node: MatchedNode): { readonly parentLayout: Json; readonly placement: Json } => {
  const parent = node.movement?.afterParent
  if (parent === undefined) {
    throw new Error(`snapshot diff: ${node.sourceId as string} moved within a parent that is not in the document`)
  }
  return { parentLayout: parentLayoutToJson(parent.layout), placement: placementToJson(node.after.node.layout) }
}

const movementToJson = (node: MatchedNode): CanonicalValue => {
  const movement = node.movement
  if (movement === undefined) return null
  const context = movement.kind === 'within-parent' ? layoutContextOf(node) : undefined
  return {
    kind: movement.kind,
    missing: movement.missing ?? null,
    box: boxPairToJson(movement.box),
    relativeBox: boxPairToJson(movement.relativeBox),
    parentLayout: context === undefined ? null : context.parentLayout,
    placement: context === undefined ? null : context.placement,
  }
}

const changedToJson = (node: MatchedNode): Json => {
  const shownBefore = shownFieldsOf(node.before.node)
  const shownAfter = shownFieldsOf(node.after.node)
  const ref = nodeRefToJson(node.sourceId, node.after)
  return {
    sourceId: ref.sourceId,
    name: ref.name,
    type: ref.type,
    parentId: ref.parentId,
    nodePath: ref.nodePath,
    categories: [...categoriesOf(node.changes)],
    changes: node.changes.map((change) => ({
      category: change.category,
      fieldPath: change.fieldPath,
      before: valueAt(node.before, shownBefore, change.fieldPath),
      after: valueAt(node.after, shownAfter, change.fieldPath),
    })),
    movement: movementToJson(node),
  }
}

const emptyPair = { before: undefined, after: undefined }

const movedWithinParentToJson = (node: MatchedNode): Json => {
  const context = layoutContextOf(node)
  const ref = nodeRefToJson(node.sourceId, node.after)
  return {
    sourceId: ref.sourceId,
    name: ref.name,
    type: ref.type,
    parentId: ref.parentId,
    nodePath: ref.nodePath,
    box: boxPairToJson(node.movement?.box ?? emptyPair),
    relativeBox: boxPairToJson(node.movement?.relativeBox ?? emptyPair),
    parentLayout: context.parentLayout,
    placement: context.placement,
  }
}

const movedRootToJson = (node: MatchedNode): Json => {
  const ref = nodeRefToJson(node.sourceId, node.after)
  return {
    sourceId: ref.sourceId,
    name: ref.name,
    type: ref.type,
    parentId: ref.parentId,
    nodePath: ref.nodePath,
    box: boxPairToJson(node.movement?.box ?? emptyPair),
  }
}

const movementUnknownToJson = (node: MatchedNode): Json => {
  const ref = nodeRefToJson(node.sourceId, node.after)
  return {
    sourceId: ref.sourceId,
    name: ref.name,
    type: ref.type,
    parentId: ref.parentId,
    nodePath: ref.nodePath,
    missing: 'parent-box',
    box: boxPairToJson(node.movement?.box ?? emptyPair),
    relativeBox: boxPairToJson(node.movement?.relativeBox ?? emptyPair),
  }
}

const carriedGroupToJson = (group: CarriedGroup): Json => ({
  parentId: group.parentId as string,
  sourceIds: group.sourceIds.map((id) => id as string),
})

const oneSidedToJson = (entry: OneSidedNode): Json => nodeRefToJson(entry.sourceId, entry.site)

const scopeTransitionToJson = (entry: ScopeTransition): Json => {
  const ref = nodeRefToJson(entry.sourceId, entry.site)
  return {
    sourceId: ref.sourceId,
    name: ref.name,
    type: ref.type,
    parentId: ref.parentId,
    nodePath: ref.nodePath,
    otherRootId: entry.otherRootId,
  }
}

const unobservedToJson = (entry: UnobservedNode): Json => {
  const ref = nodeRefToJson(entry.sourceId, entry.site)
  return {
    sourceId: ref.sourceId,
    name: ref.name,
    type: ref.type,
    parentId: ref.parentId,
    nodePath: ref.nodePath,
    side: entry.side,
    under: entry.under as string,
  }
}

const arrivedToJson = (entry: RootTransfer): Json => ({
  sourceId: entry.sourceId as string,
  fromRootId: entry.otherRootId,
})

const departedToJson = (entry: RootTransfer): Json => ({
  sourceId: entry.sourceId as string,
  toRootId: entry.otherRootId,
})

const countsToJson = (counts: DiffCounts): Json => ({
  nodesBefore: counts.nodesBefore,
  nodesAfter: counts.nodesAfter,
  identical: counts.identical,
  descendantsChanged: counts.descendantsChanged,
  movedWithinParent: counts.movedWithinParent,
  movedWithParent: counts.movedWithParent,
  movedRoot: counts.movedRoot,
  movementUnknown: counts.movementUnknown,
  changed: counts.changed,
  added: counts.added,
  removed: counts.removed,
  enteredScope: counts.enteredScope,
  leftScope: counts.leftScope,
  unobservedBefore: counts.unobservedBefore,
  unobservedAfter: counts.unobservedAfter,
  becameUnrepresentable: counts.becameUnrepresentable,
  becameRepresentable: counts.becameRepresentable,
  arrived: counts.arrived,
  departed: counts.departed,
  // Listed from the closed category list, in its order: every category is
  // present, including the ones that count zero.
  byCategory: Object.fromEntries(SNAPSHOT_DIFF_CATEGORIES.map((category) => [category, counts.byCategory[category]])),
})

const rootDiffToJson = (root: RootDiff): Json => ({
  rootId: root.rootId,
  counts: countsToJson(root.counts),
  changed: root.changed.map(changedToJson),
  movedWithinParent: root.movedWithinParent.map(movedWithinParentToJson),
  movedWithParent: root.movedWithParent.map(carriedGroupToJson),
  movedRoot: root.movedRoot.map(movedRootToJson),
  movementUnknown: root.movementUnknown.map(movementUnknownToJson),
  descendantsChanged: root.descendantsChanged.map((node) => nodeRefToJson(node.sourceId, node.after)),
  added: root.added.map(oneSidedToJson),
  removed: root.removed.map(oneSidedToJson),
  enteredScope: root.enteredScope.map(scopeTransitionToJson),
  leftScope: root.leftScope.map(scopeTransitionToJson),
  unobserved: root.unobserved.map(unobservedToJson),
  arrived: root.arrived.map(arrivedToJson),
  departed: root.departed.map(departedToJson),
})

const rejectionSideToJson = (side: RejectionSide): Json => {
  switch (side.state) {
    case 'rejected':
      return {
        state: 'rejected',
        rootId: side.site.rootId,
        parentId: side.site.parentId === undefined ? null : (side.site.parentId as string),
        nodePath: side.site.rejection.path as string,
        reason: side.site.rejection.reason,
        detail: side.site.rejection.detail,
        inComparedRoot: side.inComparedRoot,
      }
    case 'node':
      return {
        state: 'node',
        rootId: side.site.rootId,
        parentId: side.site.parentId === undefined ? null : (side.site.parentId as string),
        nodePath: side.site.node.path as string,
        inComparedRoot: side.inComparedRoot,
      }
    case 'absent':
      return { state: 'absent' }
  }
}

const rejectionToJson = (entry: RejectionDiff): Json => ({
  sourceId: entry.sourceId as string,
  before: rejectionSideToJson(entry.before),
  after: rejectionSideToJson(entry.after),
})

/**
 * `acquiredAt` is left out on purpose. It is a clock: the same design
 * acquired twice would diff to different bytes, and the result's hash would
 * stop meaning "this comparison".
 */
const snapshotRefToJson = (ref: SnapshotRef): Json => ({
  snapshotId: ref.snapshotId as string,
  canonicalHash: ref.canonicalHash as string,
  fileKey: ref.fileKey,
  sourceVersion: ref.sourceVersion,
  geometry: ref.geometry,
  adapter: { name: ref.adapter.name, version: ref.adapter.version },
  roots: [...ref.roots],
  nodeCount: ref.nodeCount,
  rejectionCount: ref.rejectionCount,
})

const payloadOf = (diff: Omit<SnapshotDiff, 'diffHash'>) => ({
  schemaVersion: diff.schemaVersion,
  canonicalSchemaVersion: diff.canonicalSchemaVersion,
  before: snapshotRefToJson(diff.before),
  after: snapshotRefToJson(diff.after),
  roots: {
    common: [...diff.roots.common],
    beforeOnly: [...diff.roots.beforeOnly],
    afterOnly: [...diff.roots.afterOnly],
  },
  total: countsToJson(diff.total),
  compared: diff.compared.map(rootDiffToJson),
  rejections: diff.rejections.map(rejectionToJson),
})

/** Serializes a diff as plain JSON data, without its own hash. */
export const snapshotDiffToJson = (diff: Omit<SnapshotDiff, 'diffHash'>): CanonicalValue => payloadOf(diff)

/**
 * The form a consumer receives: the payload plus its own hash, last.
 *
 * Separate from {@link snapshotDiffToJson} because a value cannot contain its
 * own digest.
 */
export const snapshotDiffEnvelope = (diff: SnapshotDiff): CanonicalValue => {
  const payload = payloadOf(diff)
  return {
    schemaVersion: payload.schemaVersion,
    canonicalSchemaVersion: payload.canonicalSchemaVersion,
    before: payload.before,
    after: payload.after,
    roots: payload.roots,
    total: payload.total,
    compared: payload.compared,
    rejections: payload.rejections,
    diffHash: diff.diffHash as string,
  }
}
