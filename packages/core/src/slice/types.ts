/**
 * Slices: the bounded view a consumer actually reads.
 *
 * The whole document is the wrong thing to hand a model. A single component
 * runs to hundreds of nodes and a full file read measures in the hundreds of
 * megabytes, so the question is never "can it fit" but "which part is this
 * task about". A slice answers that, and says what it left out, so a reader
 * can tell a small design from a small excerpt.
 */
import type { Hash } from '../determinism/hash.js'
import type { SourceId } from '../identity/nodeIdentity.js'
import type { TextScan, Untrusted } from '../text/untrusted.js'
import type { Box, CanonicalEffect, CanonicalNode, CharacterOverrideRun, LayoutFacts, StrokeWeights, StyleRef, StyleValue, TextFacts, VectorGeometry } from '../canonical/document.js'
import type { ChildOverflow, FactDiagnostic, Known, ResponsiveGroupFact } from '../facts/types.js'
import type { Finding } from '../rules/types.js'

/** Bumped to 2 when raw paints regained their three-state wrapper on the wire. */
export const SLICE_SCHEMA_VERSION = 4

/** What a slice was asked for. Part of its identity. */
export interface SliceRequest {
  /** Node ids to include, with their subtrees. */
  readonly roots: ReadonlyArray<string>
  /** How deep to descend. Omitted means all the way down. */
  readonly maxDepth?: number
  /**
   * Most nodes to emit.
   *
   * Depth alone does not bound anything: one very wide root at depth one is
   * still enormous. This is the limit that makes "bounded" true, and hitting
   * it is reported rather than silently shortening the answer.
   */
  readonly maxNodes?: number
  /** Include nodes that are not rendered. Off by default: a hidden layer is not there. */
  readonly includeHidden?: boolean
}

export const DEFAULT_MAX_NODES = 2000

/**
 * A node as it appears in a slice.
 *
 * Flattened deliberately: a consumer reading this wants to find a node and its
 * facts, not to walk a tree it already has the shape of. Hashes travel with it
 * so an unchanged branch is recognisable without re-reading it.
 */
export interface SliceNode {
  readonly sourceId: SourceId
  readonly parentId: SourceId | undefined
  readonly name: Untrusted
  readonly type: string
  readonly depth: number
  readonly visualOrderIndex: number
  readonly visualOrderReliable: boolean
  readonly rendered: boolean
  readonly box: Box | undefined
  /**
   * The visual extent, when it differs from the layout box.
   *
   * A cap-height-trimmed label's layout box is not where its ink is, and a
   * stroke or shadow paints outside the box entirely. A pilot had to reverse-
   * engineer this distinction from the raw snapshot because the slice
   * dropped it; the canonical layer carried it all along.
   */
  readonly renderBounds: Box | undefined
  readonly relativeBox: Box | undefined
  /** How far in-flow children reach past this box (see NodeFact). */
  readonly observedChildOverflow: Known<ChildOverflow>
  readonly layout: LayoutFacts
  readonly rotation: number | undefined
  readonly opacity: number | undefined
  readonly blendMode: string | undefined
  readonly characters: Untrusted | undefined
  readonly textStyle: StyleRef | undefined
  /**
   * The type style, as declared.
   *
   * Without it a consumer has to recover font size and spacing from a
   * screenshot, which is the measuring-by-looking this whole pipeline exists to
   * replace.
   */
  readonly typography: TextFacts['style'] | undefined
  /** True when parts of the string carry their own styling, which one styleKey cannot express. */
  readonly hasCharacterOverrides: boolean
  /** Which ranges, and what they say (text nodes only). */
  readonly characterOverrideRuns: ReadonlyArray<CharacterOverrideRun> | undefined
  /** Heuristic injection scan, carried so a gate downstream can act on it. */
  readonly textScan: TextScan | undefined
  readonly fills: ReadonlyArray<StyleValue>
  readonly strokes: ReadonlyArray<StyleValue>
  readonly strokeWeight: number | undefined
  readonly individualStrokeWeights: StrokeWeights | undefined
  readonly strokeAlign: string | undefined
  readonly cornerRadius: number | undefined
  readonly rectangleCornerRadii: ReadonlyArray<number> | undefined
  readonly effects: ReadonlyArray<CanonicalEffect>
  readonly componentId: string | undefined
  /** The drawing, when acquired; `unknown` when not asked for, `absent` on text. */
  readonly vectorGeometry: VectorGeometry
  readonly contentHash: Hash<'content'>
  readonly subtreeHash: Hash<'subtree'>
  /**
   * Set when the subtree was cut short, so the gap is visible on the node
   * itself rather than only implied by an entry in `omitted`. Either the
   * depth limit stopped here, or the node budget ran out among its children.
   */
  readonly truncated: { readonly reason: 'max-depth' | 'max-nodes'; readonly childCount: number } | undefined
}

export interface Slice {
  readonly schemaVersion: number
  readonly request: SliceRequest
  /** The document this was cut from. */
  readonly canonicalHash: Hash<'canonical'>
  readonly snapshotId: Hash<'canonical'>
  readonly fileKey: string
  readonly sourceVersion: string
  /**
   * What was asked for: the document plus the normalized request.
   *
   * Two runs with the same value looked at the same part of the same design.
   * They may still have produced different bytes, because findings depend on
   * the ruleset -- which is why this is not the only hash here.
   */
  readonly sliceRequestHash: Hash<'slice'>
  /**
   * What came out.
   *
   * Covers the serialized payload, findings included, so equal hashes really do
   * mean equal bytes. A consumer caching on the request hash alone would miss a
   * change in diagnostics.
   */
  readonly sliceHash: Hash<'slice'>
  readonly nodes: ReadonlyArray<SliceNode>
  /**
   * Subtrees left out, summarized.
   *
   * A list of every omitted node would be unbounded for exactly the inputs that
   * need bounding, so each entry is the root of what was dropped plus how much
   * of it there was. A slice that hides its omissions reads as complete.
   */
  readonly omitted: ReadonlyArray<{
    readonly sourceId: SourceId
    readonly parentId: SourceId | undefined
    readonly reason: 'not-rendered' | 'max-depth' | 'max-nodes'
    readonly descendantCount: number
  }>
  /**
   * How the breakpoints of this design line up, for the roots in scope.
   *
   * The comparison a consumer would otherwise do by eye, and get wrong: this is
   * where "sm stacks, md is three columns" is legible without measuring
   * anything.
   */
  readonly responsive: ReadonlyArray<ResponsiveGroupFact>
  /** Derivation problems, so a reader can tell a checked file from an unlined-up one. */
  readonly derivation: ReadonlyArray<FactDiagnostic>
  readonly findings: ReadonlyArray<SliceFinding>
}

/** A finding, marked when it also concerns nodes this slice does not contain. */
export interface SliceFinding {
  readonly finding: Finding
  /** Node ids the finding cites that are outside this slice. */
  readonly externalSourceIds: ReadonlyArray<SourceId>
}

export type { CanonicalNode }
