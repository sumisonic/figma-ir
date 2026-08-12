/**
 * Facts: values derived deterministically from a canonical document.
 *
 * Rules need to ask questions a single node cannot answer. "Is this footer's
 * font consistent across breakpoints?" requires comparing four trees; "which
 * section comes first?" requires sorting by position rather than by the order
 * the layers happen to sit in. Doing that walk inside every rule means every
 * rule gets its own chance to do it differently.
 *
 * Facts never modify the document, are derived from it plus configuration and
 * nothing else, and say `unknown` where the answer is not determined rather
 * than picking the likely one.
 */
import type { Hash } from '../determinism/hash.js'
import type { SourceId } from '../identity/nodeIdentity.js'
import type { ReasonCode } from '../diagnostics/reason.js'
import type { Untrusted } from '../text/untrusted.js'
import type { Box, CanonicalNode, LayoutFacts, StrokeWeights, StyleRef, StyleValue, TextFacts } from '../canonical/document.js'

export const FACTS_SCHEMA_VERSION = 5

/** A value that may be present, absent by design, or simply not determined. */
export type Known<A> =
  | { readonly kind: 'known'; readonly value: A }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unknown'; readonly reason: ReasonCode }

export const known = <A>(value: A): Known<A> => ({ kind: 'known', value })
export const absent = <A>(): Known<A> => ({ kind: 'absent' })
export const unknown = <A>(reason: ReasonCode): Known<A> => ({ kind: 'unknown', reason })

export interface ChildOverflow {
  readonly leftPx: number
  readonly rightPx: number
  readonly topPx: number
  readonly bottomPx: number
  /** The children that reach past the box on any side, sorted. */
  readonly sourceIds: ReadonlyArray<SourceId>
}

export interface NodeFact {
  readonly sourceId: SourceId
  readonly parentId: SourceId | undefined
  /** Root first. Lets a rule ask about context without walking the tree itself. */
  readonly ancestorIds: ReadonlyArray<SourceId>
  readonly depth: number
  /**
   * Whether this node and all its ancestors are visible.
   *
   * Resolved once here so that "a hidden layer is not there" is a property of
   * the data rather than a rule every consumer has to remember.
   */
  readonly rendered: boolean
  /**
   * Position among rendered siblings, top to bottom then left to right.
   *
   * The child array is z-order, which is not reading order: in a real page
   * the two disagreed in several places, starting at the artboard root
   * (REG-ORDER-002). Anything that says "the first section" means this, not
   * the array index.
   */
  readonly visualOrderIndex: number
  /**
   * Whether that order means anything.
   *
   * Top-left ordering describes a stacked layout well and says very little
   * about siblings that overlap or are rotated, where "before" is not a
   * property of the geometry at all. The index is still produced, because it is
   * deterministic and useful for display, but a rule that reasons about
   * sequence should check this first.
   */
  readonly visualOrderReliable: boolean
  /** Box relative to the parent, which is what a layout is actually written in. */
  readonly relativeBox: Box | undefined
  /** The node's own layout mode, so a rule about "is this laid out automatically" needs no other index. */
  readonly layoutMode: LayoutFacts['mode']
  /**
   * How far the rendered, in-flow children reach past this node's own box,
   * per side, in px (never negative).
   *
   * A horizontally scrolling row is drawn in the design with its cards
   * spilling out of the frame, so the frame's width is the width of the
   * spill, not of the viewport it will scroll in. A reader who took that
   * width as a design value verified against the wrong number. This is the
   * observation only: what the overflow *means* (a scroller, a clip, a
   * mistake) is read together with `overflowDirection` and `clipsContent`
   * by whoever consumes it.
   */
  readonly observedChildOverflow: Known<ChildOverflow>
  /**
   * The named text style applied to this node.
   *
   * Kept as the reference rather than a bare name: the layer below
   * distinguishes "no style applied" from "a style reference we could not
   * follow", and a dangling reference is one of the more interesting things a
   * naming rule can find.
   */
  readonly textStyle: StyleRef | undefined
  /** Name path from the containing root, e.g. `contents/nav/ABOUT`. */
  readonly namePath: ReadonlyArray<Untrusted>
}

/**
 * One named text style and everywhere it is used.
 *
 * When the project has declared a naming convention (`StyleNameConfig`) and
 * the name follows it, the parts are kept so that a rule can compare like
 * with like without re-parsing. When it does not, that is recorded rather
 * than patched — a misnamed style is a message for the designer. With no
 * convention declared, `parsed` is `absent`: nothing was checked, and nothing
 * claims to have been.
 */
export interface TextStyleFact {
  readonly styleId: string
  readonly name: Untrusted
  readonly parsed: Known<StyleNameParts>
  readonly usedBy: ReadonlyArray<SourceId>
  /** Distinct font declarations found under this style id, for consistency checks. */
  readonly fonts: ReadonlyArray<FontFact>
}

/** The segments of a name, in pattern order. An array rather than a keyed object: the order is part of the fact. */
export type StyleNameParts = ReadonlyArray<{ readonly segment: string; readonly value: Untrusted }>

/** The value of one named segment, or undefined when the parts do not carry it. */
export const styleNamePart = (parts: StyleNameParts, segment: string): Untrusted | undefined =>
  parts.find((part) => part.segment === segment)?.value

export interface FontFact {
  readonly family: Untrusted
  readonly postScriptName: Untrusted | undefined
  readonly weight: number
  readonly size: number
  readonly usedBy: ReadonlyArray<SourceId>
}

/**
 * One acquired root, with the size a rule can check against an expectation.
 *
 * A root is whatever the acquisition asked for — an artboard, a component, a
 * subtree. Whether it stands for a viewport is something a responsive
 * declaration says about it, not something its being a root implies.
 */
export interface RootFact {
  readonly sourceId: SourceId
  readonly name: Untrusted
  readonly width: Known<number>
  readonly height: Known<number>
  /** Rendered direct children in reading order. */
  readonly children: ReadonlyArray<SourceId>
}

/**
 * A set of artboards that are the same view at different widths.
 *
 * Membership comes from a declared naming convention, never from a guess: a
 * project that draws one artboard per breakpoint names them by a pattern —
 * `{section}_{width}`, `{section} / {breakpoint}` — and declares that
 * pattern; nothing is inferred from the file. Slots additionally need the
 * same element to carry the same layer-name path in every member, which is a
 * discipline of the design file, not a property of the tool.
 */
export interface ResponsiveGroupFact {
  readonly section: Untrusted
  readonly members: ReadonlyArray<ResponsiveMember>
  /**
   * Slots whose correspondence across members is certain.
   *
   * A slot appears only when its name path resolves to exactly one node in
   * every member. Anything less is reported as a diagnostic instead: matching
   * by position, or by a name that occurs twice, would pair unrelated elements
   * and the resulting comparison would look exactly as authoritative as a
   * correct one.
   */
  readonly slots: ReadonlyArray<ResponsiveSlotFact>
  /**
   * How much of the tree could be lined up.
   *
   * Worth reading before trusting the slots: in real files only a handful of
   * paths may correspond, because most run through containers the editor
   * auto-named, and those names differ per variant while the design does not
   * (REG-RESP-003). A low number is a fact about the file's naming, not about
   * the design.
   */
  readonly coverage: {
    /** Name paths that resolved in every member. */
    readonly correspondedPaths: number
    /** Name paths that did not. Renaming one container inflates this by its whole subtree. */
    readonly unresolvedPaths: number
  }
}

export interface ResponsiveMember {
  readonly breakpoint: string
  readonly designWidthPx: number
  readonly rootId: SourceId
}

/**
 * One logical element seen across every breakpoint.
 *
 * This is the shape the recorded rework was missing: measuring one breakpoint
 * and inferring the others produced a stacked list that was three columns, a
 * label that read differently, and a decoration that changed colour per block.
 * Here the four answers arrive together, and `absent` is distinguishable from
 * `unknown`.
 */
export interface ResponsiveSlotFact {
  readonly namePath: ReadonlyArray<Untrusted>
  /** Every member has an observation; a slot with a gap is not published. */
  readonly byBreakpoint: ReadonlyMap<string, Known<SlotObservation>>
}

/**
 * What one element looks like at one breakpoint.
 *
 * Deliberately close to the canonical node rather than a summary: the rules
 * that read this next need to compare alignment, sizing, padding and type
 * styles across breakpoints, and a comparison can only find a difference in a
 * field somebody thought to keep. Design-authored strings stay `Untrusted`
 * here, exactly as they are a layer down.
 */
export interface SlotObservation {
  readonly sourceId: SourceId
  readonly nodeType: string
  readonly rendered: boolean
  readonly box: Box | undefined
  readonly relativeBox: Box | undefined
  readonly rotation: number | undefined
  readonly layout: LayoutFacts
  readonly characters: Untrusted | undefined
  readonly textStyle: StyleRef | undefined
  readonly typography: TextFacts['style'] | undefined
  readonly fills: ReadonlyArray<StyleValue>
  readonly strokes: ReadonlyArray<StyleValue>
  readonly strokeWeight: number | undefined
  readonly individualStrokeWeights: StrokeWeights | undefined
  readonly cornerRadius: number | undefined
}

/** A problem found while deriving facts. Reported, never repaired. */
export interface FactDiagnostic {
  readonly reason: ReasonCode
  readonly detail: string
  readonly sourceIds: ReadonlyArray<SourceId>
}

export interface FactIndex {
  readonly schemaVersion: number
  readonly canonicalHash: Hash<'canonical'>
  /**
   * Which conventions the configuration declared, so a rule can tell "no
   * groups because none were declared" from "none because nothing matched"
   * and refuse to run in the first case rather than pass in silence.
   */
  readonly declared: {
    readonly styleNames: { readonly pattern: string; readonly segments: ReadonlyArray<string> } | undefined
    readonly responsive: { readonly namePattern: string; readonly breakpoints: ReadonlyArray<string> } | undefined
  }
  readonly nodes: ReadonlyMap<SourceId, NodeFact>
  readonly textStyles: ReadonlyMap<string, TextStyleFact>
  readonly roots: ReadonlyArray<RootFact>
  readonly responsiveGroups: ReadonlyArray<ResponsiveGroupFact>
  readonly diagnostics: ReadonlyArray<FactDiagnostic>
}

/**
 * How to recognise a responsive group.
 *
 * The pattern is a template over the root's name containing `{section}` and
 * `{width}` (a design width in px) or `{breakpoint}` (one of the declared
 * slots) — or both, in which case they must agree. The convention is declared
 * by the project, not discovered by us, and a pattern that could not match
 * anything is refused when the configuration loads (REG-CONF-017).
 */
export interface ResponsiveConfig {
  readonly namePattern: string
  readonly breakpoints: ReadonlyArray<{ readonly slot: string; readonly designWidthPx: number }>
  /**
   * Artboards the convention does not cover, named one by one.
   *
   * Real files accumulate exceptions (REG-RESP-004): a person renames an
   * artboard mid-redesign — `page_xl_final` — and it stops parsing. Reading
   * the suffix as "this is the widest one" would be the IR guessing; a
   * project saying so is a fact. Kept deliberately tedious -- a node id and a
   * breakpoint, one line each -- so that a file needing many of these is
   * uncomfortable enough to get renamed instead.
   */
  readonly explicit?: ReadonlyArray<{
    readonly nodeId: string
    readonly section: string
    readonly breakpoint: string
  }>
}

/**
 * A project's text style naming convention, declared as a pattern.
 *
 * `pattern` is a template of literals and `{segment}` placeholders that a
 * name must match whole — `{group}/{purpose}/{breakpoint}/{language}` is one
 * project's; `{role}-{size}` is another's. A segment listed in `allowed` is
 * matched against exactly those values, which is also what pins the split
 * when a separator can occur inside an open segment. Nothing about the
 * segments' meaning is assumed here; rules refer to them by name.
 */
export interface StyleNameConfig {
  readonly pattern: string
  readonly allowed?: Readonly<Record<string, ReadonlyArray<string>>>
}

export interface FactConfig {
  readonly responsive?: ResponsiveConfig
  readonly styleNames?: StyleNameConfig
}

export type { CanonicalNode }
