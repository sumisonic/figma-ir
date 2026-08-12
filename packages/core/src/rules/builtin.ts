/**
 * The checks themselves.
 *
 * Each one exists because it happened. The comments name the incident rather
 * than restating the code, so that a rule which stops earning its keep can be
 * recognised and removed.
 */
import { compareCodeUnits } from '../determinism/canonical.js'
import type { SourceId } from '../identity/nodeIdentity.js'
import { markUntrusted, unsafeUnwrap, type Untrusted } from '../text/untrusted.js'
import { styleNamePart, type FactIndex, type SlotObservation } from '../facts/types.js'
import { noExtraKeys, asObject, optionalStringArray, requireNumberRecord, requireString, requireStringArray } from './params.js'
import { erase, RuleConfigError, type AnyRule, type RawFinding, type Rule } from './types.js'

/**
 * A rule that reads a convention refuses to run when none was declared,
 * before it looks at a single node: with no styles or no roots to scan, a
 * check inside the loop would never fire, and the rule would report as
 * applied and passed (REG-CONF-017).
 */
const requireDeclared = <K extends keyof FactIndex['declared']>(
  facts: FactIndex,
  key: K,
  ruleId: string,
): NonNullable<FactIndex['declared'][K]> => {
  const declared = facts.declared[key]
  if (declared === undefined) {
    throw new RuleConfigError(ruleId, `needs a ${key} declaration in the fact configuration (--config)`)
  }
  return declared
}

/**
 * Text style names must follow the convention the project declared.
 *
 * REG-STYLE-006: a large batch of styles once shipped missing a required name
 * segment, and was found by a person reading the entire file — after
 * implementation had already started against it.
 *
 * The grammar lives in the fact configuration (`styleNames`), not here: a
 * rule that carried its own copy could disagree with the facts it reads, and
 * the earlier version did exactly that. Every referenced text style is
 * checked; a style outside the convention on purpose is excused by prefix,
 * visibly, rather than skipped in silence.
 */
interface TextStyleNameParams {
  readonly exemptPrefixes: ReadonlyArray<string>
}

export const textStyleNameRule: Rule<TextStyleNameParams> = {
  id: 'figma.text-style-name.v2',
  version: 2,
  defaultSeverity: 'error',
  parseParams: (raw) => {
    const id = 'figma.text-style-name.v2'
    const object = asObject(id, raw)
    noExtraKeys(id, object, ['exemptPrefixes'])
    return { exemptPrefixes: optionalStringArray(id, object, 'exemptPrefixes') }
  },
  evaluate: (facts, params) => {
    requireDeclared(facts, 'styleNames', 'figma.text-style-name.v2')
    const findings: RawFinding[] = []
    for (const styleId of [...facts.textStyles.keys()].sort(compareCodeUnits)) {
      const style = facts.textStyles.get(styleId)
      if (style === undefined) continue
      const name = unsafeUnwrap(style.name)
      if (params.exemptPrefixes.some((prefix) => name.startsWith(prefix))) continue
      if (style.parsed.kind === 'known') continue
      findings.push({
        // Targeted at the style rather than at the nodes using it: the name is
        // what is wrong, and it stays wrong when a node is recreated.
        target: { kind: 'textStyle', styleId },
        reason: 'NO_TOKEN_MAPPING',
        message: 'text style name does not follow the declared convention',
        sourceIds: style.usedBy,
        evidence: [style.name],
      })
    }
    return findings
  },
}

/**
 * One text style must not carry two different fonts.
 *
 * REG-STYLE-005: one breakpoint's declarations under a shared style used a
 * different font family from all the others. No single node shows this; it
 * only appears when the declarations under one style are put side by side.
 *
 * The unit is the style id — the thing a designer applied — not the name:
 * two styles that happen to share a name are two styles, and the naming rule
 * is where that gets noticed. Exemptions refer to a segment of the declared
 * name pattern, so a project whose convention has no "purpose" segment can
 * still say which styles change face on purpose.
 */
interface FontConsistencyParams {
  readonly requireSame: ReadonlyArray<string>
  readonly exemptBy: { readonly segment: string; readonly values: ReadonlyArray<string> } | undefined
}

const FONT_FIELDS = new Set(['fontFamily', 'fontWeight', 'fontSize', 'fontPostScriptName'])

export const fontConsistencyRule: Rule<FontConsistencyParams> = {
  id: 'responsive.text-style-font-consistency.v2',
  version: 2,
  defaultSeverity: 'error',
  parseParams: (raw) => {
    const id = 'responsive.text-style-font-consistency.v2'
    const object = asObject(id, raw)
    noExtraKeys(id, object, ['requireSame', 'exemptBy'])
    const requireSame = requireStringArray(id, object, 'requireSame')
    for (const field of requireSame) {
      if (!FONT_FIELDS.has(field)) {
        throw new RuleConfigError(id, `"requireSame" contains an unknown field: ${field}`)
      }
    }
    const exemptByRaw = object['exemptBy']
    if (exemptByRaw === undefined) return { requireSame, exemptBy: undefined }
    const exemptBy = asObject(`${id}.exemptBy`, exemptByRaw)
    noExtraKeys(`${id}.exemptBy`, exemptBy, ['segment', 'values'])
    // Both halves or neither: a segment with no values is a half-written
    // exemption. An explicitly empty list is a project saying it has none yet.
    if (exemptBy['values'] === undefined) throw new RuleConfigError(`${id}.exemptBy`, '"values" is required')
    return {
      requireSame,
      exemptBy: {
        segment: requireString(`${id}.exemptBy`, exemptBy, 'segment'),
        values: optionalStringArray(`${id}.exemptBy`, exemptBy, 'values'),
      },
    }
  },
  evaluate: (facts, params) => {
    const findings: RawFinding[] = []
    const exempt = params.exemptBy
    if (exempt !== undefined) {
      // An exemption that names a segment the convention does not have would
      // never match, and every style it meant to excuse would be reported.
      const declared = requireDeclared(facts, 'styleNames', 'responsive.text-style-font-consistency.v2')
      if (!declared.segments.includes(exempt.segment)) {
        throw new RuleConfigError(
          'responsive.text-style-font-consistency.v2',
          `exemptBy.segment "${exempt.segment}" is not a segment of the declared pattern ${declared.pattern}`,
        )
      }
    }

    for (const styleId of [...facts.textStyles.keys()].sort(compareCodeUnits)) {
      const style = facts.textStyles.get(styleId)
      if (style === undefined || style.fonts.length < 2) continue
      if (exempt !== undefined && style.parsed.kind === 'known') {
        const value = styleNamePart(style.parsed.value, exempt.segment)
        if (value !== undefined && exempt.values.includes(unsafeUnwrap(value))) continue
      }

      // Encoded rather than joined: a family name containing the separator
      // would make two different declarations compare equal.
      const distinct = new Set(
        style.fonts.map((font) =>
          JSON.stringify(
            params.requireSame.map((field) =>
              field === 'fontFamily'
                ? unsafeUnwrap(font.family)
                : field === 'fontPostScriptName'
                  ? (font.postScriptName === undefined ? null : unsafeUnwrap(font.postScriptName))
                  : field === 'fontWeight'
                    ? font.weight
                    : font.size,
            ),
          ),
        ),
      )
      if (distinct.size < 2) continue

      findings.push({
        target: { kind: 'textStyle', styleId },
        reason: 'NO_TOKEN_MAPPING',
        message: `one text style carries ${distinct.size} different font declarations`,
        sourceIds: style.fonts.flatMap((font) => font.usedBy),
        evidence: [style.name, ...style.fonts.map((font) => font.family)],
      })
    }
    return findings
  },
}

/**
 * An artboard's width must match the viewport it stands for.
 *
 * Observed failure: artboards drawn narrower than the viewports they stood
 * for, which makes every measurement taken from them wrong by a scale factor.
 */
interface ArtboardWidthParams {
  readonly expected: ReadonlyMap<string, number>
}

/**
 * Which roots are artboards, and for which breakpoint, comes from the
 * responsive declaration in the fact configuration. The rule takes only
 * the widths to expect; an earlier version also took a name pattern it
 * never read (REG-CONF-017).
 */
export const artboardWidthRule: Rule<ArtboardWidthParams> = {
  id: 'artboard.expected-width.v2',
  version: 2,
  defaultSeverity: 'error',
  parseParams: (raw) => {
    const id = 'artboard.expected-width.v2'
    const object = asObject(id, raw)
    noExtraKeys(id, object, ['expected'])
    return { expected: requireNumberRecord(id, object, 'expected') }
  },
  evaluate: (facts, params) => {
    requireDeclared(facts, 'responsive', 'artboard.expected-width.v2')
    const findings: RawFinding[] = []
    for (const group of facts.responsiveGroups) {
      for (const member of group.members) {
        const expected = params.expected.get(member.breakpoint)
        if (expected === undefined) continue
        const root = facts.roots.find((entry) => entry.sourceId === member.rootId)
        if (root === undefined || root.width.kind !== 'known') continue
        if (root.width.value === expected) continue
        findings.push({
          target: { kind: 'artboard', sourceId: member.rootId },
          reason: 'VIEWPORT_REQUIRED',
          message: `artboard for ${member.breakpoint} is ${root.width.value}px where ${expected}px was expected`,
          sourceIds: [member.rootId],
          evidence: [root.name],
        })
      }
    }
    return findings
  },
}

/**
 * Every declared breakpoint should be present in a responsive group.
 *
 * REG-RESP-004: implementing from three breakpoints and discovering the
 * fourth later, after the component had been built around the wrong
 * assumptions.
 */
interface GroupCompletenessParams {
  readonly breakpoints: ReadonlyArray<string>
}

export const groupCompletenessRule: Rule<GroupCompletenessParams> = {
  id: 'responsive.group-completeness.v1',
  version: 1,
  defaultSeverity: 'warning',
  parseParams: (raw) => {
    const id = 'responsive.group-completeness.v1'
    const object = asObject(id, raw)
    noExtraKeys(id, object, ['breakpoints'])
    return { breakpoints: requireStringArray(id, object, 'breakpoints') }
  },
  evaluate: (facts, params) => {
    requireDeclared(facts, 'responsive', 'responsive.group-completeness.v1')
    const findings: RawFinding[] = []
    for (const group of facts.responsiveGroups) {
      const present = new Set(group.members.map((member) => member.breakpoint))
      const missing = params.breakpoints.filter((breakpoint) => !present.has(breakpoint))
      if (missing.length === 0) continue
      findings.push({
        target: { kind: 'responsiveGroup', section: unsafeUnwrap(group.section) },
        reason: 'VIEWPORT_REQUIRED',
        message: `responsive group is missing breakpoint(s): ${missing.join(', ')}`,
        sourceIds: group.members.map((member) => member.rootId),
        evidence: [group.section],
      })
    }
    return findings
  },
}

/**
 * A repeated list should have the same number of items at every breakpoint.
 *
 * Observed failure: a list with four items at one breakpoint and seven at the
 * others, which reads as a layout decision and was a data mistake.
 *
 * "Item" has to be declared rather than assumed. Counting every visible child
 * of the container would count decorations, headings and pagination as items,
 * and would miss items that sit one wrapper deeper; either way the rule fires
 * on healthy designs, which is how a check gets switched off.
 */
interface ItemCountParams {
  readonly containers: ReadonlyArray<string>
  /** Layer names that count as an item. Anything else in the container is ignored. */
  readonly itemNames: ReadonlyArray<string>
  readonly exemptSections: ReadonlyArray<string>
}

export const itemCountRule: Rule<ItemCountParams> = {
  id: 'responsive.item-count-consistency.v1',
  version: 1,
  defaultSeverity: 'warning',
  parseParams: (raw) => {
    const id = 'responsive.item-count-consistency.v1'
    const object = asObject(id, raw)
    noExtraKeys(id, object, ['containers', 'itemNames', 'exemptSections'])
    return {
      containers: requireStringArray(id, object, 'containers'),
      itemNames: requireStringArray(id, object, 'itemNames'),
      exemptSections: optionalStringArray(id, object, 'exemptSections'),
    }
  },
  evaluate: (facts, params) => {
    requireDeclared(facts, 'responsive', 'responsive.item-count-consistency.v1')
    const findings: RawFinding[] = []
    const exempt = new Set(params.exemptSections)
    const containers = new Set(params.containers)
    const itemNames = new Set(params.itemNames)

    for (const group of facts.responsiveGroups) {
      const section = unsafeUnwrap(group.section)
      if (exempt.has(section)) continue

      for (const slot of group.slots) {
        const leaf = slot.namePath[slot.namePath.length - 1]
        if (leaf === undefined || !containers.has(unsafeUnwrap(leaf))) continue

        const counts = new Map<string, number>()
        const ids: SourceId[] = []
        let containerHidden = false

        for (const [breakpoint, observation] of [...slot.byBreakpoint.entries()].sort((a, b) =>
          compareCodeUnits(a[0], b[0]),
        )) {
          if (observation.kind !== 'known') continue
          const value = observation.value as SlotObservation
          if (!value.rendered) {
            // A hidden container has no visible children either, so comparing
            // it with a shown one reports "0 versus 7" as a data mistake when
            // the design simply does not show the list at that width.
            containerHidden = true
            break
          }
          ids.push(value.sourceId)
          counts.set(breakpoint, countItems(facts, value.sourceId, itemNames))
        }
        if (containerHidden || counts.size < 2) continue

        const distinct = new Set(counts.values())
        if (distinct.size < 2) continue

        findings.push({
          target: { kind: 'slot', section, namePath: slot.namePath.map(unsafeUnwrap) },
          reason: 'AMBIGUOUS_NODE_MATCH',
          message: `item count differs across breakpoints: ${[...counts.entries()]
            .map(([breakpoint, count]) => `${breakpoint}=${count}`)
            .join(', ')}`,
          sourceIds: ids,
          evidence: slot.namePath,
        })
      }
    }
    return findings
  },
}

const countItems = (facts: FactIndex, container: SourceId, itemNames: ReadonlySet<string>): number => {
  const nodesByPath = [...facts.nodes.values()].filter((fact) => fact.parentId === container && fact.rendered)
  return nodesByPath.filter((fact) => {
    const leaf = fact.namePath[fact.namePath.length - 1]
    return leaf !== undefined && itemNames.has(unsafeUnwrap(leaf))
  }).length
}

/**
 * A section's content root should use auto-layout.
 *
 * Observed failure: a section pinned by absolute coordinates with a fixed
 * height, which cannot reflow and has to be rebuilt by hand in code.
 *
 * Scoped to a root's own rendered children, by name: a frame called
 * `contents` nested inside a card is somebody else's business, and a root
 * itself may legitimately pin backgrounds absolutely. Reads the roots, not
 * the responsive groups — an earlier version did the latter, and was silent
 * for every project that had not declared any.
 */
interface ContentRootAutoLayoutParams {
  readonly contentRootNames: ReadonlyArray<string>
}

export const contentRootAutoLayoutRule: Rule<ContentRootAutoLayoutParams> = {
  id: 'layout.content-root-auto-layout.v2',
  version: 2,
  defaultSeverity: 'warning',
  parseParams: (raw) => {
    const id = 'layout.content-root-auto-layout.v2'
    const object = asObject(id, raw)
    noExtraKeys(id, object, ['contentRootNames'])
    return { contentRootNames: requireStringArray(id, object, 'contentRootNames') }
  },
  evaluate: (facts, params) => {
    const findings: RawFinding[] = []
    const names = new Set(params.contentRootNames)

    for (const root of facts.roots) {
      for (const childId of root.children) {
        const child = facts.nodes.get(childId)
        if (child === undefined || !child.rendered) continue
        const leaf = child.namePath[child.namePath.length - 1]
        if (leaf === undefined || !names.has(unsafeUnwrap(leaf))) continue
        if (child.layoutMode !== 'NONE') continue
        findings.push({
          target: { kind: 'node', sourceId: childId },
          reason: 'UNSUPPORTED_NODE_TYPE',
          message: 'content root is not laid out automatically, so it cannot reflow',
          sourceIds: [childId],
          evidence: [root.name, leaf],
        })
      }
    }
    return findings
  },
}

export const BUILT_IN_RULES: ReadonlyArray<AnyRule> = [
  erase(textStyleNameRule),
  erase(fontConsistencyRule),
  erase(artboardWidthRule),
  erase(groupCompletenessRule),
  erase(itemCountRule),
  erase(contentRootAutoLayoutRule),
]

export type { Untrusted }
