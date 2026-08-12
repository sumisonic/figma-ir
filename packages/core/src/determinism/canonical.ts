/**
 * Canonical JSON serialization.
 *
 * Determinism is the property everything else rests on: if the same design can
 * serialize two different ways, hashes stop meaning anything and we get the
 * worst failure mode there is — a diff appears when nothing was changed.
 *
 * Key ordering follows RFC 8785 (JCS): UTF-16 code unit order. `localeCompare`
 * is deliberately NOT used because its result depends on the environment.
 */

/** A value that is legal inside canonical JSON. */
export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<CanonicalValue>
  | { readonly [key: string]: CanonicalValue | undefined }

declare const CanonicalJsonBrand: unique symbol

/**
 * Output of {@link canonicalStringify}, and the only thing that may be hashed
 * as canonical bytes. Branding it stops an arbitrary `JSON.stringify` result —
 * whose key order is insertion order — from being passed off as canonical.
 */
export type CanonicalJson = string & { readonly [CanonicalJsonBrand]: true }

/** Thrown when a value cannot be canonicalized. Carries the path to the offender. */
export class CanonicalizationError extends Error {
  readonly _tag = 'CanonicalizationError'
  readonly path: ReadonlyArray<string>

  constructor(message: string, path: ReadonlyArray<string>) {
    const where = path.length === 0 ? '<root>' : path.join('.')
    super(`${message} (at ${where})`)
    this.name = 'CanonicalizationError'
    this.path = path
  }
}

/** UTF-16 code unit comparison. Intentionally not locale-aware. */
export const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Describes why a value was rejected. Date / Map / Set / class instances are
 * rejected on purpose: converting them here would hide a decision that the
 * caller should be making explicitly.
 */
const rejectionReason = (value: unknown): string | undefined => {
  if (typeof value === 'function') return 'functions cannot be canonicalized'
  if (typeof value === 'symbol') return 'symbols cannot be canonicalized'
  if (typeof value === 'bigint') return 'bigint cannot be canonicalized; convert explicitly'
  if (value instanceof Date) return 'Date is not allowed; convert explicitly (e.g. to an ISO string)'
  if (value instanceof Map) return 'Map is not allowed; convert explicitly to a sorted object or array'
  if (value instanceof Set) return 'Set is not allowed; convert explicitly to a canonically sorted array'
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && !isPlainObject(value)) {
    return 'class instances are not allowed; convert explicitly to a plain object'
  }
  return undefined
}

const writeNumber = (value: number, path: ReadonlyArray<string>): string => {
  if (!Number.isFinite(value)) {
    throw new CanonicalizationError(`non-finite number ${String(value)}`, path)
  }
  // -0 and 0 are the same quantity but serialize/compare differently elsewhere.
  return JSON.stringify(Object.is(value, -0) ? 0 : value) as string
}

/**
 * Reads an object's own string-keyed data properties exactly once.
 *
 * Reading twice would be enough to break determinism on its own: a property
 * backed by a getter can answer differently each time it is asked, so the same
 * object could serialize to different bytes within a single run. Accessors are
 * therefore rejected outright rather than merely read carefully — and so are
 * symbol keys and non-enumerable properties, which would otherwise be dropped
 * in silence and take their data with them.
 */
const dataEntries = (value: object, path: ReadonlyArray<string>): Array<readonly [string, unknown]> => {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new CanonicalizationError('symbol-keyed properties cannot be canonicalized', path)
  }

  const entries: Array<readonly [string, unknown]> = []
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined) continue
    if (!('value' in descriptor)) {
      throw new CanonicalizationError('accessor properties cannot be canonicalized', [...path, key])
    }
    if (!descriptor.enumerable) {
      throw new CanonicalizationError(
        'non-enumerable property would be dropped silently; remove it before canonicalizing',
        [...path, key],
      )
    }
    if (descriptor.value === undefined) continue
    entries.push([key, descriptor.value] as const)
  }

  entries.sort((a, b) => compareCodeUnits(a[0], b[0]))
  return entries
}

const write = (value: unknown, path: ReadonlyArray<string>, seen: WeakSet<object>): string => {
  const reason = rejectionReason(value)
  if (reason !== undefined) throw new CanonicalizationError(reason, path)

  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return writeNumber(value, path)
  if (typeof value === 'string') return JSON.stringify(value)

  // A cycle would otherwise surface as a stack overflow with no indication of
  // where it is, which is a miserable thing to debug in a large node tree.
  if (seen.has(value as object)) {
    throw new CanonicalizationError('circular reference', path)
  }
  seen.add(value as object)

  try {
    if (Array.isArray(value)) {
      // Arrays keep their order: in a UI tree, order carries meaning. Anything
      // that is conceptually a set must be sorted by the caller before it gets
      // here, so the sort key is an explicit decision rather than an accident.
      const parts = value.map((item, index) => {
        if (item === undefined) {
          throw new CanonicalizationError(
            'undefined array element; JSON.stringify would silently turn it into null',
            [...path, String(index)],
          )
        }
        return write(item, [...path, String(index)], seen)
      })
      return `[${parts.join(',')}]`
    }

    if (isPlainObject(value)) {
      const parts = dataEntries(value, path).map(
        ([key, child]) => `${JSON.stringify(key)}:${write(child, [...path, key], seen)}`,
      )
      return `{${parts.join(',')}}`
    }

    throw new CanonicalizationError(`unsupported value of type ${typeof value}`, path)
  } finally {
    seen.delete(value as object)
  }
}

/**
 * Serializes a value to canonical JSON.
 *
 * - object keys sorted by UTF-16 code unit; every property read exactly once
 * - array order preserved
 * - `undefined` object values dropped; `undefined` array elements rejected
 * - `-0` normalized to `0`; non-finite numbers rejected
 * - accessors, symbol keys, non-enumerable properties, cycles rejected
 * - Date / Map / Set / class instances rejected
 */
export const canonicalStringify = (value: CanonicalValue): CanonicalJson =>
  write(value, [], new WeakSet()) as CanonicalJson

/** A path from the document root to a field, e.g. `['provenance', 'fetchedAt']`. */
export type VolatilePath = readonly [string, ...string[]]

const pathKey = (path: ReadonlyArray<string>): string => JSON.stringify(path)

const isPrefixOf = (shorter: ReadonlyArray<string>, longer: ReadonlyArray<string>): boolean =>
  shorter.length < longer.length && shorter.every((segment, index) => segment === longer[index])

/**
 * Removes volatile fields (timestamps and the like) before hashing.
 *
 * The exclusion list is a set, so the result must not depend on the order it
 * was written in. Overlapping paths are rejected rather than resolved, because
 * removing an ancestor and then a descendant of it can only be ambiguous —
 * one order succeeds and the other fails, which is precisely the kind of
 * order-dependence this module exists to eliminate.
 *
 * A missing path is an error rather than a no-op. If a field is renamed and the
 * exclusion list is not updated, we want a loud failure — the quiet version is
 * a volatile value silently entering the hash and making it useless.
 */
export const stripVolatile = (value: CanonicalValue, paths: ReadonlyArray<VolatilePath>): CanonicalValue => {
  const seen = new Set<string>()
  for (const path of paths) {
    const key = pathKey(path)
    if (seen.has(key)) {
      throw new CanonicalizationError(`duplicate volatile path ${path.join('.')}`, path)
    }
    seen.add(key)
  }
  for (const path of paths) {
    for (const other of paths) {
      if (isPrefixOf(path, other)) {
        throw new CanonicalizationError(
          `overlapping volatile paths: ${path.join('.')} contains ${other.join('.')}`,
          path,
        )
      }
    }
  }

  // Applied in a canonical order so the outcome cannot depend on input order.
  const ordered = [...paths].sort((a, b) => compareCodeUnits(pathKey(a), pathKey(b)))
  let result = value
  for (const path of ordered) {
    result = stripPath(result, path, [])
  }
  return result
}

const stripPath = (
  value: CanonicalValue,
  remaining: ReadonlyArray<string>,
  walked: ReadonlyArray<string>,
): CanonicalValue => {
  const [head, ...tail] = remaining
  if (head === undefined) return value
  if (!isPlainObject(value)) {
    throw new CanonicalizationError('volatile path does not exist: expected an object', walked)
  }
  if (!Object.prototype.hasOwnProperty.call(value, head)) {
    throw new CanonicalizationError(`volatile path does not exist: missing key "${head}"`, walked)
  }

  const entries = Object.entries(value).filter(([key]) => !(tail.length === 0 && key === head))
  const next = Object.fromEntries(
    entries.map(([key, child]) =>
      key === head ? [key, stripPath(child as CanonicalValue, tail, [...walked, head])] : [key, child],
    ),
  )
  return next as CanonicalValue
}
