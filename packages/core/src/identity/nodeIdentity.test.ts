import { describe, expect, it } from 'vitest'

import {
  contentHash,
  describeSourceAddress,
  NodeIdentityError,
  nodePath,
  sourceId,
  stableKey,
  subtreeHash,
  validateCorrespondence,
  type CorrespondenceArtifactV1,
} from './nodeIdentity.js'
import { hashCanonical } from '../determinism/hash.js'

describe('sourceId', () => {
  it('keeps an instance-child id whole', () => {
    const id = sourceId('I10:20;30:40')
    expect(id as string).toBe('I10:20;30:40')
  })

  it('rejects an empty id', () => {
    expect(() => sourceId('')).toThrow(NodeIdentityError)
  })
})

describe('describeSourceAddress', () => {
  it('decomposes an instance child for candidate generation only', () => {
    const address = describeSourceAddress(sourceId('I10:20;30:40'), '7:1')
    expect(address.rawSourceId as string).toBe('I10:20;30:40')
    expect(address.occurrenceInstanceId).toBe('10:20')
    expect(address.definitionLocalNodeId).toBe('30:40')
    expect(address.componentId).toBe('7:1')
  })

  it('leaves a plain id undecomposed', () => {
    const address = describeSourceAddress(sourceId('5:60'))
    expect(address.occurrenceInstanceId).toBeUndefined()
    expect(address.definitionLocalNodeId).toBeUndefined()
  })
})

describe('stableKey', () => {
  const base = { nameChain: ['page', 'footer', 'logo'], typeChain: ['FRAME', 'INSTANCE', 'VECTOR'], indexAmongSameName: 0 }

  it('is stable for identical input', () => {
    expect(stableKey(base)).toBe(stableKey({ ...base }))
  })

  it('breaks on rename alone — which is why it is only a hint', () => {
    expect(stableKey({ ...base, nameChain: ['page', 'footer', 'logo_mark'] })).not.toBe(stableKey(base))
  })

  it('breaks on structural change alone', () => {
    expect(stableKey({ ...base, typeChain: ['FRAME', 'FRAME', 'VECTOR'] })).not.toBe(stableKey(base))
  })

  it('distinguishes same-named siblings', () => {
    expect(stableKey({ ...base, indexAmongSameName: 1 })).not.toBe(stableKey(base))
  })

  it('rejects mismatched or empty chains', () => {
    expect(() => stableKey({ ...base, typeChain: ['FRAME'] })).toThrow(NodeIdentityError)
    expect(() => stableKey({ nameChain: [], typeChain: [], indexAmongSameName: 0 })).toThrow(NodeIdentityError)
    expect(() => stableKey({ ...base, indexAmongSameName: -1 })).toThrow(NodeIdentityError)
  })
})

describe('contentHash / subtreeHash', () => {
  it('separates own fields from the subtree', () => {
    const own = contentHash({ type: 'FRAME', layoutMode: 'VERTICAL' })
    const leaf = subtreeHash(own, [])
    expect(own).not.toBe(leaf)
  })

  it('changes when a child changes', () => {
    const own = contentHash({ type: 'FRAME' })
    const childA = subtreeHash(contentHash({ type: 'TEXT', characters: 'a' }), [])
    const childB = subtreeHash(contentHash({ type: 'TEXT', characters: 'b' }), [])
    expect(subtreeHash(own, [childA])).not.toBe(subtreeHash(own, [childB]))
  })

  it('treats child order as meaningful', () => {
    const own = contentHash({ type: 'FRAME' })
    const first = subtreeHash(contentHash({ n: 1 }), [])
    const second = subtreeHash(contentHash({ n: 2 }), [])
    expect(subtreeHash(own, [first, second])).not.toBe(subtreeHash(own, [second, first]))
  })

  it('is equal for identical branches, so a diff gate can skip them', () => {
    const build = () => subtreeHash(contentHash({ type: 'FRAME' }), [subtreeHash(contentHash({ n: 1 }), [])])
    expect(build()).toBe(build())
  })
})

describe('nodePath', () => {
  it('formats an index path', () => {
    expect(nodePath([0, 2, 1]) as string).toBe('0/2/1')
    expect(nodePath([]) as string).toBe('')
  })

  it('rejects invalid segments', () => {
    expect(() => nodePath([0, -1])).toThrow(NodeIdentityError)
    expect(() => nodePath([1.5])).toThrow(NodeIdentityError)
  })
})

describe('validateCorrespondence', () => {
  const artifact = (over: Partial<CorrespondenceArtifactV1> = {}): CorrespondenceArtifactV1 => ({
    schemaVersion: 1,
    from: { snapshotId: 's1', canonicalHash: hashCanonical('canonical', 1, { v: 1 }) },
    to: { snapshotId: 's2', canonicalHash: hashCanonical('canonical', 1, { v: 2 }) },
    scope: [sourceId('1:1'), sourceId('1:2')],
    mappings: [{ fromSourceId: sourceId('1:1'), toSourceId: sourceId('1:1'), method: 'same-source-id', evidence: [] }],
    unresolved: [{ fromSourceId: sourceId('1:2'), status: 'unmatched', candidateSourceIds: [] }],
    completeness: 'complete-for-scope',
    ...over,
  })

  it('accepts a complete artifact', () => {
    expect(validateCorrespondence(artifact())).toEqual([])
  })

  it('rejects a node in scope that is neither mapped nor unresolved', () => {
    expect(validateCorrespondence(artifact({ unresolved: [] }))).toContain(
      'node in scope is neither mapped nor unresolved: 1:2',
    )
  })

  it('rejects non one-to-one mappings', () => {
    const problems = validateCorrespondence(
      artifact({
        mappings: [
          { fromSourceId: sourceId('1:1'), toSourceId: sourceId('2:1'), method: 'same-source-id', evidence: [] },
          { fromSourceId: sourceId('1:1'), toSourceId: sourceId('2:2'), method: 'same-source-id', evidence: [] },
        ],
      }),
    )
    expect(problems.some((problem) => problem.includes('duplicate fromSourceId'))).toBe(true)
  })
})

describe('validateCorrespondence — scope is a partition', () => {
  const base = (over: Partial<CorrespondenceArtifactV1> = {}): CorrespondenceArtifactV1 => ({
    schemaVersion: 1,
    from: { snapshotId: 's1', canonicalHash: hashCanonical('canonical', 1, { v: 1 }) },
    to: { snapshotId: 's2', canonicalHash: hashCanonical('canonical', 1, { v: 2 }) },
    scope: [sourceId('1:1')],
    mappings: [{ fromSourceId: sourceId('1:1'), toSourceId: sourceId('1:1'), method: 'same-source-id', evidence: [] }],
    unresolved: [],
    completeness: 'complete-for-scope',
    ...over,
  })

  it('rejects a node that is both mapped and unresolved', () => {
    const problems = validateCorrespondence(
      base({ unresolved: [{ fromSourceId: sourceId('1:1'), status: 'unmatched', candidateSourceIds: [] }] }),
    )
    expect(problems).toContain('node is both mapped and unresolved: 1:1')
  })

  it('rejects a mapping outside scope', () => {
    const problems = validateCorrespondence(
      base({
        scope: [sourceId('1:1'), sourceId('9:9')],
        unresolved: [{ fromSourceId: sourceId('9:9'), status: 'unmatched', candidateSourceIds: [] }],
        mappings: [
          { fromSourceId: sourceId('1:1'), toSourceId: sourceId('1:1'), method: 'same-source-id', evidence: [] },
          { fromSourceId: sourceId('7:7'), toSourceId: sourceId('7:7'), method: 'same-source-id', evidence: [] },
        ],
      }),
    )
    expect(problems).toContain('mapping outside scope: 7:7')
  })

  it('rejects same-source-id used for two different ids', () => {
    const problems = validateCorrespondence(
      base({
        mappings: [
          { fromSourceId: sourceId('1:1'), toSourceId: sourceId('2:2'), method: 'same-source-id', evidence: [] },
        ],
      }),
    )
    expect(problems.some((problem) => problem.includes('requires identical ids'))).toBe(true)
  })

  it('rejects an ambiguous entry with fewer than two candidates', () => {
    const problems = validateCorrespondence(
      base({
        scope: [sourceId('1:1'), sourceId('3:3')],
        unresolved: [{ fromSourceId: sourceId('3:3'), status: 'ambiguous', candidateSourceIds: [sourceId('4:4')] }],
      }),
    )
    expect(problems.some((problem) => problem.includes('needs at least two candidates'))).toBe(true)
  })

  it('rejects an unmatched entry that carries candidates', () => {
    const problems = validateCorrespondence(
      base({
        scope: [sourceId('1:1'), sourceId('3:3')],
        unresolved: [{ fromSourceId: sourceId('3:3'), status: 'unmatched', candidateSourceIds: [sourceId('4:4')] }],
      }),
    )
    expect(problems.some((problem) => problem.includes('must have no candidates'))).toBe(true)
  })
})

describe('validateCorrespondence — instance children need a confirmed enclosing instance', () => {
  const artifact = (mappings: CorrespondenceArtifactV1['mappings'], scope: ReadonlyArray<string>) => ({
    schemaVersion: 1 as const,
    from: { snapshotId: 's1', canonicalHash: hashCanonical('canonical', 1, { v: 1 }) },
    to: { snapshotId: 's2', canonicalHash: hashCanonical('canonical', 1, { v: 2 }) },
    scope: scope.map(sourceId),
    mappings,
    unresolved: [],
    completeness: 'complete-for-scope' as const,
  })

  it('accepts a child when its enclosing instance is confirmed', () => {
    const problems = validateCorrespondence(
      artifact(
        [
          { fromSourceId: sourceId('4:1'), toSourceId: sourceId('9:1'), method: 'explicit', evidence: [] },
          {
            fromSourceId: sourceId('I4:1;7:7'),
            toSourceId: sourceId('I9:1;7:7'),
            method: 'instance-occurrence-and-definition-node',
            evidence: ['same definition-local node'],
          },
        ],
        ['4:1', 'I4:1;7:7'],
      ),
    )
    expect(problems).toEqual([])
  })

  it('rejects a child whose enclosing instance is not confirmed', () => {
    // A component with several instances would otherwise let the child follow
    // the wrong occurrence while looking perfectly well-supported.
    const problems = validateCorrespondence(
      artifact(
        [
          {
            fromSourceId: sourceId('I4:1;7:7'),
            toSourceId: sourceId('I9:1;7:7'),
            method: 'instance-occurrence-and-definition-node',
            evidence: [],
          },
        ],
        ['I4:1;7:7'],
      ),
    )
    expect(problems.some((problem) => problem.includes('requires a confirmed mapping for the enclosing instance'))).toBe(
      true,
    )
  })

  it('rejects a child matched to a different definition-local node', () => {
    const problems = validateCorrespondence(
      artifact(
        [
          { fromSourceId: sourceId('4:1'), toSourceId: sourceId('9:1'), method: 'explicit', evidence: [] },
          {
            fromSourceId: sourceId('I4:1;7:7'),
            toSourceId: sourceId('I9:1;8:8'),
            method: 'instance-occurrence-and-definition-node',
            evidence: [],
          },
        ],
        ['4:1', 'I4:1;7:7'],
      ),
    )
    expect(problems.some((problem) => problem.includes('same definition-local node'))).toBe(true)
  })
})
