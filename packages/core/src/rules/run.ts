/**
 * Loading and running a project's ruleset.
 *
 * Loading is strict and happens up front: a malformed document, an unknown rule
 * id, a misspelled parameter or a severity that is not one of the three all
 * fail here rather than partway through a run. A ruleset that half-loaded would
 * check less than the project believes it checks, and the project would have no
 * way to tell.
 */
import { canonicalStringify, compareCodeUnits, type CanonicalValue } from '../determinism/canonical.js'
import { hashCanonicalString } from '../determinism/hash.js'
import type { DiagnosticSeverity } from '../diagnostics/reason.js'
import type { FactIndex } from '../facts/types.js'
import { BUILT_IN_RULES } from './builtin.js'
import {
  RuleConfigError,
  type AnyRule,
  type Finding,
  type FindingTarget,
  type RuleRun,
  type Ruleset,
} from './types.js'

const SEVERITIES = new Set<string>(['error', 'warning', 'info'])

export interface LoadedRule {
  readonly rule: AnyRule
  readonly severity: DiagnosticSeverity
  /** Parsed once, at load. Running never re-parses. */
  readonly params: unknown
  /**
   * What the project actually wrote.
   *
   * Kept for the audit trail. Parsed parameters are the rule's own
   * representation and may hold structures that are not plain data; the
   * configuration a project committed is what another run needs to be compared
   * against.
   */
  readonly rawParams: unknown
}

export interface LoadedRuleset {
  readonly rules: ReadonlyArray<LoadedRule>
}

const asObject = (where: string, raw: unknown): Record<string, unknown> => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RuleConfigError(where, 'expected an object')
  }
  return raw as Record<string, unknown>
}

/**
 * Validates a ruleset that arrived as untyped data.
 *
 * A ruleset comes from a YAML file, so a TypeScript type says nothing about it
 * at run time. Checking the shape here means a project learns that `rule:` was
 * a typo for `rules:` instead of watching a run check nothing and pass.
 */
const parseRulesetDocument = (raw: unknown): Ruleset => {
  const document = asObject('ruleset', raw)
  const extra = Object.keys(document).filter((key) => key !== 'rules')
  if (extra.length > 0) {
    throw new RuleConfigError('ruleset', `unknown key(s): ${extra.sort().join(', ')}`)
  }
  if (!Array.isArray(document.rules)) {
    throw new RuleConfigError('ruleset', '"rules" must be an array')
  }
  return {
    rules: document.rules.map((entry, index) => {
      const use = asObject(`ruleset.rules[${index}]`, entry)
      const unknownKeys = Object.keys(use).filter((key) => !['use', 'severity', 'params'].includes(key))
      if (unknownKeys.length > 0) {
        throw new RuleConfigError(`ruleset.rules[${index}]`, `unknown key(s): ${unknownKeys.sort().join(', ')}`)
      }
      if (typeof use.use !== 'string' || use.use.length === 0) {
        throw new RuleConfigError(`ruleset.rules[${index}]`, '"use" must be a non-empty string')
      }
      return {
        use: use.use,
        ...(use.severity === undefined ? {} : { severity: use.severity as DiagnosticSeverity }),
        ...(use.params === undefined ? {} : { params: use.params }),
      }
    }),
  }
}

const buildRegistry = (available: ReadonlyArray<AnyRule>): ReadonlyMap<string, AnyRule> => {
  const byId = new Map<string, AnyRule>()
  for (const rule of available) {
    if (byId.has(rule.id)) {
      // The id is the unit of auditing and waiving. Two rules sharing one, with
      // the later silently winning, makes both meaningless.
      throw new RuleConfigError(rule.id, 'two rules are registered under the same id')
    }
    byId.set(rule.id, rule)
  }
  return byId
}

/** Validates a ruleset against the available checks, parsing every parameter. */
export const loadRuleset = (
  ruleset: Ruleset | unknown,
  available: ReadonlyArray<AnyRule> = BUILT_IN_RULES,
): LoadedRuleset => {
  const parsed = parseRulesetDocument(ruleset)
  const byId = buildRegistry(available)
  const seen = new Set<string>()
  const rules: LoadedRule[] = []

  for (const use of parsed.rules) {
    const rule = byId.get(use.use)
    if (rule === undefined) {
      throw new RuleConfigError(
        use.use,
        `unknown rule; available: ${[...byId.keys()].sort(compareCodeUnits).join(', ')}`,
      )
    }
    if (seen.has(use.use)) {
      // Two entries for one rule means one of them is doing nothing, and which
      // one is a question about ordering that nobody should have to answer.
      throw new RuleConfigError(use.use, 'rule is configured more than once')
    }
    seen.add(use.use)

    if (use.severity !== undefined && !SEVERITIES.has(use.severity)) {
      throw new RuleConfigError(use.use, 'severity must be one of error, warning, info')
    }

    rules.push({
      rule,
      severity: use.severity ?? rule.defaultSeverity,
      params: rule.parse(use.params),
      rawParams: use.params ?? null,
    })
  }

  return { rules }
}

const targetKey = (target: FindingTarget): CanonicalValue =>
  target.kind === 'slot'
    ? { kind: target.kind, section: target.section, namePath: [...target.namePath] }
    : ({ ...target } as CanonicalValue)

/**
 * A finding's identity: the rule, its version, and what the finding is about.
 *
 * Deliberately not the message, which is prose and will be reworded, nor the
 * node ids, which change when a designer recreates a layer. A waiver written
 * against this survives the document moving underneath it, and stops applying
 * when the rule's meaning changes.
 */
const findingId = (ruleId: string, ruleVersion: number, target: FindingTarget): string =>
  hashCanonicalString(
    'content',
    1,
    canonicalStringify({ ruleId, ruleVersion, target: targetKey(target) }),
  ) as string

/**
 * Runs a loaded ruleset over a fact index.
 *
 * Findings come back in a total order, so a diff between two runs shows what
 * changed in the design rather than what changed in an iteration order.
 */
export const runRules = (facts: FactIndex, loaded: LoadedRuleset): RuleRun => {
  const findings: Finding[] = []

  for (const entry of loaded.rules) {
    for (const raw of entry.rule.evaluate(facts, entry.params)) {
      findings.push({
        ...raw,
        ruleId: entry.rule.id,
        ruleVersion: entry.rule.version,
        severity: entry.severity,
        findingId: findingId(entry.rule.id, entry.rule.version, raw.target),
      })
    }
  }

  // Every field that distinguishes two findings takes part, so the order does
  // not fall back to whatever order a rule happened to emit them in.
  findings.sort(
    (a, b) =>
      compareCodeUnits(a.ruleId, b.ruleId) ||
      compareCodeUnits(a.findingId, b.findingId) ||
      compareCodeUnits(a.reason, b.reason) ||
      compareCodeUnits(a.severity, b.severity) ||
      compareCodeUnits(a.message, b.message) ||
      compareCodeUnits(a.sourceIds.join(','), b.sourceIds.join(',')) ||
      compareCodeUnits(canonicalStringify([...a.evidence] as never), canonicalStringify([...b.evidence] as never)),
  )

  return {
    findings,
    applied: loaded.rules.map((entry) => ({
      id: entry.rule.id,
      version: entry.rule.version,
      severity: entry.severity,
      paramsHash: hashCanonicalString(
        'content',
        1,
        canonicalStringify(entry.rawParams as CanonicalValue),
      ) as string,
    })),
  }
}

/** True when a run should stop the job from progressing. */
export const hasBlockingFindings = (run: RuleRun): boolean =>
  run.findings.some((finding) => finding.severity === 'error')
