/**
 * The web projection: parent-context-aware layout meaning, derived — never
 * guessed — from the canonical document.
 *
 * The design is two-input. Coordinates alone cannot
 * name the rule that produced them: the same positions arise from a fixed
 * gap, from space-between, or from absolute placement, and a rule inferred
 * from one snapshot overfits that snapshot's child count. Declarations alone
 * cannot be trusted either: a declared `itemSpacing` is inert under
 * `SPACE_BETWEEN`, and transcribing it changed how many cells fit a row in a
 * real page. So the translator reads the declaration, predicts where the
 * current children would land, and compares with where they actually are.
 * Only a declaration whose prediction matches is `known`; a mismatch demotes
 * the claim and raises a mandatory diagnostic (`GEOMETRY_CONTRADICTION`) —
 * the translator itself being wrong shows up the same way, which is the
 * point: fail closed, never silently.
 */
import type { Hash, Known, ReasonCode, SourceId } from '@figma-ir/core'

export const WEB_PROJECTION_SCHEMA_VERSION = 2

/** Version of the translation rules. Changing how anything is derived bumps this. */
export const TRANSLATOR_VERSION = 2

/**
 * Tolerance for comparing the emulator's predictions with canonical geometry.
 *
 * Distinct from the browser-measurement tolerance on purpose: canonical
 * values are rounded to the px slot (two decimals), so two exact computations
 * can differ by at most one rounding step per operand. This is a versioned
 * constant of the deterministic pipeline, not an empirical allowance.
 */
export const EMULATOR_TOLERANCE_PX = 0.02

export type Distribution = 'start' | 'center' | 'end' | 'space-between'

/**
 * What a length means on the web, not what it measures.
 *
 * `intrinsic` (HUG) is a known *meaning* even when the resulting pixel count
 * is unknowable here (text depends on font metrics — TEXT_METRICS_REQUIRED).
 * Splitting meaning from measurement is what lets a text-bearing node keep
 * its translation instead of collapsing to unknown.
 */
export type AxisSizePlan =
  | { readonly kind: 'fixed'; readonly px: number }
  | { readonly kind: 'intrinsic' }
  | { readonly kind: 'stretch' }
  | { readonly kind: 'flex' }
  | { readonly kind: 'unknown'; readonly reason: ReasonCode }

export interface ContainerFlexPlan {
  readonly kind: 'flex'
  readonly direction: 'row' | 'column'
  readonly wrap: boolean
  readonly mainAlign: Known<Distribution>
  readonly crossAlign: Known<'start' | 'center' | 'end'>
  /**
   * The gap to *write*, not the gap that was declared.
   *
   * Under space-between the declared itemSpacing is inert — Figma packs at
   * zero and distributes the remainder — so emitting it would rebuild the
   * exact trap this layer exists to remove.
   */
  readonly mainGapPx: Known<number>
  readonly crossGapPx: Known<number>
  readonly padding: {
    readonly top: number
    readonly right: number
    readonly bottom: number
    readonly left: number
  }
}

export type ContainerPlan =
  | ContainerFlexPlan
  | { readonly kind: 'non-flex' }
  | { readonly kind: 'unknown'; readonly reason: ReasonCode }

/** The current children, as they are actually arranged. Fact, not rule. */
export interface ObservedArrangement {
  readonly lines: ReadonlyArray<{ readonly childIds: ReadonlyArray<SourceId> }>
}

export interface UniformFixedTrack {
  readonly mainPx: number
  readonly crossPx: number
}

/**
 * The reusable rule, each part with its own certainty.
 *
 * One Known over the whole rule would throw away the full-line answer just
 * because the partial-line one is unobservable. Capacity is deliberately not
 * a field: it is derived from container size and track size at use, so the
 * rule does not overfit the observed child count.
 */
export interface RepeatRule {
  readonly axis: Known<'horizontal'>
  readonly track: Known<UniformFixedTrack>
  /** The spacing used to decide how many fit — zero under space-between. */
  readonly packingGapPx: Known<number>
  readonly fullLineDistribution: Known<Distribution>
  readonly partialLineDistribution: Known<Distribution>
  readonly lineGapPx: Known<number>
}

export type Verification =
  | { readonly kind: 'consistent' }
  | { readonly kind: 'contradicted'; readonly reason: ReasonCode }
  | { readonly kind: 'not-verifiable'; readonly reason: ReasonCode }

/** Claim-level verification: x can be verified while text-driven y is not. */
export interface WrapVerification {
  readonly lineMembership: Verification
  readonly inlinePositions: Verification
  readonly crossPositions: Verification
  readonly childSizes: Verification
}

export interface WrapProjection {
  readonly observed: ObservedArrangement
  readonly rule: RepeatRule
  readonly verification: WrapVerification
}

export interface NodeProjection {
  readonly sourceId: SourceId
  readonly participation: 'rendered' | 'not-rendered'
  readonly container: ContainerPlan
  readonly widthPlan: AxisSizePlan
  readonly heightPlan: AxisSizePlan
  /** Present only on wrap containers inside the supported subset. */
  readonly wrap: WrapProjection | undefined
}

/**
 * What a contradiction is made of: which check, on which axis, for which
 * child, observed against predicted.
 *
 * A sentence that says "children do not sit where start with the declared
 * gap predicts" sent a reader to re-measure the gap when it was the cross
 * axis that had failed. The evidence names the check so the reader starts in the
 * right place; the sentence stays as the summary.
 */
export type ContradictionEvidence =
  | {
      readonly kind: 'stack-origin'
      readonly axis: 'x' | 'y'
      readonly distribution: Distribution
      readonly childSourceId: SourceId
      readonly observedPx: number
      readonly predictedPx: number
      /**
       * Children the slice left out as not rendered. A fact about the
       * container, offered because a declared distribution over the visible
       * children can look wrong when the hidden ones were part of it — not
       * a verdict that they were.
       */
      readonly notRenderedChildCount: number
    }
  | {
      readonly kind: 'stack-gap'
      readonly axis: 'x' | 'y'
      readonly beforeSourceId: SourceId
      readonly afterSourceId: SourceId
      readonly observedPx: number
      readonly predictedPx: number
    }
  | {
      readonly kind: 'stack-cross'
      readonly axis: 'x' | 'y'
      readonly align: 'start' | 'center' | 'end'
      readonly childSourceId: SourceId
      readonly observedPx: number
      readonly predictedPx: number
    }
  | {
      readonly kind: 'axis-size'
      readonly axis: 'width' | 'height'
      readonly plan: 'stretch' | 'flex'
      readonly observedPx: number
      readonly predictedPx: number
    }
  | { readonly kind: 'wrap-membership'; readonly predictedRows: number; readonly observedRows: number }
  | {
      readonly kind: 'wrap-inline'
      readonly row: number
      readonly distribution: Distribution
      readonly packingGapPx: number
      readonly childSourceId: SourceId
      readonly observedPx: number
      readonly predictedPx: number
    }
  | { readonly kind: 'wrap-partial-row'; readonly row: number }
  | {
      readonly kind: 'wrap-cross'
      readonly row: number
      readonly lineGapPx: number
      readonly observedPx: number
      readonly predictedPx: number
    }
  | {
      readonly kind: 'wrap-child-size'
      readonly childSourceId: SourceId
      readonly observedMainPx: number
      readonly observedCrossPx: number
      readonly trackMainPx: number
      readonly trackCrossPx: number
    }

export type ProjectionDiagnostic =
  | {
      readonly reason: 'GEOMETRY_CONTRADICTION'
      readonly detail: string
      readonly sourceIds: ReadonlyArray<SourceId>
      readonly evidence: ContradictionEvidence
    }
  | {
      readonly reason: Exclude<ReasonCode, 'GEOMETRY_CONTRADICTION'>
      readonly detail: string
      readonly sourceIds: ReadonlyArray<SourceId>
      readonly evidence: undefined
    }

/**
 * One consumption duty. The finite set a consumer must account for —
 * `consumed`, `not-applicable`, or an exception — so a value nobody read is
 * a loud gap instead of a silent omission. Enforcement arrives later;
 * emission is here from the first version because retrofitting the ids would
 * mean rebuilding the schema and every stored hash.
 */
export type Obligation =
  | {
      /** Stable: `${sourceId}#${claim}`. */
      readonly projectionFactId: string
      readonly sourceId: SourceId
      readonly claim: 'container' | 'width' | 'height' | 'wrap'
    }
  | {
      readonly projectionFactId: string
      readonly sourceId: SourceId
      /**
       * A HUG child on its parent's cross axis keeps its intrinsic size.
       *
       * On the web a flex child stretches across its parent's cross axis by
       * default, so a translation that read `intrinsic` and wrote nothing
       * produced a full-width element the design never had, in a real page. The claim names the axis; how it is met (`align-self`, the
       * container's `align-items`, an explicit size) is the target's business.
       */
      readonly claim: 'preserveIntrinsicCrossSize'
      readonly axis: 'width' | 'height'
    }

export interface WebProjectionRequest {
  readonly roots: ReadonlyArray<string>
  readonly maxDepth?: number
  readonly maxNodes?: number
}

export interface WebProjectionArtifact {
  readonly schemaVersion: number
  readonly translatorVersion: number
  readonly emulatorTolerancePx: number
  readonly fileKey: string
  readonly sourceVersion: string
  readonly canonicalHash: Hash<'canonical'>
  readonly snapshotId: Hash<'canonical'>
  readonly request: {
    readonly roots: ReadonlyArray<string>
    readonly maxDepth: number | undefined
    readonly maxNodes: number
    readonly includeHidden: boolean
  }
  readonly projectionRequestHash: Hash<'projection'>
  readonly nodes: ReadonlyArray<NodeProjection>
  readonly diagnostics: ReadonlyArray<ProjectionDiagnostic>
  readonly obligations: ReadonlyArray<Obligation>
  readonly projectionHash: Hash<'projection'>
}
