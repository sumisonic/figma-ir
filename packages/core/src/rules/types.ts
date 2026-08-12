/**
 * Named rules.
 *
 * A project declares which checks to run and with what parameters; it does not
 * write code or expressions. The shape is deliberately the one ESLint uses,
 * for the same reasons: what a project can express stays bounded, the rule id
 * and version become the unit of auditing and waiving, and each check can be
 * unit tested in the language it is written in.
 *
 * Rules read facts, never the tree, and they only ever add findings. Nothing
 * here can rewrite the document or relax another rule -- a check that could
 * make the pipeline more permissive would eventually be used to do exactly
 * that, on a deadline.
 */
import type { SourceId } from '../identity/nodeIdentity.js'
import type { DiagnosticSeverity, ReasonCode } from '../diagnostics/reason.js'
import type { Untrusted } from '../text/untrusted.js'
import type { FactIndex } from '../facts/types.js'

export const RULES_SCHEMA_VERSION = 1

/**
 * What a finding is about.
 *
 * Named as a value rather than left implicit in a list of node ids, because a
 * waiver has to survive the document changing around it. "This rule, about this
 * style name" keeps meaning something after a node is recreated; "this rule,
 * about node 1:23" does not.
 */
export type FindingTarget =
  | { readonly kind: 'node'; readonly sourceId: SourceId }
  | { readonly kind: 'artboard'; readonly sourceId: SourceId }
  | { readonly kind: 'textStyle'; readonly styleId: string }
  | { readonly kind: 'responsiveGroup'; readonly section: string }
  | { readonly kind: 'slot'; readonly section: string; readonly namePath: ReadonlyArray<string> }

/** One thing a rule found. Reported; never repaired. */
export interface Finding {
  readonly ruleId: string
  readonly ruleVersion: number
  readonly severity: DiagnosticSeverity
  readonly reason: ReasonCode
  /** Stable across runs: rule, version and target. The unit a waiver names. */
  readonly findingId: string
  readonly target: FindingTarget
  /** What was found, in terms a designer can act on. */
  readonly message: string
  readonly sourceIds: ReadonlyArray<SourceId>
  /**
   * The values the finding is about, kept as data.
   *
   * Design-authored strings stay `Untrusted` so that a finding rendered into a
   * message for a model cannot smuggle instructions along with it.
   */
  readonly evidence: ReadonlyArray<Untrusted>
}

/** What a rule returns: everything except the identity the runner assigns. */
export type RawFinding = Omit<Finding, 'ruleId' | 'ruleVersion' | 'severity' | 'findingId'>

/**
 * A check the core provides.
 *
 * `params` is validated against the rule's own schema before it runs, so a
 * typo in a project's configuration fails at load rather than silently
 * checking nothing.
 */
export interface Rule<P> {
  readonly id: string
  /** Bumped when the meaning changes, so a waiver cannot outlive what it waived. */
  readonly version: number
  readonly defaultSeverity: DiagnosticSeverity
  readonly parseParams: (raw: unknown) => P
  readonly evaluate: (facts: FactIndex, params: P) => ReadonlyArray<RawFinding>
}

export class RuleConfigError extends Error {
  readonly _tag = 'RuleConfigError'
  readonly ruleId: string
  constructor(ruleId: string, message: string) {
    super(`${ruleId}: ${message}`)
    this.name = 'RuleConfigError'
    this.ruleId = ruleId
  }
}

/** One entry in a project's ruleset. */
export interface RuleUse {
  readonly use: string
  readonly severity?: DiagnosticSeverity
  readonly params?: unknown
}

export interface Ruleset {
  readonly rules: ReadonlyArray<RuleUse>
}

export interface RuleRun {
  readonly findings: ReadonlyArray<Finding>
  /**
   * What ran, at what severity, with which parameters.
   *
   * The parameters are hashed rather than copied: the audit needs to know that
   * a run used the same configuration as another, and a project's parameters
   * can contain names it would rather not have copied into every report.
   */
  readonly applied: ReadonlyArray<{
    readonly id: string
    readonly version: number
    readonly severity: DiagnosticSeverity
    readonly paramsHash: string
  }>
}

/**
 * A rule with its parameter type erased.
 *
 * Parsing and evaluation stay separate steps. Folding them into one `run` was
 * tempting and wrong: validating a configuration then meant executing the rule
 * against an empty index, so a rule that consulted its input during evaluation
 * would break loading, and a rule with a side effect would perform it twice.
 * Loading parses; running evaluates what loading already parsed.
 */
export interface AnyRule {
  readonly id: string
  readonly version: number
  readonly defaultSeverity: DiagnosticSeverity
  readonly parse: (raw: unknown) => unknown
  readonly evaluate: (facts: FactIndex, parsed: unknown) => ReadonlyArray<RawFinding>
}

export const erase = <P>(rule: Rule<P>): AnyRule => ({
  id: rule.id,
  version: rule.version,
  defaultSeverity: rule.defaultSeverity,
  parse: (raw) => rule.parseParams(raw),
  evaluate: (facts, parsed) => rule.evaluate(facts, parsed as P),
})
