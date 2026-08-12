import { describe, expect, it } from 'vitest'

import { CanonicalizationError, canonicalStringify, stripVolatile } from './canonical.js'

describe('canonicalStringify', () => {
  it('sorts object keys by UTF-16 code unit, not locale', () => {
    // Uppercase sorts before lowercase in code-unit order; a locale-aware
    // comparison would interleave them and vary by environment.
    expect(canonicalStringify({ b: 1, A: 2, a: 3, B: 4 })).toBe('{"A":2,"B":4,"a":3,"b":1}')
  })

  it('is insensitive to insertion order', () => {
    const one = canonicalStringify({ alpha: 1, beta: { x: 1, y: 2 } })
    const two = canonicalStringify({ beta: { y: 2, x: 1 }, alpha: 1 })
    expect(one).toBe(two)
  })

  it('preserves array order', () => {
    expect(canonicalStringify([3, 1, 2])).toBe('[3,1,2]')
    expect(canonicalStringify(['b', 'a'])).not.toBe(canonicalStringify(['a', 'b']))
  })

  it('drops undefined object values', () => {
    expect(canonicalStringify({ a: 1, b: undefined })).toBe('{"a":1}')
  })

  it('rejects undefined array elements instead of letting them become null', () => {
    expect(() => canonicalStringify([1, undefined as never, 3])).toThrow(CanonicalizationError)
  })

  it('normalizes -0 to 0', () => {
    expect(canonicalStringify(-0)).toBe('0')
    expect(canonicalStringify({ x: -0 })).toBe(canonicalStringify({ x: 0 }))
  })

  it('rejects NaN and Infinity', () => {
    expect(() => canonicalStringify(Number.NaN)).toThrow(CanonicalizationError)
    expect(() => canonicalStringify(Number.POSITIVE_INFINITY)).toThrow(CanonicalizationError)
  })

  it.each([
    ['Date', new Date(0)],
    ['Map', new Map()],
    ['Set', new Set()],
    ['class instance', new (class Foo {})()],
  ])('rejects %s so the caller converts explicitly', (_label, value) => {
    expect(() => canonicalStringify(value as never)).toThrow(CanonicalizationError)
  })

  it('reports the path to the offending value', () => {
    try {
      canonicalStringify({ a: { b: [{ c: Number.NaN }] } })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(CanonicalizationError)
      expect((error as CanonicalizationError).path).toEqual(['a', 'b', '0', 'c'])
    }
  })

  it('escapes strings so text can never break the framing', () => {
    expect(canonicalStringify({ t: 'a"b\\c\nd' })).toBe('{"t":"a\\"b\\\\c\\nd"}')
  })

  it('handles nested empty containers', () => {
    expect(canonicalStringify({ a: {}, b: [] })).toBe('{"a":{},"b":[]}')
  })
})

describe('stripVolatile', () => {
  const doc = {
    canonical: { nodes: [1, 2] },
    provenance: { fetchedAt: '2026-08-12T00:00:00Z', source: { kind: 'figma', version: 'v1' } },
  } as const

  it('removes a declared path', () => {
    const stripped = stripVolatile(doc, [['provenance', 'fetchedAt']])
    expect(canonicalStringify(stripped)).not.toContain('fetchedAt')
    expect(canonicalStringify(stripped)).toContain('"version":"v1"')
  })

  it('leaves everything else untouched', () => {
    const stripped = stripVolatile(doc, [['provenance', 'fetchedAt']])
    expect(canonicalStringify(stripped)).toBe(
      canonicalStringify({
        canonical: { nodes: [1, 2] },
        provenance: { source: { kind: 'figma', version: 'v1' } },
      }),
    )
  })

  it('throws when a declared path is missing, so a rename cannot silently disable it', () => {
    expect(() => stripVolatile(doc, [['provenance', 'renamedField']])).toThrow(CanonicalizationError)
  })

  it('does not mutate the input', () => {
    const before = canonicalStringify(doc)
    stripVolatile(doc, [['provenance', 'fetchedAt']])
    expect(canonicalStringify(doc)).toBe(before)
  })
})

describe('canonicalStringify — determinism as a property', () => {
  const permutations = <A>(items: ReadonlyArray<A>): Array<Array<A>> =>
    items.length <= 1
      ? [[...items]]
      : items.flatMap((item, index) =>
          permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
        )

  it('gives the same bytes for every key insertion order', () => {
    const keys = ['b', 'a', 'Z', 'ä', '1']
    const outputs = new Set(
      permutations(keys).map((order) =>
        canonicalStringify(Object.fromEntries(order.map((key, index) => [key, index % 3]))),
      ),
    )
    // Different insertion orders assign different values, so group by the
    // ordering of keys alone: build every permutation with the same mapping.
    const fixed: Record<string, number> = { b: 1, a: 2, Z: 3, 'ä': 4, '1': 5 }
    const same = new Set(
      permutations(keys).map((order) =>
        canonicalStringify(Object.fromEntries(order.map((key) => [key, fixed[key] as number]))),
      ),
    )
    expect(same.size).toBe(1)
    expect(outputs.size).toBeGreaterThan(0)
  })

  it('gives the same bytes on repeated runs', () => {
    const doc = { a: [1, { b: 'x' }], c: { d: null, e: true } }
    const runs = new Set(Array.from({ length: 20 }, () => canonicalStringify(doc)))
    expect(runs.size).toBe(1)
  })

  it('rejects a getter rather than reading it twice', () => {
    let reads = 0
    const withGetter = {
      get x() {
        reads += 1
        return reads
      },
    }
    expect(() => canonicalStringify(withGetter as never)).toThrow(CanonicalizationError)
  })

  it('rejects symbol keys and non-enumerable properties instead of dropping them', () => {
    expect(() => canonicalStringify({ [Symbol('s')]: 1 } as never)).toThrow(CanonicalizationError)
    const hidden = {}
    Object.defineProperty(hidden, 'secret', { value: 1, enumerable: false })
    expect(() => canonicalStringify(hidden as never)).toThrow(CanonicalizationError)
  })

  it('reports a cycle with a path instead of overflowing the stack', () => {
    const node: Record<string, unknown> = { name: 'root' }
    node.child = { parent: node }
    try {
      canonicalStringify(node as never)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(CanonicalizationError)
      expect((error as CanonicalizationError).path).toEqual(['child', 'parent'])
    }
  })
})

describe('stripVolatile — order independence', () => {
  const doc = {
    a: { t: 1, keep: 'a' },
    b: { t: 2, keep: 'b' },
    c: { keep: 'c' },
  } as const

  it('gives the same result whatever order the paths are listed in', () => {
    const forward = canonicalStringify(stripVolatile(doc, [['a', 't'], ['b', 't']]))
    const reverse = canonicalStringify(stripVolatile(doc, [['b', 't'], ['a', 't']]))
    expect(forward).toBe(reverse)
  })

  it('rejects a duplicated path', () => {
    expect(() => stripVolatile(doc, [['a', 't'], ['a', 't']])).toThrow(CanonicalizationError)
  })

  it('rejects overlapping paths rather than letting order decide the outcome', () => {
    expect(() => stripVolatile(doc, [['a'], ['a', 't']])).toThrow(CanonicalizationError)
    expect(() => stripVolatile(doc, [['a', 't'], ['a']])).toThrow(CanonicalizationError)
  })
})
