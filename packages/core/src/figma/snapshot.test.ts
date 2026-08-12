import { describe, expect, it } from 'vitest'

import { design, frame, text } from '../testing/builders.js'
import { fileKey } from './client.js'
import { fixtureClient } from './fixtureClient.js'
import { acquireSnapshot, SnapshotError, verifyFresh } from './snapshot.js'

const KEY = fileKey('SYNTHETICFILEKEY0001')
const now = () => '2026-01-01T00:00:00.000Z'

/** Two roots with one shared style, the shape acquisition normally sees. */
const twoRoots = () =>
  design(
    [
      frame('1:1', 'page_a', { x: 0, y: 0, width: 375, height: 800 }, {
        children: [text('1:2', 'title', 'Hello', { styles: { text: '9:1' } })],
      }),
      frame('2:1', 'page_b', { x: 400, y: 0, width: 375, height: 800 }, {
        children: [text('2:2', 'title', 'World', { styles: { text: '9:1' } })],
      }),
    ],
    { '9:1': { name: 'main/title/sm/all' } },
  )

const ROOTS = ['1:1', '2:1']

describe('acquireSnapshot', () => {
  it('returns the requested roots and the styles they reference', async () => {
    const snapshot = await acquireSnapshot({ client: fixtureClient(twoRoots()), fileKey: KEY, roots: ROOTS, now })
    expect([...snapshot.nodes.keys()]).toEqual(ROOTS)
    expect(snapshot.parts.nodes.itemCount).toBe(2)
    expect([...snapshot.styles.values()].map((style) => style.name)).toContain('main/title/sm/all')
  })

  it('brackets the fetch with a version check, in order', async () => {
    const client = fixtureClient(twoRoots())
    await acquireSnapshot({ client, fileKey: KEY, roots: ROOTS, now })
    expect(client.calls).toEqual(['getFileMeta', `getNodes:${ROOTS.join(',')}`, 'getFileMeta'])
  })

  it('refuses a snapshot that spans two file versions (REG-ACQ-007)', async () => {
    // A designer saving mid-acquisition would otherwise leave one snapshot
    // holding a tree from before the edit and styles from after it.
    const client = fixtureClient(twoRoots(), { versionOnSecondRead: '1000000000000000002' })
    try {
      await acquireSnapshot({ client, fileKey: KEY, roots: ROOTS, now })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(SnapshotError)
      expect((error as SnapshotError).reason).toBe('INCOMPLETE_EXECUTION')
    }
  })

  it('treats a missing requested node as a hole, not as "nothing matched" (REG-ACQ-007)', async () => {
    const client = fixtureClient(twoRoots(), { dropNodeIds: ['2:1'] })
    try {
      await acquireSnapshot({ client, fileKey: KEY, roots: ROOTS, now })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as SnapshotError).reason).toBe('INCOMPLETE_EXECUTION')
    }
  })

  it('rejects an empty root list as a configuration error', async () => {
    try {
      await acquireSnapshot({ client: fixtureClient(twoRoots()), fileKey: KEY, roots: [], now })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as SnapshotError).reason).toBe('CONFIG_ERROR')
    }
  })
})

describe('roots are a set', () => {
  it('gives the same identity whatever order the roots are listed in', async () => {
    const forward = await acquireSnapshot({ client: fixtureClient(twoRoots()), fileKey: KEY, roots: ROOTS, now })
    const reverse = await acquireSnapshot({
      client: fixtureClient(twoRoots()),
      fileKey: KEY,
      roots: [...ROOTS].reverse(),
      now,
    })
    expect(reverse.identity.snapshotId).toBe(forward.identity.snapshotId)
    expect(reverse.identity.roots).toEqual(forward.identity.roots)
  })

  it('rejects a duplicated root rather than collapsing it', async () => {
    try {
      await acquireSnapshot({ client: fixtureClient(twoRoots()), fileKey: KEY, roots: ['1:1', '1:1'], now })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as SnapshotError).reason).toBe('CONFIG_ERROR')
    }
  })

  it('rejects a malformed node id', async () => {
    try {
      await acquireSnapshot({ client: fixtureClient(twoRoots()), fileKey: KEY, roots: ['not-an-id'], now })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as SnapshotError).reason).toBe('CONFIG_ERROR')
    }
  })
})

describe('snapshot identity', () => {
  it('is the same for the same design, and ignores acquisition time', async () => {
    const a = await acquireSnapshot({ client: fixtureClient(twoRoots()), fileKey: KEY, roots: ROOTS, now })
    const b = await acquireSnapshot({
      client: fixtureClient(twoRoots()),
      fileKey: KEY,
      roots: ROOTS,
      now: () => '2027-06-06T06:06:06.000Z',
    })
    // Fetching the same design twice must not look like a change.
    expect(b.identity.snapshotId).toBe(a.identity.snapshotId)
    expect(b.identity.acquiredAt).not.toBe(a.identity.acquiredAt)
  })

  it('records whether paths were asked for, and differs by it (REG-ACQ-015)', async () => {
    const plain = await acquireSnapshot({ client: fixtureClient(twoRoots()), fileKey: KEY, roots: ROOTS, now })
    const client = fixtureClient(twoRoots())
    const withPaths = await acquireSnapshot({ client, fileKey: KEY, roots: ROOTS, now, geometry: 'paths' })
    expect(plain.identity.geometry).toBe('none')
    expect(withPaths.identity.geometry).toBe('paths')
    // The same roots with and without paths are two acquisitions, and the
    // request that made the difference is visible in what the client was asked.
    expect(withPaths.identity.snapshotId).not.toBe(plain.identity.snapshotId)
    expect(client.calls).toContain(`getNodes:${ROOTS.join(',')}?geometry=paths`)
  })

  it('differs when the requested roots differ', async () => {
    const both = await acquireSnapshot({ client: fixtureClient(twoRoots()), fileKey: KEY, roots: ROOTS, now })
    const one = await acquireSnapshot({ client: fixtureClient(twoRoots()), fileKey: KEY, roots: ['1:1'], now })
    expect(one.identity.snapshotId).not.toBe(both.identity.snapshotId)
  })

  it('changes when the returned content changes', async () => {
    const tampered = twoRoots()
    const entry = tampered.nodes.nodes['1:1'] as unknown as { document: { name: string } }
    entry.document.name = 'tampered'
    const original = await acquireSnapshot({ client: fixtureClient(twoRoots()), fileKey: KEY, roots: ['1:1'], now })
    const modified = await acquireSnapshot({ client: fixtureClient(tampered), fileKey: KEY, roots: ['1:1'], now })
    // Identity that ignored the body would let a corrupted response pass as
    // the same snapshot.
    expect(modified.identity.snapshotId).not.toBe(original.identity.snapshotId)
  })

  it('gives each part its own digest and states its scope', async () => {
    const snapshot = await acquireSnapshot({ client: fixtureClient(twoRoots()), fileKey: KEY, roots: ROOTS, now })
    expect(snapshot.parts.nodes.digest).not.toBe(snapshot.parts.styles.digest)
    expect(snapshot.parts.nodes.scope).toBe('requested-roots')
    // Not "every style in the file" — REST has no way to tell us that.
    expect(snapshot.parts.styles.scope).toBe('referenced-by-requested-roots')
  })

  it('is stable across repeated acquisitions', async () => {
    const runs = new Set<string>()
    for (let index = 0; index < 5; index += 1) {
      const snapshot = await acquireSnapshot({ client: fixtureClient(twoRoots()), fileKey: KEY, roots: ROOTS, now })
      runs.add(`${snapshot.identity.snapshotId}|${snapshot.parts.nodes.digest}|${snapshot.parts.styles.digest}`)
    }
    expect(runs.size).toBe(1)
  })
})

describe('malformed responses are holes, not answers', () => {
  it('rejects a payload filed under the wrong node id', async () => {
    const swapped = twoRoots()
    ;(swapped.nodes.nodes['1:1'] as unknown as { document: { id: string } }).document.id = '9:9'
    try {
      await acquireSnapshot({ client: fixtureClient(swapped), fileKey: KEY, roots: ['1:1'], now })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as SnapshotError).reason).toBe('INCOMPLETE_EXECUTION')
    }
  })

  it('refuses to pick a winner when two roots disagree about a style (REG-ACQ-007)', async () => {
    const conflicting = twoRoots()
    const nodes = conflicting.nodes.nodes as Record<string, { styles?: Record<string, { name: string }> }>
    const second = nodes['2:1'] as { styles?: Record<string, { name: string; key: string; styleType: string; remote: boolean }> }
    const existing = second.styles?.['9:1']
    if (existing !== undefined) second.styles = { '9:1': { ...existing, name: 'different/name' } }
    try {
      await acquireSnapshot({ client: fixtureClient(conflicting), fileKey: KEY, roots: ROOTS, now })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as SnapshotError).reason).toBe('INCOMPLETE_EXECUTION')
    }
  })
})

describe('verifyFresh', () => {
  it('accepts a snapshot whose file has not moved', async () => {
    const snapshot = await acquireSnapshot({ client: fixtureClient(twoRoots()), fileKey: KEY, roots: ROOTS, now })
    expect(await verifyFresh(fixtureClient(twoRoots()), snapshot.identity)).toEqual({ kind: 'fresh' })
  })

  it('reports staleness by version, not by age', async () => {
    const snapshot = await acquireSnapshot({ client: fixtureClient(twoRoots()), fileKey: KEY, roots: ROOTS, now })
    const moved = fixtureClient(design([frame('1:1', 'page_a', { x: 0, y: 0, width: 375, height: 800 })], {}, '1000000000000000009'))
    expect(await verifyFresh(moved, snapshot.identity)).toEqual({
      kind: 'stale',
      storedVersion: '1000000000000000001',
      currentVersion: '1000000000000000009',
    })
  })
})
