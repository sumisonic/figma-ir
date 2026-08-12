/**
 * Figma REST → CanonicalDoc.
 *
 * This is the one place that reads Figma's vocabulary, and it is deliberately
 * dull: no inference, no repair, no filling in of blanks. Where the source is
 * silent the result says so, and where a node cannot be represented it becomes
 * a rejection rather than a gap in the tree.
 */
import { canonicalStringify, compareCodeUnits, stripVolatile, type CanonicalValue } from '../determinism/canonical.js'
import { hashCanonical, hashCanonicalString, type Hash } from '../determinism/hash.js'
import { roundAngle, roundPx, roundRatio } from '../determinism/rounding.js'
import {
  contentHash,
  nodePath,
  sourceId,
  stableKey,
  subtreeHash,
  type NodePath,
  type SourceId,
} from '../identity/nodeIdentity.js'
import { markUntrusted, scanText, unsafeUnwrap } from '../text/untrusted.js'
import type { NodeDocument, StyleEntry } from '../figma/client.js'
import type { DesignSnapshot } from '../figma/snapshot.js'
import {
  CANONICAL_SCHEMA_VERSION,
  type CharacterOverrideRun,
  type PathSpec,
  type StrokeWeights,
  type TextDecoration,
  type VectorGeometry,
  isSupportedNodeType,
  VOLATILE_PATHS,
  type Box,
  type CanonicalDoc,
  type CanonicalEffect,
  type CanonicalNode,
  type CanonicalPaint,
  type CanonicalRejection,
  type Constraints,
  type LayoutFacts,
  type PaintCommon,
  type Rgba,
  type StyleRef,
  type StyleValue,
  type TextFacts,
} from './document.js'

/** A raw Figma node, read defensively: every field is optional until checked. */
type RawNode = NodeDocument & Record<string, unknown>

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

const asArray = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : [])

const boxOf = (value: unknown): Box | undefined => {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const x = asNumber(record.x)
  const y = asNumber(record.y)
  const width = asNumber(record.width)
  const height = asNumber(record.height)
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined
  // Figma answers with values like 782.9999717483797; unrounded, two fetches of
  // an unchanged design can disagree and every hash below becomes noise.
  return { x: roundPx(x), y: roundPx(y), width: roundPx(width), height: roundPx(height) }
}

const rgbaOf = (color: unknown): Rgba | undefined => {
  const record = asRecord(color)
  if (record === undefined) return undefined
  const r = asNumber(record.r)
  const g = asNumber(record.g)
  const b = asNumber(record.b)
  if (r === undefined || g === undefined || b === undefined) return undefined
  return [roundRatio(r), roundRatio(g), roundRatio(b), roundRatio(asNumber(record.a) ?? 1)]
}

const paintCommon = (record: Record<string, unknown>): PaintCommon => {
  const opacity = asNumber(record.opacity)
  return {
    visible: record.visible !== false,
    // Kept apart from the colour's own alpha. They are two things a designer
    // set separately, and multiplying them here would destroy the distinction
    // for every consumer, including the ones that need to know which changed.
    opacity: opacity === undefined ? undefined : roundRatio(opacity),
    blendMode: asString(record.blendMode),
  }
}

const paintOf = (paint: unknown): CanonicalPaint | undefined => {
  const record = asRecord(paint)
  if (record === undefined) return undefined
  const common = paintCommon(record)
  const type = asString(record.type) ?? 'UNKNOWN'

  if (type === 'SOLID') {
    const rgba = rgbaOf(record.color)
    return rgba === undefined ? { kind: 'other', paintType: type, ...common } : { kind: 'solid', rgba, ...common }
  }
  if (type.startsWith('GRADIENT_')) {
    const stops = asArray(record.gradientStops).flatMap((stop) => {
      const entry = asRecord(stop)
      const position = asNumber(entry?.position)
      const rgba = rgbaOf(entry?.color)
      return position === undefined || rgba === undefined ? [] : [{ position: roundRatio(position), rgba }]
    })
    // Without the handles, two gradients with identical stops but opposite
    // directions are the same document.
    const handles = asArray(record.gradientHandlePositions).flatMap((handle) => {
      const entry = asRecord(handle)
      const x = asNumber(entry?.x)
      const y = asNumber(entry?.y)
      return x === undefined || y === undefined ? [] : [{ x: roundRatio(x), y: roundRatio(y) }]
    })
    return { kind: 'gradient', gradientType: type, stops, handles, ...common }
  }
  if (type === 'IMAGE') {
    return {
      kind: 'image',
      imageRef: asString(record.imageRef),
      scaleMode: asString(record.scaleMode),
      ...common,
    }
  }
  return { kind: 'other', paintType: type, ...common }
}

const styleRefOf = (styleId: string | undefined, catalog: ReadonlyMap<string, StyleEntry>): StyleRef | undefined => {
  if (styleId === undefined) return undefined
  const entry = catalog.get(styleId)
  return entry === undefined
    ? { kind: 'unresolved', styleId, reason: 'NO_TOKEN_MAPPING' }
    : { kind: 'token', styleId, name: markUntrusted(entry.name), styleType: entry.styleType }
}

/**
 * Turns a paint list into style slots.
 *
 * A style reference wins over the literal value, because the reference is what
 * the designer actually chose; the resolved colour is a consequence of it. A
 * reference we cannot resolve stays `unresolved` rather than falling back to
 * the literal, since quietly hard-coding a broken token is precisely how a
 * design system stops being one.
 */
const styleSlots = (
  paints: unknown,
  styleId: string | undefined,
  catalog: ReadonlyMap<string, StyleEntry>,
): ReadonlyArray<StyleValue> => {
  const ref = styleRefOf(styleId, catalog)
  if (ref !== undefined) return [ref]
  return asArray(paints).flatMap((paint) => {
    const value = paintOf(paint)
    return value === undefined ? [] : [{ kind: 'raw', value } as StyleValue]
  })
}

const effectsOf = (value: unknown): ReadonlyArray<CanonicalEffect> =>
  asArray(value).flatMap((effect) => {
    const record = asRecord(effect)
    if (record === undefined) return []
    const offset = asRecord(record.offset)
    const offsetX = asNumber(offset?.x)
    const offsetY = asNumber(offset?.y)
    const radius = asNumber(record.radius)
    const spread = asNumber(record.spread)
    return [
      {
        type: asString(record.type) ?? 'UNKNOWN',
        visible: record.visible !== false,
        radius: radius === undefined ? undefined : roundPx(radius),
        spread: spread === undefined ? undefined : roundPx(spread),
        offset:
          offsetX === undefined || offsetY === undefined
            ? undefined
            : { x: roundPx(offsetX), y: roundPx(offsetY) },
        rgba: rgbaOf(record.color),
        blendMode: asString(record.blendMode),
      },
    ]
  })

const constraintsOf = (value: unknown): Constraints | undefined => {
  const record = asRecord(value)
  const horizontal = asString(record?.horizontal)
  const vertical = asString(record?.vertical)
  return horizontal === undefined || vertical === undefined ? undefined : { horizontal, vertical }
}

const LAYOUT_MODES = new Set(['NONE', 'HORIZONTAL', 'VERTICAL', 'GRID'])
const SIZINGS = new Set(['FIXED', 'HUG', 'FILL'])
const PRIMARY_AXIS_ALIGNS = new Set(['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'])
const COUNTER_AXIS_ALIGNS = new Set(['MIN', 'CENTER', 'MAX', 'BASELINE'])
const ALIGN_CONTENTS = new Set(['AUTO', 'SPACE_BETWEEN'])
const AXIS_SIZING_MODES = new Set(['FIXED', 'AUTO'])

/**
 * Validates an optional enum: absence stays absence (no documented default
 * worth inventing), a recognised value passes, anything else is `unknown`
 * (REG-CANON-010) so the projection cannot branch on a mislabelled member.
 */
const optionalEnumOf = <A extends string>(value: unknown, members: ReadonlySet<string>): A | 'unknown' | undefined => {
  const declared = asString(value)
  if (declared === undefined) return undefined
  return members.has(declared) ? (declared as A) : 'unknown'
}

/**
 * Validates an axis alignment against its closed set (REG-CANON-010).
 *
 * Absence means MIN — Figma's documented default for auto-layout frames. A
 * present value outside the set becomes `unknown` instead of being cast:
 * downstream layers branch on these values, and an unrecognised member
 * wearing a known type would take a branch silently.
 */
const axisAlignOf = <A extends string>(value: unknown, alignments: ReadonlySet<string>): A | 'MIN' | 'unknown' => {
  const declared = asString(value)
  if (declared === undefined) return 'MIN'
  return alignments.has(declared) ? (declared as A) : 'unknown'
}

const layoutOf = (node: RawNode): LayoutFacts => {
  const mode = asString(node.layoutMode)
  const horizontal = asString(node.layoutSizingHorizontal)
  const vertical = asString(node.layoutSizingVertical)
  const spacing = asNumber(node.itemSpacing)
  const counterSpacing = asNumber(node.counterAxisSpacing)
  const positioning = asString(node.layoutPositioning)
  const grow = asNumber(node.layoutGrow)

  return {
    // Absence means no auto-layout / no wrapping — those are the API's own
    // defaults. A *present but unrecognised* value is a different thing:
    // mapping it to a known member would let the projection translate a
    // declaration it never saw (REG-CANON-010).
    mode: mode === undefined ? 'NONE' : LAYOUT_MODES.has(mode) ? (mode as LayoutFacts['mode']) : 'unknown',
    wrap: ((wrapRaw) => (wrapRaw === undefined ? 'NO_WRAP' : wrapRaw === 'WRAP' || wrapRaw === 'NO_WRAP' ? wrapRaw : 'unknown'))(
      asString(node.layoutWrap),
    ),
    primaryAxisAlign: axisAlignOf<LayoutFacts['primaryAxisAlign']>(node.primaryAxisAlignItems, PRIMARY_AXIS_ALIGNS),
    counterAxisAlign: axisAlignOf<LayoutFacts['counterAxisAlign']>(node.counterAxisAlignItems, COUNTER_AXIS_ALIGNS),
    counterAxisAlignContent: optionalEnumOf<'AUTO' | 'SPACE_BETWEEN'>(node.counterAxisAlignContent, ALIGN_CONTENTS),
    primaryAxisSizingMode: optionalEnumOf<'FIXED' | 'AUTO'>(node.primaryAxisSizingMode, AXIS_SIZING_MODES),
    counterAxisSizingMode: optionalEnumOf<'FIXED' | 'AUTO'>(node.counterAxisSizingMode, AXIS_SIZING_MODES),
    // "Not stated" is its own answer: a node outside auto-layout has no sizing
    // rule, which is different from having one that happens to be FIXED.
    sizingHorizontal:
      horizontal !== undefined && SIZINGS.has(horizontal)
        ? (horizontal as LayoutFacts['sizingHorizontal'])
        : 'UNSPECIFIED',
    sizingVertical:
      vertical !== undefined && SIZINGS.has(vertical) ? (vertical as LayoutFacts['sizingVertical']) : 'UNSPECIFIED',
    itemSpacing: spacing === undefined ? undefined : roundPx(spacing),
    counterAxisSpacing: counterSpacing === undefined ? undefined : roundPx(counterSpacing),
    padding: {
      top: roundPx(asNumber(node.paddingTop) ?? 0),
      right: roundPx(asNumber(node.paddingRight) ?? 0),
      bottom: roundPx(asNumber(node.paddingBottom) ?? 0),
      left: roundPx(asNumber(node.paddingLeft) ?? 0),
    },
    // Recorded exactly as declared, including the case where Figma declared
    // nothing. Inferring "flows normally" from a sibling field being present
    // would be translation, and translation belongs to the next layer.
    positioning: positioning === 'ABSOLUTE' ? 'ABSOLUTE' : positioning === 'AUTO' ? 'AUTO' : 'unstated',
    layoutAlign: asString(node.layoutAlign),
    layoutGrow: grow === undefined ? undefined : roundRatio(grow),
    constraints: constraintsOf(node.constraints),
    overflowDirection: asString(node.overflowDirection),
    clipsContent: node.clipsContent === true,
  }
}

/**
 * Keys in code-unit order, so two responses listing the same flags in a
 * different order produce the same object — the hash sorts keys itself, but
 * the JSON a consumer receives does not, and "same hash, same bytes" has to
 * hold there too.
 */
const opentypeFlagsOf = (value: unknown): Readonly<Record<string, number>> | undefined => {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const flags: Record<string, number> = {}
  for (const key of Object.keys(record).sort(compareCodeUnits)) {
    const numeric = asNumber(record[key])
    if (numeric !== undefined) flags[key] = numeric
  }
  return Object.keys(flags).length > 0 ? flags : undefined
}

const textOf = (node: RawNode, catalog: ReadonlyMap<string, StyleEntry>): TextFacts | undefined => {
  const characters = asString(node.characters)
  if (characters === undefined) return undefined
  const style = asRecord(node.style) ?? {}
  const styles = asRecord(node.styles) ?? {}
  const untrusted = markUntrusted(characters)
  const postScript = asString(style.fontPostScriptName)
  const lineHeightPercent = asNumber(style.lineHeightPercentFontSize)

  return {
    characters: untrusted,
    // The style's name lives here, whatever convention the project gives it.
    // The literal font values below cannot stand in for it: they cannot tell a
    // token from a one-off, nor spot a misnamed or dangling style.
    styleRef: styleRefOf(asString(styles.text), catalog),
    style: {
      fontFamily: markUntrusted(asString(style.fontFamily) ?? ''),
      fontPostScriptName: postScript === undefined ? undefined : markUntrusted(postScript),
      fontWeight: asNumber(style.fontWeight) ?? 400,
      fontSize: roundPx(asNumber(style.fontSize) ?? 0),
      letterSpacing: roundPx(asNumber(style.letterSpacing) ?? 0),
      lineHeightPx: roundPx(asNumber(style.lineHeightPx) ?? 0),
      lineHeightPercentFontSize: lineHeightPercent === undefined ? undefined : roundRatio(lineHeightPercent),
      textAlignHorizontal: asString(style.textAlignHorizontal) ?? 'LEFT',
      textAlignVertical: asString(style.textAlignVertical) ?? 'TOP',
      textAutoResize: asString(style.textAutoResize),
      leadingTrim: asString(style.leadingTrim),
      opentypeFlags: opentypeFlagsOf(style.opentypeFlags),
      textDecoration: textDecorationOf(style.textDecoration) ?? 'NONE',
    },
    scan: scanText(untrusted),
    // Per-character overrides mean the string is not uniformly styled, which a
    // single styleKey cannot express; downstream needs to know before it tries.
    hasCharacterOverrides:
      asArray(node.characterStyleOverrides).some((value) => asNumber(value) !== undefined && value !== 0) ||
      Object.keys(asRecord(node.styleOverrideTable) ?? {}).length > 0,
    characterOverrideRuns: overrideRunsOf(node.characterStyleOverrides, node.styleOverrideTable),
  }
}

const TEXT_DECORATIONS = new Set<TextDecoration>(['NONE', 'UNDERLINE', 'STRIKETHROUGH'])

/** Absent → undefined (the caller picks the documented default); present but outside the set → unknown. */
const textDecorationOf = (value: unknown): TextDecoration | undefined =>
  value === undefined ? undefined : TEXT_DECORATIONS.has(value as TextDecoration) ? (value as TextDecoration) : 'unknown'

/**
 * Maximal runs of a non-zero override id, in array order.
 *
 * The array is the only order there is: the table's key order is not
 * consulted, so two responses that list the same table differently produce
 * the same runs. An id the table does not define is reported as `unknown`
 * rather than resolved to the base style — a missing entry is a fact about
 * the response, not a licence to guess.
 */
const overrideRunsOf = (overridesRaw: unknown, tableRaw: unknown): ReadonlyArray<CharacterOverrideRun> => {
  // Only the number 0 is the base style. Anything else the source put here
  // is an override reference, however malformed: rewriting a negative or
  // fractional id to 0 would turn "styled somehow" into "base style", which
  // is a repair, not a report.
  const ids = asArray(overridesRaw).map((value) => asNumber(value))
  const table = asRecord(tableRaw) ?? {}
  const runs: CharacterOverrideRun[] = []
  let index = 0
  while (index < ids.length) {
    const id = ids[index]
    let end = index + 1
    while (end < ids.length && ids[end] === id) end += 1
    if (id !== 0) {
      const entry = id !== undefined && Number.isInteger(id) && id > 0 ? asRecord(table[String(id)]) : undefined
      const decoration =
        entry === undefined ? 'unknown' : (textDecorationOf(entry.textDecoration) ?? 'unstated')
      runs.push({ start: index, end, overrideId: id, textDecoration: decoration })
    }
    index = end
  }
  return runs
}

const styleValueForHash = (value: StyleValue | StyleRef): CanonicalValue =>
  value.kind === 'token'
    ? { kind: value.kind, styleId: value.styleId, name: unsafeUnwrap(value.name), styleType: value.styleType }
    : (value as unknown as CanonicalValue)

/**
 * The fields that make up a node's own identity, children excluded.
 *
 * The schema version is part of the payload so that extending the subset later
 * cannot make a v1 branch hash equal to a v2 branch that happens to agree on
 * the fields v1 knew about.
 */
const ownFields = (node: CanonicalNode): CanonicalValue =>
  ({
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    type: node.type,
    name: unsafeUnwrap(node.name),
    selfVisible: node.selfVisible,
    effectiveVisible: node.effectiveVisible,
    geometry: node.geometry === undefined ? null : { ...node.geometry },
    renderBounds: node.renderBounds === undefined ? null : { ...node.renderBounds },
    rotation: node.rotation,
    opacity: node.opacity,
    blendMode: node.blendMode,
    layout: { ...node.layout, padding: { ...node.layout.padding }, constraints: node.layout.constraints ?? null },
    text:
      node.text === undefined
        ? null
        : {
            characters: unsafeUnwrap(node.text.characters),
            styleRef: node.text.styleRef === undefined ? null : styleValueForHash(node.text.styleRef),
            style: {
              ...node.text.style,
              fontFamily: unsafeUnwrap(node.text.style.fontFamily),
              fontPostScriptName:
                node.text.style.fontPostScriptName === undefined
                  ? undefined
                  : unsafeUnwrap(node.text.style.fontPostScriptName),
            },
            hasCharacterOverrides: node.text.hasCharacterOverrides,
            characterOverrideRuns: node.text.characterOverrideRuns.map((run) => ({
              start: run.start,
              end: run.end,
              overrideId: run.overrideId ?? null,
              textDecoration: run.textDecoration,
            })),
            // The scan is a diagnostic about the text, not part of what the
            // text is; letting it into the hash would make a tweak to the
            // heuristic look like a change to the design.
          },
    fills: node.fills.map(styleValueForHash),
    strokes: node.strokes.map(styleValueForHash),
    strokeWeight: node.strokeWeight,
    individualStrokeWeights: node.individualStrokeWeights === undefined ? null : { ...node.individualStrokeWeights },
    strokeAlign: node.strokeAlign,
    cornerRadius: node.cornerRadius,
    rectangleCornerRadii: node.rectangleCornerRadii === undefined ? null : [...node.rectangleCornerRadii],
    effects: node.effects.map((effect) => ({
      ...effect,
      offset: effect.offset ?? null,
      rgba: effect.rgba === undefined ? null : [...effect.rgba],
    })),
    componentId: node.componentId,
    // The paths themselves, not only their hash: a changed drawing is a
    // changed node, and the hash alone would hide which part moved.
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
  }) as CanonicalValue

/**
 * All entries or none: a list with one entry the adapter cannot read is not
 * a shorter drawing, it is a drawing the adapter did not understand, and
 * dropping the entry would hash the remainder as if it were whole.
 */
const pathsOf = (raw: unknown): ReadonlyArray<PathSpec> | undefined => {
  const paths: PathSpec[] = []
  for (const entry of asArray(raw)) {
    const record = asRecord(entry)
    const path = asString(record?.path)
    const windingRule = asString(record?.windingRule)
    if (path === undefined || windingRule === undefined) return undefined
    paths.push({ path, windingRule })
  }
  return paths
}

/**
 * Three states, decided by what was asked for rather than by what came
 * back: an empty list after a request for paths is "this node draws
 * nothing", and no list without one is "nobody asked". A list the adapter
 * could not read in full is a hole in the response, reported as such.
 */
const vectorGeometryOf = (raw: RawNode, mode: 'none' | 'paths'): VectorGeometry => {
  if (raw.type === 'TEXT') return { kind: 'absent' }
  if (mode === 'none') return { kind: 'unknown', reason: 'GEOMETRY_NOT_ACQUIRED' }
  const fill = pathsOf(raw.fillGeometry)
  const stroke = pathsOf(raw.strokeGeometry)
  if (fill === undefined || stroke === undefined) return { kind: 'unknown', reason: 'INCOMPLETE_EXECUTION' }
  return {
    kind: 'known',
    fill,
    stroke,
    geometryHash: hashCanonical('geometry', 1, {
      fill: fill.map((entry) => ({ ...entry })),
      stroke: stroke.map((entry) => ({ ...entry })),
    }),
  }
}

/**
 * Four sides or nothing: a record missing a side is not "three sides and a
 * default", it is a response this adapter does not understand.
 */
const strokeWeightsOf = (raw: unknown): StrokeWeights | undefined => {
  const record = asRecord(raw)
  if (record === undefined) return undefined
  const top = asNumber(record.top)
  const right = asNumber(record.right)
  const bottom = asNumber(record.bottom)
  const left = asNumber(record.left)
  if (top === undefined || right === undefined || bottom === undefined || left === undefined) return undefined
  return { top: roundPx(top), right: roundPx(right), bottom: roundPx(bottom), left: roundPx(left) }
}

interface WalkContext {
  readonly catalog: ReadonlyMap<string, StyleEntry>
  readonly geometry: 'none' | 'paths'
  readonly rejections: CanonicalRejection[]
  readonly nameChain: ReadonlyArray<string>
  readonly typeChain: ReadonlyArray<string>
  readonly indices: ReadonlyArray<number>
  readonly ancestorsVisible: boolean
  readonly indexAmongSameName: number
}

/**
 * A stand-in hash for a child we could not represent.
 *
 * Without it, a branch whose unsupported child was dropped hashes the same as a
 * branch that never had one — and "equal subtree hash means nothing to
 * regenerate" would then be advice to skip regenerating a branch we know is
 * incomplete.
 */
const rejectedChildHash = (rejection: CanonicalRejection): Hash<'subtree'> =>
  hashCanonical('subtree', CANONICAL_SCHEMA_VERSION, {
    rejected: true,
    sourceId: rejection.sourceId as string,
    reason: rejection.reason,
  })

type ChildResult =
  | { readonly kind: 'node'; readonly node: CanonicalNode }
  | { readonly kind: 'rejected'; readonly hash: Hash<'subtree'> }

const convert = (raw: RawNode, context: WalkContext): ChildResult => {
  const id = sourceId(raw.id)
  const path = nodePath(context.indices)

  if (!isSupportedNodeType(raw.type)) {
    // Recorded, not skipped: a branch that vanishes without a trace is
    // indistinguishable from one that was never in the design.
    const rejection: CanonicalRejection = {
      sourceId: id,
      path,
      reason: 'UNSUPPORTED_NODE_TYPE',
      // A section is the one unsupported type a person is likely to hand in
      // as a root, because list-frames shows it; the detail says what to do.
      // Only for a root: a section met deeper in a tree is not one
      // list-frames reaches, and the plain statement is the honest one.
      detail:
        raw.type === 'SECTION' && context.indices.length === 1
          ? 'SECTION is an organising container, not a design node; list-frames lists the frames inside it — acquire those as roots'
          : `node type ${raw.type} is outside the supported subset`,
    }
    context.rejections.push(rejection)
    return { kind: 'rejected', hash: rejectedChildHash(rejection) }
  }

  const name = asString(raw.name) ?? ''
  const selfVisible = raw.visible !== false
  const effectiveVisible = context.ancestorsVisible && selfVisible
  const styles = asRecord(raw.styles) ?? {}
  const rotation = asNumber(raw.rotation)
  const opacity = asNumber(raw.opacity)
  const strokeWeight = asNumber(raw.strokeWeight)
  const cornerRadius = asNumber(raw.cornerRadius)
  const radii = asArray(raw.rectangleCornerRadii).flatMap((value) => {
    const radius = asNumber(value)
    return radius === undefined ? [] : [roundPx(radius)]
  })

  const nameChain = [...context.nameChain, name]
  const typeChain = [...context.typeChain, raw.type]

  const rawChildren = asArray(raw.children).flatMap((child) => {
    const record = asRecord(child)
    return record !== undefined && typeof record.id === 'string' && typeof record.type === 'string'
      ? [record as RawNode]
      : []
  })

  const sameNameCounts = new Map<string, number>()
  const childResults = rawChildren.map((child, index) => {
    const childName = asString(child.name) ?? ''
    const seen = sameNameCounts.get(childName) ?? 0
    sameNameCounts.set(childName, seen + 1)
    return convert(child, {
      ...context,
      nameChain,
      typeChain,
      indices: [...context.indices, index],
      ancestorsVisible: effectiveVisible,
      indexAmongSameName: seen,
    })
  })

  const children = childResults.flatMap((result) => (result.kind === 'node' ? [result.node] : []))
  const childHashes = childResults.map((result) => (result.kind === 'node' ? result.node.subtreeHash : result.hash))

  const node: CanonicalNode = {
    sourceId: id,
    path,
    stableKey: stableKey({ nameChain, typeChain, indexAmongSameName: context.indexAmongSameName }),
    name: markUntrusted(name),
    type: raw.type,
    selfVisible,
    effectiveVisible,
    geometry: boxOf(raw.absoluteBoundingBox),
    renderBounds: boxOf(raw.absoluteRenderBounds),
    rotation: rotation === undefined ? undefined : roundAngle(rotation),
    opacity: opacity === undefined ? undefined : roundRatio(opacity),
    blendMode: asString(raw.blendMode),
    layout: layoutOf(raw),
    text: textOf(raw, context.catalog),
    fills: styleSlots(raw.fills, asString(styles.fill), context.catalog),
    strokes: styleSlots(raw.strokes, asString(styles.stroke), context.catalog),
    strokeWeight: strokeWeight === undefined ? undefined : roundPx(strokeWeight),
    individualStrokeWeights: strokeWeightsOf(raw.individualStrokeWeights),
    strokeAlign: asString(raw.strokeAlign),
    cornerRadius: cornerRadius === undefined ? undefined : roundPx(cornerRadius),
    rectangleCornerRadii: radii.length > 0 ? radii : undefined,
    effects: effectsOf(raw.effects),
    componentId: asString(raw.componentId),
    vectorGeometry: vectorGeometryOf(raw, context.geometry),
    children,
    contentHash: '' as Hash<'content'>,
    subtreeHash: '' as Hash<'subtree'>,
  }

  const own = contentHash(ownFields(node))
  return { kind: 'node', node: { ...node, contentHash: own, subtreeHash: subtreeHash(own, childHashes) } }
}

const serializeNode = (node: CanonicalNode): CanonicalValue =>
  ({
    sourceId: node.sourceId as string,
    path: node.path as string,
    stableKey: node.stableKey as string,
    contentHash: node.contentHash as string,
    subtreeHash: node.subtreeHash as string,
    ...(ownFields(node) as Record<string, CanonicalValue>),
    children: node.children.map(serializeNode),
  }) as CanonicalValue

/**
 * Builds the canonical document from a snapshot.
 *
 * The document hash covers the declared subset and nothing else — see
 * `VOLATILE_PATHS` for what is excluded and why.
 */
export const fromSnapshot = (snapshot: DesignSnapshot): CanonicalDoc => {
  const rejections: CanonicalRejection[] = []
  // Roots need same-name counting too: two roots with the same name and type
  // would otherwise share a fingerprint.
  const rootNameCounts = new Map<string, number>()

  const roots = [...snapshot.identity.roots].flatMap((rootId, index) => {
    const raw = snapshot.nodes.get(rootId)
    if (raw === undefined) return []
    const rootName = asString((raw as RawNode).name) ?? ''
    const seen = rootNameCounts.get(rootName) ?? 0
    rootNameCounts.set(rootName, seen + 1)
    const result = convert(raw as RawNode, {
      catalog: snapshot.styles,
      geometry: snapshot.identity.geometry,
      rejections,
      nameChain: [],
      typeChain: [],
      indices: [index],
      ancestorsVisible: true,
      indexAmongSameName: seen,
    })
    return result.kind === 'node' ? [result.node] : []
  })

  const provenance = {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    snapshotId: snapshot.identity.snapshotId,
    fileKey: snapshot.identity.fileKey as string,
    sourceVersion: snapshot.identity.sourceVersionAtEnd,
    roots: [...snapshot.identity.roots],
    geometry: snapshot.identity.geometry,
    adapter: { ...snapshot.identity.adapter },
    acquiredAt: snapshot.identity.acquiredAt,
  }

  const hashable = stripVolatile(
    {
      provenance: { ...provenance, snapshotId: provenance.snapshotId as string },
      roots: roots.map(serializeNode),
      rejections: rejections.map((rejection) => ({
        sourceId: rejection.sourceId as string,
        path: rejection.path as string,
        reason: rejection.reason,
        detail: rejection.detail,
      })),
    } as CanonicalValue,
    [...VOLATILE_PATHS],
  )

  return {
    provenance,
    roots,
    rejections,
    canonicalHash: hashCanonicalString('canonical', CANONICAL_SCHEMA_VERSION, canonicalStringify(hashable)),
  }
}

/** Depth-first walk in document order. */
export function* walkNodes(doc: CanonicalDoc): Generator<CanonicalNode> {
  const stack = [...doc.roots].reverse()
  while (stack.length > 0) {
    const node = stack.pop() as CanonicalNode
    yield node
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index] as CanonicalNode)
    }
  }
}

/** Index by source id. Ids are unique within a snapshot, so this is a lookup, not a guess. */
export const indexBySourceId = (doc: CanonicalDoc): ReadonlyMap<SourceId, CanonicalNode> => {
  const index = new Map<SourceId, CanonicalNode>()
  for (const node of walkNodes(doc)) index.set(node.sourceId, node)
  return index
}

export type { NodePath, SourceId }
