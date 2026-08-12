/**
 * Which of a node's own fields changed, and how each is shown.
 *
 * Two questions, answered from two sources on purpose.
 *
 * *Whether* a field changed is read from the hash input, so the diff and the
 * hash can never disagree about what counts as a difference.
 *
 * *How* it is shown follows the slice: same names, same value shapes, written
 * by the same functions. The hash input is not fit to print — it spells a raw
 * paint differently from the slice and leaves absent keys out — and a reader
 * holds a slice in the other hand. A second vocabulary for the same paint
 * would have to be translated on every line.
 *
 * The two can only drift in one direction that matters: the hash sees a
 * difference the shown fields do not carry. That is checked for every field
 * of every node and is an error, never an empty list of changes.
 */
import { canonicalStringify, compareCodeUnits, type CanonicalValue } from '../determinism/canonical.js'
import { roundPx } from '../determinism/rounding.js'
import type { SourceId } from '../identity/nodeIdentity.js'
import { unsafeUnwrap } from '../text/untrusted.js'
import type { Box, CanonicalNode } from '../canonical/document.js'
import { canonicalNodeOwnFields } from '../canonical/nodeOwnFields.js'
import {
  characterOverrideRunToJson,
  effectToJson,
  layoutToJson,
  paintToJson,
  strokeWeightsToJson,
  styleRefToJson,
  typographyToJson,
} from '../slice/nodeJson.js'
import type { ChangeRef, NodeSite } from './model.js'
import { SNAPSHOT_DIFF_CATEGORIES, SnapshotDiffError, type SnapshotDiffCategory } from './types.js'

/** One key of the hash input: its category, and the shown fields that carry it. */
export interface OwnFieldRow {
  readonly key: string
  /** Absent only for the schema version, which is a namespace and not a property of the design. */
  readonly category: SnapshotDiffCategory | undefined
  readonly shownAs: ReadonlyArray<string>
}

/**
 * Every key of the hash input, exactly once, in the order errors are reported.
 *
 * A key added to the hash input and not to this table fails a test: an
 * unlisted key would be a change the hash sees and the diff cannot place.
 */
export const OWN_FIELD_ROWS: ReadonlyArray<OwnFieldRow> = [
  { key: 'schemaVersion', category: undefined, shownAs: [] },
  { key: 'name', category: 'name', shownAs: ['name'] },
  { key: 'type', category: 'type', shownAs: ['type'] },
  { key: 'selfVisible', category: 'visibility', shownAs: ['selfVisible'] },
  { key: 'effectiveVisible', category: 'visibility', shownAs: ['rendered'] },
  { key: 'geometry', category: 'box', shownAs: ['box'] },
  { key: 'renderBounds', category: 'render-bounds', shownAs: ['renderBounds'] },
  { key: 'rotation', category: 'rotation', shownAs: ['rotation'] },
  { key: 'opacity', category: 'compositing', shownAs: ['opacity'] },
  { key: 'blendMode', category: 'compositing', shownAs: ['blendMode'] },
  { key: 'layout', category: 'layout', shownAs: ['layout'] },
  {
    key: 'text',
    category: 'text',
    shownAs: ['characters', 'textStyle', 'typography', 'hasCharacterOverrides', 'characterOverrideRuns'],
  },
  { key: 'fills', category: 'fills', shownAs: ['fills'] },
  { key: 'strokes', category: 'strokes', shownAs: ['strokes'] },
  { key: 'strokeWeight', category: 'strokes', shownAs: ['strokeWeight'] },
  { key: 'individualStrokeWeights', category: 'strokes', shownAs: ['individualStrokeWeights'] },
  { key: 'strokeAlign', category: 'strokes', shownAs: ['strokeAlign'] },
  { key: 'cornerRadius', category: 'corners', shownAs: ['cornerRadius'] },
  { key: 'rectangleCornerRadii', category: 'corners', shownAs: ['rectangleCornerRadii'] },
  { key: 'effects', category: 'effects', shownAs: ['effects'] },
  { key: 'componentId', category: 'component', shownAs: ['componentId'] },
  { key: 'vectorGeometry', category: 'vector', shownAs: ['vectorGeometry'] },
]

/** The two changes that are about a node's place in the tree, not its own fields. */
export const CHILDREN_CHANGE: ChangeRef = { category: 'children', fieldPath: 'children' }
export const PARENT_CHANGE: ChangeRef = { category: 'parent', fieldPath: 'parentId' }

export type ShownFields = Readonly<Record<string, CanonicalValue>>

const boxToJson = (box: Box): CanonicalValue => ({ x: box.x, y: box.y, width: box.width, height: box.height })

/**
 * Render bounds measured from the node's own box.
 *
 * Stored, they are absolute: a node that only moved has "different" render
 * bounds. Measured from its own box they change only when what is drawn
 * outside the box changes, which is the thing worth reporting. The offset is
 * a derived number and is rounded like one (REG-FACT-009).
 */
const renderBoundsToJson = (node: CanonicalNode): CanonicalValue => {
  const bounds = node.renderBounds
  if (bounds === undefined) return { state: 'absent' }
  const box = node.geometry
  // Bounds with no box to measure from can still be compared, only not
  // separated into "moved" and "changed" — so they are shown as they are.
  if (box === undefined) return { state: 'unanchored', absolute: boxToJson(bounds) }
  return {
    state: 'known',
    offsetX: roundPx(bounds.x - box.x),
    offsetY: roundPx(bounds.y - box.y),
    width: bounds.width,
    height: bounds.height,
  }
}

/**
 * The drawing's identity without the drawing.
 *
 * Path data multiplies the size of a result and the hash already answers "is
 * it the same shape". The paths themselves are in the slice.
 */
const vectorToJson = (node: CanonicalNode): CanonicalValue => {
  const vector = node.vectorGeometry
  return {
    kind: vector.kind,
    reason: vector.kind === 'unknown' ? vector.reason : null,
    geometryHash: vector.kind === 'known' ? (vector.geometryHash as string) : null,
  }
}

/** Every shown field of a node, absent ones as null. Unwraps text: call only to compare or to serialize. */
export const shownFieldsOf = (node: CanonicalNode): ShownFields => {
  const text = node.text
  return {
    name: unsafeUnwrap(node.name),
    type: node.type,
    selfVisible: node.selfVisible,
    rendered: node.effectiveVisible,
    box: node.geometry === undefined ? null : boxToJson(node.geometry),
    renderBounds: renderBoundsToJson(node),
    rotation: node.rotation ?? null,
    opacity: node.opacity ?? null,
    blendMode: node.blendMode ?? null,
    layout: layoutToJson(node.layout),
    characters: text === undefined ? null : unsafeUnwrap(text.characters),
    textStyle: text === undefined ? null : styleRefToJson(text.styleRef),
    typography: text === undefined ? null : typographyToJson(text.style),
    // Null, not false, where there is no text: "has no overrides" is a
    // statement about a string, and here there is no string to make it about.
    hasCharacterOverrides: text === undefined ? null : text.hasCharacterOverrides,
    characterOverrideRuns: text === undefined ? null : text.characterOverrideRuns.map(characterOverrideRunToJson),
    fills: node.fills.map(paintToJson),
    strokes: node.strokes.map(paintToJson),
    strokeWeight: node.strokeWeight ?? null,
    individualStrokeWeights: strokeWeightsToJson(node.individualStrokeWeights),
    strokeAlign: node.strokeAlign ?? null,
    cornerRadius: node.cornerRadius ?? null,
    rectangleCornerRadii: node.rectangleCornerRadii === undefined ? null : [...node.rectangleCornerRadii],
    effects: node.effects.map(effectToJson),
    componentId: node.componentId ?? null,
    vectorGeometry: vectorToJson(node),
  }
}

type JsonObject = { readonly [key: string]: CanonicalValue | undefined }

const isObject = (value: CanonicalValue | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const sameValue = (a: CanonicalValue | undefined, b: CanonicalValue | undefined): boolean =>
  a === undefined || b === undefined ? a === b : canonicalStringify(a) === canonicalStringify(b)

/**
 * Structs whose members are reported one by one when both sides have them.
 *
 * Everything else is one value: arrays, because a list's meaning is its
 * whole order; a style reference, because its shape depends on its kind;
 * OpenType flags, because their keys come from the design and a field path
 * built from them would make the set of paths depend on the data.
 */
const MEMBERWISE: ReadonlySet<string> = new Set([
  'layout',
  'layout.padding',
  'layout.constraints',
  'typography',
  'individualStrokeWeights',
  'vectorGeometry',
])

const collectChangedPaths = (path: string, before: CanonicalValue, after: CanonicalValue, into: string[]): void => {
  if (path === 'box' && isObject(before) && isObject(after)) {
    // Position is not a change to the box: it is reported as movement,
    // where it can be read against the parent instead of the page.
    for (const member of ['height', 'width']) {
      if (!sameValue(before[member], after[member])) into.push(`box.${member}`)
    }
    return
  }
  if (path === 'renderBounds' && isObject(before) && isObject(after)) {
    if (before['state'] === 'known' && after['state'] === 'known') {
      for (const member of ['height', 'offsetX', 'offsetY', 'width']) {
        if (!sameValue(before[member], after[member])) into.push(`renderBounds.${member}`)
      }
      return
    }
  }
  if (MEMBERWISE.has(path) && isObject(before) && isObject(after)) {
    const members = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(compareCodeUnits)
    for (const member of members) {
      collectChangedPaths(`${path}.${member}`, before[member] ?? null, after[member] ?? null, into)
    }
    return
  }
  if (!sameValue(before, after)) into.push(path)
}

const absolutePositionDiffers = (before: CanonicalNode, after: CanonicalNode): boolean =>
  before.geometry !== undefined &&
  after.geometry !== undefined &&
  (before.geometry.x !== after.geometry.x || before.geometry.y !== after.geometry.y)

/**
 * A key the hash input says changed, with nothing shown for it.
 *
 * Two keys carry absolute coordinates, so a node that only moved differs in
 * both and shows a change in neither: the movement accounts for it. Any other
 * key arriving here means the shown form has lost something the hash input
 * still has.
 */
const accountedForByMovement = (row: OwnFieldRow, before: CanonicalNode, after: CanonicalNode): boolean =>
  (row.key === 'geometry' || row.key === 'renderBounds') && absolutePositionDiffers(before, after)

/**
 * The own-field changes between two versions of one node.
 *
 * Call only when the content hashes differ; equal hashes mean an equal hash
 * input, and there is nothing to find.
 */
export const changedOwnFields = (
  sourceId: SourceId,
  before: CanonicalNode,
  after: CanonicalNode,
): ReadonlyArray<ChangeRef> => {
  const ownBefore = canonicalNodeOwnFields(before) as JsonObject
  const ownAfter = canonicalNodeOwnFields(after) as JsonObject
  const shownBefore = shownFieldsOf(before)
  const shownAfter = shownFieldsOf(after)
  const changes: ChangeRef[] = []

  for (const row of OWN_FIELD_ROWS) {
    if (sameValue(ownBefore[row.key], ownAfter[row.key])) continue
    const paths: string[] = []
    for (const shown of row.shownAs) {
      collectChangedPaths(shown, shownBefore[shown] ?? null, shownAfter[shown] ?? null, paths)
    }
    if (row.category === undefined || (paths.length === 0 && !accountedForByMovement(row, before, after))) {
      throw new SnapshotDiffError({
        kind: 'change-serialization-mismatch',
        sourceId: sourceId as string,
        ownField: row.key,
      })
    }
    for (const fieldPath of paths) changes.push({ category: row.category, fieldPath })
  }
  return changes
}

const categoryOrder = new Map<SnapshotDiffCategory, number>(
  SNAPSHOT_DIFF_CATEGORIES.map((category, index) => [category, index]),
)

/** Category order first, then field path by code unit: the order changes are listed in. */
export const sortChanges = (changes: ReadonlyArray<ChangeRef>): ReadonlyArray<ChangeRef> =>
  [...changes].sort(
    (a, b) =>
      (categoryOrder.get(a.category) ?? 0) - (categoryOrder.get(b.category) ?? 0) ||
      compareCodeUnits(a.fieldPath, b.fieldPath),
  )

/** The distinct categories of a node's changes, in declaration order. */
export const categoriesOf = (changes: ReadonlyArray<ChangeRef>): ReadonlyArray<SnapshotDiffCategory> =>
  SNAPSHOT_DIFF_CATEGORIES.filter((category) => changes.some((change) => change.category === category))

/**
 * The value at a field path on one side.
 *
 * Children and parent come from the site: they describe where the node sits,
 * which the node itself does not know.
 */
export const valueAt = (site: NodeSite, shown: ShownFields, fieldPath: string): CanonicalValue => {
  if (fieldPath === CHILDREN_CHANGE.fieldPath) return site.childIds.map((id) => id as string)
  if (fieldPath === PARENT_CHANGE.fieldPath) return site.parentId === undefined ? null : (site.parentId as string)
  const [head, ...rest] = fieldPath.split('.')
  let value: CanonicalValue = shown[head ?? ''] ?? null
  for (const member of rest) value = isObject(value) ? (value[member] ?? null) : null
  return value
}
