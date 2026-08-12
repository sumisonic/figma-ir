/**
 * The canonical document: what Figma actually says, normalized.
 *
 * The subset kept here is declared rather than incidental, and
 * `CANONICAL_SCHEMA_VERSION` namespaces that decision so a later change to what
 * we keep cannot make two documents falsely comparable.
 *
 * The bias throughout is to record rather than resolve. Where Figma declares
 * two separate things — a colour's own alpha and the paint's opacity, a node's
 * own visibility and its ancestors' — both are kept, because combining them is
 * a decision that belongs to a layer that knows what the combination is for.
 */
import type { Hash } from '../determinism/hash.js'
import type { NodePath, SourceId, StableKey } from '../identity/nodeIdentity.js'
import type { ReasonCode } from '../diagnostics/reason.js'
import type { TextScan, Untrusted } from '../text/untrusted.js'

export const CANONICAL_SCHEMA_VERSION = 3

/**
 * Node types this pipeline understands.
 *
 * Anything else becomes a rejection rather than a silently dropped branch: a
 * missing node is indistinguishable from a node that was never there, and the
 * generator would have no way to know it was working from a partial design.
 */
export const SUPPORTED_NODE_TYPES = [
  'COMPONENT',
  'COMPONENT_SET',
  'FRAME',
  'GROUP',
  'INSTANCE',
  'RECTANGLE',
  'TEXT',
  'VECTOR',
  'LINE',
  'ELLIPSE',
  'POLYGON',
  'STAR',
  'BOOLEAN_OPERATION',
] as const
export type NodeType = (typeof SUPPORTED_NODE_TYPES)[number]

const SUPPORTED = new Set<string>(SUPPORTED_NODE_TYPES)
export const isSupportedNodeType = (type: string): type is NodeType => SUPPORTED.has(type)

/** Absolute box in px, rounded to slot precision. */
export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * A style slot in one of three states.
 *
 * `unresolved` is the one that earns its keep: a reference we could not follow
 * is not the same as no reference, and collapsing the two would let a design
 * with a broken token silently produce a hard-coded value.
 */
export type StyleValue =
  | { readonly kind: 'token'; readonly styleId: string; readonly name: Untrusted; readonly styleType: string }
  | { readonly kind: 'raw'; readonly value: CanonicalPaint }
  | { readonly kind: 'unresolved'; readonly styleId: string; readonly reason: ReasonCode }

/** A reference to a named style, in the same three states. */
export type StyleRef =
  | { readonly kind: 'token'; readonly styleId: string; readonly name: Untrusted; readonly styleType: string }
  | { readonly kind: 'unresolved'; readonly styleId: string; readonly reason: ReasonCode }

/** RGBA as declared, each channel 0..1. The alpha here is the colour's own. */
export type Rgba = readonly [number, number, number, number]

/**
 * A paint, kept close to how Figma declares it.
 *
 * `opacity` stays separate from the colour's alpha rather than being multiplied
 * in. They are two things a designer set independently, and a layer that needs
 * the product can compute it — whereas a layer that needs to know which one was
 * changed cannot recover it from a single number.
 */
export interface PaintCommon {
  readonly visible: boolean
  readonly opacity: number | undefined
  readonly blendMode: string | undefined
}

export type CanonicalPaint =
  | ({ readonly kind: 'solid'; readonly rgba: Rgba } & PaintCommon)
  | ({
      readonly kind: 'gradient'
      readonly gradientType: string
      readonly stops: ReadonlyArray<GradientStop>
      /** Direction and extent. Without these, two differently-angled gradients look identical. */
      readonly handles: ReadonlyArray<{ readonly x: number; readonly y: number }>
    } & PaintCommon)
  | ({
      readonly kind: 'image'
      readonly imageRef: string | undefined
      readonly scaleMode: string | undefined
    } & PaintCommon)
  | ({ readonly kind: 'other'; readonly paintType: string } & PaintCommon)

export interface GradientStop {
  readonly position: number
  readonly rgba: Rgba
}

/** A visual effect, kept declaratively. */
export interface CanonicalEffect {
  readonly type: string
  readonly visible: boolean
  readonly radius: number | undefined
  readonly spread: number | undefined
  readonly offset: { readonly x: number; readonly y: number } | undefined
  readonly rgba: Rgba | undefined
  readonly blendMode: string | undefined
}

/** How a node responds to its frame being resized, outside auto-layout. */
export interface Constraints {
  readonly horizontal: string
  readonly vertical: string
}

/**
 * Auto-layout as Figma states it, with no interpretation.
 *
 * `HUG` and `FILL` stay in Figma's vocabulary here on purpose. What they mean
 * in CSS depends on the parent, and resolving that is the web projection's job
 * — doing it here would bake a web assumption into the layer that is supposed
 * to be a faithful record of the source.
 */
export interface LayoutFacts {
  readonly mode: 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'GRID' | 'unknown'
  readonly wrap: 'NO_WRAP' | 'WRAP' | 'unknown'
  /**
   * Closed sets, validated at the adapter (REG-CANON-010): a value the
   * API returns that is not in the set becomes `unknown` rather than being
   * cast into a known member. Downstream layers branch on these values, and
   * a mislabelled branch is silent; `unknown` fails closed. Absence stays
   * `MIN`, which is Figma's documented default for auto-layout frames.
   */
  readonly primaryAxisAlign: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN' | 'unknown'
  readonly counterAxisAlign: 'MIN' | 'CENTER' | 'MAX' | 'BASELINE' | 'unknown'
  readonly counterAxisAlignContent: 'AUTO' | 'SPACE_BETWEEN' | 'unknown' | undefined
  readonly primaryAxisSizingMode: 'FIXED' | 'AUTO' | 'unknown' | undefined
  readonly counterAxisSizingMode: 'FIXED' | 'AUTO' | 'unknown' | undefined
  readonly sizingHorizontal: 'FIXED' | 'HUG' | 'FILL' | 'UNSPECIFIED'
  readonly sizingVertical: 'FIXED' | 'HUG' | 'FILL' | 'UNSPECIFIED'
  readonly itemSpacing: number | undefined
  readonly counterAxisSpacing: number | undefined
  readonly padding: {
    readonly top: number
    readonly right: number
    readonly bottom: number
    readonly left: number
  }
  /**
   * Exactly what Figma declared, including having declared nothing.
   *
   * `unstated` means the field was absent — which happens outside auto-layout,
   * where coordinates are all the source offers. Inferring "flows normally"
   * from the presence of a sibling field would be translation, and translation
   * is the next layer's job.
   */
  readonly positioning: 'AUTO' | 'ABSOLUTE' | 'unstated'
  /** Child-side auto-layout declarations, kept verbatim. */
  readonly layoutAlign: string | undefined
  readonly layoutGrow: number | undefined
  readonly constraints: Constraints | undefined
  readonly overflowDirection: string | undefined
  readonly clipsContent: boolean
}

/**
 * A closed set, validated at the adapter (REG-CANON-010). Absent on the base
 * style means the documented default, `NONE`.
 */
export type TextDecoration = 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH' | 'unknown'

/**
 * One maximal run of characters that reference the same style override.
 *
 * `start`/`end` index the source's override array (end exclusive) — the
 * unit the API defines, which is not asserted to be a code point or a UTF-16
 * unit. Only overridden runs are listed: characters outside every run carry
 * the base style, by the API's own definition. The per-field values are what
 * the override entry says; `unstated` records that the entry says nothing
 * about the field, which is not the same as saying it inherits — the source
 * does not document inheritance, so the IR does not assume it.
 */
export interface CharacterOverrideRun {
  readonly start: number
  readonly end: number
  /** As the source wrote it; undefined when the entry was not a number at all. */
  readonly overrideId: number | undefined
  readonly textDecoration: TextDecoration | 'unstated'
}

export interface TextFacts {
  /** The string as typed by a designer. Data, never instruction. */
  readonly characters: Untrusted
  /**
   * The named text style, when one is applied.
   *
   * This is the field a project's naming convention lives in, if it has one
   * (declared in the facts configuration, never assumed here), and the one a
   * token mapping needs. The literal font values below cannot substitute for
   * it: they cannot tell a token from a one-off, and they cannot detect a
   * misnamed or dangling style.
   */
  readonly styleRef: StyleRef | undefined
  readonly style: {
    readonly fontFamily: Untrusted
    readonly fontPostScriptName: Untrusted | undefined
    readonly fontWeight: number
    readonly fontSize: number
    readonly letterSpacing: number
    readonly lineHeightPx: number
    readonly lineHeightPercentFontSize: number | undefined
    readonly textAlignHorizontal: string
    readonly textAlignVertical: string
    readonly textAutoResize: string | undefined
    /**
     * Vertical trim, kept verbatim (e.g. `CAP_HEIGHT`).
     *
     * This field changes rendered geometry: a 20px/35px-line label trimmed to
     * cap height measures ~15px tall in the design. Dropping it left a real
     * render 7px off with nothing in the IR to explain why.
     */
    readonly leadingTrim: string | undefined
    /**
     * OpenType features as declared (e.g. `{ PALT: 1 }`).
     *
     * Proportional alternates change glyph advance widths, which changes
     * line breaks. A pilot rediscovered a declared `palt` by measuring the
     * render, because this field was dropped on the way in.
     */
    readonly opentypeFlags: Readonly<Record<string, number>> | undefined
    /**
     * Underline or strikethrough on the whole string.
     *
     * A pilot had to read the raw snapshot's override table to learn whether
     * a label was underlined, because the IR reduced overrides to a boolean.
     * The base value lives here; per-range overrides are the runs below.
     */
    readonly textDecoration: TextDecoration
  }
  /** Heuristic scan for instruction-shaped content. Never a verdict. */
  readonly scan: TextScan
  /** True when parts of the string carry their own overrides. */
  readonly hasCharacterOverrides: boolean
  /** The overridden ranges, in source order. Empty when the string is uniformly styled. */
  readonly characterOverrideRuns: ReadonlyArray<CharacterOverrideRun>
}

/** One path as the source draws it: SVG path data plus its fill rule. */
export interface PathSpec {
  readonly path: string
  readonly windingRule: string
}

/**
 * A node's vector paths, in the three states a value can be in.
 *
 * `known` when the acquisition asked for paths (both lists may be empty);
 * `unknown` with `GEOMETRY_NOT_ACQUIRED` when it did not — the source only
 * returns paths on request, and "not requested" must never read as "no
 * shape" (REG-ACQ-015); `absent` on text, whose outlines are font output
 * rather than anything a designer drew. `geometryHash` is an exact-match
 * identity for the paths, so "is this the same drawing" is answerable
 * without carrying the paths around — it does not normalise for size.
 */
export type VectorGeometry =
  | {
      readonly kind: 'known'
      readonly fill: ReadonlyArray<PathSpec>
      readonly stroke: ReadonlyArray<PathSpec>
      readonly geometryHash: Hash<'geometry'>
    }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unknown'; readonly reason: ReasonCode }

export interface StrokeWeights {
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly left: number
}

export interface CanonicalNode {
  readonly sourceId: SourceId
  readonly path: NodePath
  /** Matching fingerprint. Never used as a key. */
  readonly stableKey: StableKey
  readonly name: Untrusted
  readonly type: NodeType
  /** What this node declares about itself. */
  readonly selfVisible: boolean
  /**
   * Visibility of this node and every ancestor, resolved once.
   *
   * Kept alongside `selfVisible` rather than instead of it: under a hidden
   * ancestor the effective value cannot change, so on its own it would make a
   * designer toggling this node invisible to every hash in the system.
   */
  readonly effectiveVisible: boolean
  readonly geometry: Box | undefined
  /** Visual extent including shadows and thick strokes. Not the layout box. */
  readonly renderBounds: Box | undefined
  readonly rotation: number | undefined
  readonly opacity: number | undefined
  readonly blendMode: string | undefined
  readonly layout: LayoutFacts
  readonly text: TextFacts | undefined
  readonly fills: ReadonlyArray<StyleValue>
  readonly strokes: ReadonlyArray<StyleValue>
  /** Border geometry. A colour on its own cannot produce a border. */
  readonly strokeWeight: number | undefined
  /**
   * Per-side stroke weights, when the sides differ.
   *
   * Only returned by the source when individual weights are in use, and kept
   * exactly so: a single-value `strokeWeight` is not expanded into four sides
   * here, because "the designer said one number" and "the designer said four"
   * are different facts, and a consumer that needs four sides can derive them
   * with the provenance intact. Without this field an underline-only border
   * and a full box are the same IR (REG-CANON-013).
   */
  readonly individualStrokeWeights: StrokeWeights | undefined
  readonly strokeAlign: string | undefined
  readonly cornerRadius: number | undefined
  /** Per-corner radii, when the corners differ. */
  readonly rectangleCornerRadii: ReadonlyArray<number> | undefined
  readonly effects: ReadonlyArray<CanonicalEffect>
  /** Set on INSTANCE nodes: which component this is an instance of. */
  readonly componentId: string | undefined
  readonly vectorGeometry: VectorGeometry
  readonly children: ReadonlyArray<CanonicalNode>
  readonly contentHash: Hash<'content'>
  readonly subtreeHash: Hash<'subtree'>
}

/** A node that could not be represented, recorded rather than dropped. */
export interface CanonicalRejection {
  readonly sourceId: SourceId
  readonly path: NodePath
  readonly reason: ReasonCode
  readonly detail: string
}

export interface CanonicalProvenance {
  readonly schemaVersion: number
  readonly snapshotId: Hash<'canonical'>
  readonly fileKey: string
  readonly sourceVersion: string
  readonly roots: ReadonlyArray<string>
  /** Whether the acquisition asked for vector paths. */
  readonly geometry: 'none' | 'paths'
  readonly adapter: { readonly name: string; readonly version: string }
  /** Volatile: excluded from `canonicalHash` by declaration, not by convention. */
  readonly acquiredAt: string
}

export interface CanonicalDoc {
  readonly provenance: CanonicalProvenance
  readonly roots: ReadonlyArray<CanonicalNode>
  readonly rejections: ReadonlyArray<CanonicalRejection>
  readonly canonicalHash: Hash<'canonical'>
}

/**
 * Provenance fields excluded from `canonicalHash`.
 *
 * `acquiredAt` is a clock. `snapshotId` digests the raw payload including every
 * field this document deliberately drops, so leaving it in would make an edit
 * to an interaction or a render bound look like a change to the design.
 * `sourceVersion` is file-wide and moves when anything in the file moves,
 * including pages we never asked for. All three stay in provenance, where they
 * describe where the document came from without pretending to identify it.
 */
export const VOLATILE_PATHS = [
  ['provenance', 'acquiredAt'],
  ['provenance', 'snapshotId'],
  ['provenance', 'sourceVersion'],
] as const
