/**
 * The shape of a comparison before it becomes JSON.
 *
 * Deliberately holds references to the two documents' nodes rather than the
 * values that changed: names and text stay `Untrusted` for as long as they
 * are in memory, and the one place they become plain strings is the
 * serializer. A model that stored the before/after values would have had to
 * unwrap them here, where nothing is leaving.
 *
 * Off the package's public surface except for `SnapshotDiff` itself.
 */
import type { Hash } from '../determinism/hash.js'
import type { SourceId } from '../identity/nodeIdentity.js'
import type { Box, CanonicalNode, CanonicalRejection } from '../canonical/document.js'
import type { SnapshotDiffCategory } from './types.js'

/** Where a node sits in one document. */
export interface NodeSite {
  readonly node: CanonicalNode
  readonly rootId: string
  readonly parentId: SourceId | undefined
  /**
   * Child ids in source order, rejected children included.
   *
   * `CanonicalNode.children` leaves the rejected ones out, so a list built
   * from it alone would call "a child became unrepresentable" a reordering.
   */
  readonly childIds: ReadonlyArray<SourceId>
}

/** Where a rejection sits in one document, recovered from its path. */
export interface RejectionSite {
  readonly rejection: CanonicalRejection
  readonly rootId: string
  readonly parentId: SourceId | undefined
}

/** One thing that changed on a node. The values are read off the nodes when serializing. */
export interface ChangeRef {
  readonly category: SnapshotDiffCategory
  readonly fieldPath: string
}

export type MovementKind = 'with-parent' | 'within-parent' | 'root' | 'reparented' | 'unknown'

/**
 * How a node's position changed, as far as two bounding boxes can say.
 *
 * `relativeBox` is the offset between two axis-aligned boxes. For a rotated
 * node that is not its position inside the parent — the documents do not
 * carry a transform — which is why this names the boxes it compared instead
 * of claiming a coordinate system.
 */
export interface Movement {
  readonly kind: MovementKind
  /** Set only for `unknown`: which box was missing, on one side or both. */
  readonly missing: 'box' | 'parent-box' | undefined
  readonly box: { readonly before: Box | undefined; readonly after: Box | undefined }
  readonly relativeBox: { readonly before: Box | undefined; readonly after: Box | undefined }
  /** The parent on the after side: where `within-parent` reads the layout it reports. */
  readonly afterParent: CanonicalNode | undefined
}

/** A node present, as a node, under a compared root on both sides. */
export interface MatchedNode {
  readonly sourceId: SourceId
  readonly before: NodeSite
  readonly after: NodeSite
  readonly changes: ReadonlyArray<ChangeRef>
  readonly movement: Movement | undefined
}

/**
 * Nodes that differ only in absolute position, grouped by their direct parent.
 *
 * The parent is a grouping key and nothing more. It is not offered as the
 * reason they moved: a node keeps its offset from its parent when an ancestor
 * three levels up was nudged, too.
 */
export interface CarriedGroup {
  readonly parentId: SourceId
  readonly sourceIds: ReadonlyArray<SourceId>
}

export interface OneSidedNode {
  readonly sourceId: SourceId
  readonly site: NodeSite
}

export interface ScopeTransition {
  readonly sourceId: SourceId
  /** The side that is under a compared root. */
  readonly site: NodeSite
  /** The root it is under on the other side, which only that side acquired. */
  readonly otherRootId: string
}

export interface UnobservedNode {
  readonly sourceId: SourceId
  readonly site: NodeSite
  readonly side: 'before' | 'after'
  /** The nearest ancestor that the other side could not represent. */
  readonly under: SourceId
}

export interface RootTransfer {
  readonly sourceId: SourceId
  readonly otherRootId: string
}

export interface DiffCounts {
  readonly nodesBefore: number
  readonly nodesAfter: number
  readonly identical: number
  readonly descendantsChanged: number
  readonly movedWithinParent: number
  readonly movedWithParent: number
  readonly movedRoot: number
  readonly movementUnknown: number
  readonly changed: number
  readonly added: number
  readonly removed: number
  readonly enteredScope: number
  readonly leftScope: number
  readonly unobservedBefore: number
  readonly unobservedAfter: number
  readonly becameUnrepresentable: number
  readonly becameRepresentable: number
  readonly arrived: number
  readonly departed: number
  readonly byCategory: Readonly<Record<SnapshotDiffCategory, number>>
}

export interface RootDiff {
  readonly rootId: string
  readonly counts: DiffCounts
  readonly changed: ReadonlyArray<MatchedNode>
  readonly movedWithinParent: ReadonlyArray<MatchedNode>
  readonly movedWithParent: ReadonlyArray<CarriedGroup>
  readonly movedRoot: ReadonlyArray<MatchedNode>
  readonly movementUnknown: ReadonlyArray<MatchedNode>
  readonly descendantsChanged: ReadonlyArray<MatchedNode>
  readonly added: ReadonlyArray<OneSidedNode>
  readonly removed: ReadonlyArray<OneSidedNode>
  readonly enteredScope: ReadonlyArray<ScopeTransition>
  readonly leftScope: ReadonlyArray<ScopeTransition>
  readonly unobserved: ReadonlyArray<UnobservedNode>
  readonly arrived: ReadonlyArray<RootTransfer>
  readonly departed: ReadonlyArray<RootTransfer>
}

export type RejectionSide =
  | { readonly state: 'rejected'; readonly site: RejectionSite; readonly inComparedRoot: boolean }
  | { readonly state: 'node'; readonly site: NodeSite; readonly inComparedRoot: boolean }
  | { readonly state: 'absent' }

export interface RejectionDiff {
  readonly sourceId: SourceId
  readonly before: RejectionSide
  readonly after: RejectionSide
}

export interface SnapshotRef {
  readonly snapshotId: Hash<'canonical'>
  readonly canonicalHash: Hash<'canonical'>
  readonly fileKey: string
  readonly sourceVersion: string
  readonly geometry: 'none' | 'paths'
  readonly adapter: { readonly name: string; readonly version: string }
  readonly roots: ReadonlyArray<string>
  readonly nodeCount: number
  readonly rejectionCount: number
}

export interface SnapshotDiff {
  readonly schemaVersion: number
  readonly canonicalSchemaVersion: number
  readonly before: SnapshotRef
  readonly after: SnapshotRef
  readonly roots: {
    readonly common: ReadonlyArray<string>
    readonly beforeOnly: ReadonlyArray<string>
    readonly afterOnly: ReadonlyArray<string>
  }
  readonly total: DiffCounts
  readonly compared: ReadonlyArray<RootDiff>
  readonly rejections: ReadonlyArray<RejectionDiff>
  readonly diffHash: Hash<'snapshot-diff'>
}
