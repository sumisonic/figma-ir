/**
 * Hashing over canonical JSON.
 *
 * Hash kinds are kept apart on purpose. Mixing them makes "is this the same
 * pipeline?" and "is this the same result?" indistinguishable, and that
 * distinction is the whole point of having hashes here. The kind is part of the
 * type as well as the string, so a canonical hash cannot be passed where a
 * content hash is expected.
 */
import { createHash } from 'node:crypto'

import { canonicalStringify, compareCodeUnits, type CanonicalJson, type CanonicalValue } from './canonical.js'

/** Every hash kind used across the system. Adding one is a deliberate act. */
export const HASH_KINDS = [
  /** Identity of the input design (Design snapshot only). */
  'canonical',
  /** Identity of a node's own normalized fields, children excluded. */
  'content',
  /** Identity of a node including its children. */
  'subtree',
  /** Candidate-matching fingerprint. Never an authoritative key. */
  'stable-key',
  /** Identity of the whole-file style catalog, used for hygiene checks. */
  'governance-catalog',
  /** canonicalHash + web projection version. */
  'projection',
  /** projectionHash + target profile digest. */
  'target',
  /** Identity of an exported slice. */
  'slice',
  /** Identity of a node's vector paths, for exact-match reuse decisions. */
  'geometry',
] as const

export type HashKind = (typeof HASH_KINDS)[number]

declare const HashKindBrand: unique symbol

/**
 * `<kind>:v<version>:sha256:<hex>`.
 *
 * The kind is a phantom type parameter, so mixing two kinds is a compile error
 * rather than a subtle equality that always answers "different".
 */
export type Hash<K extends HashKind = HashKind> = string & { readonly [HashKindBrand]: K }

const HASH_PATTERN = /^([a-z-]+):v(\d+):sha256:([0-9a-f]{64})$/

const HASH_KIND_SET: ReadonlySet<string> = new Set(HASH_KINDS)

export class HashError extends Error {
  readonly _tag = 'HashError'
  constructor(message: string) {
    super(message)
    this.name = 'HashError'
  }
}

const assertVersion = (version: number): void => {
  if (!Number.isInteger(version) || version < 1) {
    throw new HashError(`hash version must be a positive integer, got ${String(version)}`)
  }
}

const digestOf = (serialized: string): string => createHash('sha256').update(serialized, 'utf8').digest('hex')

/**
 * Hashes a value as `<kind>:v<version>:sha256:<hex>`.
 *
 * The version lives inside the string so that adding fields later cannot make
 * an old hash and a new hash accidentally comparable.
 */
export const hashCanonical = <K extends HashKind>(kind: K, version: number, value: CanonicalValue): Hash<K> => {
  assertVersion(version)
  return `${kind}:v${version}:sha256:${digestOf(canonicalStringify(value))}` as Hash<K>
}

/**
 * Hashes an already-canonicalized string.
 *
 * Only accepts {@link CanonicalJson}, so a plain `JSON.stringify` result — with
 * its insertion-order keys — cannot be laundered into a canonical hash.
 */
export const hashCanonicalString = <K extends HashKind>(
  kind: K,
  version: number,
  serialized: CanonicalJson,
): Hash<K> => {
  assertVersion(version)
  return `${kind}:v${version}:sha256:${digestOf(serialized)}` as Hash<K>
}

/** True only for a well-formed hash whose kind is one we actually declare. */
export const isHash = (value: string): value is Hash => {
  const match = HASH_PATTERN.exec(value)
  return match !== null && HASH_KIND_SET.has(match[1] as string)
}

export const isHashOfKind = <K extends HashKind>(value: string, kind: K): value is Hash<K> => {
  const match = HASH_PATTERN.exec(value)
  return match !== null && match[1] === kind
}

export const hashKindOf = (hash: Hash): HashKind => {
  const match = HASH_PATTERN.exec(hash)
  if (match === null || !HASH_KIND_SET.has(match[1] as string)) {
    throw new HashError(`not a valid hash: ${hash}`)
  }
  return match[1] as HashKind
}

/**
 * Sorts values that are conceptually a set, so that "order is not part of the
 * identity" is expressed by an explicit sort rather than by hoping the input
 * arrived in a stable order.
 *
 * Duplicate keys are rejected rather than tie-broken. Falling back to the
 * original index would make the output depend on input order again — exactly
 * the property the sort was supposed to remove — so a collision means the key
 * is not identifying, and that is the caller's bug to fix.
 */
export const canonicalSortBy = <A>(items: ReadonlyArray<A>, key: (item: A) => string): ReadonlyArray<A> => {
  const keyed = items.map((item) => ({ item, key: key(item) }))
  const seen = new Set<string>()
  for (const entry of keyed) {
    if (seen.has(entry.key)) {
      throw new HashError(`canonicalSortBy requires unique keys; "${entry.key}" appeared more than once`)
    }
    seen.add(entry.key)
  }
  keyed.sort((a, b) => compareCodeUnits(a.key, b.key))
  return keyed.map((entry) => entry.item)
}

/**
 * Sorts a set-like collection after collapsing exact duplicates.
 *
 * Use when repeated entries are meaningless — adding the same candidate twice
 * must not change the hash.
 */
export const canonicalSortUnique = <A>(items: ReadonlyArray<A>, key: (item: A) => string): ReadonlyArray<A> => {
  const byKey = new Map<string, A>()
  for (const item of items) {
    const k = key(item)
    const existing = byKey.get(k)
    if (existing !== undefined) {
      const a = canonicalStringify(existing as never)
      const b = canonicalStringify(item as never)
      if (a !== b) {
        throw new HashError(`key "${k}" maps to two different values; the key is not identifying`)
      }
      continue
    }
    byKey.set(k, item)
  }
  return [...byKey.keys()].sort(compareCodeUnits).map((k) => byKey.get(k) as A)
}
