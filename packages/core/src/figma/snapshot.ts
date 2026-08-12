/**
 * Snapshot acquisition.
 *
 * A snapshot is several REST calls, and a designer can save the file in the
 * middle of them. Left unchecked, one IR ends up holding two different versions
 * of the same design — the node tree from before a change and the styles from
 * after — and `canonicalHash` silently starts describing a document that never
 * existed. So the acquisition is bracketed by a version check, and a mismatch
 * is an infrastructure failure rather than a result.
 */
import {
  canonicalStringify,
  type CanonicalValue,
} from '../determinism/canonical.js'
import { hashCanonicalString, type Hash } from '../determinism/hash.js'
import type { ReasonCode } from '../diagnostics/reason.js'
import { assertNodeId, type FigmaClient, type FileKey, type NodeDocument, type StyleEntry } from './client.js'

export const SNAPSHOT_SCHEMA_VERSION = 2

/** Which acquisition each part came from, so completeness can be judged per part. */
export const SNAPSHOT_PARTS = ['nodes', 'styles'] as const
export type SnapshotPart = (typeof SNAPSHOT_PARTS)[number]

export interface PartDigest {
  readonly digest: Hash<'canonical'>
  readonly itemCount: number
  /** `partial` means we know something is missing — never inferred from silence. */
  readonly completeness: 'complete' | 'partial'
  /**
   * What the part covers.
   *
   * Named explicitly because "complete" on its own invites the wrong reading:
   * the styles part is complete *for the styles the requested roots reference*,
   * which is not the same as every style defined in the file. Only the
   * governance catalogue can claim the latter.
   */
  readonly scope: 'requested-roots' | 'referenced-by-requested-roots'
}

/**
 * Everything needed to decide whether a stored snapshot may still be used.
 *
 * `acquiredAt` is deliberately outside the identity hash: the same design
 * fetched twice is the same design, and letting a clock into the hash would
 * make every re-fetch look like a change.
 */
/** What the acquisition asked the source for beyond the node tree. */
export type GeometryMode = 'none' | 'paths'

export interface SnapshotIdentity {
  readonly schemaVersion: number
  readonly fileKey: FileKey
  readonly roots: ReadonlyArray<string>
  /**
   * Whether vector paths were requested. Part of the identity: the same
   * roots with and without paths are two different acquisitions, and a
   * consumer must be able to tell "no shape" from "shape not asked for".
   */
  readonly geometry: GeometryMode
  readonly sourceVersionAtStart: string
  readonly sourceVersionAtEnd: string
  readonly acquiredAt: string
  readonly snapshotId: Hash<'canonical'>
  readonly adapter: { readonly name: string; readonly version: string }
}

export interface DesignSnapshot {
  readonly identity: SnapshotIdentity
  /** Raw node documents, keyed by requested root id. */
  readonly nodes: ReadonlyMap<string, NodeDocument>
  /** Styles referenced by those nodes, keyed by style node id. */
  readonly styles: ReadonlyMap<string, StyleEntry>
  readonly parts: { readonly [K in SnapshotPart]: PartDigest }
}

export class SnapshotError extends Error {
  readonly _tag = 'SnapshotError'
  readonly reason: ReasonCode
  constructor(message: string, reason: ReasonCode, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined)
    this.name = 'SnapshotError'
    this.reason = reason
  }
}

export const ADAPTER = { name: 'figma-rest', version: '1' } as const

const partDigest = (
  kind: string,
  entries: CanonicalValue,
  itemCount: number,
  scope: PartDigest['scope'],
): PartDigest => ({
  digest: hashCanonicalString('canonical', SNAPSHOT_SCHEMA_VERSION, canonicalStringify({ kind, entries })),
  itemCount,
  completeness: 'complete',
  scope,
})

/** Sorted plain object, so a Map's insertion order cannot leak into a hash. */
const sortedEntries = <A>(map: ReadonlyMap<string, A>): CanonicalValue => {
  const keys = [...map.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return Object.fromEntries(keys.map((key) => [key, map.get(key) as never])) as CanonicalValue
}

export interface AcquireOptions {
  readonly client: FigmaClient
  readonly fileKey: FileKey
  /** Node ids to fetch. These become the snapshot's roots. */
  readonly roots: ReadonlyArray<string>
  /** Injected so acquisition stays testable and the clock stays out of the hash. */
  readonly now: () => string
  /** Off by default: paths make a production snapshot several times larger. */
  readonly geometry?: GeometryMode
}

/**
 * Fetches a design snapshot, refusing to return one that spans two file versions.
 *
 * Note what is *not* here: the whole-file style catalogue. Only styles actually
 * referenced by the requested nodes come back, because that is all the REST
 * response carries. Enumerating unused styles needs the governance catalogue,
 * which is a separate and far more expensive acquisition — a full read of a
 * production file measures in the hundreds of megabytes, which is exactly why
 * it has its own lifecycle and its own hash instead of riding along with
 * every run.
 */
export const acquireSnapshot = async (options: AcquireOptions): Promise<DesignSnapshot> => {
  const { client, fileKey: key, roots: requested, now } = options
  const geometry: GeometryMode = options.geometry ?? 'none'
  if (geometry !== 'none' && geometry !== 'paths') {
    // A mode the request cannot express would be recorded as if it had been
    // honoured, and every node's shape would then read as acquired.
    throw new SnapshotError(`geometry must be none or paths, got ${String(geometry)}`, 'CONFIG_ERROR')
  }
  if (requested.length === 0) {
    throw new SnapshotError('a snapshot needs at least one root node', 'CONFIG_ERROR')
  }
  // Roots are a set: asking for A and B in either order requests the same
  // design, so the order must not reach the identity. Duplicates are rejected
  // rather than collapsed, because asking for the same node twice is a caller
  // bug worth surfacing.
  const seenRoot = new Set<string>()
  for (const root of requested) {
    assertNodeIdOrFail(root)
    if (seenRoot.has(root)) throw new SnapshotError(`duplicate root requested: ${root}`, 'CONFIG_ERROR')
    seenRoot.add(root)
  }
  const roots = [...requested].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  const before = await client.getFileMeta(key)
  const acquiredAt = now()
  const response = await client.getNodes(key, roots, geometry === 'paths' ? { geometry: 'paths' } : {})
  const after = await client.getFileMeta(key)

  if (before.version !== after.version) {
    // Not "the design is unmappable" — we simply did not see one file.
    throw new SnapshotError(
      `file changed during acquisition (${before.version} -> ${after.version}); retry`,
      'INCOMPLETE_EXECUTION',
    )
  }

  const nodes = new Map<string, NodeDocument>()
  const styles = new Map<string, StyleEntry>()
  const missing: string[] = []

  for (const root of roots) {
    const entry = response.nodes[root]
    if (entry === undefined || entry === null) {
      missing.push(root)
      continue
    }
    if (entry.document.id !== root) {
      // A payload filed under the wrong key would silently attribute one node's
      // geometry to another.
      throw new SnapshotError(
        `response for ${root} contains node ${entry.document.id}`,
        'INCOMPLETE_EXECUTION',
      )
    }
    nodes.set(root, entry.document)
    for (const [styleId, style] of Object.entries(entry.styles ?? {})) {
      const existing = styles.get(styleId)
      if (existing !== undefined && canonicalStringify({ ...existing }) !== canonicalStringify({ ...style })) {
        // Two roots disagreeing about one style id means the responses do not
        // describe one coherent file. Taking the last one seen would repair it
        // quietly, which is exactly what this pipeline must not do.
        throw new SnapshotError(
          `style ${styleId} has conflicting definitions across roots`,
          'INCOMPLETE_EXECUTION',
        )
      }
      styles.set(styleId, style)
    }
  }

  if (missing.length > 0) {
    // A node we asked for and did not get is a hole in the input. Treating it
    // as "nothing matched" would report our own blind spot as a finding.
    throw new SnapshotError(
      `requested nodes are missing from the response: ${missing.join(', ')}`,
      'INCOMPLETE_EXECUTION',
    )
  }

  const parts = {
    nodes: partDigest('nodes', sortedEntries(nodes) as CanonicalValue, nodes.size, 'requested-roots'),
    styles: partDigest('styles', sortedEntries(styles), styles.size, 'referenced-by-requested-roots'),
  } as const

  // The id covers the payload digests as well as where it came from, so a
  // corrupted or mis-cached body cannot pass as the same snapshot.
  const snapshotId = hashCanonicalString(
    'canonical',
    SNAPSHOT_SCHEMA_VERSION,
    canonicalStringify({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      fileKey: key as string,
      roots: [...roots],
      geometry,
      sourceVersion: before.version,
      adapter: { ...ADAPTER },
      parts: {
        nodes: parts.nodes.digest as string,
        styles: parts.styles.digest as string,
      },
    }),
  )

  return {
    identity: {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      fileKey: key,
      roots: [...roots],
      geometry,
      sourceVersionAtStart: before.version,
      sourceVersionAtEnd: after.version,
      acquiredAt,
      snapshotId,
      adapter: { ...ADAPTER },
    },
    nodes,
    styles,
    parts,
  }
}

/** Reports a malformed node id as a snapshot-level configuration error. */
const assertNodeIdOrFail = (id: string): void => {
  try {
    assertNodeId(id)
  } catch (cause) {
    throw new SnapshotError(`malformed root node id: ${id}`, 'CONFIG_ERROR', cause)
  }
}

export type FreshnessVerdict =
  | { readonly kind: 'fresh' }
  | { readonly kind: 'stale'; readonly storedVersion: string; readonly currentVersion: string }

/**
 * Checks a stored snapshot against the file as it is now.
 *
 * Bracketing acquisition only proves the snapshot was internally consistent
 * when it was taken. Between then and the moment someone implements from it,
 * the design can move — so consumers ask this before they start, and the answer
 * is a version comparison rather than an age in minutes, because a file that
 * has not changed in a week is perfectly usable and one edited a second ago is
 * not.
 */
export const verifyFresh = async (
  client: FigmaClient,
  identity: SnapshotIdentity,
): Promise<FreshnessVerdict> => {
  const current = await client.getFileMeta(identity.fileKey)
  return current.version === identity.sourceVersionAtEnd
    ? { kind: 'fresh' }
    : { kind: 'stale', storedVersion: identity.sourceVersionAtEnd, currentVersion: current.version }
}
