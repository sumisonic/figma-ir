/**
 * Writing a snapshot to disk and reading it back.
 *
 * A `Map` becomes `{}` under `JSON.stringify`, so a snapshot serialized naively
 * comes back with no nodes and no styles while looking perfectly well-formed.
 * The stored shape uses arrays of pairs, and reading verifies the part digests
 * so a truncated or edited file is caught here rather than surfacing later as a
 * design that mysteriously has no tokens in it.
 */
import { canonicalStringify, type CanonicalValue } from '../determinism/canonical.js'
import { hashCanonicalString } from '../determinism/hash.js'
import type { StyleEntry } from './client.js'
import { SNAPSHOT_SCHEMA_VERSION, SnapshotError, type DesignSnapshot, type PartDigest } from './snapshot.js'

export interface StoredSnapshot {
  readonly schemaVersion: number
  readonly identity: unknown
  readonly nodes: ReadonlyArray<readonly [string, unknown]>
  readonly styles: ReadonlyArray<readonly [string, StyleEntry]>
  readonly parts: unknown
}

const sortedPairs = <A>(map: ReadonlyMap<string, A>): Array<readonly [string, A]> =>
  [...map.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((key) => [key, map.get(key) as A] as const)

const partToStored = (part: PartDigest): PartDigest => ({
  digest: part.digest,
  itemCount: part.itemCount,
  completeness: part.completeness,
  scope: part.scope,
})

/** Every field named: a domain object passed through would drop an undefined one in silence. */
export const snapshotToStored = (snapshot: DesignSnapshot): StoredSnapshot => ({
  schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  identity: {
    schemaVersion: snapshot.identity.schemaVersion,
    fileKey: snapshot.identity.fileKey,
    roots: [...snapshot.identity.roots],
    geometry: snapshot.identity.geometry,
    sourceVersionAtStart: snapshot.identity.sourceVersionAtStart,
    sourceVersionAtEnd: snapshot.identity.sourceVersionAtEnd,
    acquiredAt: snapshot.identity.acquiredAt,
    snapshotId: snapshot.identity.snapshotId,
    adapter: { name: snapshot.identity.adapter.name, version: snapshot.identity.adapter.version },
  },
  nodes: sortedPairs(snapshot.nodes),
  styles: sortedPairs(snapshot.styles),
  parts: { nodes: partToStored(snapshot.parts.nodes), styles: partToStored(snapshot.parts.styles) },
})

const partDigest = (kind: string, entries: CanonicalValue): string =>
  hashCanonicalString('canonical', SNAPSHOT_SCHEMA_VERSION, canonicalStringify({ kind, entries })) as string

const asObject = (pairs: ReadonlyArray<readonly [string, unknown]>): CanonicalValue =>
  Object.fromEntries(pairs) as CanonicalValue

/**
 * Reads a stored snapshot, checking it still hashes to what it claims.
 *
 * An edited or truncated file is an infrastructure problem, not a design that
 * happens to be empty.
 */
export const storedToSnapshot = (raw: unknown): DesignSnapshot => {
  const stored = raw as StoredSnapshot
  if (
    typeof stored !== 'object' ||
    stored === null ||
    !Array.isArray(stored.nodes) ||
    !Array.isArray(stored.styles) ||
    typeof stored.identity !== 'object' ||
    stored.identity === null
  ) {
    throw new SnapshotError('not a snapshot file: expected identity, nodes and styles', 'CONFIG_ERROR')
  }
  if (stored.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new SnapshotError(
      `snapshot schema version ${String(stored.schemaVersion)} cannot be read by version ${SNAPSHOT_SCHEMA_VERSION}`,
      'CONFIG_ERROR',
    )
  }

  const identity = stored.identity as DesignSnapshot['identity']
  const parts = stored.parts as DesignSnapshot['parts']
  if (identity.schemaVersion !== stored.schemaVersion) {
    // The identity is hashed under one version and the file claims another:
    // one of them was edited, and neither can be trusted to say which.
    throw new SnapshotError('snapshot identity and file disagree about the schema version', 'CONFIG_ERROR')
  }

  const nodeDigest = partDigest('nodes', asObject(stored.nodes))
  const styleDigest = partDigest('styles', asObject(stored.styles))
  if (nodeDigest !== (parts?.nodes?.digest as string) || styleDigest !== (parts?.styles?.digest as string)) {
    throw new SnapshotError('snapshot contents do not match their recorded digests', 'INCOMPLETE_EXECUTION')
  }

  // The bracket is the whole reason acquisition refuses a moving file; a stored
  // snapshot claiming two versions was never valid and must not become usable
  // by being written down.
  if (identity.geometry !== 'none' && identity.geometry !== 'paths') {
    throw new SnapshotError('snapshot identity does not say whether paths were acquired', 'CONFIG_ERROR')
  }
  if (identity.sourceVersionAtStart !== identity.sourceVersionAtEnd) {
    throw new SnapshotError(
      `snapshot spans two file versions (${identity.sourceVersionAtStart} -> ${identity.sourceVersionAtEnd})`,
      'INCOMPLETE_EXECUTION',
    )
  }

  // A snapshot whose roots are not the nodes it carries is describing something
  // other than what it holds.
  const nodeKeys = new Set(stored.nodes.map(([key]) => key))
  const roots = [...identity.roots]
  const missing = roots.filter((root) => !nodeKeys.has(root))
  if (missing.length > 0 || nodeKeys.size !== roots.length) {
    throw new SnapshotError(
      `snapshot roots do not match its nodes (missing: ${missing.join(', ') || 'none'})`,
      'INCOMPLETE_EXECUTION',
    )
  }

  // Recomputed rather than trusted: the id covers the payload digests, so this
  // catches a file whose digests were edited to match tampered content.
  const expectedId = hashCanonicalString(
    'canonical',
    SNAPSHOT_SCHEMA_VERSION,
    canonicalStringify({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      fileKey: identity.fileKey as string,
      roots,
      geometry: identity.geometry,
      sourceVersion: identity.sourceVersionAtStart,
      adapter: { ...identity.adapter },
      parts: { nodes: parts.nodes.digest as string, styles: parts.styles.digest as string },
    }),
  )
  if ((expectedId as string) !== (identity.snapshotId as string)) {
    throw new SnapshotError('snapshot id does not match its contents', 'INCOMPLETE_EXECUTION')
  }

  return {
    identity,
    nodes: new Map(stored.nodes),
    styles: new Map(stored.styles),
    parts,
  }
}
