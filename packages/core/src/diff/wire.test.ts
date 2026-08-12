import { describe, expect, it } from 'vitest'

import { design, frame, type RawNodeSpec } from '../testing/builders.js'
import { fileKey } from '../figma/client.js'
import { fixtureClient } from '../figma/fixtureClient.js'
import { acquireSnapshot } from '../figma/snapshot.js'
import { fromSnapshot } from '../canonical/adapter.js'
import { canonicalStringify, type CanonicalValue } from '../determinism/canonical.js'
import { hashCanonicalString, hashKindOf, isHash } from '../determinism/hash.js'
import { diffSnapshots } from './compare.js'
import { SNAPSHOT_DIFF_CATEGORIES, SNAPSHOT_DIFF_SCHEMA_VERSION } from './types.js'
import {
  decodeSnapshotDiffEnvelopeWire,
  decodeSnapshotDiffWire,
  snapshotDiffEnvelope,
  snapshotDiffToJson,
} from './wire.js'

const KEY = fileKey('SYNTHETICFILEKEY0001')
const now = () => '2026-01-01T00:00:00.000Z'

const docOf = async (root: RawNodeSpec, version: string) =>
  fromSnapshot(
    await acquireSnapshot({ client: fixtureClient(design([root], {}, version)), fileKey: KEY, roots: [root.id], now }),
  )

const page = (headerHeight: number): RawNodeSpec =>
  frame('1:1', 'page', { x: 0, y: 0, width: 400, height: 300 }, {
    children: [
      frame('1:2', 'header', { x: 0, y: 0, width: 400, height: headerHeight }),
      frame('1:3', 'body', { x: 0, y: headerHeight, width: 400, height: 100 }, {
        children: [frame('1:4', 'card', { x: 0, y: headerHeight + 10, width: 100, height: 50 })],
      }),
    ],
  })

const sample = async () =>
  diffSnapshots(await docOf(page(100), '1000000000000000001'), await docOf(page(110), '1000000000000000002'))

type Mutable = Record<string, unknown>
const clone = (value: unknown): Mutable => JSON.parse(JSON.stringify(value)) as Mutable

describe('the snapshot diff wire contract', () => {
  it('decodes what the serializer writes, with and without the hash', async () => {
    const diff = await sample()
    expect(() => decodeSnapshotDiffWire(clone(snapshotDiffToJson(diff)))).not.toThrow()
    expect(() => decodeSnapshotDiffEnvelopeWire(clone(snapshotDiffEnvelope(diff)))).not.toThrow()
  })

  it('refuses a payload with a field missing', async () => {
    const payload = clone(snapshotDiffEnvelope(await sample()))
    delete (payload['total'] as Mutable)['identical']
    expect(() => decodeSnapshotDiffEnvelopeWire(payload)).toThrow()
  })

  it('refuses a payload with a change that has lost its before value', async () => {
    // The value's shape is not checked by the schema, but its presence is.
    const payload = clone(snapshotDiffEnvelope(await sample()))
    const root = (payload['compared'] as Mutable[])[0] as Mutable
    const change = (((root['changed'] as Mutable[])[0] as Mutable)['changes'] as Mutable[])[0] as Mutable
    delete change['before']
    expect(() => decodeSnapshotDiffEnvelopeWire(payload)).toThrow()
  })

  it('refuses a payload with a key it does not know', async () => {
    const payload = clone(snapshotDiffEnvelope(await sample()))
    payload['note'] = 'extra'
    expect(() => decodeSnapshotDiffEnvelopeWire(payload)).toThrow()
  })

  it('refuses a payload from another schema version', async () => {
    const payload = clone(snapshotDiffEnvelope(await sample()))
    payload['schemaVersion'] = 2
    expect(() => decodeSnapshotDiffEnvelopeWire(payload)).toThrow()
  })

  it('refuses a category it does not declare', async () => {
    const payload = clone(snapshotDiffEnvelope(await sample()))
    const root = (payload['compared'] as Mutable[])[0] as Mutable
    ;((root['changed'] as Mutable[])[0] as Mutable)['categories'] = ['colour']
    expect(() => decodeSnapshotDiffEnvelopeWire(payload)).toThrow()
  })

  it('writes keys in a fixed order, the hash last, because the bytes are printed in insertion order', async () => {
    const envelope = snapshotDiffEnvelope(await sample()) as Mutable
    expect(Object.keys(envelope)).toEqual([
      'schemaVersion',
      'canonicalSchemaVersion',
      'before',
      'after',
      'roots',
      'total',
      'compared',
      'rejections',
      'diffHash',
    ])
    const root = (envelope['compared'] as Mutable[])[0] as Mutable
    expect(Object.keys(root)).toEqual([
      'rootId',
      'counts',
      'changed',
      'movedWithinParent',
      'movedWithParent',
      'movedRoot',
      'movementUnknown',
      'descendantsChanged',
      'added',
      'removed',
      'enteredScope',
      'leftScope',
      'unobserved',
      'arrived',
      'departed',
    ])
    expect(Object.keys((root['counts'] as Mutable)['byCategory'] as Mutable)).toEqual([...SNAPSHOT_DIFF_CATEGORIES])
    // A node reference leads every entry that has one.
    expect(Object.keys((root['changed'] as Mutable[])[0] as Mutable)).toEqual([
      'sourceId',
      'name',
      'type',
      'parentId',
      'nodePath',
      'categories',
      'changes',
      'movement',
    ])
  })

  it('leaves the clock out, so re-acquiring an unchanged design does not change the result', async () => {
    const before = await docOf(page(100), '1000000000000000001')
    const after = await docOf(page(110), '1000000000000000002')
    const later = { ...after, provenance: { ...after.provenance, acquiredAt: '2026-06-01T00:00:00.000Z' } }

    expect(JSON.stringify(snapshotDiffEnvelope(diffSnapshots(before, later)))).toBe(
      JSON.stringify(snapshotDiffEnvelope(diffSnapshots(before, after))),
    )
  })

  it('hashes exactly the payload it carries, and nothing else', async () => {
    const diff = await sample()
    const payload = snapshotDiffToJson(diff)
    const { diffHash, ...rest } = snapshotDiffEnvelope(diff) as Mutable

    // A kind the hash module declares: a diff hash is a hash like the others.
    expect(isHash(diff.diffHash)).toBe(true)
    expect(hashKindOf(diff.diffHash)).toBe('snapshot-diff')
    // The envelope is the payload plus the hash: no field in one and not the other.
    expect(rest).toEqual(payload)
    expect(diffHash).toBe(diff.diffHash)
    // Recomputed here rather than trusted: the hash is over the canonical
    // form of the payload, under its own kind and version.
    expect(hashCanonicalString('snapshot-diff', SNAPSHOT_DIFF_SCHEMA_VERSION, canonicalStringify(payload))).toBe(
      diff.diffHash,
    )
    const altered = clone(payload)
    ;(altered['total'] as Mutable)['identical'] = 99
    expect(
      hashCanonicalString('snapshot-diff', SNAPSHOT_DIFF_SCHEMA_VERSION, canonicalStringify(altered as CanonicalValue)),
    ).not.toBe(diff.diffHash)
  })
})
