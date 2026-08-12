import { describe, expect, it } from 'vitest'

import { acquireSnapshot, deriveFacts, fileKey, fixtureClient, fromSnapshot } from '@figma-ir/core'
import { design, frame } from '@figma-ir/core/testing'

import { projectWeb } from './project.js'
import { checkObligations, consumptionReportFails, decodeConsumptionLedger, ConsumptionError } from './consume.js'
import type { WebProjectionArtifact } from './types.js'

const KEY = fileKey('SYNTHETICFILEKEY0001')
const now = () => '2026-01-01T00:00:00.000Z'

const artifactOf = async (): Promise<WebProjectionArtifact> => {
  const root = frame('1:1', 'stack', { x: 0, y: 0, width: 200, height: 300 }, {
    layoutMode: 'VERTICAL',
    itemSpacing: 8,
    children: [
      frame('2:1', 'a', { x: 0, y: 0, width: 200, height: 40 }, {
        layoutSizingHorizontal: 'FIXED',
        layoutSizingVertical: 'FIXED',
      }),
      frame('2:2', 'b', { x: 0, y: 48, width: 200, height: 40 }, {
        layoutSizingHorizontal: 'FIXED',
        layoutSizingVertical: 'FIXED',
      }),
    ],
  })
  const doc = fromSnapshot(
    await acquireSnapshot({ client: fixtureClient(design([root], {})), fileKey: KEY, roots: ['1:1'], now }),
  )
  return projectWeb({ doc, facts: deriveFacts(doc), request: { roots: ['1:1'] } })
}

const ledgerFor = (
  artifact: WebProjectionArtifact,
  transform: (ids: string[]) => Array<Record<string, unknown>>,
  over: Record<string, unknown> = {},
) =>
  decodeConsumptionLedger({
    schemaVersion: 1,
    projectionHash: artifact.projectionHash as string,
    entries: transform(artifact.obligations.map((obligation) => obligation.projectionFactId)),
    ...over,
  })

describe('checkObligations', () => {
  it('accounts a complete ledger', async () => {
    const artifact = await artifactOf()
    const report = checkObligations(
      artifact,
      ledgerFor(artifact, (ids) => ids.map((id) => ({ projectionFactId: id, status: 'consumed' }))),
    )
    expect(report.unaccounted).toEqual([])
    expect(report.unknownFactIds).toEqual([])
    expect(report.consumedCount).toBe(report.obligationCount)
    expect(consumptionReportFails(report)).toBe(false)
  })

  it('fails on an obligation the ledger never mentioned — the original sin, now countable', async () => {
    const artifact = await artifactOf()
    const report = checkObligations(
      artifact,
      ledgerFor(artifact, (ids) => ids.slice(1).map((id) => ({ projectionFactId: id, status: 'consumed' }))),
    )
    expect(report.unaccounted).toHaveLength(1)
    expect(consumptionReportFails(report)).toBe(true)
  })

  it('fails on an entry for an obligation that was never issued', async () => {
    const artifact = await artifactOf()
    const report = checkObligations(
      artifact,
      ledgerFor(artifact, (ids) => [
        ...ids.map((id) => ({ projectionFactId: id, status: 'consumed' })),
        { projectionFactId: '9:9#width', status: 'consumed' },
      ]),
    )
    expect(report.unknownFactIds).toEqual(['9:9#width'])
    expect(consumptionReportFails(report)).toBe(true)
  })

  it('records a declared exception as a failing candidate — Phase 1 has no approvals to spend', async () => {
    const artifact = await artifactOf()
    const report = checkObligations(
      artifact,
      ledgerFor(artifact, (ids) =>
        ids.map((id, index) =>
          index === 0
            ? { projectionFactId: id, status: 'exception', reason: 'user asked for centred rows' }
            : { projectionFactId: id, status: 'consumed' },
        ),
      ),
    )
    expect(report.exceptions).toHaveLength(1)
    expect(report.exceptions[0]!.reason).toContain('centred')
    expect(consumptionReportFails(report)).toBe(true)
  })

  it('refuses a ledger for another projection: an answer to a different exam', async () => {
    const artifact = await artifactOf()
    const ledger = decodeConsumptionLedger({
      schemaVersion: 1,
      projectionHash: 'projection:v1:sha256:0000',
      entries: [],
    })
    expect(() => checkObligations(artifact, ledger)).toThrowError(ConsumptionError)
  })

  it('demands a reason for anything but consumed', () => {
    expect(() =>
      decodeConsumptionLedger({
        schemaVersion: 1,
        projectionHash: 'projection:v1:sha256:0000',
        entries: [{ projectionFactId: '1:1#container', status: 'not-applicable' }],
      }),
    ).toThrowError(/reason/)
  })

  it('refuses double accounting', () => {
    expect(() =>
      decodeConsumptionLedger({
        schemaVersion: 1,
        projectionHash: 'projection:v1:sha256:0000',
        entries: [
          { projectionFactId: '1:1#container', status: 'consumed' },
          { projectionFactId: '1:1#container', status: 'consumed' },
        ],
      }),
    ).toThrowError(/twice/)
  })
})
