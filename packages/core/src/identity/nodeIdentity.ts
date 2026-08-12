/**
 * Node identity.
 *
 * Three keys with different failure modes, and a clear ranking between them.
 * Within one snapshot `sourceId` is authoritative: Figma keeps it across
 * renames and reordering, and only loses it when a node is genuinely recreated.
 * `stableKey` is a fingerprint for *suggesting* matches — a designer renaming a
 * layer must not silently reassign a diagnostic to a different node.
 */
import { canonicalStringify, type CanonicalValue } from '../determinism/canonical.js'
import { hashCanonical, type Hash } from '../determinism/hash.js'

/** Opaque node id from the source. Instance children (`I123;456`) stay whole. */
export type SourceId = string & { readonly __sourceIdBrand: unique symbol }

/** Index path from the root, e.g. `0/2/1`. For display and diagnostics. */
export type NodePath = string & { readonly __nodePathBrand: unique symbol }

/**
 * Fingerprint for candidate matching. Never an authoritative key.
 *
 * Typed as its own hash kind so it cannot be stored where a canonical or
 * content hash is expected — the type system carries the demotion, not just
 * the comment.
 */
export type StableKey = Hash<'stable-key'>

export const IDENTITY_VERSION = 1

export class NodeIdentityError extends Error {
  readonly _tag = 'NodeIdentityError'
  constructor(message: string) {
    super(message)
    this.name = 'NodeIdentityError'
  }
}

/**
 * Wraps a raw source id.
 *
 * Deliberately opaque. `I<instanceId>;<childId>` is not split apart here:
 * a key assembled from the pieces would look stable while quietly following
 * the wrong occurrence when a component has several instances.
 */
export const sourceId = (raw: string): SourceId => {
  if (raw.length === 0) throw new NodeIdentityError('sourceId cannot be empty')
  return raw as SourceId
}

export const nodePath = (indices: ReadonlyArray<number>): NodePath => {
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0) {
      throw new NodeIdentityError(`node path segments must be non-negative integers, got ${String(index)}`)
    }
  }
  return indices.join('/') as NodePath
}

/**
 * Structural address of a Figma instance child, kept for *explaining* a match.
 *
 * Held as provenance only. Correspondence may use it to propose a candidate,
 * but never to confirm one on its own.
 */
export interface FigmaSourceAddress {
  readonly rawSourceId: SourceId
  readonly occurrenceInstanceId?: string
  readonly definitionLocalNodeId?: string
  readonly componentId?: string
}

const INSTANCE_CHILD = /^I([^;]+);(.+)$/

/** Decomposes an instance-child id for candidate generation. Never for keying. */
export const describeSourceAddress = (id: SourceId, componentId?: string): FigmaSourceAddress => {
  const match = INSTANCE_CHILD.exec(id as string)
  const base: FigmaSourceAddress = { rawSourceId: id }
  const occurrence = match?.[1]
  const local = match?.[2]
  return {
    ...base,
    ...(occurrence !== undefined ? { occurrenceInstanceId: occurrence } : {}),
    ...(local !== undefined ? { definitionLocalNodeId: local } : {}),
    ...(componentId !== undefined ? { componentId } : {}),
  }
}

export interface StableKeyInput {
  /** Layer names from the root down to this node, inclusive. */
  readonly nameChain: ReadonlyArray<string>
  /** Node types from the root down to this node, inclusive. */
  readonly typeChain: ReadonlyArray<string>
  /** Position among siblings that share this node's name. */
  readonly indexAmongSameName: number
}

/**
 * Computes the matching fingerprint.
 *
 * Note what breaks it: renaming a layer is enough, and so is inserting a
 * same-named sibling. That fragility is exactly why this is a hint and not a key.
 */
export const stableKey = (input: StableKeyInput): StableKey => {
  if (input.nameChain.length !== input.typeChain.length) {
    throw new NodeIdentityError(
      `nameChain (${input.nameChain.length}) and typeChain (${input.typeChain.length}) must be the same length`,
    )
  }
  if (input.nameChain.length === 0) throw new NodeIdentityError('stableKey requires a non-empty chain')
  if (!Number.isInteger(input.indexAmongSameName) || input.indexAmongSameName < 0) {
    throw new NodeIdentityError(
      `indexAmongSameName must be a non-negative integer, got ${String(input.indexAmongSameName)}`,
    )
  }

  return hashCanonical('stable-key', IDENTITY_VERSION, {
    nameChain: [...input.nameChain],
    typeChain: [...input.typeChain],
    indexAmongSameName: input.indexAmongSameName,
  })
}

/**
 * Hash of a node's own normalized fields. Children are not included.
 *
 * Values must already be rounded to their slot precision; hashing raw Figma
 * floats would make `12.000001` and `12` different nodes.
 */
export const contentHash = (ownFields: CanonicalValue): Hash<'content'> =>
  hashCanonical('content', IDENTITY_VERSION, ownFields)

/**
 * Hash of a node together with its children.
 *
 * Child order is preserved rather than sorted, because in a UI tree the order
 * is part of what the design says. Two branches with equal `subtreeHash` need
 * no regeneration — but deciding to *keep the old code* on that basis belongs
 * to the diff gate, not here.
 */
export const subtreeHash = (
  own: Hash<'content'>,
  childSubtreeHashes: ReadonlyArray<Hash<'subtree'>>,
): Hash<'subtree'> =>
  hashCanonical('subtree', IDENTITY_VERSION, {
    contentHash: own as string,
    children: childSubtreeHashes.map((hash) => hash as string),
  })

/** How a cross-snapshot match was established. */
export const CORRESPONDENCE_METHODS = [
  'same-source-id',
  'instance-occurrence-and-definition-node',
  'explicit',
] as const
export type CorrespondenceMethod = (typeof CORRESPONDENCE_METHODS)[number]

export interface CorrespondenceMapping {
  readonly fromSourceId: SourceId
  readonly toSourceId: SourceId
  readonly method: CorrespondenceMethod
  /** Human-readable support for the match. Audit material, not an input to decisions. */
  readonly evidence: ReadonlyArray<string>
}

export interface CorrespondenceUnresolved {
  readonly fromSourceId?: SourceId
  readonly toSourceId?: SourceId
  readonly status: 'unmatched' | 'ambiguous'
  readonly candidateSourceIds: ReadonlyArray<SourceId>
}

/**
 * Cross-snapshot correspondence.
 *
 * Confirmed mappings and candidates are separate types on purpose: a single
 * `confidence: 0.87` field invites picking a plausible wrong answer quietly,
 * which is the most expensive way for this to fail. Generation of this artifact
 * is out of scope for Phase 1; the shape is fixed now so the rest of the system
 * can be written against it.
 */
export interface CorrespondenceArtifactV1 {
  readonly schemaVersion: 1
  readonly from: { readonly snapshotId: string; readonly canonicalHash: Hash<'canonical'> }
  readonly to: { readonly snapshotId: string; readonly canonicalHash: Hash<'canonical'> }
  readonly scope: ReadonlyArray<SourceId>
  readonly mappings: ReadonlyArray<CorrespondenceMapping>
  readonly unresolved: ReadonlyArray<CorrespondenceUnresolved>
  readonly completeness: 'complete-for-scope'
}

/**
 * Checks the invariants a correspondence artifact must satisfy.
 *
 * `complete-for-scope` is a strong claim, so it is checked as one: scope must
 * be partitioned exactly — every node accounted for once, as either a confirmed
 * mapping or an unresolved entry, never both and never neither. A node that
 * appears in both would let a caller read whichever answer suited it.
 *
 * Method-specific rules are checked too. `instance-occurrence-and-definition-node`
 * is only legitimate when the enclosing instance itself has a confirmed
 * one-to-one mapping: a component with several instances would otherwise let a
 * child follow the wrong occurrence while looking perfectly well-supported.
 *
 * Returns problems rather than throwing, so a caller can report all of them at
 * once instead of playing whack-a-mole.
 */
export const validateCorrespondence = (artifact: CorrespondenceArtifactV1): ReadonlyArray<string> => {
  const problems: string[] = []

  const scope = new Set<string>()
  for (const id of artifact.scope) {
    if (scope.has(id)) problems.push(`duplicate scope entry: ${id}`)
    scope.add(id)
  }

  const froms = new Set<string>()
  const tos = new Set<string>()
  for (const mapping of artifact.mappings) {
    if (froms.has(mapping.fromSourceId)) problems.push(`duplicate fromSourceId: ${mapping.fromSourceId}`)
    if (tos.has(mapping.toSourceId)) problems.push(`duplicate toSourceId: ${mapping.toSourceId}`)
    froms.add(mapping.fromSourceId)
    tos.add(mapping.toSourceId)

    if (!scope.has(mapping.fromSourceId)) {
      problems.push(`mapping outside scope: ${mapping.fromSourceId}`)
    }
    if (mapping.method === 'same-source-id' && mapping.fromSourceId !== mapping.toSourceId) {
      problems.push(
        `method same-source-id requires identical ids, got ${mapping.fromSourceId} -> ${mapping.toSourceId}`,
      )
    }
    if (mapping.method === 'instance-occurrence-and-definition-node') {
      problems.push(...checkOccurrenceMethod(mapping, artifact))
    }
  }

  const unresolvedFroms = new Set<string>()
  for (const entry of artifact.unresolved) {
    if (entry.fromSourceId !== undefined) {
      if (unresolvedFroms.has(entry.fromSourceId)) {
        problems.push(`duplicate unresolved entry: ${entry.fromSourceId}`)
      }
      unresolvedFroms.add(entry.fromSourceId)
      if (!scope.has(entry.fromSourceId)) {
        problems.push(`unresolved entry outside scope: ${entry.fromSourceId}`)
      }
      if (froms.has(entry.fromSourceId)) {
        problems.push(`node is both mapped and unresolved: ${entry.fromSourceId}`)
      }
    }
    if (entry.status === 'unmatched' && entry.candidateSourceIds.length > 0) {
      problems.push(`unmatched entry must have no candidates: ${String(entry.fromSourceId)}`)
    }
    if (entry.status === 'ambiguous' && entry.candidateSourceIds.length < 2) {
      problems.push(`ambiguous entry needs at least two candidates: ${String(entry.fromSourceId)}`)
    }
  }

  for (const id of artifact.scope) {
    if (!froms.has(id) && !unresolvedFroms.has(id)) {
      problems.push(`node in scope is neither mapped nor unresolved: ${id}`)
    }
  }

  return problems
}

const checkOccurrenceMethod = (
  mapping: CorrespondenceMapping,
  artifact: CorrespondenceArtifactV1,
): ReadonlyArray<string> => {
  const from = describeSourceAddress(mapping.fromSourceId)
  const to = describeSourceAddress(mapping.toSourceId)
  if (from.occurrenceInstanceId === undefined || to.occurrenceInstanceId === undefined) {
    return [
      `method instance-occurrence-and-definition-node requires instance-child ids, got ${mapping.fromSourceId} -> ${mapping.toSourceId}`,
    ]
  }
  if (from.definitionLocalNodeId !== to.definitionLocalNodeId) {
    return [
      `method instance-occurrence-and-definition-node requires the same definition-local node, got ${String(from.definitionLocalNodeId)} -> ${String(to.definitionLocalNodeId)}`,
    ]
  }
  const outerConfirmed = artifact.mappings.some(
    (candidate) =>
      (candidate.fromSourceId as string) === from.occurrenceInstanceId &&
      (candidate.toSourceId as string) === to.occurrenceInstanceId,
  )
  return outerConfirmed
    ? []
    : [
        `method instance-occurrence-and-definition-node requires a confirmed mapping for the enclosing instance ${String(from.occurrenceInstanceId)}`,
      ]
}

/** Serializes identity inputs for debugging. Not part of any hash. */
export const describeIdentity = (input: StableKeyInput): string => canonicalStringify({ ...input })
