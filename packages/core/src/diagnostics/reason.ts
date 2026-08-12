/**
 * Reason codes, as closed enumerations.
 *
 * Free text would make the two things we most need to count uncountable: how
 * often we correctly declined work, and how often we simply broke. The split
 * below is the important part — a timeout is not "no match", and turning one
 * into the other manufactures a confident wrong answer out of an outage.
 */
import { Schema } from 'effect'

/** The pipeline ran correctly and this is what it concluded. */
export const SEMANTIC_REASONS = [
  'UNSUPPORTED_NODE_TYPE',
  'NO_COMPONENT_MATCH',
  'AMBIGUOUS_COMPONENT',
  'AMBIGUOUS_NODE_MATCH',
  'NO_TOKEN_MAPPING',
  'RAW_VALUE_NOT_ALLOWED',
  'INTERACTIVE_NOT_SUPPORTED',
  'STATEFUL_NOT_SUPPORTED',
  'ASSET_MISSING',
  'VIEWPORT_REQUIRED',
  'TEXT_INJECTION_SUSPECTED',
  'DEPTH_LIMIT_EXCEEDED',
  'UNKNOWN_GROUPING',
  'PARENT_LAYOUT_REQUIRED',
  /** The declaration falls outside the projection's supported subset. */
  'UNSUPPORTED_LAYOUT',
  /** A translation needs geometry the node does not carry. */
  'GEOMETRY_MISSING',
  /** The translated rule's predicted coordinates disagree with the observed ones. */
  'GEOMETRY_CONTRADICTION',
  /** A pixel value depends on font metrics, which the pipeline cannot compute. */
  'TEXT_METRICS_REQUIRED',
  /** A partial wrapped line was neither observed nor pinned down by the declaration. */
  'PARTIAL_LINE_UNOBSERVED',
  /** A gap claim had no pair of children to be observed on. */
  'GAP_UNOBSERVED',
  /** Vector paths were not requested at acquisition; the source only returns them on request. */
  'GEOMETRY_NOT_ACQUIRED',
] as const

/** The pipeline could not run correctly. Never a statement about the design. */
export const INFRASTRUCTURE_REASONS = [
  'CONFIG_ERROR',
  'SUPPLY_CHAIN_ERROR',
  'CONTRIBUTOR_FAILED',
  'CONTRIBUTOR_TIMEOUT',
  'RESOURCE_EXCEEDED',
  'INCOMPLETE_EXECUTION',
] as const

export type SemanticReason = (typeof SEMANTIC_REASONS)[number]
export type InfrastructureReason = (typeof INFRASTRUCTURE_REASONS)[number]
export type ReasonCode = SemanticReason | InfrastructureReason

export const SemanticReasonSchema = Schema.Literals(SEMANTIC_REASONS)
export const InfrastructureReasonSchema = Schema.Literals(INFRASTRUCTURE_REASONS)
export const ReasonCodeSchema = Schema.Literals([...SEMANTIC_REASONS, ...INFRASTRUCTURE_REASONS])

const SEMANTIC_SET: ReadonlySet<string> = new Set(SEMANTIC_REASONS)
const INFRASTRUCTURE_SET: ReadonlySet<string> = new Set(INFRASTRUCTURE_REASONS)

export const isSemanticReason = (reason: string): reason is SemanticReason => SEMANTIC_SET.has(reason)

export const isInfrastructureReason = (reason: string): reason is InfrastructureReason =>
  INFRASTRUCTURE_SET.has(reason)

/**
 * Whether a reason must stop the job.
 *
 * Infrastructure reasons close the gate: we do not know what we did not see, so
 * publishing a result would be reporting ignorance as a finding.
 */
export const isFailClosed = (reason: ReasonCode): boolean => isInfrastructureReason(reason)

export const DIAGNOSTIC_SEVERITIES = ['error', 'warning', 'info'] as const
export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number]
export const DiagnosticSeveritySchema = Schema.Literals(DIAGNOSTIC_SEVERITIES)

/**
 * Job status.
 *
 * `partial-incomplete` is the one that earns its keep: diagnostics may be
 * shown, but approval, code generation and MR creation stay shut.
 */
export const JOB_STATUSES = [
  'complete',
  'complete-with-warnings',
  'partial-incomplete',
  'failed-infrastructure',
] as const
export type JobStatus = (typeof JOB_STATUSES)[number]
export const JobStatusSchema = Schema.Literals(JOB_STATUSES)

/** True when the job may proceed to approval and code generation. */
export const allowsDownstreamWork = (status: JobStatus): boolean =>
  status === 'complete' || status === 'complete-with-warnings'
