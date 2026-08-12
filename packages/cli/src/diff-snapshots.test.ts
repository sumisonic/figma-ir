import {
  acquireSnapshot,
  canonicalStringify,
  decodeSnapshotDiffEnvelopeWire,
  fileKey,
  fixtureClient,
  hashCanonicalString,
  SNAPSHOT_SCHEMA_VERSION,
  snapshotToStored,
} from '@figma-ir/core'
import { design, frame, type RawNodeSpec } from '@figma-ir/core/testing'

import { describe, expect, it } from 'vitest'

import { COMMANDS, main, type CliIO } from './index.js'

const now = () => '2026-01-01T00:00:00.000Z'
const BEFORE_VERSION = '1000000000000000001'
const AFTER_VERSION = '1000000000000000002'

interface SnapshotOptions {
  readonly version?: string
  readonly key?: string
  readonly geometry?: 'paths'
}

const snapshotJson = async (roots: ReadonlyArray<RawNodeSpec>, options: SnapshotOptions = {}): Promise<string> =>
  JSON.stringify(
    snapshotToStored(
      await acquireSnapshot({
        client: fixtureClient(design(roots, {}, options.version ?? BEFORE_VERSION)),
        fileKey: fileKey(options.key ?? 'SYNTHETICFILEKEY0001'),
        roots: roots.map((root) => root.id),
        now,
        ...(options.geometry === undefined ? {} : { geometry: options.geometry }),
      }),
    ),
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

const io = (files: Record<string, string>) => {
  const out: string[] = []
  const err: string[] = []
  const impl: CliIO = {
    readFile: (path) => {
      const file = files[path]
      if (file === undefined) throw new Error(`no such file: ${path}`)
      return file
    },
    exists: (path) => files[path] !== undefined,
    writeFile: () => {
      throw new Error('diff-snapshots writes no file')
    },
    write: (text) => {
      out.push(text)
    },
    writeError: (text) => {
      err.push(text)
    },
    env: () => undefined,
  }
  return { impl, out, err }
}

const COMMAND = ['diff-snapshots', '--before', 'before.json', '--after', 'after.json']

describe('diff-snapshots', () => {
  it('prints what changed, and exits 0 though something did', async () => {
    // A change is the answer, not a failure: a script that treated a
    // non-zero exit as "broken" would stop on every real revision.
    const { impl, out, err } = io({
      'before.json': await snapshotJson([page(100)]),
      'after.json': await snapshotJson([page(110)], { version: AFTER_VERSION }),
    })

    expect(await main(COMMAND, impl)).toBe(0)
    expect(err).toEqual([])
    const wire = decodeSnapshotDiffEnvelopeWire(JSON.parse(out.join('\n')))
    const [root] = wire.compared
    expect(root?.changed.map((node) => node.sourceId)).toEqual(['1:2'])
    expect(root?.movedWithinParent.map((node) => node.sourceId)).toEqual(['1:3'])
    expect(root?.movedWithParent).toEqual([{ parentId: '1:3', sourceIds: ['1:4'] }])
    expect(wire.diffHash).toMatch(/^snapshot-diff:v1:sha256:[0-9a-f]{64}$/)
  })

  it('exits 0 with nothing listed when the two snapshots hold the same design', async () => {
    const { impl, out } = io({
      'before.json': await snapshotJson([page(100)]),
      'after.json': await snapshotJson([page(100)], { version: AFTER_VERSION }),
    })

    expect(await main(COMMAND, impl)).toBe(0)
    const wire = decodeSnapshotDiffEnvelopeWire(JSON.parse(out.join('\n')))
    expect(wire.total.identical).toBe(4)
    expect(wire.total.changed).toBe(0)
  })

  it('prints the same bytes for the same two files', async () => {
    const files = {
      'before.json': await snapshotJson([page(100)]),
      'after.json': await snapshotJson([page(110)], { version: AFTER_VERSION }),
    }
    const first = io(files)
    const second = io(files)
    await main(COMMAND, first.impl)
    await main(COMMAND, second.impl)

    expect(second.out).toEqual(first.out)
  })

  it('refuses snapshots of two different files, naming the kind of refusal first', async () => {
    const { impl, out, err } = io({
      'before.json': await snapshotJson([page(100)]),
      'after.json': await snapshotJson([page(100)], { key: 'SYNTHETICFILEKEY0002' }),
    })

    expect(await main(COMMAND, impl)).toBe(2)
    expect(out).toEqual([])
    // Name, then kind: a caller branches on these without reading the sentence.
    expect(err[0]?.startsWith('SnapshotDiffError: file-mismatch: ')).toBe(true)
  })

  it('refuses a pair where only one side was acquired with vector paths, and says what to do', async () => {
    const { impl, err } = io({
      'before.json': await snapshotJson([page(100)]),
      'after.json': await snapshotJson([page(100)], { geometry: 'paths' }),
    })

    expect(await main(COMMAND, impl)).toBe(2)
    expect(err[0]?.startsWith('SnapshotDiffError: geometry-mode-mismatch: ')).toBe(true)
    expect(err[0]).toContain('re-acquire the newer one with the same mode as the older one')
  })

  it('refuses a pair acquired by different adapters', async () => {
    // A snapshot as a build with another adapter would have written it: the
    // identity names that adapter, and the id is recomputed to agree, since
    // a file whose id does not match its contents is refused before any
    // comparison is attempted.
    const snapshot = await acquireSnapshot({
      client: fixtureClient(design([page(100)], {}, AFTER_VERSION)),
      fileKey: fileKey('SYNTHETICFILEKEY0001'),
      roots: ['1:1'],
      now,
    })
    const adapter = { name: snapshot.identity.adapter.name, version: 'next' }
    const snapshotId = hashCanonicalString(
      'canonical',
      SNAPSHOT_SCHEMA_VERSION,
      canonicalStringify({
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        fileKey: snapshot.identity.fileKey as string,
        roots: [...snapshot.identity.roots],
        geometry: snapshot.identity.geometry,
        sourceVersion: snapshot.identity.sourceVersionAtStart,
        adapter,
        parts: { nodes: snapshot.parts.nodes.digest as string, styles: snapshot.parts.styles.digest as string },
      }),
    )
    const { impl, out, err } = io({
      'before.json': await snapshotJson([page(100)]),
      'after.json': JSON.stringify(snapshotToStored({ ...snapshot, identity: { ...snapshot.identity, adapter, snapshotId } })),
    })

    expect(await main(COMMAND, impl)).toBe(2)
    expect(out).toEqual([])
    expect(err[0]?.startsWith('SnapshotDiffError: adapter-mismatch: ')).toBe(true)
  })

  it('refuses a snapshot acquired with one root inside another', async () => {
    const inner = frame('1:2', 'header', { x: 0, y: 0, width: 400, height: 100 })
    const outer = frame('1:1', 'page', { x: 0, y: 0, width: 400, height: 300 }, { children: [inner] })
    const { impl, err } = io({
      'before.json': await snapshotJson([outer]),
      'after.json': await snapshotJson([outer, inner], { version: AFTER_VERSION }),
    })

    expect(await main(COMMAND, impl)).toBe(2)
    expect(err[0]?.startsWith('SnapshotDiffError: duplicate-source-id: the after snapshot contains node 1:2')).toBe(true)
    expect(err[0]).toContain('acquire without nested roots')
  })

  it('refuses a file that is not a snapshot before comparing anything', async () => {
    const { impl, err } = io({ 'before.json': '{}', 'after.json': await snapshotJson([page(100)]) })

    expect(await main(COMMAND, impl)).toBe(2)
    expect(err[0]).toContain('not a snapshot file')
  })

  it('needs both files', async () => {
    const { impl, err } = io({ 'before.json': await snapshotJson([page(100)]) })

    expect(await main(['diff-snapshots', '--before', 'before.json'], impl)).toBe(2)
    expect(err[0]).toBe('--after is required')
  })

  it('takes the two files and nothing else (REG-CLI-011)', async () => {
    const files = { 'before.json': await snapshotJson([page(100)]), 'after.json': await snapshotJson([page(100)]) }
    const run = async (extra: ReadonlyArray<string>) => {
      const { impl, err } = io(files)
      return { code: await main([...COMMAND, ...extra], impl), err }
    }

    // An option another command takes is not one this command takes.
    const unknown = await run(['--roots', '1:1'])
    expect(unknown.code).toBe(2)
    expect(unknown.err[0]).toBe('unknown option --roots for diff-snapshots; see figma-ir diff-snapshots --help')

    const twice = await run(['--before', 'other.json'])
    expect(twice.code).toBe(2)
    expect(twice.err[0]).toBe('--before given twice')

    const { impl, err } = io(files)
    expect(await main(['diff-snapshots', '--before', 'before.json', '--after'], impl)).toBe(2)
    expect(err[0]).toBe('--after needs a value')

    expect(COMMANDS['diff-snapshots']).toEqual({ values: ['before', 'after'], flags: [] })
  })

  it('is described in the usage text', async () => {
    const { impl, out } = io({})

    expect(await main(['help'], impl)).toBe(0)
    expect(out.join('\n')).toContain('diff-snapshots --before <file> --after <file>')
  })
})
