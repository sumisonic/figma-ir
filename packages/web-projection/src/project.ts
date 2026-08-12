/**
 * The translator: declaration in, prediction out, verification against what
 * is actually there. See types.ts for why both inputs are required.
 *
 * The contract is uniform: a numeric or positional claim leaves this file as
 * `known` only when the declaration's prediction matched the observed
 * geometry. That covers wrap rows, single-line stacks, and FILL sizes alike —
 * a claim the current children cannot verify is not a claim, it is a guess
 * with a type.
 */
import {
  canonicalStringify,
  compareCodeUnits,
  cutSlice,
  hashCanonicalString,
  known,
  roundPx,
  unknown,
  type Box,
  type CanonicalDoc,
  type FactIndex,
  type Hash,
  type Known,
  type LayoutFacts,
  type Slice,
  type SliceNode,
} from '@figma-ir/core'

import {
  EMULATOR_TOLERANCE_PX,
  TRANSLATOR_VERSION,
  WEB_PROJECTION_SCHEMA_VERSION,
  type AxisSizePlan,
  type ContainerFlexPlan,
  type ContainerPlan,
  type ContradictionEvidence,
  type Distribution,
  type NodeProjection,
  type Obligation,
  type ObservedArrangement,
  type ProjectionDiagnostic,
  type RepeatRule,
  type Verification,
  type WebProjectionArtifact,
  type WebProjectionRequest,
  type WrapProjection,
  type WrapVerification,
} from './types.js'
import { projectionToJson } from './wire.js'

const near = (a: number, b: number): boolean => Math.abs(a - b) <= EMULATOR_TOLERANCE_PX

/** Integer centipixels, so capacity boundaries are exact instead of IEEE-adjacent. */
const centi = (px: number): number => Math.round(px * 100)

const DISTRIBUTIONS: Record<'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN', Distribution> = {
  MIN: 'start',
  CENTER: 'center',
  MAX: 'end',
  SPACE_BETWEEN: 'space-between',
}

const CONSISTENT: Verification = { kind: 'consistent' }

const containerOf = (layout: LayoutFacts): ContainerPlan => {
  if (layout.mode === 'NONE') return { kind: 'non-flex' }
  if (layout.mode === 'GRID' || layout.mode === 'unknown' || layout.wrap === 'unknown') {
    return { kind: 'unknown', reason: 'UNSUPPORTED_LAYOUT' }
  }

  const mainAlign: Known<Distribution> =
    layout.primaryAxisAlign === 'unknown'
      ? unknown('UNSUPPORTED_LAYOUT')
      : known(DISTRIBUTIONS[layout.primaryAxisAlign])
  const crossAlign: Known<'start' | 'center' | 'end'> =
    layout.counterAxisAlign === 'unknown' || layout.counterAxisAlign === 'BASELINE'
      ? unknown('UNSUPPORTED_LAYOUT')
      : known(DISTRIBUTIONS[layout.counterAxisAlign] as 'start' | 'center' | 'end')

  // Inert declarations are not repeated: under space-between the packing gap
  // is zero regardless of what itemSpacing says (verified against a real page
  // where itemSpacing said 30 and the children sat 9 apart).
  const mainGapPx: Known<number> =
    layout.primaryAxisAlign === 'SPACE_BETWEEN' ? known(0) : known(layout.itemSpacing ?? 0)
  const crossGapPx: Known<number> =
    layout.counterAxisAlignContent === 'SPACE_BETWEEN' || layout.counterAxisAlignContent === 'unknown'
      ? unknown('UNSUPPORTED_LAYOUT')
      : known(layout.counterAxisSpacing ?? layout.itemSpacing ?? 0)

  return {
    kind: 'flex',
    direction: layout.mode === 'HORIZONTAL' ? 'row' : 'column',
    wrap: layout.wrap === 'WRAP',
    mainAlign,
    crossAlign,
    mainGapPx,
    crossGapPx,
    padding: layout.padding,
  }
}

const axisPlanOf = (
  node: SliceNode,
  parent: SliceNode | undefined,
  axis: 'horizontal' | 'vertical',
): AxisSizePlan => {
  const sizing = axis === 'horizontal' ? node.layout.sizingHorizontal : node.layout.sizingVertical
  switch (sizing) {
    case 'FIXED': {
      if (node.box === undefined) return { kind: 'unknown', reason: 'GEOMETRY_MISSING' }
      return { kind: 'fixed', px: axis === 'horizontal' ? node.box.width : node.box.height }
    }
    case 'HUG':
      return { kind: 'intrinsic' }
    case 'FILL': {
      // FILL is a flow behaviour. An absolutely positioned child is not in
      // the flow, so the flex/stretch reading does not apply to it.
      if (node.layout.positioning === 'ABSOLUTE') return { kind: 'unknown', reason: 'UNSUPPORTED_LAYOUT' }
      // The same FILL is flex-grow on the parent's main axis and stretch on
      // its cross axis; without the parent there is no answer.
      if (
        parent === undefined ||
        parent.layout.mode === 'NONE' ||
        parent.layout.mode === 'GRID' ||
        parent.layout.mode === 'unknown'
      ) {
        return { kind: 'unknown', reason: 'PARENT_LAYOUT_REQUIRED' }
      }
      const parentMain = parent.layout.mode === 'HORIZONTAL' ? 'horizontal' : 'vertical'
      return axis === parentMain ? { kind: 'flex' } : { kind: 'stretch' }
    }
    case 'UNSPECIFIED':
      return { kind: 'unknown', reason: 'UNSUPPORTED_LAYOUT' }
  }
}

interface ObservedLine {
  readonly y: number
  readonly children: ReadonlyArray<SliceNode>
}

const observeLines = (container: Box, children: ReadonlyArray<SliceNode>): ObservedLine[] => {
  const lines: { y: number; children: SliceNode[] }[] = []
  const sorted = [...children].sort(
    (a, b) => a.box!.y - b.box!.y || a.box!.x - b.box!.x || compareCodeUnits(a.sourceId, b.sourceId),
  )
  for (const child of sorted) {
    const y = roundPx(child.box!.y - container.y)
    const line = lines.find((candidate) => near(candidate.y, y))
    if (line === undefined) lines.push({ y, children: [child] })
    else line.children.push(child)
  }
  return lines
}

/** Predicted main-axis offsets (content-box relative) for one line of items. */
const lineOffsets = (
  distribution: Distribution,
  sizes: ReadonlyArray<number>,
  gapPx: number,
  innerPx: number,
): number[] => {
  const n = sizes.length
  const total = sizes.reduce((sum, size) => sum + size, 0)
  if (distribution === 'space-between' && n > 1) {
    const step = (innerPx - total) / (n - 1)
    const offsets: number[] = []
    let cursor = 0
    for (const size of sizes) {
      offsets.push(roundPx(cursor))
      cursor += size + step
    }
    return offsets
  }
  const lineWidth = total + (n - 1) * gapPx
  const origin =
    distribution === 'center' ? (innerPx - lineWidth) / 2 : distribution === 'end' ? innerPx - lineWidth : 0
  const offsets: number[] = []
  let cursor = origin
  for (const size of sizes) {
    offsets.push(roundPx(cursor))
    cursor += size + gapPx
  }
  return offsets
}

interface WrapAttempt {
  readonly wrap: WrapProjection | undefined
  readonly diagnostics: ProjectionDiagnostic[]
}

const NO_WRAP: WrapAttempt = { wrap: undefined, diagnostics: [] }

/**
 * The wrap plan, under the v1 entry conditions: a fixed-extent row that
 * wraps, uniform fixed-size children, cross-axis packed to the start.
 * Anything outside stays undefined — a narrow translator that is right
 * beats a broad one that guesses.
 */
const wrapOf = (node: SliceNode, children: ReadonlyArray<SliceNode>): WrapAttempt => {
  const layout = node.layout
  const container = containerOf(layout)
  if (container.kind !== 'flex' || container.direction !== 'row' || !container.wrap) return NO_WRAP
  if (node.box === undefined || children.length === 0) return NO_WRAP
  if (layout.sizingHorizontal === 'HUG') return NO_WRAP
  if (layout.counterAxisAlign !== 'MIN') return NO_WRAP
  // Absence is the API default (AUTO); SPACE_BETWEEN and unrecognised values
  // change how lines are laid out and sit outside this subset.
  if (layout.counterAxisAlignContent === 'SPACE_BETWEEN' || layout.counterAxisAlignContent === 'unknown') return NO_WRAP
  if (container.mainAlign.kind !== 'known') return NO_WRAP

  const eligible = children.every(
    (child) =>
      child.layout.positioning !== 'ABSOLUTE' &&
      child.layout.sizingHorizontal === 'FIXED' &&
      child.layout.sizingVertical === 'FIXED' &&
      child.box !== undefined &&
      (child.rotation === undefined || child.rotation === 0),
  )
  if (!eligible) return NO_WRAP

  const first = children[0]!.box!
  const uniform = children.every((child) => near(child.box!.width, first.width) && near(child.box!.height, first.height))
  if (!uniform) return NO_WRAP

  const padding = layout.padding
  const innerPx = roundPx(node.box.width - padding.left - padding.right)
  const trackMain = first.width
  const trackCross = first.height
  const fullDistribution = container.mainAlign.value
  const packingGapPx = fullDistribution === 'space-between' ? 0 : (layout.itemSpacing ?? 0)
  const lineGapPx = layout.counterAxisSpacing ?? layout.itemSpacing ?? 0
  if (trackMain <= 0 || packingGapPx < 0 || lineGapPx < 0) return NO_WRAP

  // Observation: how the current children actually sit.
  const ordered = [...children].sort((a, b) => a.visualOrderIndex - b.visualOrderIndex)
  const lines = observeLines(node.box, children)
  const observed: ObservedArrangement = {
    lines: lines.map((line) => ({ childIds: line.children.map((child) => child.sourceId) })),
  }

  // Prediction: where the rule would put them. Integer centipixels keep the
  // exactly-fits boundary exact — IEEE noise in a float division must not
  // decide between two and three columns.
  const capacity = Math.max(
    1,
    Math.floor((centi(innerPx) + centi(packingGapPx)) / (centi(trackMain) + centi(packingGapPx))),
  )
  const predictedLines: SliceNode[][] = []
  for (let start = 0; start < ordered.length; start += capacity) {
    predictedLines.push(ordered.slice(start, start + capacity))
  }

  const diagnostics: ProjectionDiagnostic[] = []
  const contradiction = (detail: string, evidence: ContradictionEvidence): Verification => {
    diagnostics.push({ reason: 'GEOMETRY_CONTRADICTION', detail, sourceIds: [node.sourceId], evidence })
    return { kind: 'contradicted', reason: 'GEOMETRY_CONTRADICTION' }
  }

  const membershipMatches =
    predictedLines.length === lines.length &&
    predictedLines.every(
      (predicted, index) =>
        predicted.length === lines[index]!.children.length &&
        predicted.every((child, position) => child.sourceId === lines[index]!.children[position]!.sourceId),
    )
  const lineMembership: Verification = membershipMatches
    ? CONSISTENT
    : contradiction('predicted line membership disagrees with the observed rows', {
        kind: 'wrap-membership',
        predictedRows: predictedLines.length,
        observedRows: lines.length,
      })

  // Partial-line distribution: known only from the declaration (start/center/
  // end pack every line the same way) or from an observed partial line that
  // exactly one candidate explains. A lone under-capacity line is partial too.
  let partialDistribution: Known<Distribution> =
    fullDistribution === 'space-between' ? unknown('PARTIAL_LINE_UNOBSERVED') : known(fullDistribution)

  let inlinePositions: Verification = CONSISTENT
  let crossPositions: Verification = CONSISTENT
  let childSizes: Verification = CONSISTENT

  if (membershipMatches) {
    for (const [index, line] of lines.entries()) {
      const n = line.children.length
      const isPartial = index === lines.length - 1 && n < capacity
      const xs = line.children.map((child) => roundPx(child.box!.x - node.box!.x - padding.left))
      const sizes = line.children.map(() => trackMain)
      /** The first child that is not where the distribution predicts, or -1. */
      const firstMiss = (distribution: Distribution): { position: number; predictedPx: number } | undefined => {
        const predicted = lineOffsets(distribution, sizes, packingGapPx, innerPx)
        const position = predicted.findIndex((x, i) => !near(x, xs[i]!))
        return position < 0 ? undefined : { position, predictedPx: predicted[position]! }
      }
      if (!isPartial || partialDistribution.kind === 'known') {
        const distribution =
          isPartial && partialDistribution.kind === 'known' ? partialDistribution.value : fullDistribution
        const miss = firstMiss(distribution)
        if (miss !== undefined) {
          inlinePositions = contradiction(
            `row ${index} does not sit where ${distribution} with a ${packingGapPx}px packing gap predicts`,
            {
              kind: 'wrap-inline',
              row: index,
              distribution,
              packingGapPx,
              childSourceId: line.children[miss.position]!.sourceId,
              observedPx: xs[miss.position]!,
              predictedPx: miss.predictedPx,
            },
          )
          break
        }
      } else {
        // An observed partial line under space-between: let the candidates
        // compete. Exactly one survivor is a fact; several is a coincidence
        // the snapshot cannot break.
        const survivors = (['start', 'center', 'end', 'space-between'] as const).filter(
          (candidate) => firstMiss(candidate) === undefined,
        )
        if (survivors.length === 1) partialDistribution = known(survivors[0]!)
        else if (survivors.length === 0) {
          inlinePositions = contradiction(`the partial row matches none of the supported distributions`, {
            kind: 'wrap-partial-row',
            row: index,
          })
        }
      }
    }

    const expectedCross = (index: number): number => roundPx(padding.top + index * (trackCross + lineGapPx))
    const crossDrift = lines.findIndex((line, index) => !near(line.y, expectedCross(index)))
    if (crossDrift >= 0) {
      crossPositions = contradiction(`row ${crossDrift} does not sit where a ${lineGapPx}px line gap predicts`, {
        kind: 'wrap-cross',
        row: crossDrift,
        lineGapPx,
        observedPx: lines[crossDrift]!.y,
        predictedPx: expectedCross(crossDrift),
      })
    }

    const sizeDrift = children.find(
      (child) => !near(child.box!.width, trackMain) || !near(child.box!.height, trackCross),
    )
    if (sizeDrift !== undefined) {
      childSizes = contradiction(`child ${sizeDrift.sourceId} is not the uniform track size`, {
        kind: 'wrap-child-size',
        childSourceId: sizeDrift.sourceId,
        observedMainPx: sizeDrift.box!.width,
        observedCrossPx: sizeDrift.box!.height,
        trackMainPx: trackMain,
        trackCrossPx: trackCross,
      })
    }
  } else {
    inlinePositions = { kind: 'contradicted', reason: 'GEOMETRY_CONTRADICTION' }
    crossPositions = { kind: 'contradicted', reason: 'GEOMETRY_CONTRADICTION' }
  }

  // Fail closed: a contradicted claim must not travel as a usable rule.
  const demoteUnless = <A>(value: Known<A>, ...verifications: Verification[]): Known<A> =>
    verifications.every((verification) => verification.kind === 'consistent')
      ? value
      : unknown('GEOMETRY_CONTRADICTION')

  const verification: WrapVerification = { lineMembership, inlinePositions, crossPositions, childSizes }
  const rule: RepeatRule = {
    axis: known('horizontal'),
    track: demoteUnless(known({ mainPx: trackMain, crossPx: trackCross }), childSizes),
    packingGapPx: demoteUnless(known(packingGapPx), lineMembership, inlinePositions),
    fullLineDistribution: demoteUnless(known(fullDistribution), lineMembership, inlinePositions),
    partialLineDistribution: demoteUnless(partialDistribution, lineMembership, inlinePositions),
    lineGapPx: demoteUnless(known(lineGapPx), crossPositions),
  }

  return { wrap: { observed, rule, verification }, diagnostics }
}

interface StackReview {
  readonly container: ContainerPlan
  readonly diagnostics: ProjectionDiagnostic[]
}

/**
 * Verifies a single-line flex container's numeric claims against geometry,
 * one claim at a time.
 *
 * The declaration names an alignment and a gap. Each is checked on its own
 * evidence — the gap on every adjacent pair, the alignment on where the
 * observed span sits — so a wrong gap does not take the alignment down with
 * it, and a reader is told which one failed. A claim with nothing to observe
 * it on (a gap with one child) is not verified, and says so. Without this
 * pass a container's claims were exactly the "declared, therefore true"
 * reading the two-input design exists to forbid.
 */
const reviewStack = (
  node: SliceNode,
  plan: ContainerFlexPlan,
  flow: ReadonlyArray<SliceNode>,
  notRenderedChildCount: number,
): StackReview => {
  if (flow.length === 0) return { container: plan, diagnostics: [] }

  const demoteAll = (reason: Parameters<typeof unknown>[0]): StackReview => ({
    container: {
      ...plan,
      mainAlign: plan.mainAlign.kind === 'known' ? unknown(reason) : plan.mainAlign,
      crossAlign: plan.crossAlign.kind === 'known' ? unknown(reason) : plan.crossAlign,
      mainGapPx: plan.mainGapPx.kind === 'known' ? unknown(reason) : plan.mainGapPx,
    },
    diagnostics: [],
  })

  if (node.box === undefined) return demoteAll('GEOMETRY_MISSING')
  const measurable = flow.every(
    (child) => child.box !== undefined && (child.rotation === undefined || child.rotation === 0),
  )
  if (!measurable) return demoteAll('GEOMETRY_MISSING')

  const horizontal = plan.direction === 'row'
  const mainAxis = horizontal ? 'x' : 'y'
  const box = node.box
  const padding = plan.padding
  const mainStart = horizontal ? padding.left : padding.top
  const crossStart = horizontal ? padding.top : padding.left
  const innerMain = roundPx((horizontal ? box.width : box.height) - mainStart - (horizontal ? padding.right : padding.bottom))
  const innerCross = roundPx((horizontal ? box.height : box.width) - crossStart - (horizontal ? padding.bottom : padding.right))

  const ordered = [...flow].sort((a, b) => a.visualOrderIndex - b.visualOrderIndex)
  const sizes = ordered.map((child) => (horizontal ? child.box!.width : child.box!.height))
  const offsets = ordered.map((child) =>
    roundPx((horizontal ? child.box!.x - box.x : child.box!.y - box.y) - mainStart),
  )

  let reviewed = plan
  const diagnostics: ProjectionDiagnostic[] = []
  const contradiction = (detail: string, evidence: ContradictionEvidence): void => {
    diagnostics.push({ reason: 'GEOMETRY_CONTRADICTION', detail, sourceIds: [node.sourceId], evidence })
  }

  // One child has no gap to observe, whatever the distribution. The
  // declaration is still in the slice; it is just not a verified claim.
  if (plan.mainGapPx.kind === 'known' && ordered.length < 2) {
    reviewed = { ...reviewed, mainGapPx: unknown('GAP_UNOBSERVED') }
  }

  const spaceBetween = plan.mainAlign.kind === 'known' && plan.mainAlign.value === 'space-between'
  if (spaceBetween) {
    // Under space-between the packing gap is zero by definition and the
    // positions are one prediction: the two claims stand or fall together
    // (a gap already unverified stays so).
    const predicted = lineOffsets('space-between', sizes, 0, innerMain)
    const miss = predicted.findIndex((offset, index) => !near(offset, offsets[index]!))
    if (miss >= 0) {
      contradiction(`children do not sit where space-between predicts`, {
        kind: 'stack-origin',
        axis: mainAxis,
        distribution: 'space-between',
        childSourceId: ordered[miss]!.sourceId,
        observedPx: offsets[miss]!,
        predictedPx: predicted[miss]!,
        notRenderedChildCount,
      })
      reviewed = {
        ...reviewed,
        mainAlign: unknown('GEOMETRY_CONTRADICTION'),
        mainGapPx: reviewed.mainGapPx.kind === 'known' ? unknown('GEOMETRY_CONTRADICTION') : reviewed.mainGapPx,
      }
    }
  } else {
    if (plan.mainGapPx.kind === 'known') {
      if (ordered.length >= 2) {
        const gapPx = plan.mainGapPx.value
        for (let index = 1; index < ordered.length; index += 1) {
          const observedGap = roundPx(offsets[index]! - (offsets[index - 1]! + sizes[index - 1]!))
          if (near(observedGap, gapPx)) continue
          contradiction(`children ${ordered[index - 1]!.sourceId} and ${ordered[index]!.sourceId} are not ${gapPx}px apart`, {
            kind: 'stack-gap',
            axis: mainAxis,
            beforeSourceId: ordered[index - 1]!.sourceId,
            afterSourceId: ordered[index]!.sourceId,
            observedPx: observedGap,
            predictedPx: gapPx,
          })
          reviewed = { ...reviewed, mainGapPx: unknown('GEOMETRY_CONTRADICTION') }
          break
        }
      }
    }
    if (plan.mainAlign.kind === 'known') {
      // Where the observed span sits, independent of what the gaps are: the
      // distribution is a claim about the origin, checked on the origin.
      const last = ordered.length - 1
      const span = roundPx(offsets[last]! + sizes[last]! - offsets[0]!)
      const distribution = plan.mainAlign.value
      const predictedOrigin = roundPx(
        distribution === 'center' ? (innerMain - span) / 2 : distribution === 'end' ? innerMain - span : 0,
      )
      if (!near(predictedOrigin, offsets[0]!)) {
        contradiction(`the children do not start where ${distribution} predicts`, {
          kind: 'stack-origin',
          axis: mainAxis,
          distribution,
          childSourceId: ordered[0]!.sourceId,
          observedPx: offsets[0]!,
          predictedPx: predictedOrigin,
          notRenderedChildCount,
        })
        reviewed = { ...reviewed, mainAlign: unknown('GEOMETRY_CONTRADICTION') }
      }
    }
  }

  if (reviewed.crossAlign.kind === 'known') {
    const align = reviewed.crossAlign.value
    for (const child of ordered) {
      // A stretched child sits at the cross start by construction; its size
      // claim is reviewed with the axis plans, not here.
      const crossSizing = horizontal ? child.layout.sizingVertical : child.layout.sizingHorizontal
      if (crossSizing === 'FILL') continue
      const childCross = horizontal ? child.box!.height : child.box!.width
      const offset = roundPx((horizontal ? child.box!.y - box.y : child.box!.x - box.x) - crossStart)
      const expected = roundPx(
        align === 'center' ? (innerCross - childCross) / 2 : align === 'end' ? innerCross - childCross : 0,
      )
      if (near(offset, expected)) continue
      contradiction(`child ${child.sourceId} does not sit where cross-axis ${align} predicts`, {
        kind: 'stack-cross',
        axis: horizontal ? 'y' : 'x',
        align,
        childSourceId: child.sourceId,
        observedPx: offset,
        predictedPx: expected,
      })
      reviewed = { ...reviewed, crossAlign: unknown('GEOMETRY_CONTRADICTION') }
      break
    }
  }

  return { container: reviewed, diagnostics }
}

/** FILL sizes are predictions too: stretch must span, flex must share the remainder. */
const reviewAxisPlan = (
  plan: AxisSizePlan,
  node: SliceNode,
  parent: SliceNode | undefined,
  siblingsInFlow: ReadonlyArray<SliceNode>,
  axis: 'horizontal' | 'vertical',
  diagnostics: ProjectionDiagnostic[],
): AxisSizePlan => {
  if (plan.kind !== 'stretch' && plan.kind !== 'flex') return plan
  if (parent === undefined || parent.box === undefined || node.box === undefined) {
    return { kind: 'unknown', reason: 'GEOMETRY_MISSING' }
  }
  const horizontal = axis === 'horizontal'
  const padding = parent.layout.padding
  const inner = roundPx(
    (horizontal ? parent.box.width : parent.box.height) -
      (horizontal ? padding.left + padding.right : padding.top + padding.bottom),
  )
  const size = horizontal ? node.box.width : node.box.height

  const axisName = horizontal ? 'width' : 'height'
  if (plan.kind === 'stretch') {
    if (near(size, inner)) return plan
    diagnostics.push({
      reason: 'GEOMETRY_CONTRADICTION',
      detail: `a stretch child measures ${size}px against a ${inner}px content box`,
      sourceIds: [node.sourceId],
      evidence: { kind: 'axis-size', axis: axisName, plan: 'stretch', observedPx: size, predictedPx: inner },
    })
    return { kind: 'unknown', reason: 'GEOMETRY_CONTRADICTION' }
  }

  // flex: the remainder after non-flex siblings and gaps, split evenly among
  // the flex ones (Figma FILL has no weights).
  const mainSizing = (sibling: SliceNode) =>
    horizontal ? sibling.layout.sizingHorizontal : sibling.layout.sizingVertical
  if (siblingsInFlow.some((sibling) => sibling.box === undefined)) {
    return { kind: 'unknown', reason: 'GEOMETRY_MISSING' }
  }
  const gap =
    parent.layout.primaryAxisAlign === 'SPACE_BETWEEN' ? 0 : (parent.layout.itemSpacing ?? 0)
  const flexCount = siblingsInFlow.filter((sibling) => mainSizing(sibling) === 'FILL').length
  const fixedTotal = siblingsInFlow
    .filter((sibling) => mainSizing(sibling) !== 'FILL')
    .reduce((sum, sibling) => sum + (horizontal ? sibling.box!.width : sibling.box!.height), 0)
  const remainder = inner - fixedTotal - gap * (siblingsInFlow.length - 1)
  const expected = roundPx(remainder / Math.max(1, flexCount))
  if (near(size, expected)) return plan
  diagnostics.push({
    reason: 'GEOMETRY_CONTRADICTION',
    detail: `a flex child measures ${size}px where the remainder predicts ${expected}px`,
    sourceIds: [node.sourceId],
    evidence: { kind: 'axis-size', axis: axisName, plan: 'flex', observedPx: size, predictedPx: expected },
  })
  return { kind: 'unknown', reason: 'GEOMETRY_CONTRADICTION' }
}

export interface ProjectWebInput {
  readonly doc: CanonicalDoc
  readonly facts: FactIndex
  readonly request: WebProjectionRequest
}

export const projectWeb = ({ doc, facts, request }: ProjectWebInput): WebProjectionArtifact => {
  const slice: Slice = cutSlice(doc, facts, {
    roots: request.roots,
    ...(request.maxDepth === undefined ? {} : { maxDepth: request.maxDepth }),
    ...(request.maxNodes === undefined ? {} : { maxNodes: request.maxNodes }),
  })

  const byId = new Map(slice.nodes.map((node) => [node.sourceId as string, node]))
  const childrenOf = new Map<string, SliceNode[]>()
  for (const node of slice.nodes) {
    if (node.parentId === undefined || !node.rendered) continue
    const list = childrenOf.get(node.parentId as string)
    if (list === undefined) childrenOf.set(node.parentId as string, [node])
    else list.push(node)
  }

  // A parent whose children were cut out of the slice (depth or node budget)
  // must not claim rules about "all" its children — it never saw them all.
  const incomplete = new Set<string>()
  const notRenderedChildren = new Map<string, number>()
  for (const entry of slice.omitted) {
    if (entry.parentId === undefined) continue
    if (entry.reason !== 'not-rendered') incomplete.add(entry.parentId as string)
    else notRenderedChildren.set(entry.parentId as string, (notRenderedChildren.get(entry.parentId as string) ?? 0) + 1)
  }
  for (const node of slice.nodes) if (node.truncated !== undefined) incomplete.add(node.sourceId as string)

  const nodes: NodeProjection[] = []
  const diagnostics: ProjectionDiagnostic[] = []
  const obligations: Obligation[] = []

  for (const node of slice.nodes) {
    const parent = node.parentId === undefined ? undefined : byId.get(node.parentId as string)
    const children = childrenOf.get(node.sourceId as string) ?? []
    const flow = children.filter((child) => child.layout.positioning !== 'ABSOLUTE')
    const complete = !incomplete.has(node.sourceId as string)

    let container = containerOf(node.layout)
    let wrap: WrapProjection | undefined
    if (node.rendered && container.kind === 'flex' && complete) {
      if (container.wrap) {
        const attempt = wrapOf(node, flow)
        wrap = attempt.wrap
        diagnostics.push(...attempt.diagnostics)
        if (wrap !== undefined) {
          // The container's numeric claims are the wrap rule's claims;
          // they succeed and fail together.
          container = {
            ...container,
            mainAlign: wrap.rule.fullLineDistribution,
            mainGapPx: wrap.rule.packingGapPx,
            crossGapPx: wrap.rule.lineGapPx,
          }
        } else {
          // A wrap container outside the subset has unverifiable numbers.
          container = {
            ...container,
            mainAlign: unknown('UNSUPPORTED_LAYOUT'),
            mainGapPx: unknown('UNSUPPORTED_LAYOUT'),
            crossGapPx: unknown('UNSUPPORTED_LAYOUT'),
          }
        }
      } else {
        const review = reviewStack(node, container, flow, notRenderedChildren.get(node.sourceId as string) ?? 0)
        container = review.container
        diagnostics.push(...review.diagnostics)
      }
    } else if (container.kind === 'flex' && !complete) {
      container = {
        ...container,
        mainAlign: unknown('DEPTH_LIMIT_EXCEEDED'),
        mainGapPx: unknown('DEPTH_LIMIT_EXCEEDED'),
        crossGapPx: unknown('DEPTH_LIMIT_EXCEEDED'),
      }
    }

    const parentFlow =
      parent === undefined
        ? []
        : (childrenOf.get(parent.sourceId as string) ?? []).filter(
            (sibling) => sibling.layout.positioning !== 'ABSOLUTE',
          )
    const widthPlan = reviewAxisPlan(
      axisPlanOf(node, parent, 'horizontal'),
      node,
      parent,
      parent?.layout.mode === 'HORIZONTAL' ? parentFlow : [node],
      'horizontal',
      diagnostics,
    )
    const heightPlan = reviewAxisPlan(
      axisPlanOf(node, parent, 'vertical'),
      node,
      parent,
      parent?.layout.mode === 'VERTICAL' ? parentFlow : [node],
      'vertical',
      diagnostics,
    )

    const projection: NodeProjection = {
      sourceId: node.sourceId,
      participation: node.rendered ? 'rendered' : 'not-rendered',
      container,
      widthPlan,
      heightPlan,
      wrap,
    }
    nodes.push(projection)

    if (!node.rendered) continue
    const claim = (name: 'container' | 'width' | 'height' | 'wrap'): Obligation => ({
      projectionFactId: `${node.sourceId as string}#${name}`,
      sourceId: node.sourceId,
      claim: name,
    })
    if (container.kind !== 'unknown') obligations.push(claim('container'))
    if (widthPlan.kind !== 'unknown') obligations.push(claim('width'))
    if (heightPlan.kind !== 'unknown') obligations.push(claim('height'))
    if (wrap !== undefined) obligations.push(claim('wrap'))

    // A HUG child on its parent's cross axis: on the web it would stretch
    // unless told otherwise, so "intrinsic" here is a duty, not a default.
    const parentMode = parent?.layout.mode
    if (
      parent !== undefined &&
      (parentMode === 'HORIZONTAL' || parentMode === 'VERTICAL') &&
      node.layout.positioning !== 'ABSOLUTE'
    ) {
      const crossAxis = parentMode === 'HORIZONTAL' ? 'height' : 'width'
      const crossSizing = parentMode === 'HORIZONTAL' ? node.layout.sizingVertical : node.layout.sizingHorizontal
      const crossPlan = crossAxis === 'height' ? heightPlan : widthPlan
      if (crossSizing === 'HUG' && crossPlan.kind === 'intrinsic') {
        obligations.push({
          projectionFactId: `${node.sourceId as string}#preserveIntrinsicCrossSize`,
          sourceId: node.sourceId,
          claim: 'preserveIntrinsicCrossSize',
          axis: crossAxis,
        })
      }
    }
  }

  const normalizedRequest = {
    roots: [...new Set(slice.request.roots)].sort(compareCodeUnits),
    maxDepth: slice.request.maxDepth ?? undefined,
    maxNodes: slice.request.maxNodes ?? 2000,
    includeHidden: slice.request.includeHidden ?? false,
  }
  const projectionRequestHash = hashCanonicalString(
    'projection',
    WEB_PROJECTION_SCHEMA_VERSION,
    canonicalStringify({
      canonicalHash: slice.canonicalHash as string,
      translatorVersion: TRANSLATOR_VERSION,
      request: { ...normalizedRequest, maxDepth: normalizedRequest.maxDepth ?? null },
    }),
  ) as Hash<'projection'>

  const artifact: WebProjectionArtifact = {
    schemaVersion: WEB_PROJECTION_SCHEMA_VERSION,
    translatorVersion: TRANSLATOR_VERSION,
    emulatorTolerancePx: EMULATOR_TOLERANCE_PX,
    fileKey: slice.fileKey,
    sourceVersion: slice.sourceVersion,
    canonicalHash: slice.canonicalHash,
    snapshotId: slice.snapshotId,
    request: normalizedRequest,
    projectionRequestHash,
    nodes,
    diagnostics,
    obligations,
    projectionHash: '' as Hash<'projection'>,
  }
  return {
    ...artifact,
    projectionHash: hashCanonicalString(
      'projection',
      WEB_PROJECTION_SCHEMA_VERSION,
      canonicalStringify(projectionToJson(artifact)),
    ) as Hash<'projection'>,
  }
}
