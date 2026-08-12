/**
 * The wire contract for a slice, stated as a schema.
 *
 * Hand-written serializers dropped `undefined` keys three separate times
 * (layout, list-frames, typography) before the rule "spell out every field"
 * went into AGENTS.md — and a fourth instance (effects, raw paints) was alive
 * after the rule was written. Prose does not enforce itself. This schema
 * does: every key is required, absence is `null`, and a decode of the
 * serializer's output through it fails the moment a key vanishes.
 *
 * The schema is the contract, not the implementation: `sliceToJson` stays the
 * producer, and tests decode its output. Changing either side alone breaks
 * loudly instead of shipping a payload whose key set depends on the values.
 */
import { Schema } from 'effect'

import { SLICE_SCHEMA_VERSION } from './types.js'

const NullOr = Schema.NullOr

const BoxWire = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
})

const RgbaWire = Schema.Tuple([Schema.Number, Schema.Number, Schema.Number, Schema.Number])

const LayoutWire = Schema.Struct({
  mode: Schema.String,
  wrap: Schema.String,
  primaryAxisAlign: Schema.String,
  counterAxisAlign: Schema.String,
  counterAxisAlignContent: NullOr(Schema.String),
  primaryAxisSizingMode: NullOr(Schema.String),
  counterAxisSizingMode: NullOr(Schema.String),
  sizingHorizontal: Schema.String,
  sizingVertical: Schema.String,
  itemSpacing: NullOr(Schema.Number),
  counterAxisSpacing: NullOr(Schema.Number),
  padding: Schema.Struct({
    top: Schema.Number,
    right: Schema.Number,
    bottom: Schema.Number,
    left: Schema.Number,
  }),
  positioning: Schema.String,
  layoutAlign: NullOr(Schema.String),
  layoutGrow: NullOr(Schema.Number),
  constraints: NullOr(Schema.Struct({ horizontal: Schema.String, vertical: Schema.String })),
  overflowDirection: NullOr(Schema.String),
  clipsContent: Schema.Boolean,
})

const TypographyWire = Schema.Struct({
  fontFamily: Schema.String,
  fontPostScriptName: NullOr(Schema.String),
  fontWeight: Schema.Number,
  fontSize: Schema.Number,
  letterSpacing: Schema.Number,
  lineHeightPx: Schema.Number,
  lineHeightPercentFontSize: NullOr(Schema.Number),
  textAlignHorizontal: Schema.String,
  textAlignVertical: Schema.String,
  textAutoResize: NullOr(Schema.String),
  leadingTrim: NullOr(Schema.String),
  opentypeFlags: NullOr(Schema.Record(Schema.String, Schema.Number)),
  textDecoration: Schema.String,
})

const PathWire = Schema.Struct({ path: Schema.String, windingRule: Schema.String })

const VectorGeometryWire = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('known'),
    fill: Schema.Array(PathWire),
    stroke: Schema.Array(PathWire),
    geometryHash: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal('absent') }),
  Schema.Struct({ kind: Schema.Literal('unknown'), reason: Schema.String }),
])

const ChildOverflowWire = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('known'),
    leftPx: Schema.Number,
    rightPx: Schema.Number,
    topPx: Schema.Number,
    bottomPx: Schema.Number,
    sourceIds: Schema.Array(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal('absent') }),
  Schema.Struct({ kind: Schema.Literal('unknown'), reason: Schema.String }),
])

const StrokeWeightsWire = Schema.Struct({
  top: Schema.Number,
  right: Schema.Number,
  bottom: Schema.Number,
  left: Schema.Number,
})

const CharacterOverrideRunWire = Schema.Struct({
  start: Schema.Number,
  end: Schema.Number,
  overrideId: NullOr(Schema.Number),
  textDecoration: Schema.String,
})

const StyleRefWire = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('token'),
    styleId: Schema.String,
    name: Schema.String,
    styleType: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal('unresolved'), styleId: Schema.String, reason: Schema.String }),
])

const PaintCommonWire = {
  visible: Schema.Boolean,
  opacity: NullOr(Schema.Number),
  blendMode: NullOr(Schema.String),
}

const RawPaintWire = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('solid'), ...PaintCommonWire, rgba: RgbaWire }),
  Schema.Struct({
    kind: Schema.Literal('gradient'),
    ...PaintCommonWire,
    gradientType: Schema.String,
    stops: Schema.Array(Schema.Struct({ position: Schema.Number, rgba: RgbaWire })),
    handles: Schema.Array(Schema.Struct({ x: Schema.Number, y: Schema.Number })),
  }),
  Schema.Struct({
    kind: Schema.Literal('image'),
    ...PaintCommonWire,
    imageRef: NullOr(Schema.String),
    scaleMode: NullOr(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal('other'), ...PaintCommonWire, paintType: Schema.String }),
])

const StyleValueWire = Schema.Union([
  StyleRefWire,
  Schema.Struct({ kind: Schema.Literal('raw'), paint: RawPaintWire }),
])

const EffectWire = Schema.Struct({
  type: Schema.String,
  visible: Schema.Boolean,
  radius: NullOr(Schema.Number),
  spread: NullOr(Schema.Number),
  offset: NullOr(Schema.Struct({ x: Schema.Number, y: Schema.Number })),
  rgba: NullOr(RgbaWire),
  blendMode: NullOr(Schema.String),
})

const TextScanWire = Schema.Struct({
  suspectedInjection: Schema.Boolean,
  matches: Schema.Array(Schema.String),
})

export const SliceNodeWire = Schema.Struct({
  sourceId: Schema.String,
  parentId: NullOr(Schema.String),
  name: Schema.String,
  type: Schema.String,
  depth: Schema.Number,
  visualOrderIndex: Schema.Number,
  visualOrderReliable: Schema.Boolean,
  rendered: Schema.Boolean,
  box: NullOr(BoxWire),
  renderBounds: NullOr(BoxWire),
  relativeBox: NullOr(BoxWire),
  observedChildOverflow: ChildOverflowWire,
  rotation: NullOr(Schema.Number),
  opacity: NullOr(Schema.Number),
  blendMode: NullOr(Schema.String),
  layout: LayoutWire,
  characters: NullOr(Schema.String),
  textStyle: NullOr(StyleRefWire),
  typography: NullOr(TypographyWire),
  hasCharacterOverrides: Schema.Boolean,
  characterOverrideRuns: NullOr(Schema.Array(CharacterOverrideRunWire)),
  textScan: NullOr(TextScanWire),
  fills: Schema.Array(StyleValueWire),
  strokes: Schema.Array(StyleValueWire),
  strokeWeight: NullOr(Schema.Number),
  individualStrokeWeights: NullOr(StrokeWeightsWire),
  strokeAlign: NullOr(Schema.String),
  cornerRadius: NullOr(Schema.Number),
  rectangleCornerRadii: NullOr(Schema.Array(Schema.Number)),
  effects: Schema.Array(EffectWire),
  componentId: NullOr(Schema.String),
  vectorGeometry: VectorGeometryWire,
  contentHash: Schema.String,
  subtreeHash: Schema.String,
  truncated: NullOr(Schema.Struct({ reason: Schema.String, childCount: Schema.Number })),
})

const SlotObservationWire = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('known'),
    sourceId: Schema.String,
    nodeType: Schema.String,
    rendered: Schema.Boolean,
    box: NullOr(BoxWire),
    relativeBox: NullOr(BoxWire),
    rotation: NullOr(Schema.Number),
    layoutMode: Schema.String,
    itemSpacing: NullOr(Schema.Number),
    characters: NullOr(Schema.String),
    textStyle: NullOr(StyleRefWire),
    typography: NullOr(TypographyWire),
    fills: Schema.Array(StyleValueWire),
    strokes: Schema.Array(StyleValueWire),
    strokeWeight: NullOr(Schema.Number),
    individualStrokeWeights: NullOr(StrokeWeightsWire),
    cornerRadius: NullOr(Schema.Number),
  }),
  Schema.Struct({ kind: Schema.Literal('absent') }),
  Schema.Struct({ kind: Schema.Literal('unknown') }),
])

const ResponsiveGroupWire = Schema.Struct({
  section: Schema.String,
  members: Schema.Array(
    Schema.Struct({ breakpoint: Schema.String, designWidthPx: Schema.Number, rootId: Schema.String }),
  ),
  coverage: Schema.Struct({ correspondedPaths: Schema.Number, unresolvedPaths: Schema.Number }),
  slots: Schema.Array(
    Schema.Struct({
      namePath: Schema.Array(Schema.String),
      byBreakpoint: Schema.Record(Schema.String, SlotObservationWire),
    }),
  ),
})

export const SliceWire = Schema.Struct({
  // A literal, not a number: a payload from another schema version must fail
  // the decode rather than read as this one with a different shape.
  schemaVersion: Schema.Literal(SLICE_SCHEMA_VERSION),
  fileKey: Schema.String,
  sourceVersion: Schema.String,
  canonicalHash: Schema.String,
  snapshotId: Schema.String,
  sliceRequestHash: Schema.String,
  request: Schema.Struct({
    roots: Schema.Array(Schema.String),
    maxDepth: NullOr(Schema.Number),
    maxNodes: Schema.Number,
    includeHidden: Schema.Boolean,
  }),
  nodes: Schema.Array(SliceNodeWire),
  omitted: Schema.Array(
    Schema.Struct({
      sourceId: Schema.String,
      parentId: NullOr(Schema.String),
      reason: Schema.String,
      descendantCount: Schema.Number,
    }),
  ),
  responsive: Schema.Array(ResponsiveGroupWire),
  derivation: Schema.Array(
    Schema.Struct({ reason: Schema.String, detail: Schema.String, sourceIds: Schema.Array(Schema.String) }),
  ),
  findings: Schema.Array(
    Schema.Struct({
      ruleId: Schema.String,
      ruleVersion: Schema.String,
      findingId: Schema.String,
      severity: Schema.String,
      reason: Schema.String,
      message: Schema.String,
      sourceIds: Schema.Array(Schema.String),
      externalSourceIds: Schema.Array(Schema.String),
      evidence: Schema.Array(Schema.String),
    }),
  ),
})

export const SliceEnvelopeWire = Schema.Struct({
  ...SliceWire.fields,
  sliceHash: Schema.String,
})

/**
 * Decodes a value against the wire contract, rejecting unknown keys.
 *
 * `onExcessProperty: 'error'` is the other half of the guarantee: a key the
 * schema does not know about is a schema that lags the serializer, which is
 * the same drift in the opposite direction.
 */
export const decodeSliceWire = (value: unknown) =>
  Schema.decodeUnknownSync(SliceWire)(value, { onExcessProperty: 'error', errors: 'all' })

export const decodeSliceEnvelopeWire = (value: unknown) =>
  Schema.decodeUnknownSync(SliceEnvelopeWire)(value, { onExcessProperty: 'error', errors: 'all' })
