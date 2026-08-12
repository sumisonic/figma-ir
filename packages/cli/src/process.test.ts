import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { acquireSnapshot, fileKey, fixtureClient, snapshotToStored } from '@figma-ir/core'
import { design, largePage } from '@figma-ir/core/testing'
import { describe, expect, it } from 'vitest'

const cliEntry = fileURLToPath(new URL('../dist/main.js', import.meta.url))
const now = () => '2026-01-01T00:00:00.000Z'

const writeSnapshot = async (): Promise<string> => {
  const snapshot = await acquireSnapshot({
    client: fixtureClient(design([largePage()])),
    fileKey: fileKey('SYNTHETICFILEKEY0001'),
    roots: ['1:1'],
    now,
  })
  const dir = mkdtempSync(join(tmpdir(), 'figma-ir-cli-'))
  const path = join(dir, 'snapshot.json')
  writeFileSync(path, JSON.stringify(snapshotToStored(snapshot)))
  return path
}

describe('the real process, through a pipe', () => {
  it('does not truncate a large slice', async () => {
    const snapshotPath = await writeSnapshot()
    // process.exit terminates before Node flushes a pipe: a large payload once
    // arrived as 65,536 bytes with a successful exit code. Only a real process
    // with a real pipe can catch that.
    const stdout = execFileSync(
      process.execPath,
      [cliEntry, 'export-slice', '--snapshot', snapshotPath, '--roots', '1:1', '--max-nodes', '10000'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
    expect(stdout.length).toBeGreaterThan(200_000)
    const slice = JSON.parse(stdout) as { nodes: unknown[]; sliceHash: string }
    expect(slice.nodes.length).toBeGreaterThan(400)
    expect(slice.sliceHash).toMatch(/^slice:v4:sha256:/)
  })

  it('reports a stale snapshot with a non-zero exit code', async () => {
    const snapshotPath = await writeSnapshot()
    let status = 0
    try {
      execFileSync(
        process.execPath,
        [cliEntry, 'verify-fresh', '--snapshot', snapshotPath, '--current-version', 'moved-on'],
        { encoding: 'utf8' },
      )
    } catch (error) {
      status = (error as { status: number }).status
    }
    expect(status).toBe(1)
  })
})
