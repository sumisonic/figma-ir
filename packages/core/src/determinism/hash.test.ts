import { describe, expect, it } from 'vitest'

import {
  canonicalSortBy,
  canonicalSortUnique,
  HashError,
  hashCanonical,
  hashKindOf,
  isHash,
  isHashOfKind,
} from './hash.js'

describe('hashCanonical', () => {
  it('produces a namespaced, well-formed hash', () => {
    const hash = hashCanonical('canonical', 1, { a: 1 })
    expect(isHash(hash)).toBe(true)
    expect(hash.startsWith('canonical:v1:sha256:')).toBe(true)
    expect(hashKindOf(hash)).toBe('canonical')
  })

  it('is stable across key insertion order', () => {
    expect(hashCanonical('content', 1, { a: 1, b: 2 })).toBe(hashCanonical('content', 1, { b: 2, a: 1 }))
  })

  it('changes when the value changes', () => {
    expect(hashCanonical('content', 1, { a: 1 })).not.toBe(hashCanonical('content', 1, { a: 2 }))
  })

  it('keeps kinds apart so "same pipeline" and "same result" cannot be confused', () => {
    const digest = (hash: string) => hash.slice(hash.lastIndexOf(':') + 1)
    const canonical = hashCanonical('canonical', 1, { a: 1 })
    const content = hashCanonical('content', 1, { a: 1 })
    expect(canonical).not.toBe(content)
    // Same bytes hashed, but the labels prevent them from being compared as equals.
    expect(digest(canonical)).toBe(digest(content))
  })

  it('namespaces by version so a later field addition cannot collide with an old hash', () => {
    expect(hashCanonical('canonical', 1, { a: 1 })).not.toBe(hashCanonical('canonical', 2, { a: 1 }))
  })

  it('rejects an invalid version', () => {
    expect(() => hashCanonical('canonical', 0, {})).toThrow(HashError)
    expect(() => hashCanonical('canonical', 1.5, {})).toThrow(HashError)
  })

  it('treats -0 and 0 as the same input', () => {
    expect(hashCanonical('content', 1, { x: -0 })).toBe(hashCanonical('content', 1, { x: 0 }))
  })
})

describe('canonicalSortBy', () => {
  it('sorts by key so set-like data hashes consistently', () => {
    const items = [{ id: 'b' }, { id: 'a' }, { id: 'c' }]
    expect(canonicalSortBy(items, (item) => item.id).map((item) => item.id)).toEqual(['a', 'b', 'c'])
  })

  it('refuses to guess when two items share a key', () => {
    // Tie-breaking by input position would quietly reintroduce order
    // dependence, so a collision is reported as the caller's bug instead.
    const items = [
      { id: 'a', n: 1 },
      { id: 'a', n: 2 },
    ]
    expect(() => canonicalSortBy(items, (item) => item.id)).toThrow(HashError)
  })

  it('does not mutate the input', () => {
    const items = [{ id: 'b' }, { id: 'a' }]
    canonicalSortBy(items, (item) => item.id)
    expect(items.map((item) => item.id)).toEqual(['b', 'a'])
  })
})

describe('canonicalSortBy / canonicalSortUnique — set semantics', () => {
  it('rejects a colliding key rather than tie-breaking by input order', () => {
    const items = [
      { k: 'x', v: 1 },
      { k: 'x', v: 2 },
    ]
    expect(() => canonicalSortBy(items, (item) => item.k)).toThrow(HashError)
  })

  it('is order-independent for every input permutation', () => {
    const items = [{ id: 'c' }, { id: 'a' }, { id: 'b' }]
    const orders = [
      [0, 1, 2],
      [2, 1, 0],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [0, 2, 1],
    ]
    const results = new Set(
      orders.map((order) =>
        hashCanonical('content', 1, canonicalSortBy(order.map((i) => items[i] as { id: string }), (x) => x.id) as never),
      ),
    )
    expect(results.size).toBe(1)
  })

  it('collapses exact duplicates so adding one twice does not change the hash', () => {
    const once = canonicalSortUnique([{ id: 'a' }, { id: 'b' }], (x) => x.id)
    const twice = canonicalSortUnique([{ id: 'b' }, { id: 'a' }, { id: 'a' }], (x) => x.id)
    expect(hashCanonical('content', 1, once as never)).toBe(hashCanonical('content', 1, twice as never))
  })

  it('rejects a key that maps to two different values', () => {
    expect(() => canonicalSortUnique([{ id: 'a', n: 1 }, { id: 'a', n: 2 }], (x) => x.id)).toThrow(HashError)
  })
})

describe('isHash — kind must be declared', () => {
  it('rejects an undeclared kind', () => {
    expect(isHash(`evil:v1:sha256:${'a'.repeat(64)}`)).toBe(false)
    expect(isHash(`canonical:v1:sha256:${'a'.repeat(64)}`)).toBe(true)
  })

  it('checks a specific kind', () => {
    const hash = hashCanonical('subtree', 1, { a: 1 })
    expect(isHashOfKind(hash, 'subtree')).toBe(true)
    expect(isHashOfKind(hash, 'canonical')).toBe(false)
  })

  it('throws for a malformed hash instead of inventing a kind', () => {
    expect(() => hashKindOf('nope' as never)).toThrow(HashError)
  })
})
