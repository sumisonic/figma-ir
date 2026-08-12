/**
 * Comparing two snapshots of the same design: the public names.
 *
 * A follow-up run starts from "what did the designer change since last time",
 * and without this that question was answered by a script written on the
 * spot — a different script each time, so the answer depended on who asked.
 * The comparison is deterministic and belongs here, decided once.
 *
 * It reports and never explains. Which change pushed which node is a claim
 * about cause, and the two documents do not contain it.
 */
export type { SnapshotDiff } from './model.js'

export const SNAPSHOT_DIFF_SCHEMA_VERSION = 1

/**
 * What kind of thing changed on a node, in the order changes are listed.
 *
 * Closed on purpose: a consumer decides what to re-read and what to
 * re-measure by category, and a category it has never heard of is a decision
 * it silently does not make.
 */
export const SNAPSHOT_DIFF_CATEGORIES = [
  'name',
  'type',
  'visibility',
  'box',
  'render-bounds',
  'rotation',
  'compositing',
  'layout',
  'text',
  'fills',
  'strokes',
  'corners',
  'effects',
  'component',
  'vector',
  'children',
  'parent',
] as const
export type SnapshotDiffCategory = (typeof SNAPSHOT_DIFF_CATEGORIES)[number]

/**
 * Why two documents were not compared.
 *
 * Every member except the last describes inputs that cannot be compared
 * honestly: comparing them anyway would report the difference between two
 * ways of asking as if it were a difference in the design. The last one is
 * different in kind — see its own note.
 */
export type SnapshotDiffErrorDetail =
  | { readonly kind: 'canonical-schema-mismatch'; readonly before: number; readonly after: number; readonly expected: number }
  | { readonly kind: 'file-mismatch'; readonly before: string; readonly after: string }
  | { readonly kind: 'geometry-mode-mismatch'; readonly before: 'none' | 'paths'; readonly after: 'none' | 'paths' }
  | {
      readonly kind: 'adapter-mismatch'
      readonly before: { readonly name: string; readonly version: string }
      readonly after: { readonly name: string; readonly version: string }
    }
  | { readonly kind: 'invalid-canonical-document'; readonly side: 'before' | 'after'; readonly nodePath: string }
  | {
      readonly kind: 'duplicate-source-id'
      readonly side: 'before' | 'after'
      readonly sourceId: string
      /** Every place the id appears, sorted by code unit. */
      readonly nodePaths: ReadonlyArray<string>
    }
  /**
   * The hash input says a field differs and nothing in the result accounts
   * for it. That is a defect in the comparison, not a fact about the design,
   * so it stops the run instead of being listed beside real changes.
   */
  | { readonly kind: 'change-serialization-mismatch'; readonly sourceId: string; readonly ownField: string }

const sentenceFor = (detail: SnapshotDiffErrorDetail): string => {
  switch (detail.kind) {
    case 'canonical-schema-mismatch':
      return `the documents were normalized with canonical schema versions ${detail.before} and ${detail.after}; this build compares version ${detail.expected}`
    case 'file-mismatch':
      return `the snapshots come from different files (before: ${detail.before}, after: ${detail.after})`
    case 'geometry-mode-mismatch':
      return `the snapshots were acquired with different geometry modes (before: ${detail.before}, after: ${detail.after}); re-acquire the newer one with the same mode as the older one`
    case 'adapter-mismatch':
      return `the snapshots were acquired by different adapters (before: ${detail.before.name}@${detail.before.version}, after: ${detail.after.name}@${detail.after.version})`
    case 'invalid-canonical-document':
      return `the ${detail.side} document has a rejection at ${detail.nodePath} whose root or parent cannot be located`
    case 'duplicate-source-id':
      return `the ${detail.side} snapshot contains node ${detail.sourceId} more than once (at ${detail.nodePaths.join(', ')}); a root nested inside another root causes this — acquire without nested roots`
    case 'change-serialization-mismatch':
      return `node ${detail.sourceId} differs in ${detail.ownField} but the difference could not be reported; this is a defect in diff-snapshots, not a property of the design`
  }
}

/**
 * The message leads with the kind, so a caller reading stderr can branch on
 * it without parsing a sentence written for people.
 */
export class SnapshotDiffError extends Error {
  readonly _tag = 'SnapshotDiffError'
  readonly detail: SnapshotDiffErrorDetail
  constructor(detail: SnapshotDiffErrorDetail) {
    super(`${detail.kind}: ${sentenceFor(detail)}`)
    this.name = 'SnapshotDiffError'
    this.detail = detail
  }
}
