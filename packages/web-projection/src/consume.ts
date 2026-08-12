/**
 * Obligation enforcement, the minimal version.
 *
 * The projection emits obligations — the finite set of claims a consumer
 * must account for. Until now the accounting was self-reported, which is
 * the exact hole the obligations exist to close: a value nobody read never
 * makes it into a self-chosen checklist. This checker takes the consumer's
 * ledger and the projection and disagrees loudly.
 *
 * Deliberately small: an exception fails the run and
 * leaves a candidate record; approvals, owners, and expiry are a later
 * governance problem. A free-text reason is not a gate — but an unaccounted
 * obligation is, and that is the part a machine can hold today.
 */
import type { WebProjectionArtifact } from './types.js'

export class ConsumptionError extends Error {
  readonly _tag = 'ConsumptionError'
  constructor(message: string) {
    super(message)
    this.name = 'ConsumptionError'
  }
}

export type ConsumptionStatus = 'consumed' | 'not-applicable' | 'exception'

export interface ConsumptionEntry {
  readonly projectionFactId: string
  readonly status: ConsumptionStatus
  /** Required for anything but `consumed`: unexplained is unaccounted. */
  readonly reason: string | undefined
}

export interface ConsumptionLedger {
  /** The projection this ledger claims to account for. */
  readonly projectionHash: string
  readonly entries: ReadonlyArray<ConsumptionEntry>
}

export interface ConsumptionReport {
  readonly projectionHash: string
  readonly obligationCount: number
  readonly consumedCount: number
  readonly notApplicableCount: number
  /** The excusals in full, not a count: a reason nobody can read is not a reason. */
  readonly notApplicable: ReadonlyArray<{ readonly projectionFactId: string; readonly reason: string }>
  /** Obligations the ledger never mentioned. The original sin, now countable. */
  readonly unaccounted: ReadonlyArray<string>
  /** Ledger entries naming obligations the projection never issued. */
  readonly unknownFactIds: ReadonlyArray<string>
  /** Declared deviations. Phase 1: recorded as candidates, and failing. */
  readonly exceptions: ReadonlyArray<{ readonly projectionFactId: string; readonly reason: string }>
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** Validates a consumer's ledger, loudly: it is the artifact under test. */
export const decodeConsumptionLedger = (raw: unknown): ConsumptionLedger => {
  const record = asRecord(raw)
  if (record === undefined) throw new ConsumptionError('a consumption ledger must be an object')
  if (record['schemaVersion'] !== 1) throw new ConsumptionError('consumption ledger schemaVersion must be 1')
  const projectionHash = record['projectionHash']
  if (typeof projectionHash !== 'string' || projectionHash.length === 0) {
    throw new ConsumptionError('projectionHash must be a non-empty string')
  }
  const entriesRaw = record['entries']
  if (!Array.isArray(entriesRaw)) throw new ConsumptionError('entries must be an array')
  const seen = new Set<string>()
  const entries = entriesRaw.map((entryRaw, index): ConsumptionEntry => {
    const entry = asRecord(entryRaw)
    if (entry === undefined) throw new ConsumptionError(`entries[${index}] must be an object`)
    const projectionFactId = entry['projectionFactId']
    if (typeof projectionFactId !== 'string' || projectionFactId.length === 0) {
      throw new ConsumptionError(`entries[${index}].projectionFactId must be a non-empty string`)
    }
    if (seen.has(projectionFactId)) {
      throw new ConsumptionError(`entries accounts for ${projectionFactId} twice`)
    }
    seen.add(projectionFactId)
    const status = entry['status']
    if (status !== 'consumed' && status !== 'not-applicable' && status !== 'exception') {
      throw new ConsumptionError(`entries[${index}].status must be consumed, not-applicable, or exception`)
    }
    const reason = entry['reason']
    if (status !== 'consumed') {
      if (typeof reason !== 'string' || reason.trim().length === 0) {
        throw new ConsumptionError(`entries[${index}] (${status}) needs a non-empty reason`)
      }
      return { projectionFactId, status, reason }
    }
    if (reason !== undefined && typeof reason !== 'string') {
      throw new ConsumptionError(`entries[${index}].reason must be a string when present`)
    }
    return { projectionFactId, status, reason: typeof reason === 'string' ? reason : undefined }
  })
  return { projectionHash, entries }
}

/**
 * Checks a ledger against the projection it claims to account for.
 *
 * The hash check comes first: a ledger for another projection is not a
 * wrong answer, it is an answer to a different exam.
 */
export const checkObligations = (artifact: WebProjectionArtifact, ledger: ConsumptionLedger): ConsumptionReport => {
  if (ledger.projectionHash !== (artifact.projectionHash as string)) {
    throw new ConsumptionError(
      `the ledger accounts for ${ledger.projectionHash}, not this projection (${artifact.projectionHash as string})`,
    )
  }

  const issued = new Set(artifact.obligations.map((obligation) => obligation.projectionFactId))
  const accounted = new Map(ledger.entries.map((entry) => [entry.projectionFactId, entry]))

  const unaccounted = [...issued].filter((id) => !accounted.has(id)).sort()
  const unknownFactIds = ledger.entries
    .map((entry) => entry.projectionFactId)
    .filter((id) => !issued.has(id))
    .sort()
  const byFactId = (a: { projectionFactId: string }, b: { projectionFactId: string }): number =>
    a.projectionFactId < b.projectionFactId ? -1 : a.projectionFactId > b.projectionFactId ? 1 : 0
  const exceptions = ledger.entries
    .filter((entry) => entry.status === 'exception')
    .map((entry) => ({ projectionFactId: entry.projectionFactId, reason: entry.reason as string }))
    .sort(byFactId)
  const notApplicable = ledger.entries
    .filter((entry) => entry.status === 'not-applicable' && issued.has(entry.projectionFactId))
    .map((entry) => ({ projectionFactId: entry.projectionFactId, reason: entry.reason as string }))
    .sort(byFactId)

  return {
    projectionHash: ledger.projectionHash,
    obligationCount: issued.size,
    consumedCount: ledger.entries.filter((entry) => entry.status === 'consumed' && issued.has(entry.projectionFactId))
      .length,
    notApplicableCount: notApplicable.length,
    notApplicable,
    unaccounted,
    unknownFactIds,
    exceptions,
  }
}

/** True when the accounting should fail a gate. Exceptions fail — Phase 1 has no approvals to spend. */
export const consumptionReportFails = (report: ConsumptionReport): boolean =>
  report.unaccounted.length > 0 || report.unknownFactIds.length > 0 || report.exceptions.length > 0
