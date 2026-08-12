/**
 * IR-driven render verification.
 *
 * The expected table comes from the slice, never from the implementation:
 * measuring what was implemented and comparing it with what was transcribed
 * lets every omission pass — a field nobody read is a field nobody measures.
 * A real pilot reported "all values match" while three geometry mismatches
 * shipped, precisely because the implementation was its own oracle.
 *
 * Child coordinates are the one part of a design that needs no interpretation
 * of layout declarations (a declared `itemSpacing` can be inert under
 * `SPACE_BETWEEN`; a box is just where the child is), which is why geometry —
 * not declarations — is the comparison basis here.
 */
import { compareCodeUnits } from '../determinism/canonical.js'
import { roundPx } from '../determinism/rounding.js'
import type { SourceId } from '../identity/nodeIdentity.js'
import type { Box } from '../canonical/document.js'
import type { Slice, SliceNode } from '../slice/types.js'

export class GeometryError extends Error {
  readonly _tag = 'GeometryError'
  constructor(message: string) {
    super(message)
    this.name = 'GeometryError'
  }
}

/**
 * What a browser measured, relative to one root element.
 *
 * `x`/`y` are CSS px from the root element's border-box origin, unscaled: the
 * collector stays a dumb reporter and the scaling happens here, where it is
 * deterministic and testable. `viewportWidthPx` exists because a browser may
 * refuse to shrink to the design width (500px minimum against a 375 design);
 * with every length in the page proportional to viewport width, one factor
 * maps measured space into design space.
 */
export type MeasuredSchemaVersion = 1 | 2

export interface MeasuredGeometry {
  /**
   * Which contract the collector wrote to. Version 2 adds `tagName` on every
   * entry and two exclusion kinds that need it or the slice's structure;
   * version 1 files keep working unchanged.
   */
  readonly schemaVersion: MeasuredSchemaVersion
  readonly designWidthPx: number
  readonly viewportWidthPx: number
  readonly rootSourceId: string
  readonly entries: ReadonlyArray<MeasuredEntry>
  readonly exclusions: ReadonlyArray<MeasuredExclusion>
}

export interface MeasuredEntry {
  readonly sourceId: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /**
   * An opaque identity for the DOM element this was read from.
   *
   * Optional, but scoring wants it: without it, one element can quietly
   * answer for two nodes and coverage still reads 100%. Any collector can
   * supply one (a counter while walking is enough).
   */
  readonly element?: string
  /**
   * The DOM element's tag name, upper-cased, as the collector saw it.
   *
   * Schema version 2 carries it on every entry (null when the collector
   * has none). A claim that text lives inside a native control is checked
   * against what the element actually is, not against what the claim says.
   */
  readonly tagName?: string
}

/**
 * A rendered node deliberately not measured, with a machine-readable reason.
 *
 * Coverage under `requireCoverage` fails on any gap this list does not
 * explain. The reasons are a closed set so "excluded" stays countable, and
 * every kind names a condition the slice can check — a kind that verified
 * nothing would make the list a bypass (REG-VERIFY-012):
 *
 * - `asset-internal`: the inside of a measured image or vector.
 * - `collapsed-into`: a wrapper folded into `targetSourceId` under the score
 *   contract's eligibility conditions.
 * - `derived-from-children` (v2): an auto-layout frame the implementation
 *   gave no box of its own, whose design box is exactly its rendered
 *   children plus its padding — so measuring the children measures it.
 * - `native-control-internal` (v2): text a native control renders itself
 *   (the displayed value of a `<select>`), which has no box a collector can
 *   read; `targetSourceId` names the measured control.
 */
export type MeasuredExclusion =
  | { readonly sourceId: string; readonly kind: 'asset-internal' }
  | { readonly sourceId: string; readonly kind: 'collapsed-into'; readonly targetSourceId: string }
  | { readonly sourceId: string; readonly kind: 'derived-from-children' }
  | { readonly sourceId: string; readonly kind: 'native-control-internal'; readonly targetSourceId: string }

/** The kinds a version 1 file may use; the rest need version 2. */
const V1_EXCLUSION_KINDS = new Set(['asset-internal', 'collapsed-into'])

/** Native controls whose displayed text is theirs to render, not the page's. */
const NATIVE_CONTROLS = new Set(['SELECT'])

/**
 * The one blend mode under which a frame adds nothing to how its children
 * composite. `NORMAL` on a container is not it: it isolates the children,
 * so a child's own blend mode stops at the frame instead of reaching what
 * lies behind — which is exactly what a DOM without the wrapper cannot do.
 */
const NEUTRAL_BLEND_MODES = new Set(['PASS_THROUGH'])

/** Node types that are a drawing in themselves. */
const VECTOR_TYPES = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'LINE', 'ELLIPSE', 'STAR', 'POLYGON', 'REGULAR_POLYGON'])

/**
 * How far a design-side reconstruction may miss and still count as exact.
 *
 * Distinct from the browser tolerance on purpose: a frame whose box is its
 * children plus padding within a quarter pixel is not "exactly derived", it
 * is a frame with slack — and slack is where alignment lives.
 */
const STRUCTURAL_TOLERANCE_PX = 0.02

const SLOTS = ['x', 'y', 'width', 'height'] as const
export type GeometrySlot = (typeof SLOTS)[number]

export interface GeometryMismatch {
  readonly sourceId: SourceId
  readonly slot: GeometrySlot
  readonly expectedPx: number
  readonly measuredPx: number
  readonly deltaPx: number
}

/**
 * How one vertical text measurement fared against the gates.
 *
 * - `strict-pass`: within the base tolerance, like any geometry.
 * - `budget-pass`: beyond it, but the contract's text budget explains it.
 * - `budget-fail`: beyond the budget too — also a mismatch.
 * - `wrap-flip-candidate`: the height moved by close to a whole number of
 *   lines — also a wrap flip.
 */
export type TextDeltaClassification = 'strict-pass' | 'budget-pass' | 'budget-fail' | 'wrap-flip-candidate'

/**
 * A text node's vertical measurement, recorded for every budget-eligible
 * y/height slot — passes included, at slot precision. The score contract
 * reads distributions from this list, so an entry must never depend on the
 * verdict: "explained" cannot quietly become "invisible", and neither can
 * "fine".
 */
export interface TextMetricDelta {
  readonly sourceId: SourceId
  readonly slot: 'y' | 'height'
  readonly expectedPx: number
  readonly measuredPx: number
  readonly deltaPx: number
  /** The contract's budget for this node: base + perLine × estimated lines. */
  readonly boundPx: number
  readonly classification: TextDeltaClassification
}

/**
 * A text height that moved by close to a whole number of lines.
 *
 * A candidate, not a verdict: the tool sees boxes, not glyphs, so "the wrap
 * count changed" is the best explanation of an integer-line jump, and
 * anything that is *not* close to an integer multiple stays an ordinary
 * mismatch instead of being blamed on text rendering. Candidates always
 * fail, whatever the text budget — one line more pushes everything below.
 */
export interface TextWrapFlip {
  readonly sourceId: SourceId
  readonly expectedPx: number
  readonly measuredPx: number
  readonly deltaPx: number
  readonly lineHeightPx: number
  /** Lines gained (positive) or lost (negative). */
  readonly lineDelta: number
  /** How far the delta sits from exactly `lineDelta` lines. */
  readonly residualPx: number
}

/** One DOM element answering for several nodes without a collapse declaration. */
export interface SharedElement {
  readonly element: string
  readonly sourceIds: ReadonlyArray<SourceId>
}

/**
 * The diff, with its blind spots stated.
 *
 * `unmeasuredRendered` is the coverage gap: rendered nodes with geometry
 * that neither a measurement nor a declared exclusion accounts for. It is
 * reported rather than failed by default — which nodes to measure is the
 * caller's scope decision — but "matched everything I measured" and
 * "matched everything" are different claims, and a report that hides the
 * difference invites the stronger reading.
 */
export interface GeometryReport {
  readonly rootSourceId: SourceId
  /** Which measured-geometry contract the verdict was computed under. */
  readonly measuredSchemaVersion: MeasuredSchemaVersion
  readonly designWidthPx: number
  /** What the render was actually measured at, so a saved report is auditable on its own. */
  readonly viewportWidthPx: number
  /** True when measured values were scaled by designWidthPx / viewportWidthPx. */
  readonly scaled: boolean
  readonly tolerancePx: number
  /** Echoed so a saved report says which text budget produced its verdict. */
  readonly textTolerancePx: number
  readonly textTolerancePerLinePx: number
  readonly comparedCount: number
  readonly matchedCount: number
  readonly mismatches: ReadonlyArray<GeometryMismatch>
  /** Every budget-eligible vertical text measurement, passes included. */
  readonly textMetricDeltas: ReadonlyArray<TextMetricDelta>
  /** Integer-line height jumps. Always failing, whatever the text budget. */
  readonly wrapFlips: ReadonlyArray<TextWrapFlip>
  /** The declared exclusions, echoed for the audit trail (sorted). */
  readonly exclusions: ReadonlyArray<MeasuredExclusion>
  /**
   * Declared exclusions whose conditions the slice contradicts.
   *
   * An exclusion is a claim, and claims get verified: asset-internal must
   * sit inside a measured asset, a collapse must satisfy the contract's
   * eligibility (direct parent-child, identical boxes, a parent with nothing
   * of its own), a derived frame must really be its children plus padding,
   * and native-control text must sit inside a measured native control. A
   * failed claim leaves the coverage gap open and fails on its own —
   * otherwise the allowlist is a bypass.
   */
  readonly invalidExclusions: ReadonlyArray<{ readonly sourceId: string; readonly reason: string }>
  /** Measured entries that carry no element identity. Failing under requireElements. */
  readonly entriesWithoutElement: ReadonlyArray<SourceId>
  /** One element answering for several nodes. Always a failure. */
  readonly sharedElements: ReadonlyArray<SharedElement>
  /** Measured ids the slice does not contain. Always a failure: the mapping is wrong. */
  readonly unknownSourceIds: ReadonlyArray<string>
  /** Measured ids whose slice node carries no geometry. A mapping the IR cannot confirm. */
  readonly withoutExpectedBox: ReadonlyArray<SourceId>
  readonly unmeasuredRendered: ReadonlyArray<SourceId>
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/**
 * Validates a measured-geometry document from outside the type system.
 *
 * Hand-rolled and loud: this file is produced by a browser snippet a person
 * pasted together, which is exactly the input that arrives subtly wrong.
 */
export const decodeMeasuredGeometry = (raw: unknown): MeasuredGeometry => {
  const record = asRecord(raw)
  if (record === undefined) throw new GeometryError('measured geometry must be an object')
  const schemaVersion = record['schemaVersion']
  if (schemaVersion !== 1 && schemaVersion !== 2) throw new GeometryError('measured geometry schemaVersion must be 1 or 2')
  const designWidthPx = record['designWidthPx']
  const viewportWidthPx = record['viewportWidthPx']
  if (!isFiniteNumber(designWidthPx) || designWidthPx <= 0) {
    throw new GeometryError('designWidthPx must be a positive number')
  }
  if (!isFiniteNumber(viewportWidthPx) || viewportWidthPx <= 0) {
    throw new GeometryError('viewportWidthPx must be a positive number')
  }
  const rootSourceId = record['rootSourceId']
  if (typeof rootSourceId !== 'string' || rootSourceId.length === 0) {
    throw new GeometryError('rootSourceId must be a non-empty string')
  }
  const entriesRaw = record['entries']
  if (!Array.isArray(entriesRaw)) throw new GeometryError('entries must be an array')
  const seen = new Set<string>()
  const entries = entriesRaw.map((entryRaw, index) => {
    const entry = asRecord(entryRaw)
    if (entry === undefined) throw new GeometryError(`entries[${index}] must be an object`)
    const sourceId = entry['sourceId']
    if (typeof sourceId !== 'string' || sourceId.length === 0) {
      throw new GeometryError(`entries[${index}].sourceId must be a non-empty string`)
    }
    if (seen.has(sourceId)) {
      // Two measurements for one node means the mapping is ambiguous, and
      // quietly taking either one would hide that.
      throw new GeometryError(`entries contains ${sourceId} twice`)
    }
    seen.add(sourceId)
    for (const slot of SLOTS) {
      if (!isFiniteNumber(entry[slot])) throw new GeometryError(`entries[${index}].${slot} must be a finite number`)
    }
    const element = entry['element']
    if (element !== undefined && (typeof element !== 'string' || element.length === 0)) {
      throw new GeometryError(`entries[${index}].element must be a non-empty string when present`)
    }
    const tagNameRaw = entry['tagName']
    if (schemaVersion === 1) {
      if (tagNameRaw !== undefined) throw new GeometryError(`entries[${index}].tagName is a schemaVersion 2 field`)
    } else if (tagNameRaw !== null && (typeof tagNameRaw !== 'string' || tagNameRaw.length === 0)) {
      // Present on every entry, null when unknown: a field that is sometimes
      // missing cannot be told apart from a collector that never reports it.
      throw new GeometryError(`entries[${index}].tagName must be a non-empty string or null`)
    }
    const tagName = typeof tagNameRaw === 'string' ? tagNameRaw.toUpperCase() : undefined
    return {
      sourceId,
      x: entry['x'] as number,
      y: entry['y'] as number,
      width: entry['width'] as number,
      height: entry['height'] as number,
      ...(element === undefined ? {} : { element }),
      ...(tagName === undefined ? {} : { tagName }),
    }
  })

  const exclusionsRaw = record['exclusions'] ?? []
  if (!Array.isArray(exclusionsRaw)) throw new GeometryError('exclusions must be an array when present')
  const excludedSeen = new Set<string>()
  const exclusions = exclusionsRaw.map((exclusionRaw, index): MeasuredExclusion => {
    const exclusion = asRecord(exclusionRaw)
    if (exclusion === undefined) throw new GeometryError(`exclusions[${index}] must be an object`)
    const sourceId = exclusion['sourceId']
    if (typeof sourceId !== 'string' || sourceId.length === 0) {
      throw new GeometryError(`exclusions[${index}].sourceId must be a non-empty string`)
    }
    if (excludedSeen.has(sourceId)) throw new GeometryError(`exclusions contains ${sourceId} twice`)
    excludedSeen.add(sourceId)
    if (seen.has(sourceId)) {
      // Measured and excluded is a contradiction, not a belt-and-braces.
      throw new GeometryError(`${sourceId} is both measured and excluded`)
    }
    const kind = exclusion['kind']
    if (typeof kind === 'string' && schemaVersion === 1 && !V1_EXCLUSION_KINDS.has(kind)) {
      throw new GeometryError(`exclusions[${index}].kind ${kind} requires schemaVersion 2`)
    }
    const target = (): string => {
      const targetSourceId = exclusion['targetSourceId']
      if (typeof targetSourceId !== 'string' || targetSourceId.length === 0 || targetSourceId === sourceId) {
        throw new GeometryError(`exclusions[${index}].targetSourceId must name a different node`)
      }
      return targetSourceId
    }
    if (kind === 'asset-internal') return { sourceId, kind }
    if (kind === 'derived-from-children') return { sourceId, kind }
    if (kind === 'collapsed-into') return { sourceId, kind, targetSourceId: target() }
    if (kind === 'native-control-internal') return { sourceId, kind, targetSourceId: target() }
    throw new GeometryError(
      `exclusions[${index}].kind must be asset-internal, collapsed-into, derived-from-children or native-control-internal`,
    )
  })

  return { schemaVersion, designWidthPx, viewportWidthPx, rootSourceId, entries, exclusions }
}

export interface DiffGeometryOptions {
  readonly tolerancePx?: number
  /**
   * Permits comparing a render measured at a viewport other than the design
   * width, scaled by designWidthPx / viewportWidthPx.
   *
   * Off by default because the scaling assumes every length in the page is
   * proportional to viewport width — a property of one target encoding
   * (viewport-relative units such as vw), not of renders in general. A fixed-px page measured at 500px and
   * silently scaled to 375 would "verify" geometry the page does not have.
   * The caller sets this only when the target's encoding guarantees it
   * (a scale-equivariant TargetProfile).
   */
  readonly allowScaling?: boolean
  /**
   * The score contract's budget for a text node's y and height.
   *
   * Text is the one place where a faithful implementation and the design
   * disagree by construction: Figma rounds cap heights and per-line heights
   * its own way. The budget is bound = textTolerancePx + textTolerancePerLinePx
   * × estimated lines (from the node's box height and declared line height),
   * applied to y and height only — x and width stay at the strict tolerance,
   * so a blanket allowance cannot smuggle real mistakes through. Defaults to
   * the strict tolerance: looseness is something a contract opts into.
   *
   * Only auto-resizing text (`textAutoResize` HEIGHT or WIDTH_AND_HEIGHT)
   * with a declared line height is budget-eligible: a fixed-height text box
   * does not drift with its content, and without a line height there is
   * nothing to derive the budget from — both stay on the strict gate.
   */
  readonly textTolerancePx?: number
  readonly textTolerancePerLinePx?: number
}

const AUTO_RESIZING = new Set(['HEIGHT', 'WIDTH_AND_HEIGHT'])

/**
 * Compares measured geometry against the slice it claims to render.
 *
 * Expected values are root-relative: node box minus root box, re-rounded
 * (REG-FACT-009 — the difference of two rounded values is not rounded).
 * Measured values are scaled into design space by one factor and re-rounded
 * the same way, so both sides live in the same grid before the tolerance test.
 */
export const diffGeometry = (
  slice: Slice,
  measured: MeasuredGeometry,
  options: DiffGeometryOptions = {},
): GeometryReport => {
  if (typeof (options as unknown) === 'number') {
    // The third argument used to be the tolerance. From JavaScript the old
    // form would silently fall back to the default instead of the strict
    // tolerance the caller asked for — fail loudly instead.
    throw new GeometryError('the tolerance moved to options.tolerancePx')
  }
  const tolerancePx = options.tolerancePx ?? 0.25
  if (!isFiniteNumber(tolerancePx) || tolerancePx < 0) {
    throw new GeometryError('tolerancePx must be a non-negative number')
  }
  const textTolerancePx = options.textTolerancePx ?? tolerancePx
  const textTolerancePerLinePx = options.textTolerancePerLinePx ?? 0
  if (!isFiniteNumber(textTolerancePx) || textTolerancePx < tolerancePx) {
    throw new GeometryError('textTolerancePx must be a number at least the base tolerance')
  }
  if (!isFiniteNumber(textTolerancePerLinePx) || textTolerancePerLinePx < 0) {
    throw new GeometryError('textTolerancePerLinePx must be a non-negative number')
  }
  if (measured.viewportWidthPx !== measured.designWidthPx && options.allowScaling !== true) {
    throw new GeometryError(
      `measured at ${measured.viewportWidthPx}px for a ${measured.designWidthPx}px design: ` +
        'scaling assumes every length is proportional to viewport width, which only a ' +
        'scale-equivariant target encoding (e.g. every length in vw) guarantees — pass allowScaling to own that assumption',
    )
  }
  const byId = new Map(slice.nodes.map((node) => [node.sourceId as string, node]))
  const root = byId.get(measured.rootSourceId)
  if (root === undefined) {
    throw new GeometryError(`rootSourceId ${measured.rootSourceId} is not in the slice`)
  }
  if (root.box === undefined) {
    throw new GeometryError(`rootSourceId ${measured.rootSourceId} has no geometry to anchor to`)
  }
  const rootBox: Box = root.box
  const scale = measured.designWidthPx / measured.viewportWidthPx

  const mismatches: GeometryMismatch[] = []
  const textMetricDeltas: TextMetricDelta[] = []
  const wrapFlips: TextWrapFlip[] = []
  const unknownSourceIds: string[] = []
  const withoutExpectedBox: SourceId[] = []
  const measuredIds = new Set<string>()
  const byElement = new Map<string, SourceId[]>()
  const entriesWithoutElement: SourceId[] = []
  let comparedCount = 0
  let matchedCount = 0

  for (const entry of measured.entries) {
    measuredIds.add(entry.sourceId)
    const node = byId.get(entry.sourceId)
    if (node === undefined) {
      unknownSourceIds.push(entry.sourceId)
      continue
    }
    if (node.box === undefined) {
      withoutExpectedBox.push(node.sourceId)
      continue
    }
    if (entry.element !== undefined) {
      const holders = byElement.get(entry.element)
      if (holders === undefined) byElement.set(entry.element, [node.sourceId])
      else holders.push(node.sourceId)
    } else {
      entriesWithoutElement.push(node.sourceId)
    }
    const expected: Record<GeometrySlot, number> = {
      x: roundPx(node.box.x - rootBox.x),
      y: roundPx(node.box.y - rootBox.y),
      width: node.box.width,
      height: node.box.height,
    }
    const lineHeightPx = node.typography?.lineHeightPx
    const budgetEligible =
      node.type === 'TEXT' &&
      isFiniteNumber(lineHeightPx) &&
      lineHeightPx > 0 &&
      AUTO_RESIZING.has(node.typography?.textAutoResize ?? '')
    // Ceil, minus a rounding guard: a trimmed box is capHeight + (n−1) lines,
    // which ceils to n whenever the cap fits inside a line, and an untrimmed
    // box of exactly n lines still ceils to n instead of tipping over on
    // float noise.
    const estimatedLines = budgetEligible ? Math.max(1, Math.ceil((node.box.height - 0.05) / lineHeightPx!)) : 1
    const textBoundPx = roundPx(textTolerancePx + textTolerancePerLinePx * estimatedLines)

    comparedCount += 1
    let nodeMatched = true
    for (const slot of SLOTS) {
      const measuredPx = roundPx(entry[slot] * scale)
      const deltaPx = roundPx(measuredPx - expected[slot])
      const withinStrict = Math.abs(deltaPx) <= tolerancePx

      // Budget-eligible vertical text is recorded whatever the verdict: the
      // contract reads distributions from this list, and a list that only
      // holds some verdicts cannot carry a distribution.
      if (budgetEligible && (slot === 'y' || slot === 'height')) {
        const record = (classification: TextDeltaClassification): void => {
          textMetricDeltas.push({
            sourceId: node.sourceId,
            slot,
            expectedPx: expected[slot],
            measuredPx,
            deltaPx,
            boundPx: textBoundPx,
            classification,
          })
        }
        if (withinStrict) {
          record('strict-pass')
          continue
        }
        if (slot === 'height') {
          // Close to a whole number of lines → the wrap count is the best
          // explanation. Anything else stays an ordinary mismatch rather
          // than being blamed on text rendering.
          const lineDelta = Math.round(deltaPx / lineHeightPx!)
          const residualPx = roundPx(Math.abs(deltaPx - lineDelta * lineHeightPx!))
          if (lineDelta !== 0 && residualPx <= textBoundPx) {
            record('wrap-flip-candidate')
            nodeMatched = false
            wrapFlips.push({
              sourceId: node.sourceId,
              expectedPx: expected[slot],
              measuredPx,
              deltaPx,
              lineHeightPx: lineHeightPx!,
              lineDelta,
              residualPx,
            })
            continue
          }
        }
        if (Math.abs(deltaPx) <= textBoundPx) {
          record('budget-pass')
          continue
        }
        record('budget-fail')
        nodeMatched = false
        mismatches.push({ sourceId: node.sourceId, slot, expectedPx: expected[slot], measuredPx, deltaPx })
        continue
      }

      if (withinStrict) continue
      nodeMatched = false
      mismatches.push({ sourceId: node.sourceId, slot, expectedPx: expected[slot], measuredPx, deltaPx })
    }
    if (nodeMatched) matchedCount += 1
  }

  // Exclusions are claims, and claims get verified against the slice. A
  // claim that fails leaves its coverage gap open and fails on its own.
  const renderedChildren = new Map<string, SliceNode[]>()
  for (const node of slice.nodes) {
    if (node.parentId === undefined || !node.rendered) continue
    const siblings = renderedChildren.get(node.parentId as string)
    if (siblings === undefined) renderedChildren.set(node.parentId as string, [node])
    else siblings.push(node)
  }
  // A parent whose child list the slice cut short (depth or node budget)
  // has children the slice cannot vouch for; hidden children are absent on
  // purpose and do not count.
  const childrenCutShort = new Set<string>()
  for (const entry of slice.omitted) {
    if (entry.reason !== 'not-rendered' && entry.parentId !== undefined) childrenCutShort.add(entry.parentId as string)
  }
  const entriesById = new Map(measured.entries.map((entry) => [entry.sourceId, entry]))
  const nearestMeasuredAncestor = (sourceId: string): SliceNode | undefined => {
    let current = byId.get(sourceId)?.parentId as string | undefined
    while (current !== undefined) {
      if (measuredIds.has(current)) return byId.get(current)
      current = byId.get(current)?.parentId as string | undefined
    }
    return undefined
  }
  const isDescendantOf = (sourceId: string, ancestorId: string): boolean => {
    let current = byId.get(sourceId)?.parentId as string | undefined
    while (current !== undefined) {
      if (current === ancestorId) return true
      current = byId.get(current)?.parentId as string | undefined
    }
    return false
  }
  const boxesEqual = (a: Box | undefined, b: Box | undefined): boolean =>
    a !== undefined && b !== undefined && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  const within = (a: number, b: number): boolean => Math.abs(roundPx(a - b)) <= STRUCTURAL_TOLERANCE_PX
  const contains = (outer: Box, inner: Box): boolean =>
    inner.x >= outer.x - STRUCTURAL_TOLERANCE_PX &&
    inner.y >= outer.y - STRUCTURAL_TOLERANCE_PX &&
    inner.x + inner.width <= outer.x + outer.width + STRUCTURAL_TOLERANCE_PX &&
    inner.y + inner.height <= outer.y + outer.height + STRUCTURAL_TOLERANCE_PX

  /**
   * An asset: something the page shows as one picture. A leaf is one when
   * it is a vector-family node or carries an image fill; anything with
   * rendered children is one only when every child is — an image-backed
   * card with a label in it is a card, not a picture. Text is never an
   * asset, and a container whose child list the slice cut short cannot be
   * vouched for either way.
   */
  const assetLike = new Map<string, boolean>()
  const isAssetLike = (node: SliceNode): boolean => {
    const known = assetLike.get(node.sourceId as string)
    if (known !== undefined) return known
    const children = renderedChildren.get(node.sourceId as string) ?? []
    const verdict =
      node.type !== 'TEXT' &&
      !childrenCutShort.has(node.sourceId as string) &&
      (children.length === 0
        ? VECTOR_TYPES.has(node.type) || node.fills.some((fill) => fill.kind === 'raw' && fill.value.kind === 'image')
        : children.every((child) => isAssetLike(child)))
    assetLike.set(node.sourceId as string, verdict)
    return verdict
  }

  /**
   * Why an auto-layout frame is not "its children plus padding", or
   * undefined when it is. Every objection is a way the frame carries
   * information of its own — slack, paint, a clip, a child the slice did
   * not see — that a DOM without a box for it would drop.
   */
  const notDerivable = (node: SliceNode): string | undefined => {
    if (!node.rendered || node.box === undefined) return 'not a rendered node with geometry'
    if (node.layout.mode !== 'HORIZONTAL' && node.layout.mode !== 'VERTICAL') return 'not an auto-layout frame'
    // A declaration outside the known set is not "probably fine": unknown
    // fails closed here as everywhere else. The known distributions and
    // wrap are not objections in themselves — this is a comparison of
    // positions, not of mechanisms, and each child's position is verified
    // on its own.
    if (
      node.layout.wrap === 'unknown' ||
      node.layout.primaryAxisAlign === 'unknown' ||
      node.layout.counterAxisAlign === 'unknown'
    ) {
      return 'the frame declares a layout value outside the known set'
    }
    if (node.layout.overflowDirection !== undefined && node.layout.overflowDirection !== 'NONE') {
      return 'the frame scrolls'
    }
    if (node.layout.clipsContent) return 'the frame clips'
    if (node.effects.length > 0) return 'the frame has effects'
    if (node.fills.length > 0 || node.strokes.length > 0) return 'the frame paints something of its own'
    if (node.blendMode !== undefined && !NEUTRAL_BLEND_MODES.has(node.blendMode)) return 'the frame blends'
    if (node.opacity !== undefined && node.opacity !== 1) return 'the frame has opacity'
    if (node.rotation !== undefined && node.rotation !== 0) return 'the frame is rotated'
    if (childrenCutShort.has(node.sourceId as string)) return 'the children were cut short by the slice budget'
    const children = renderedChildren.get(node.sourceId as string) ?? []
    if (children.length === 0) return 'no rendered children'
    let left = Infinity
    let top = Infinity
    let right = -Infinity
    let bottom = -Infinity
    for (const child of children) {
      if (child.box === undefined) return `child ${child.sourceId} has no geometry`
      if (child.layout.positioning === 'ABSOLUTE') return `child ${child.sourceId} is absolutely positioned`
      if (child.rotation !== undefined && child.rotation !== 0) return `child ${child.sourceId} is rotated`
      // Directly measured, not excused: a chain of derivations would need
      // an order to resolve in, and this kind does not offer one.
      if (!measuredIds.has(child.sourceId as string)) return `child ${child.sourceId} was not measured`
      left = Math.min(left, child.box.x)
      top = Math.min(top, child.box.y)
      right = Math.max(right, child.box.x + child.box.width)
      bottom = Math.max(bottom, child.box.y + child.box.height)
    }
    const padding = node.layout.padding
    // Compared on the design side only: once the children are individually
    // verified within the browser tolerance and the design box is exactly
    // their union plus padding, the measured union follows — a second
    // comparison would restate the first.
    const derived = {
      x: left - padding.left,
      y: top - padding.top,
      width: right - left + padding.left + padding.right,
      height: bottom - top + padding.top + padding.bottom,
    }
    if (
      !within(derived.x, node.box.x) ||
      !within(derived.y, node.box.y) ||
      !within(derived.width, node.box.width) ||
      !within(derived.height, node.box.height)
    ) {
      return 'the box is not its children plus padding'
    }
    return undefined
  }
  const collapsible = (parentId: string): string | undefined => {
    const parent = byId.get(parentId)
    if (parent === undefined) return 'unknown node'
    const padding = parent.layout.padding
    if (padding.top !== 0 || padding.right !== 0 || padding.bottom !== 0 || padding.left !== 0) {
      return 'the parent has padding of its own'
    }
    if (parent.layout.clipsContent) return 'the parent clips'
    if (parent.effects.length > 0) return 'the parent has effects'
    if (parent.opacity !== undefined && parent.opacity !== 1) return 'the parent has opacity'
    if (parent.rotation !== undefined && parent.rotation !== 0) return 'the parent is rotated'
    if ((renderedChildren.get(parentId) ?? []).length !== 1) return 'the parent has more than one rendered child'
    return undefined
  }

  const invalidExclusions: { sourceId: string; reason: string }[] = []
  const excludedIds = new Set<string>()
  for (const exclusion of measured.exclusions) {
    const node = byId.get(exclusion.sourceId)
    if (node === undefined) {
      invalidExclusions.push({ sourceId: exclusion.sourceId, reason: 'not in the slice' })
      continue
    }
    if (exclusion.kind === 'asset-internal') {
      // The inside of a placeholder is under something that was measured;
      // top-level content is not "inside" anything — and being under a
      // measured card does not make a label part of a picture.
      const holder = nearestMeasuredAncestor(exclusion.sourceId)
      if (holder === undefined) {
        invalidExclusions.push({ sourceId: exclusion.sourceId, reason: 'no measured ancestor' })
        continue
      }
      if (!isAssetLike(holder)) {
        invalidExclusions.push({ sourceId: exclusion.sourceId, reason: 'the measured ancestor is not an asset' })
        continue
      }
      excludedIds.add(exclusion.sourceId)
      continue
    }
    if (exclusion.kind === 'derived-from-children') {
      const objection = notDerivable(node)
      if (objection !== undefined) {
        invalidExclusions.push({ sourceId: exclusion.sourceId, reason: objection })
        continue
      }
      excludedIds.add(exclusion.sourceId)
      continue
    }
    if (exclusion.kind === 'native-control-internal') {
      const control = byId.get(exclusion.targetSourceId)
      const controlEntry = entriesById.get(exclusion.targetSourceId)
      const objection =
        node.type !== 'TEXT'
          ? 'not a text node'
          : control === undefined
            ? 'control not in the slice'
            : controlEntry === undefined
              ? 'control was not measured'
              : controlEntry.tagName === undefined || !NATIVE_CONTROLS.has(controlEntry.tagName)
                ? 'the measured control is not a native select'
                : !isDescendantOf(exclusion.sourceId, exclusion.targetSourceId)
                  ? 'not inside the control'
                  : node.box === undefined || control.box === undefined || !contains(control.box, node.box)
                    ? 'not inside the control box'
                    : undefined
      if (objection !== undefined) {
        invalidExclusions.push({ sourceId: exclusion.sourceId, reason: objection })
        continue
      }
      excludedIds.add(exclusion.sourceId)
      continue
    }
    const target = byId.get(exclusion.targetSourceId)
    if (target === undefined) {
      invalidExclusions.push({ sourceId: exclusion.sourceId, reason: 'collapse target not in the slice' })
      continue
    }
    if (!measuredIds.has(exclusion.targetSourceId)) {
      // A chain of mutual collapses must bottom out in something real.
      invalidExclusions.push({ sourceId: exclusion.sourceId, reason: 'collapse target was not measured' })
      continue
    }
    const parentChild =
      (node.parentId as string | undefined) === exclusion.targetSourceId ||
      (target.parentId as string | undefined) === exclusion.sourceId
    if (!parentChild) {
      invalidExclusions.push({ sourceId: exclusion.sourceId, reason: 'not a direct parent-child pair' })
      continue
    }
    if (!boxesEqual(node.box, target.box)) {
      invalidExclusions.push({ sourceId: exclusion.sourceId, reason: 'boxes differ' })
      continue
    }
    const parentId =
      (node.parentId as string | undefined) === exclusion.targetSourceId
        ? exclusion.targetSourceId
        : exclusion.sourceId
    const objection = collapsible(parentId)
    if (objection !== undefined) {
      invalidExclusions.push({ sourceId: exclusion.sourceId, reason: objection })
      continue
    }
    excludedIds.add(exclusion.sourceId)
  }
  invalidExclusions.sort((a, b) => compareCodeUnits(a.sourceId, b.sourceId))

  const unmeasuredRendered = slice.nodes
    .filter(
      (node) =>
        node.rendered &&
        node.box !== undefined &&
        !measuredIds.has(node.sourceId as string) &&
        !excludedIds.has(node.sourceId as string),
    )
    .map((node) => node.sourceId)
    .sort(compareCodeUnits)

  const sharedElements: SharedElement[] = [...byElement.entries()]
    .filter(([, sourceIds]) => sourceIds.length > 1)
    .map(([element, sourceIds]) => ({ element, sourceIds: [...sourceIds].sort(compareCodeUnits) }))
    .sort((a, b) => compareCodeUnits(a.element, b.element))

  mismatches.sort(
    (a, b) => compareCodeUnits(a.sourceId, b.sourceId) || SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot),
  )
  textMetricDeltas.sort(
    (a, b) => compareCodeUnits(a.sourceId, b.sourceId) || SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot),
  )
  wrapFlips.sort((a, b) => compareCodeUnits(a.sourceId, b.sourceId))
  unknownSourceIds.sort(compareCodeUnits)
  withoutExpectedBox.sort(compareCodeUnits)
  entriesWithoutElement.sort(compareCodeUnits)

  return {
    rootSourceId: root.sourceId,
    measuredSchemaVersion: measured.schemaVersion,
    designWidthPx: measured.designWidthPx,
    viewportWidthPx: measured.viewportWidthPx,
    scaled: measured.viewportWidthPx !== measured.designWidthPx,
    tolerancePx,
    textTolerancePx,
    textTolerancePerLinePx,
    comparedCount,
    matchedCount,
    mismatches,
    textMetricDeltas,
    wrapFlips,
    exclusions: [...measured.exclusions].sort((a, b) => compareCodeUnits(a.sourceId, b.sourceId)),
    invalidExclusions,
    entriesWithoutElement,
    sharedElements,
    unknownSourceIds,
    withoutExpectedBox,
    unmeasuredRendered,
  }
}

export interface GeometryGateOptions {
  /**
   * Fails the gate on coverage gaps too.
   *
   * The default treats which nodes to measure as the caller's scope decision.
   * Scoring flips that: without required coverage, "zero mismatches" is
   * achievable by measuring nothing, so a scored run must either measure
   * every rendered node with geometry — or exclude it with a declared,
   * machine-readable reason — or fail.
   */
  readonly requireCoverage?: boolean
  /**
   * Fails entries that carry no element identity.
   *
   * The shared-element check only sees what the collector labelled; leaving
   * the labels off would silence it. A scored run demands them.
   */
  readonly requireElements?: boolean
}

/** True when the report should fail a verification gate. Wrong mappings always fail; coverage gaps only when required. */
export const geometryReportFails = (report: GeometryReport, options: GeometryGateOptions = {}): boolean =>
  report.mismatches.length > 0 ||
  report.wrapFlips.length > 0 ||
  report.sharedElements.length > 0 ||
  report.invalidExclusions.length > 0 ||
  report.unknownSourceIds.length > 0 ||
  report.withoutExpectedBox.length > 0 ||
  (options.requireCoverage === true && report.unmeasuredRendered.length > 0) ||
  (options.requireElements === true && report.entriesWithoutElement.length > 0)
