/**
 * Cutting a slice out of a canonical document.
 *
 * Deterministic like everything else: the same document and the same request
 * give the same bytes, and the slice carries hashes of both the request and the
 * result so a consumer can tell whether what it holds still describes the
 * design.
 */
import { canonicalStringify, compareCodeUnits, type CanonicalValue } from '../determinism/canonical.js'
import { hashCanonicalString } from '../determinism/hash.js'
import type { SourceId } from '../identity/nodeIdentity.js'
import { unsafeUnwrap } from '../text/untrusted.js'
import type { CanonicalDoc, CanonicalNode, CanonicalPaint, StyleValue } from '../canonical/document.js'
import { indexBySourceId } from '../canonical/adapter.js'
import type { FactIndex } from '../facts/types.js'
import type { Finding } from '../rules/types.js'
import {
  DEFAULT_MAX_NODES,
  SLICE_SCHEMA_VERSION,
  type Slice,
  type SliceFinding,
  type SliceNode,
  type SliceRequest,
} from './types.js'

export class SliceError extends Error {
  readonly _tag = 'SliceError'
  constructor(message: string) {
    super(message)
    this.name = 'SliceError'
  }
}

interface Omission {
  sourceId: SourceId
  parentId: SourceId | undefined
  reason: 'not-rendered' | 'max-depth' | 'max-nodes'
  descendantCount: number
}

const countDescendants = (node: CanonicalNode): number =>
  node.children.reduce((total, child) => total + 1 + countDescendants(child), 0)

/**
 * Builds a slice.
 *
 * `findings` are filtered to the slice: a consumer working on one section
 * should see the problems in that section. Findings that also cite nodes
 * outside it are kept, with those ids listed, because a finding about a
 * mismatch between breakpoints is exactly the kind that spans a slice and
 * silently trimming it would make it look like a local problem.
 */
export const cutSlice = (
  doc: CanonicalDoc,
  facts: FactIndex,
  request: SliceRequest,
  findings: ReadonlyArray<Finding> = [],
): Slice => {
  if (request.roots.length === 0) throw new SliceError('a slice needs at least one root')
  if (request.maxDepth !== undefined && (!Number.isInteger(request.maxDepth) || request.maxDepth < 0)) {
    throw new SliceError(`maxDepth must be a non-negative integer, got ${String(request.maxDepth)}`)
  }
  const maxNodes = request.maxNodes ?? DEFAULT_MAX_NODES
  if (!Number.isInteger(maxNodes) || maxNodes < 1) {
    throw new SliceError(`maxNodes must be a positive integer, got ${String(maxNodes)}`)
  }

  const byId = indexBySourceId(doc)
  const requested = [...new Set(request.roots)].sort(compareCodeUnits)
  if (requested.length !== request.roots.length) {
    throw new SliceError('roots contains a duplicate')
  }
  const missing = requested.filter((id) => !byId.has(id as SourceId))
  if (missing.length > 0) {
    // Quietly returning a smaller slice would look like a smaller design.
    // A root the adapter rejected is absent for a reason it recorded; the
    // reason travels with the error, or the person is left to guess
    // between a wrong id and an unsupported node (REG-DISC-018).
    // First rejection wins, as a scan would have found it; a later entry
    // for the same id must not quietly replace the one recorded first.
    const rejected = new Map<string, (typeof doc.rejections)[number]>()
    for (const entry of doc.rejections) if (!rejected.has(entry.sourceId)) rejected.set(entry.sourceId, entry)
    const explained = missing.map((id) => {
      const rejection = rejected.get(id)
      return rejection === undefined ? id : `${id} (${rejection.reason}: ${rejection.detail})`
    })
    throw new SliceError(`requested nodes are not in this document: ${explained.join(', ')}`)
  }

  // A root inside another root would visit the same node twice, with different
  // parents each time, and leave a consumer to work out which one to believe.
  const factsById = facts.nodes
  for (const id of requested) {
    const ancestors = factsById.get(id as SourceId)?.ancestorIds ?? []
    const enclosing = ancestors.find((ancestor) => requested.includes(ancestor as string))
    if (enclosing !== undefined) {
      throw new SliceError(`root ${id} is already inside requested root ${enclosing}`)
    }
  }

  const nodes: SliceNode[] = []
  const omitted: Omission[] = []
  const cutByBudget = new Set<string>()
  const includeHidden = request.includeHidden === true

  const visit = (node: CanonicalNode, parent: CanonicalNode | undefined, depth: number): void => {
    if (!includeHidden && !node.effectiveVisible) {
      omitted.push({
        sourceId: node.sourceId,
        parentId: parent?.sourceId,
        reason: 'not-rendered',
        descendantCount: countDescendants(node),
      })
      return
    }
    if (nodes.length >= maxNodes) {
      // Recorded as an omission like any other, so a shortened answer is
      // visible in the output rather than inferred from a suspiciously round
      // node count — and on the parent, so a reader holding the node sees
      // the gap without cross-referencing the omission list.
      omitted.push({
        sourceId: node.sourceId,
        parentId: parent?.sourceId,
        reason: 'max-nodes',
        descendantCount: countDescendants(node),
      })
      if (parent !== undefined) cutByBudget.add(parent.sourceId as string)
      return
    }

    const fact = factsById.get(node.sourceId)
    const atLimit = request.maxDepth !== undefined && depth >= request.maxDepth

    nodes.push({
      sourceId: node.sourceId,
      parentId: parent?.sourceId,
      name: node.name,
      type: node.type,
      depth,
      visualOrderIndex: fact?.visualOrderIndex ?? 0,
      visualOrderReliable: fact?.visualOrderReliable ?? true,
      rendered: node.effectiveVisible,
      box: node.geometry,
      renderBounds: node.renderBounds,
      relativeBox: fact?.relativeBox,
      observedChildOverflow: fact?.observedChildOverflow ?? { kind: 'unknown', reason: 'GEOMETRY_MISSING' },
      layout: node.layout,
      rotation: node.rotation,
      opacity: node.opacity,
      blendMode: node.blendMode,
      characters: node.text?.characters,
      textStyle: node.text?.styleRef,
      typography: node.text?.style,
      hasCharacterOverrides: node.text?.hasCharacterOverrides ?? false,
      characterOverrideRuns: node.text?.characterOverrideRuns,
      textScan: node.text?.scan,
      fills: node.fills,
      strokes: node.strokes,
      strokeWeight: node.strokeWeight,
      individualStrokeWeights: node.individualStrokeWeights,
      strokeAlign: node.strokeAlign,
      cornerRadius: node.cornerRadius,
      rectangleCornerRadii: node.rectangleCornerRadii,
      effects: node.effects,
      componentId: node.componentId,
      vectorGeometry: node.vectorGeometry,
      contentHash: node.contentHash,
      subtreeHash: node.subtreeHash,
      truncated:
        atLimit && node.children.length > 0 ? { reason: 'max-depth', childCount: node.children.length } : undefined,
    })

    if (atLimit) {
      for (const child of node.children) {
        omitted.push({
          sourceId: child.sourceId,
          parentId: node.sourceId,
          reason: 'max-depth',
          descendantCount: countDescendants(child),
        })
      }
      return
    }
    for (const child of node.children) visit(child, node, depth + 1)
  }

  for (const rootId of requested) visit(byId.get(rootId as SourceId) as CanonicalNode, undefined, 0)
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index] as SliceNode
    if (!cutByBudget.has(node.sourceId as string)) continue
    // The depth limit returns before any child is visited, so a node is cut
    // by one or the other, never both.
    const childCount = (byId.get(node.sourceId) as CanonicalNode).children.length
    nodes[index] = { ...node, truncated: { reason: 'max-nodes', childCount } }
  }

  const included = new Set(nodes.map((node) => node.sourceId as string))
  const relevant: SliceFinding[] = findings
    .filter((finding) => finding.sourceIds.some((id) => included.has(id as string)))
    .map((finding) => ({
      finding,
      externalSourceIds: finding.sourceIds.filter((id) => !included.has(id as string)),
    }))

  // Only the groups that touch this slice: a consumer working on the footer has
  // no use for how the navigation lines up, and every extra group is context it
  // has to read past. "Touch" includes enclosing: a consumer slicing one
  // section still needs the breakpoint comparison, and that group is keyed by
  // the artboards the section sits inside — matching only nodes inside the
  // slice would drop it exactly when it is needed most.
  const enclosing = new Set<string>()
  for (const id of included) {
    for (const ancestor of factsById.get(id as SourceId)?.ancestorIds ?? []) {
      enclosing.add(ancestor as string)
    }
  }
  const responsive = facts.responsiveGroups.filter((group) =>
    group.members.some(
      (member) => included.has(member.rootId as string) || enclosing.has(member.rootId as string),
    ),
  )

  const normalizedRequest = {
    roots: requested,
    ...(request.maxDepth === undefined ? {} : { maxDepth: request.maxDepth }),
    maxNodes,
    includeHidden,
  }

  const sliceRequestHash = hashCanonicalString(
    'slice',
    SLICE_SCHEMA_VERSION,
    canonicalStringify({
      schemaVersion: SLICE_SCHEMA_VERSION,
      canonicalHash: doc.canonicalHash as string,
      request: { ...normalizedRequest, maxDepth: request.maxDepth ?? null },
    }),
  )

  const slice: Slice = {
    schemaVersion: SLICE_SCHEMA_VERSION,
    request: normalizedRequest,
    canonicalHash: doc.canonicalHash,
    snapshotId: doc.provenance.snapshotId,
    fileKey: doc.provenance.fileKey,
    sourceVersion: doc.provenance.sourceVersion,
    sliceRequestHash,
    sliceHash: sliceRequestHash,
    nodes,
    omitted,
    responsive,
    derivation: facts.diagnostics,
    findings: relevant,
  }

  // The content hash covers what actually came out, findings included, so equal
  // hashes mean equal bytes rather than merely the same question asked twice.
  return {
    ...slice,
    sliceHash: hashCanonicalString('slice', SLICE_SCHEMA_VERSION, canonicalStringify(sliceToJson(slice))),
  }
}

/**
 * Serializes a slice as plain JSON data.
 *
 * The brand does not survive JSON, and cannot: this is the boundary where
 * typed values become bytes. What survives is the framing that
 * `JSON.stringify` gives every string, and the injection scan travelling
 * alongside the text it is about. A consumer must pass this as structured
 * data; concatenating it into a prompt is the thing the scan and the gate
 * exist to make detectable, not something this function can prevent.
 */
export const sliceToJson = (slice: Slice): CanonicalValue =>
  ({
    schemaVersion: slice.schemaVersion,
    fileKey: slice.fileKey,
    sourceVersion: slice.sourceVersion,
    canonicalHash: slice.canonicalHash as string,
    snapshotId: slice.snapshotId as string,
    sliceRequestHash: slice.sliceRequestHash as string,
    request: {
      roots: [...slice.request.roots],
      maxDepth: slice.request.maxDepth ?? null,
      maxNodes: slice.request.maxNodes ?? DEFAULT_MAX_NODES,
      includeHidden: slice.request.includeHidden ?? false,
    },
    nodes: slice.nodes.map((node) => ({
      sourceId: node.sourceId as string,
      parentId: node.parentId === undefined ? null : (node.parentId as string),
      name: unsafeUnwrap(node.name),
      type: node.type,
      depth: node.depth,
      visualOrderIndex: node.visualOrderIndex,
      visualOrderReliable: node.visualOrderReliable,
      rendered: node.rendered,
      box: node.box ?? null,
      renderBounds: node.renderBounds ?? null,
      relativeBox: node.relativeBox ?? null,
      observedChildOverflow:
        node.observedChildOverflow.kind === 'known'
          ? {
              kind: 'known',
              leftPx: node.observedChildOverflow.value.leftPx,
              rightPx: node.observedChildOverflow.value.rightPx,
              topPx: node.observedChildOverflow.value.topPx,
              bottomPx: node.observedChildOverflow.value.bottomPx,
              sourceIds: node.observedChildOverflow.value.sourceIds.map((id) => id as string),
            }
          : node.observedChildOverflow.kind === 'absent'
            ? { kind: 'absent' }
            : { kind: 'unknown', reason: node.observedChildOverflow.reason },
      rotation: node.rotation ?? null,
      opacity: node.opacity ?? null,
      blendMode: node.blendMode ?? null,
      layout: layoutToJson(node.layout),
      characters: node.characters === undefined ? null : unsafeUnwrap(node.characters),
      textStyle: styleRefToJson(node.textStyle),
      typography: typographyToJson(node.typography),
      hasCharacterOverrides: node.hasCharacterOverrides,
      characterOverrideRuns:
        node.characterOverrideRuns === undefined
          ? null
          : node.characterOverrideRuns.map((run) => ({
              start: run.start,
              end: run.end,
              overrideId: run.overrideId ?? null,
              textDecoration: run.textDecoration,
            })),
      textScan:
        node.textScan === undefined
          ? null
          : { suspectedInjection: node.textScan.suspectedInjection, matches: [...node.textScan.matches] },
      fills: node.fills.map(paintToJson),
      strokes: node.strokes.map(paintToJson),
      strokeWeight: node.strokeWeight ?? null,
      individualStrokeWeights: strokeWeightsToJson(node.individualStrokeWeights),
      strokeAlign: node.strokeAlign ?? null,
      cornerRadius: node.cornerRadius ?? null,
      rectangleCornerRadii: node.rectangleCornerRadii === undefined ? null : [...node.rectangleCornerRadii],
      effects: node.effects.map((effect) => ({
        type: effect.type,
        visible: effect.visible,
        radius: effect.radius ?? null,
        spread: effect.spread ?? null,
        offset: effect.offset === undefined ? null : { x: effect.offset.x, y: effect.offset.y },
        rgba: effect.rgba === undefined ? null : [...effect.rgba],
        blendMode: effect.blendMode ?? null,
      })),
      componentId: node.componentId ?? null,
      vectorGeometry:
        node.vectorGeometry.kind === 'known'
          ? {
              kind: 'known',
              fill: node.vectorGeometry.fill.map((entry) => ({ path: entry.path, windingRule: entry.windingRule })),
              stroke: node.vectorGeometry.stroke.map((entry) => ({ path: entry.path, windingRule: entry.windingRule })),
              geometryHash: node.vectorGeometry.geometryHash as string,
            }
          : node.vectorGeometry.kind === 'absent'
            ? { kind: 'absent' }
            : { kind: 'unknown', reason: node.vectorGeometry.reason },
      contentHash: node.contentHash as string,
      subtreeHash: node.subtreeHash as string,
      truncated: node.truncated ?? null,
    })),
    omitted: slice.omitted.map((entry) => ({
      sourceId: entry.sourceId as string,
      parentId: entry.parentId === undefined ? null : (entry.parentId as string),
      reason: entry.reason,
      descendantCount: entry.descendantCount,
    })),
    responsive: slice.responsive.map((group) => ({
      section: unsafeUnwrap(group.section),
      members: group.members.map((member) => ({
        breakpoint: member.breakpoint,
        designWidthPx: member.designWidthPx,
        rootId: member.rootId as string,
      })),
      coverage: {
        correspondedPaths: group.coverage.correspondedPaths,
        unresolvedPaths: group.coverage.unresolvedPaths,
      },
      slots: group.slots.map((slot) => ({
        namePath: slot.namePath.map(unsafeUnwrap),
        byBreakpoint: Object.fromEntries(
          [...slot.byBreakpoint.entries()]
            .sort((a, b) => compareCodeUnits(a[0], b[0]))
            .map(([breakpoint, observation]) => [
              breakpoint,
              observation.kind === 'known'
                ? {
                    kind: 'known',
                    sourceId: observation.value.sourceId as string,
                    nodeType: observation.value.nodeType,
                    rendered: observation.value.rendered,
                    box: observation.value.box ?? null,
                    relativeBox: observation.value.relativeBox ?? null,
                    rotation: observation.value.rotation ?? null,
                    layoutMode: observation.value.layout.mode,
                    itemSpacing: observation.value.layout.itemSpacing ?? null,
                    characters:
                      observation.value.characters === undefined
                        ? null
                        : unsafeUnwrap(observation.value.characters),
                    textStyle: styleRefToJson(observation.value.textStyle),
                    // The observation carries these; a wire that dropped them
                    // made a stroke or a font change invisible across
                    // breakpoints while fully visible on the node.
                    typography: typographyToJson(observation.value.typography),
                    fills: observation.value.fills.map(paintToJson),
                    strokes: observation.value.strokes.map(paintToJson),
                    strokeWeight: observation.value.strokeWeight ?? null,
                    individualStrokeWeights: strokeWeightsToJson(observation.value.individualStrokeWeights),
                    cornerRadius: observation.value.cornerRadius ?? null,
                  }
                : { kind: observation.kind },
            ]),
        ),
      })),
    })),
    derivation: slice.derivation.map((diagnostic) => ({
      reason: diagnostic.reason,
      detail: diagnostic.detail,
      sourceIds: diagnostic.sourceIds.map((id) => id as string),
    })),
    findings: slice.findings.map((entry) => ({
      ruleId: entry.finding.ruleId,
      ruleVersion: entry.finding.ruleVersion,
      findingId: entry.finding.findingId,
      severity: entry.finding.severity,
      reason: entry.finding.reason,
      message: entry.finding.message,
      sourceIds: entry.finding.sourceIds.map((id) => id as string),
      externalSourceIds: entry.externalSourceIds.map((id) => id as string),
      evidence: entry.finding.evidence.map(unsafeUnwrap),
    })),
  }) as CanonicalValue

/**
 * Layout with every field present, absent ones as null.
 *
 * Spreading the object was not enough: `undefined` fields vanish under
 * `JSON.stringify`, so a node outside auto-layout came back without
 * `itemSpacing` at all while one inside it had the key. A consumer then cannot
 * read `layout.itemSpacing` without first checking whether the key exists —
 * and the shape of the answer would depend on the answer.
 */
/**
 * Every field spelled out (no spread): an absent optional would vanish from
 * the JSON, and two text nodes would disagree about which keys exist.
 */
const typographyToJson = (typography: SliceNode['typography']): CanonicalValue =>
  typography === undefined
    ? null
    : {
        fontFamily: unsafeUnwrap(typography.fontFamily),
        fontPostScriptName:
          typography.fontPostScriptName === undefined ? null : unsafeUnwrap(typography.fontPostScriptName),
        fontWeight: typography.fontWeight,
        fontSize: typography.fontSize,
        letterSpacing: typography.letterSpacing,
        lineHeightPx: typography.lineHeightPx,
        lineHeightPercentFontSize: typography.lineHeightPercentFontSize ?? null,
        textAlignHorizontal: typography.textAlignHorizontal,
        textAlignVertical: typography.textAlignVertical,
        textAutoResize: typography.textAutoResize ?? null,
        leadingTrim: typography.leadingTrim ?? null,
        opentypeFlags: typography.opentypeFlags === undefined ? null : { ...typography.opentypeFlags },
        textDecoration: typography.textDecoration,
      }

const strokeWeightsToJson = (weights: SliceNode['individualStrokeWeights']): CanonicalValue =>
  weights === undefined
    ? null
    : { top: weights.top, right: weights.right, bottom: weights.bottom, left: weights.left }

const layoutToJson = (layout: SliceNode['layout']): CanonicalValue =>
  ({
    mode: layout.mode,
    wrap: layout.wrap,
    primaryAxisAlign: layout.primaryAxisAlign,
    counterAxisAlign: layout.counterAxisAlign,
    counterAxisAlignContent: layout.counterAxisAlignContent ?? null,
    primaryAxisSizingMode: layout.primaryAxisSizingMode ?? null,
    counterAxisSizingMode: layout.counterAxisSizingMode ?? null,
    sizingHorizontal: layout.sizingHorizontal,
    sizingVertical: layout.sizingVertical,
    itemSpacing: layout.itemSpacing ?? null,
    counterAxisSpacing: layout.counterAxisSpacing ?? null,
    padding: { ...layout.padding },
    positioning: layout.positioning,
    layoutAlign: layout.layoutAlign ?? null,
    layoutGrow: layout.layoutGrow ?? null,
    constraints: layout.constraints ?? null,
    overflowDirection: layout.overflowDirection ?? null,
    clipsContent: layout.clipsContent,
  }) as CanonicalValue

const styleRefToJson = (ref: SliceNode['textStyle']): CanonicalValue =>
  ref === undefined
    ? null
    : ref.kind === 'token'
      ? { kind: 'token', styleId: ref.styleId, name: unsafeUnwrap(ref.name), styleType: ref.styleType }
      : { kind: 'unresolved', styleId: ref.styleId, reason: ref.reason }

/**
 * A paint with every field present, absent ones as null.
 *
 * The old path handed the domain paint to JSON as-is, which dropped whichever
 * optional keys happened to be undefined — and flattened the `raw` wrapper
 * away, so the wire showed `solid` where the domain said "raw, not a token".
 * All three states stay visible now, matching how strokes of text styles read.
 */
const rawPaintToJson = (paint: CanonicalPaint): CanonicalValue => {
  switch (paint.kind) {
    case 'solid':
      return {
        kind: 'solid',
        visible: paint.visible,
        opacity: paint.opacity ?? null,
        blendMode: paint.blendMode ?? null,
        rgba: [...paint.rgba],
      }
    case 'gradient':
      return {
        kind: 'gradient',
        visible: paint.visible,
        opacity: paint.opacity ?? null,
        blendMode: paint.blendMode ?? null,
        gradientType: paint.gradientType,
        stops: paint.stops.map((stop) => ({ position: stop.position, rgba: [...stop.rgba] })),
        handles: paint.handles.map((handle) => ({ x: handle.x, y: handle.y })),
      }
    case 'image':
      return {
        kind: 'image',
        visible: paint.visible,
        opacity: paint.opacity ?? null,
        blendMode: paint.blendMode ?? null,
        imageRef: paint.imageRef ?? null,
        scaleMode: paint.scaleMode ?? null,
      }
    case 'other':
      return {
        kind: 'other',
        visible: paint.visible,
        opacity: paint.opacity ?? null,
        blendMode: paint.blendMode ?? null,
        paintType: paint.paintType,
      }
  }
}

const paintToJson = (slot: StyleValue): CanonicalValue => {
  switch (slot.kind) {
    case 'token':
      return { kind: 'token', styleId: slot.styleId, name: unsafeUnwrap(slot.name), styleType: slot.styleType }
    case 'unresolved':
      return { kind: 'unresolved', styleId: slot.styleId, reason: slot.reason }
    case 'raw':
      return { kind: 'raw', paint: rawPaintToJson(slot.value) }
  }
}


/**
 * The form a consumer receives: the payload plus its own hash.
 *
 * Separate from {@link sliceToJson} because a value cannot contain its own
 * digest. Two envelopes with the same `sliceHash` hold the same bytes.
 */
export const sliceEnvelope = (slice: Slice): CanonicalValue =>
  ({
    ...(sliceToJson(slice) as Record<string, CanonicalValue>),
    sliceHash: slice.sliceHash as string,
  }) as CanonicalValue
