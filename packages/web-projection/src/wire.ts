/**
 * The projection's wire contract, built the way the slice's is: an explicit
 * serializer whose output must decode through a schema with every key
 * required, absence as null, unions tagged, and unknown keys rejected.
 */
import { Schema } from 'effect'
import { INFRASTRUCTURE_REASONS, ReasonCodeSchema, SEMANTIC_REASONS, type CanonicalValue, type Known, type ReasonCode } from '@figma-ir/core'

import {
  WEB_PROJECTION_SCHEMA_VERSION,
  type AxisSizePlan,
  type ContainerPlan,
  type ContradictionEvidence,
  type Obligation,
  type Verification,
  type WebProjectionArtifact,
  type WrapProjection,
} from './types.js'

const NullOr = Schema.NullOr

const DistributionWire = Schema.Literals(['start', 'center', 'end', 'space-between'])
const CrossAlignWire = Schema.Literals(['start', 'center', 'end'])

const knownToJson = <A>(value: Known<A>, encode: (inner: A) => CanonicalValue): CanonicalValue => {
  switch (value.kind) {
    case 'known':
      return { kind: 'known', value: encode(value.value) }
    case 'absent':
      return { kind: 'absent' }
    case 'unknown':
      return { kind: 'unknown', reason: value.reason }
  }
}

const KnownWire = <Inner extends Schema.Top>(inner: Inner) =>
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal('known'), value: inner }),
    Schema.Struct({ kind: Schema.Literal('absent') }),
    Schema.Struct({ kind: Schema.Literal('unknown'), reason: ReasonCodeSchema }),
  ])

const verificationToJson = (verification: Verification): CanonicalValue =>
  verification.kind === 'consistent' ? { kind: 'consistent' } : { kind: verification.kind, reason: verification.reason }

const VerificationWire = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('consistent') }),
  Schema.Struct({ kind: Schema.Literal('contradicted'), reason: ReasonCodeSchema }),
  Schema.Struct({ kind: Schema.Literal('not-verifiable'), reason: ReasonCodeSchema }),
])

const axisPlanToJson = (plan: AxisSizePlan): CanonicalValue => {
  switch (plan.kind) {
    case 'fixed':
      return { kind: 'fixed', px: plan.px }
    case 'intrinsic':
    case 'stretch':
    case 'flex':
      return { kind: plan.kind }
    case 'unknown':
      return { kind: 'unknown', reason: plan.reason }
  }
}

const AxisPlanWire = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('fixed'), px: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal('intrinsic') }),
  Schema.Struct({ kind: Schema.Literal('stretch') }),
  Schema.Struct({ kind: Schema.Literal('flex') }),
  Schema.Struct({ kind: Schema.Literal('unknown'), reason: ReasonCodeSchema }),
])

const containerToJson = (container: ContainerPlan): CanonicalValue => {
  switch (container.kind) {
    case 'non-flex':
      return { kind: 'non-flex' }
    case 'unknown':
      return { kind: 'unknown', reason: container.reason }
    case 'flex':
      return {
        kind: 'flex',
        direction: container.direction,
        wrap: container.wrap,
        mainAlign: knownToJson(container.mainAlign, (value) => value),
        crossAlign: knownToJson(container.crossAlign, (value) => value),
        mainGapPx: knownToJson(container.mainGapPx, (value) => value),
        crossGapPx: knownToJson(container.crossGapPx, (value) => value),
        padding: {
          top: container.padding.top,
          right: container.padding.right,
          bottom: container.padding.bottom,
          left: container.padding.left,
        },
      }
  }
}

const ContainerWire = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('non-flex') }),
  Schema.Struct({ kind: Schema.Literal('unknown'), reason: ReasonCodeSchema }),
  Schema.Struct({
    kind: Schema.Literal('flex'),
    direction: Schema.Literals(['row', 'column']),
    wrap: Schema.Boolean,
    mainAlign: KnownWire(DistributionWire),
    crossAlign: KnownWire(CrossAlignWire),
    mainGapPx: KnownWire(Schema.Number),
    crossGapPx: KnownWire(Schema.Number),
    padding: Schema.Struct({
      top: Schema.Number,
      right: Schema.Number,
      bottom: Schema.Number,
      left: Schema.Number,
    }),
  }),
])

const wrapToJson = (wrap: WrapProjection): CanonicalValue => ({
  observed: {
    lines: wrap.observed.lines.map((line) => ({ childIds: line.childIds.map((id) => id as string) })),
  },
  rule: {
    axis: knownToJson(wrap.rule.axis, (value) => value),
    track: knownToJson(wrap.rule.track, (value) => ({ mainPx: value.mainPx, crossPx: value.crossPx })),
    packingGapPx: knownToJson(wrap.rule.packingGapPx, (value) => value),
    fullLineDistribution: knownToJson(wrap.rule.fullLineDistribution, (value) => value),
    partialLineDistribution: knownToJson(wrap.rule.partialLineDistribution, (value) => value),
    lineGapPx: knownToJson(wrap.rule.lineGapPx, (value) => value),
  },
  verification: {
    lineMembership: verificationToJson(wrap.verification.lineMembership),
    inlinePositions: verificationToJson(wrap.verification.inlinePositions),
    crossPositions: verificationToJson(wrap.verification.crossPositions),
    childSizes: verificationToJson(wrap.verification.childSizes),
  },
})

const WrapWire = Schema.Struct({
  observed: Schema.Struct({
    lines: Schema.Array(Schema.Struct({ childIds: Schema.Array(Schema.String) })),
  }),
  rule: Schema.Struct({
    axis: KnownWire(Schema.Literal('horizontal')),
    track: KnownWire(Schema.Struct({ mainPx: Schema.Number, crossPx: Schema.Number })),
    packingGapPx: KnownWire(Schema.Number),
    fullLineDistribution: KnownWire(DistributionWire),
    partialLineDistribution: KnownWire(DistributionWire),
    lineGapPx: KnownWire(Schema.Number),
  }),
  verification: Schema.Struct({
    lineMembership: VerificationWire,
    inlinePositions: VerificationWire,
    crossPositions: VerificationWire,
    childSizes: VerificationWire,
  }),
})

/** Everything but the projectionHash, which is a digest of exactly this. */
export const projectionToJson = (artifact: WebProjectionArtifact): CanonicalValue =>
  ({
    schemaVersion: artifact.schemaVersion,
    translatorVersion: artifact.translatorVersion,
    emulatorTolerancePx: artifact.emulatorTolerancePx,
    fileKey: artifact.fileKey,
    sourceVersion: artifact.sourceVersion,
    canonicalHash: artifact.canonicalHash as string,
    snapshotId: artifact.snapshotId as string,
    request: {
      roots: [...artifact.request.roots],
      maxDepth: artifact.request.maxDepth ?? null,
      maxNodes: artifact.request.maxNodes,
      includeHidden: artifact.request.includeHidden,
    },
    projectionRequestHash: artifact.projectionRequestHash as string,
    nodes: artifact.nodes.map((node) => ({
      sourceId: node.sourceId as string,
      participation: node.participation,
      container: containerToJson(node.container),
      widthPlan: axisPlanToJson(node.widthPlan),
      heightPlan: axisPlanToJson(node.heightPlan),
      wrap: node.wrap === undefined ? null : wrapToJson(node.wrap),
    })),
    diagnostics: artifact.diagnostics.map((diagnostic) => ({
      reason: diagnostic.reason,
      detail: diagnostic.detail,
      sourceIds: diagnostic.sourceIds.map((id) => id as string),
      evidence: diagnostic.evidence === undefined ? null : evidenceToJson(diagnostic.evidence),
    })),
    obligations: artifact.obligations.map(obligationToJson),
  }) as CanonicalValue

/** Every kind spelled out: a spread would carry whichever keys the variant happened to have. */
const evidenceToJson = (evidence: ContradictionEvidence): CanonicalValue => {
  switch (evidence.kind) {
    case 'stack-origin':
      return {
        kind: evidence.kind,
        axis: evidence.axis,
        distribution: evidence.distribution,
        childSourceId: evidence.childSourceId as string,
        observedPx: evidence.observedPx,
        predictedPx: evidence.predictedPx,
        notRenderedChildCount: evidence.notRenderedChildCount,
      }
    case 'stack-gap':
      return {
        kind: evidence.kind,
        axis: evidence.axis,
        beforeSourceId: evidence.beforeSourceId as string,
        afterSourceId: evidence.afterSourceId as string,
        observedPx: evidence.observedPx,
        predictedPx: evidence.predictedPx,
      }
    case 'stack-cross':
      return {
        kind: evidence.kind,
        axis: evidence.axis,
        align: evidence.align,
        childSourceId: evidence.childSourceId as string,
        observedPx: evidence.observedPx,
        predictedPx: evidence.predictedPx,
      }
    case 'axis-size':
      return {
        kind: evidence.kind,
        axis: evidence.axis,
        plan: evidence.plan,
        observedPx: evidence.observedPx,
        predictedPx: evidence.predictedPx,
      }
    case 'wrap-membership':
      return { kind: evidence.kind, predictedRows: evidence.predictedRows, observedRows: evidence.observedRows }
    case 'wrap-inline':
      return {
        kind: evidence.kind,
        row: evidence.row,
        distribution: evidence.distribution,
        packingGapPx: evidence.packingGapPx,
        childSourceId: evidence.childSourceId as string,
        observedPx: evidence.observedPx,
        predictedPx: evidence.predictedPx,
      }
    case 'wrap-partial-row':
      return { kind: evidence.kind, row: evidence.row }
    case 'wrap-cross':
      return {
        kind: evidence.kind,
        row: evidence.row,
        lineGapPx: evidence.lineGapPx,
        observedPx: evidence.observedPx,
        predictedPx: evidence.predictedPx,
      }
    case 'wrap-child-size':
      return {
        kind: evidence.kind,
        childSourceId: evidence.childSourceId as string,
        observedMainPx: evidence.observedMainPx,
        observedCrossPx: evidence.observedCrossPx,
        trackMainPx: evidence.trackMainPx,
        trackCrossPx: evidence.trackCrossPx,
      }
  }
}

const obligationToJson = (obligation: Obligation): CanonicalValue =>
  obligation.claim === 'preserveIntrinsicCrossSize'
    ? {
        projectionFactId: obligation.projectionFactId,
        sourceId: obligation.sourceId as string,
        claim: obligation.claim,
        axis: obligation.axis,
      }
    : {
        projectionFactId: obligation.projectionFactId,
        sourceId: obligation.sourceId as string,
        claim: obligation.claim,
      }

export const projectionEnvelope = (artifact: WebProjectionArtifact): CanonicalValue =>
  ({
    ...(projectionToJson(artifact) as Record<string, CanonicalValue>),
    projectionHash: artifact.projectionHash as string,
  }) as CanonicalValue

const MainAxisWire = Schema.Literals(['x', 'y'])
const PxPair = { observedPx: Schema.Number, predictedPx: Schema.Number }

const EvidenceWire = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('stack-origin'),
    axis: MainAxisWire,
    distribution: DistributionWire,
    childSourceId: Schema.String,
    ...PxPair,
    notRenderedChildCount: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal('stack-gap'),
    axis: MainAxisWire,
    beforeSourceId: Schema.String,
    afterSourceId: Schema.String,
    ...PxPair,
  }),
  Schema.Struct({
    kind: Schema.Literal('stack-cross'),
    axis: MainAxisWire,
    align: CrossAlignWire,
    childSourceId: Schema.String,
    ...PxPair,
  }),
  Schema.Struct({
    kind: Schema.Literal('axis-size'),
    axis: Schema.Literals(['width', 'height']),
    plan: Schema.Literals(['stretch', 'flex']),
    ...PxPair,
  }),
  Schema.Struct({ kind: Schema.Literal('wrap-membership'), predictedRows: Schema.Number, observedRows: Schema.Number }),
  Schema.Struct({
    kind: Schema.Literal('wrap-inline'),
    row: Schema.Number,
    distribution: DistributionWire,
    packingGapPx: Schema.Number,
    childSourceId: Schema.String,
    ...PxPair,
  }),
  Schema.Struct({ kind: Schema.Literal('wrap-partial-row'), row: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal('wrap-cross'), row: Schema.Number, lineGapPx: Schema.Number, ...PxPair }),
  Schema.Struct({
    kind: Schema.Literal('wrap-child-size'),
    childSourceId: Schema.String,
    observedMainPx: Schema.Number,
    observedCrossPx: Schema.Number,
    trackMainPx: Schema.Number,
    trackCrossPx: Schema.Number,
  }),
])

// Discriminated on the outside by reason and on the inside by kind: a
// contradiction without evidence, or evidence on some other reason, fails
// to decode instead of passing as a diagnostic with a hole in it.
const DiagnosticWire = Schema.Union([
  Schema.Struct({
    reason: Schema.Literal('GEOMETRY_CONTRADICTION'),
    detail: Schema.String,
    sourceIds: Schema.Array(Schema.String),
    evidence: EvidenceWire,
  }),
  Schema.Struct({
    reason: Schema.Literals(
      [...SEMANTIC_REASONS, ...INFRASTRUCTURE_REASONS].filter(
        (reason): reason is Exclude<ReasonCode, 'GEOMETRY_CONTRADICTION'> => reason !== 'GEOMETRY_CONTRADICTION',
      ),
    ),
    detail: Schema.String,
    sourceIds: Schema.Array(Schema.String),
    evidence: Schema.Null,
  }),
])

const ObligationWire = Schema.Union([
  Schema.Struct({
    projectionFactId: Schema.String,
    sourceId: Schema.String,
    claim: Schema.Literals(['container', 'width', 'height', 'wrap']),
  }),
  Schema.Struct({
    projectionFactId: Schema.String,
    sourceId: Schema.String,
    claim: Schema.Literal('preserveIntrinsicCrossSize'),
    axis: Schema.Literals(['width', 'height']),
  }),
])

export const ProjectionWire = Schema.Struct({
  schemaVersion: Schema.Literal(WEB_PROJECTION_SCHEMA_VERSION),
  translatorVersion: Schema.Number,
  emulatorTolerancePx: Schema.Number,
  fileKey: Schema.String,
  sourceVersion: Schema.String,
  canonicalHash: Schema.String,
  snapshotId: Schema.String,
  request: Schema.Struct({
    roots: Schema.Array(Schema.String),
    maxDepth: NullOr(Schema.Number),
    maxNodes: Schema.Number,
    includeHidden: Schema.Boolean,
  }),
  projectionRequestHash: Schema.String,
  nodes: Schema.Array(
    Schema.Struct({
      sourceId: Schema.String,
      participation: Schema.Literals(['rendered', 'not-rendered']),
      container: ContainerWire,
      widthPlan: AxisPlanWire,
      heightPlan: AxisPlanWire,
      wrap: NullOr(WrapWire),
    }),
  ),
  diagnostics: Schema.Array(DiagnosticWire),
  obligations: Schema.Array(ObligationWire),
})

export const ProjectionEnvelopeWire = Schema.Struct({
  ...ProjectionWire.fields,
  projectionHash: Schema.String,
})

export const decodeProjectionWire = (value: unknown) =>
  Schema.decodeUnknownSync(ProjectionWire)(value, { onExcessProperty: 'error', errors: 'all' })

export const decodeProjectionEnvelopeWire = (value: unknown) =>
  Schema.decodeUnknownSync(ProjectionEnvelopeWire)(value, { onExcessProperty: 'error', errors: 'all' })
