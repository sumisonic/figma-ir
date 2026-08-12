/**
 * Deriving facts from a canonical document.
 *
 * Everything here is a pure function of the document plus configuration. No
 * network, no clock, no ordering that depends on how a map was built: a fact
 * index computed twice from the same document is the same index.
 */
import { compareCodeUnits } from '../determinism/canonical.js'
import { roundPx } from '../determinism/rounding.js'
import type { SourceId } from '../identity/nodeIdentity.js'
import { markUntrusted, unsafeUnwrap, type Untrusted } from '../text/untrusted.js'
import type { Box, CanonicalDoc, CanonicalNode } from '../canonical/document.js'
import { compileArtboardPattern, compileNamePattern, matchNamePattern, resolveArtboardName, type CompiledPattern } from './pattern.js'
import { decodeFactConfig } from './config.js'
import {
  absent,
  FACTS_SCHEMA_VERSION,
  known,
  unknown,
  type ChildOverflow,
  type FactConfig,
  type FactDiagnostic,
  type FactIndex,
  type FontFact,
  type Known,
  type NodeFact,
  type ResponsiveConfig,
  type ResponsiveGroupFact,
  type ResponsiveMember,
  type ResponsiveSlotFact,
  type RootFact,
  type SlotObservation,
  type StyleNameConfig,
  type StyleNameParts,
  type TextStyleFact,
} from './types.js'

/**
 * Reading order: top to bottom, then left to right.
 *
 * The child array is z-order (REG-ORDER-002): in a real page it disagreed
 * with vertical position in several places including the artboard root, so
 * "the first section" has to mean this. Ties fall back to the source id,
 * which keeps the order total and stable rather than dependent on the sort
 * implementation.
 */
const byReadingOrder = (a: CanonicalNode, b: CanonicalNode): number => {
  const boxA = a.geometry
  const boxB = b.geometry
  if (boxA === undefined && boxB === undefined) return compareCodeUnits(a.sourceId, b.sourceId)
  if (boxA === undefined) return 1
  if (boxB === undefined) return -1
  if (boxA.y !== boxB.y) return boxA.y - boxB.y
  if (boxA.x !== boxB.x) return boxA.x - boxB.x
  return compareCodeUnits(a.sourceId, b.sourceId)
}

/**
 * Child position relative to its parent.
 *
 * The subtraction is re-rounded (REG-FACT-009): both inputs honour the px
 * slot precision, but their difference picks up IEEE noise (40.3 - 10.1 is
 * 30.199999999999996), and without this the noise reached slice output
 * verbatim. Width and height are copied, not derived, so they stay as-is.
 */
/**
 * Overflow is a comparison of boxes: rendered, in-flow children against the
 * node's own layout box. Missing geometry on either side leaves it unknown
 * rather than partially summed — a spill measured over half the children is
 * not a smaller spill, it is a different number.
 */
const childOverflowOf = (node: CanonicalNode): Known<ChildOverflow> => {
  if (node.geometry === undefined) return unknown('GEOMETRY_MISSING')
  const box = node.geometry
  const children = node.children.filter(
    (child) => child.effectiveVisible && child.layout.positioning !== 'ABSOLUTE',
  )
  if (children.some((child) => child.geometry === undefined)) return unknown('GEOMETRY_MISSING')
  let leftPx = 0
  let rightPx = 0
  let topPx = 0
  let bottomPx = 0
  const spilling: SourceId[] = []
  for (const child of children) {
    const geometry = child.geometry as Box
    const left = roundPx(box.x - geometry.x)
    const right = roundPx(geometry.x + geometry.width - (box.x + box.width))
    const top = roundPx(box.y - geometry.y)
    const bottom = roundPx(geometry.y + geometry.height - (box.y + box.height))
    if (left > 0 || right > 0 || top > 0 || bottom > 0) spilling.push(child.sourceId)
    leftPx = Math.max(leftPx, left)
    rightPx = Math.max(rightPx, right)
    topPx = Math.max(topPx, top)
    bottomPx = Math.max(bottomPx, bottom)
  }
  return known({ leftPx, rightPx, topPx, bottomPx, sourceIds: spilling.sort(compareCodeUnits) })
}

const relativeTo = (child: Box | undefined, parent: Box | undefined): Box | undefined =>
  child === undefined || parent === undefined
    ? undefined
    : {
        x: roundPx(child.x - parent.x),
        y: roundPx(child.y - parent.y),
        width: child.width,
        height: child.height,
      }

/**
 * Whether top-left ordering says anything about these siblings.
 *
 * It describes a stacked layout well. It describes overlapping or rotated
 * elements not at all, because "before" is not a property of their geometry —
 * so rather than let a rule read sequence out of a coincidence of coordinates,
 * the order is marked unreliable and the rule can decide what to do.
 */
const orderIsMeaningful = (siblings: ReadonlyArray<CanonicalNode>): boolean => {
  if (siblings.some((node) => node.rotation !== undefined && node.rotation !== 0)) return false
  for (let i = 0; i < siblings.length; i += 1) {
    for (let j = i + 1; j < siblings.length; j += 1) {
      const a = siblings[i]?.geometry
      const b = siblings[j]?.geometry
      if (a === undefined || b === undefined) continue
      const overlapsVertically = a.y < b.y + b.height && b.y < a.y + a.height
      const overlapsHorizontally = a.x < b.x + b.width && b.x < a.x + a.width
      if (overlapsVertically && overlapsHorizontally) return false
    }
  }
  return true
}

interface Walked {
  readonly facts: Map<SourceId, NodeFact>
  readonly nodesById: Map<SourceId, CanonicalNode>
}

const walk = (doc: CanonicalDoc): Walked => {
  const facts = new Map<SourceId, NodeFact>()
  const nodesById = new Map<SourceId, CanonicalNode>()

  const visit = (
    node: CanonicalNode,
    parent: CanonicalNode | undefined,
    ancestors: ReadonlyArray<SourceId>,
    namePath: ReadonlyArray<Untrusted>,
    visualOrderIndex: number,
    visualOrderReliable: boolean,
  ): void => {
    nodesById.set(node.sourceId, node)
    facts.set(node.sourceId, {
      sourceId: node.sourceId,
      parentId: parent?.sourceId,
      ancestorIds: ancestors,
      depth: ancestors.length,
      rendered: node.effectiveVisible,
      visualOrderIndex,
      visualOrderReliable,
      relativeBox: relativeTo(node.geometry, parent?.geometry),
      layoutMode: node.layout.mode,
      observedChildOverflow: childOverflowOf(node),
      textStyle: node.text?.styleRef,
      namePath,
    })

    // Hidden nodes stay in the index but leave the reading order: a rule may
    // still need to know they exist, while anything reasoning about what a
    // reader sees should not have to filter them out again.
    const ordered = [...node.children].filter((child) => child.effectiveVisible).sort(byReadingOrder)
    const hidden = node.children.filter((child) => !child.effectiveVisible)
    const nextAncestors = [...ancestors, node.sourceId]
    const reliable = orderIsMeaningful(ordered)

    ordered.forEach((child, index) => {
      visit(child, node, nextAncestors, [...namePath, child.name], index, reliable)
    })
    for (const child of hidden) {
      visit(child, node, nextAncestors, [...namePath, child.name], -1, reliable)
    }
  }

  for (const root of doc.roots) visit(root, undefined, [], [], 0, true)
  return { facts, nodesById }
}

/**
 * The declared grammar, compiled once. A pattern that could not mean what it
 * says fails here, when the configuration loads, not by matching nothing.
 */
const compileStyleNames = (config: StyleNameConfig | undefined): CompiledPattern | undefined =>
  config === undefined
    ? undefined
    : compileNamePattern(config.pattern, {
        where: 'styleNames.pattern',
        ...(config.allowed === undefined ? {} : { vocabulary: config.allowed }),
      })

const parseStyleName = (name: Untrusted, grammar: CompiledPattern | undefined): Known<StyleNameParts> => {
  if (grammar === undefined) return absent()
  const parts = matchNamePattern(grammar, unsafeUnwrap(name))
  // Not repaired, not guessed at. A name outside the convention is a message
  // for the designer, and normalizing it here would delete the message.
  if (parts === undefined) return unknown('NO_TOKEN_MAPPING')
  return known(parts.map((part) => ({ segment: part.segment, value: markUntrusted(part.value) })))
}

const deriveTextStyles = (
  nodesById: ReadonlyMap<SourceId, CanonicalNode>,
  grammar: CompiledPattern | undefined,
): ReadonlyMap<string, TextStyleFact> => {
  interface Accumulator {
    readonly name: Untrusted
    readonly usedBy: SourceId[]
    readonly fonts: Map<string, { readonly fact: Omit<FontFact, 'usedBy'>; readonly usedBy: SourceId[] }>
  }
  const accumulators = new Map<string, Accumulator>()

  const ids = [...nodesById.keys()].sort(compareCodeUnits)
  for (const id of ids) {
    const node = nodesById.get(id) as CanonicalNode
    const ref = node.text?.styleRef
    if (ref === undefined || ref.kind !== 'token' || node.text === undefined) continue

    const existing: Accumulator = accumulators.get(ref.styleId) ?? {
      name: ref.name,
      usedBy: [],
      fonts: new Map(),
    }
    existing.usedBy.push(node.sourceId)

    const style = node.text.style
    // Encoded rather than joined: a family name containing the separator would
    // otherwise merge two different declarations. PostScript name is part of
    // the key because two faces can agree on family, weight and size and still
    // be different fonts, and a rule asked to compare them can only do so if
    // they arrived as two declarations.
    const fontKey = JSON.stringify([
      unsafeUnwrap(style.fontFamily),
      style.fontPostScriptName === undefined ? null : unsafeUnwrap(style.fontPostScriptName),
      style.fontWeight,
      style.fontSize,
    ])
    const font = existing.fonts.get(fontKey)
    if (font === undefined) {
      existing.fonts.set(fontKey, {
        fact: {
          family: style.fontFamily,
          postScriptName: style.fontPostScriptName,
          weight: style.fontWeight,
          size: style.fontSize,
        },
        usedBy: [node.sourceId],
      })
    } else {
      font.usedBy.push(node.sourceId)
    }
    accumulators.set(ref.styleId, existing)
  }

  const result = new Map<string, TextStyleFact>()
  for (const styleId of [...accumulators.keys()].sort(compareCodeUnits)) {
    const accumulator = accumulators.get(styleId) as Accumulator
    result.set(styleId, {
      styleId,
      name: accumulator.name,
      parsed: parseStyleName(accumulator.name, grammar),
      usedBy: accumulator.usedBy,
      fonts: [...accumulator.fonts.keys()].sort(compareCodeUnits).map((key) => {
        const entry = accumulator.fonts.get(key) as { fact: Omit<FontFact, 'usedBy'>; usedBy: SourceId[] }
        return { ...entry.fact, usedBy: entry.usedBy }
      }),
    })
  }
  return result
}

const deriveRoots = (doc: CanonicalDoc): ReadonlyArray<RootFact> =>
  doc.roots.map((root) => ({
    sourceId: root.sourceId,
    name: root.name,
    width: root.geometry === undefined ? unknown<number>('VIEWPORT_REQUIRED') : known(root.geometry.width),
    height: root.geometry === undefined ? unknown<number>('VIEWPORT_REQUIRED') : known(root.geometry.height),
    children: [...root.children]
      .filter((child) => child.effectiveVisible)
      .sort(byReadingOrder)
      .map((child) => child.sourceId),
  }))

/**
 * A collision-free key for a name path.
 *
 * Joining on a separator is not safe here: a large share of layer names in a
 * real file contain spaces (every editor-generated "Frame 232" does), so
 * ["Frame 232", "x"] and ["Frame", "232 x"] would become the same key and
 * either pair unrelated elements or invent an ambiguity. JSON gives an encoding that survives any character a
 * designer can type, and the path is carried alongside for display.
 */
const pathKey = (path: ReadonlyArray<Untrusted>): string => JSON.stringify(path.map(unsafeUnwrap))

const pathFromKey = (key: string): ReadonlyArray<Untrusted> =>
  (JSON.parse(key) as ReadonlyArray<string>).map(markUntrusted)

const displayPath = (path: ReadonlyArray<Untrusted>): string => path.map(unsafeUnwrap).join('/')

const observe = (node: CanonicalNode, fact: NodeFact | undefined): SlotObservation => ({
  sourceId: node.sourceId,
  nodeType: node.type,
  rendered: node.effectiveVisible,
  box: node.geometry,
  relativeBox: fact?.relativeBox,
  rotation: node.rotation,
  // Whole layout facts rather than two of them: a comparison can only find a
  // difference in a field somebody thought to keep, and the rules that read
  // this compare alignment, sizing and padding across breakpoints.
  layout: node.layout,
  characters: node.text?.characters,
  textStyle: node.text?.styleRef,
  typography: node.text?.style,
  fills: node.fills,
  strokes: node.strokes,
  strokeWeight: node.strokeWeight,
  individualStrokeWeights: node.individualStrokeWeights,
  cornerRadius: node.cornerRadius,
})

/**
 * Collects every descendant by its name path, and notes which paths repeat.
 *
 * A repeated path is not usable for matching across breakpoints: pairing the
 * first occurrence in one tree with the first in another looks authoritative
 * and is only a coincidence away from being wrong.
 */
const pathsWithin = (
  root: CanonicalNode,
): { readonly unique: Map<string, CanonicalNode>; readonly duplicated: Set<string> } => {
  const seen = new Map<string, CanonicalNode>()
  const duplicated = new Set<string>()

  const visit = (node: CanonicalNode, path: ReadonlyArray<Untrusted>): void => {
    for (const child of node.children) {
      const childPath = [...path, child.name]
      const key = pathKey(childPath)
      if (seen.has(key)) duplicated.add(key)
      else seen.set(key, child)
      visit(child, childPath)
    }
  }
  visit(root, [])
  for (const key of duplicated) seen.delete(key)
  return { unique: seen, duplicated }
}

const deriveResponsiveGroups = (
  doc: CanonicalDoc,
  facts: ReadonlyMap<SourceId, NodeFact>,
  config: ResponsiveConfig | undefined,
  diagnostics: FactDiagnostic[],
): ReadonlyArray<ResponsiveGroupFact> => {
  if (config === undefined) return []

  const pattern = compileArtboardPattern(config.namePattern, config.breakpoints.map((entry) => entry.slot))
  const widthToSlot = new Map(config.breakpoints.map((entry) => [entry.designWidthPx, entry.slot]))
  const bySection = new Map<string, Array<{ member: ResponsiveMember; root: CanonicalNode }>>()

  const slotToWidth = new Map(config.breakpoints.map((entry) => [entry.slot, entry.designWidthPx]))
  const declared = new Map(
    (config.explicit ?? []).map((entry) => [entry.nodeId, entry] as const),
  )

  const declaredSeen = new Set<string>()
  for (const root of doc.roots) {
    // A declaration wins over the pattern: it exists precisely because the
    // pattern does not describe this artboard.
    const named = declared.get(root.sourceId as string)
    if (named !== undefined) {
      declaredSeen.add(named.nodeId)
      const width = slotToWidth.get(named.breakpoint)
      if (width === undefined) {
        diagnostics.push({
          reason: 'CONFIG_ERROR',
          detail: `declared breakpoint ${named.breakpoint} for ${root.sourceId} is not among the configured breakpoints`,
          sourceIds: [root.sourceId],
        })
        continue
      }
      const entries = bySection.get(named.section) ?? []
      entries.push({
        member: { breakpoint: named.breakpoint, designWidthPx: width, rootId: root.sourceId },
        root,
      })
      bySection.set(named.section, entries)
      continue
    }

    const resolved = resolveArtboardName(pattern, unsafeUnwrap(root.name), widthToSlot, slotToWidth)
    if (resolved === undefined) continue
    if ('problem' in resolved) {
      // A width the project never declared, or a name that contradicts
      // itself, is not ours to resolve.
      diagnostics.push({ reason: 'UNKNOWN_GROUPING', detail: resolved.problem, sourceIds: [root.sourceId] })
      continue
    }
    const entries = bySection.get(resolved.section) ?? []
    entries.push({
      member: { breakpoint: resolved.slot, designWidthPx: resolved.designWidthPx, rootId: root.sourceId },
      root,
    })
    bySection.set(resolved.section, entries)
  }

  for (const nodeId of [...declared.keys()].sort(compareCodeUnits)) {
    // A declaration about a root that was not acquired did nothing, and a
    // configuration that does nothing must say so (REG-CONF-017).
    if (declaredSeen.has(nodeId)) continue
    diagnostics.push({
      reason: 'CONFIG_ERROR',
      detail: `explicit declaration for ${nodeId} names a root that was not acquired`,
      sourceIds: [],
    })
  }

  const groups: ResponsiveGroupFact[] = []
  for (const section of [...bySection.keys()].sort(compareCodeUnits)) {
    const entries = (bySection.get(section) as Array<{ member: ResponsiveMember; root: CanonicalNode }>).sort(
      (a, b) => a.member.designWidthPx - b.member.designWidthPx,
    )

    const claimed = new Map<string, ResponsiveMember>()
    for (const entry of entries) {
      const previous = claimed.get(entry.member.breakpoint)
      if (previous !== undefined) {
        diagnostics.push({
          reason: 'AMBIGUOUS_NODE_MATCH',
          detail: `two artboards claim breakpoint ${entry.member.breakpoint} in group ${section}`,
          sourceIds: [previous.rootId, entry.member.rootId],
        })
      }
      claimed.set(entry.member.breakpoint, entry.member)
    }

    const perMember = entries.map((entry) => ({ entry, paths: pathsWithin(entry.root) }))
    const candidatePaths = new Set<string>()
    for (const { paths } of perMember) {
      for (const key of paths.unique.keys()) candidatePaths.add(key)
      for (const key of paths.duplicated) candidatePaths.add(key)
    }

    const slots: ResponsiveSlotFact[] = []
    let unresolvedPaths = 0

    for (const key of [...candidatePaths].sort(compareCodeUnits)) {
      // A slot is only usable when every member agrees it is unambiguous.
      const ambiguousIn = perMember.filter(({ paths }) => paths.duplicated.has(key))
      if (ambiguousIn.length > 0) {
        unresolvedPaths += 1
        diagnostics.push({
          reason: 'AMBIGUOUS_NODE_MATCH',
          detail: `name path ${displayPath(pathFromKey(key))} occurs more than once in ${ambiguousIn
            .map(({ entry }) => entry.member.breakpoint)
            .join(', ')}`,
          sourceIds: ambiguousIn.map(({ entry }) => entry.member.rootId),
        })
        continue
      }

      const missingIn = perMember.filter(({ paths }) => !paths.unique.has(key))
      if (missingIn.length > 0) {
        // Tempting to call this "absent at sm", and wrong (REG-RESP-003).
        // From names alone, an element the designer removed and an element
        // sitting under a container the editor auto-named differently look
        // identical — and in real files most paths run through auto-generated
        // names ("Frame 123") that change per variant while the design does
        // not. Claiming absence here would manufacture exactly the kind of
        // confident wrong answer this pipeline exists to avoid; deciding
        // between the two needs better names in the file or an explicit
        // mapping.
        unresolvedPaths += 1
        diagnostics.push({
          reason: 'UNKNOWN_GROUPING',
          detail: `name path ${displayPath(pathFromKey(key))} is present in ${perMember.length - missingIn.length} of ${
            perMember.length
          } breakpoints; removal and renaming are indistinguishable from names alone`,
          sourceIds: missingIn.map(({ entry }) => entry.member.rootId),
        })
        continue
      }

      const byBreakpoint = new Map<string, Known<SlotObservation>>()
      for (const { entry, paths } of perMember) {
        const node = paths.unique.get(key) as CanonicalNode
        byBreakpoint.set(entry.member.breakpoint, known(observe(node, facts.get(node.sourceId))))
      }
      slots.push({ namePath: pathFromKey(key), byBreakpoint })
    }

    groups.push({
      section: markUntrusted(section),
      members: entries.map(({ member }) => member),
      slots,
      coverage: { correspondedPaths: slots.length, unresolvedPaths },
    })
  }
  return groups
}

/** Builds the fact index. Pure: same document and config, same index. */
export const deriveFacts = (doc: CanonicalDoc, rawConfig: FactConfig = {}): FactIndex => {
  // Validated even when it arrives typed: duplicates, empty lists and
  // patterns that cannot match are not things the type can refuse.
  const config = decodeFactConfig(rawConfig)
  const diagnostics: FactDiagnostic[] = []
  const { facts, nodesById } = walk(doc)
  const grammar = compileStyleNames(config.styleNames)

  return {
    schemaVersion: FACTS_SCHEMA_VERSION,
    canonicalHash: doc.canonicalHash,
    declared: {
      styleNames:
        config.styleNames === undefined || grammar === undefined
          ? undefined
          : { pattern: config.styleNames.pattern, segments: grammar.segments },
      responsive:
        config.responsive === undefined
          ? undefined
          : {
              namePattern: config.responsive.namePattern,
              breakpoints: config.responsive.breakpoints.map((entry) => entry.slot),
            },
    },
    nodes: facts,
    textStyles: deriveTextStyles(nodesById, grammar),
    roots: deriveRoots(doc),
    responsiveGroups: deriveResponsiveGroups(doc, facts, config.responsive, diagnostics),
    diagnostics,
  }
}

/** Children of a node in reading order. */
export const readingOrder = (node: CanonicalNode): ReadonlyArray<CanonicalNode> =>
  [...node.children].filter((child) => child.effectiveVisible).sort(byReadingOrder)
