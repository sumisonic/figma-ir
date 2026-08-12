import { describe, expect, it } from 'vitest'

import { fromSnapshot, walkNodes } from './canonical/adapter.js'
import { deriveFacts } from './facts/derive.js'
import { fileKey } from './figma/client.js'
import { fixtureClient } from './figma/fixtureClient.js'
import { snapshotToStored, storedToSnapshot } from './figma/persist.js'
import { acquireSnapshot } from './figma/snapshot.js'
import { loadRuleset, runRules } from './rules/run.js'
import { cutSlice, sliceEnvelope } from './slice/cut.js'
import { design, frame, text, type RawNodeSpec } from './testing/builders.js'
import { unsafeUnwrap } from './text/untrusted.js'

/**
 * One scenario, end to end.
 *
 * Every layer has its own witnesses; this test exists for the wiring between
 * them — acquisition through persistence, canonicalization, fact derivation,
 * rules and slicing in one pass — because a bug that only appears when layers
 * hand off to each other is invisible to every per-layer suite.
 *
 * The design is composed, not captured: two breakpoint variants whose sections
 * are listed out of reading order, whose containers carry editor-generated
 * names, with one misnamed text style for the rules to find.
 */
const variant = (prefix: string, width: number): RawNodeSpec =>
  frame(`${prefix}:1`, `page_${width}`, { x: 0, y: 0, width, height: 900 }, {
    children: [
      // Listed footer-first: paint order, not reading order (REG-ORDER-002).
      frame(`${prefix}:40`, 'footer', { x: 0, y: 700, width, height: 200 }, {
        children: [text(`${prefix}:41`, 'copyright', '(c) example-web')],
      }),
      frame(`${prefix}:20`, 'hero', { x: 0, y: 0, width, height: 300 }, {
        children: [
          text(`${prefix}:21`, 'title', 'Spring lineup', { styles: { text: '9:1' } }),
          // A style whose name is missing its final segment (REG-STYLE-006).
          text(`${prefix}:22`, 'lead', 'Three new venues.', { styles: { text: '9:2' } }),
        ],
      }),
      // An editor-named container, different per variant (REG-RESP-003).
      frame(`${prefix}:30`, `Frame ${prefix}99`, { x: 0, y: 300, width, height: 400 }, {
        children: [text(`${prefix}:31`, 'body', 'Details follow.')],
      }),
      frame(`${prefix}:50`, 'draft', { x: 0, y: 0, width: 10, height: 10 }, { visible: false }),
    ],
  })

const STYLES = {
  '9:1': { name: 'main/title/sm/all' },
  '9:2': { name: 'main/lead/sm' },
}

const RULESET = {
  rules: [
    { use: 'figma.text-style-name.v2', params: {} },
    { use: 'responsive.group-completeness.v1', params: { breakpoints: ['sm', 'xl'] } },
  ],
}

describe('the whole pipeline, one scenario', () => {
  it('carries a design from acquisition to a slice a consumer could implement from', async () => {
    // 1. Acquire, and survive the disk round trip that JSON would break.
    const acquired = await acquireSnapshot({
      client: fixtureClient(design([variant('1', 375), variant('2', 1440)], STYLES)),
      fileKey: fileKey('SYNTHETICFILEKEY0001'),
      roots: ['1:1', '2:1'],
      now: () => '2026-01-01T00:00:00.000Z',
    })
    const snapshot = storedToSnapshot(JSON.parse(JSON.stringify(snapshotToStored(acquired))) as unknown)

    // 2. Canonicalize: hidden branch resolved, styles in three states.
    const doc = fromSnapshot(snapshot)
    expect(doc.rejections).toEqual([])
    const hidden = [...walkNodes(doc)].find((node) => (node.sourceId as string) === '1:50')
    expect(hidden?.effectiveVisible).toBe(false)

    // 3. Facts: reading order beats paint order; the variants group; the
    //    editor-named container does not correspond and says so.
    const facts = deriveFacts(doc, {
      responsive: {
        namePattern: '{section}_{width}',
        breakpoints: [
          { slot: 'sm', designWidthPx: 375 },
          { slot: 'xl', designWidthPx: 1440 },
        ],
      },
      styleNames: { pattern: '{group}/{purpose}/{breakpoint}/{language}', allowed: { breakpoint: ['sm', 'md', 'lg', 'xl'], language: ['ja', 'en', 'all'] } },
    })
    const smRoot = facts.roots.find((root) => (root.sourceId as string) === '1:1')
    const sectionNames = smRoot?.children.map((id) => {
      const fact = facts.nodes.get(id)
      return fact === undefined ? '?' : unsafeUnwrap([...fact.namePath].pop() ?? ('' as never))
    })
    expect(sectionNames?.[0]).toBe('hero')
    expect(sectionNames?.[sectionNames.length - 1]).toBe('footer')

    const group = facts.responsiveGroups[0]
    expect(group?.members.map((member) => member.breakpoint)).toEqual(['sm', 'xl'])
    const slotPaths = group?.slots.map((slot) => slot.namePath.map(unsafeUnwrap).join('/')) ?? []
    expect(slotPaths).toContain('hero/title')
    expect(slotPaths.some((path) => path.startsWith('Frame '))).toBe(false)
    expect(group?.coverage.unresolvedPaths).toBeGreaterThan(0)

    // 4. Rules: the misnamed style is found once, at the style, blocking.
    const run = runRules(facts, loadRuleset(RULESET))
    expect(run.findings).toHaveLength(1)
    expect(run.findings[0]?.ruleId).toBe('figma.text-style-name.v2')
    expect(run.findings[0]?.target).toEqual({ kind: 'textStyle', styleId: '9:2' })

    // 5. Slice one section: findings filtered to it, omissions declared, and
    //    the cross-breakpoint comparison and derivation diagnostics carried
    //    through — the wiring this test exists for. If cutSlice dropped either,
    //    a consumer would re-measure by eye and never know.
    const slice = cutSlice(doc, facts, { roots: ['1:20'] }, run.findings)
    expect(slice.nodes.map((node) => node.sourceId as string)).toEqual(['1:20', '1:21', '1:22'])
    expect(slice.findings).toHaveLength(1)
    expect(slice.findings[0]?.externalSourceIds).toContain('2:22')
    expect(slice.responsive).toHaveLength(1)
    expect(slice.responsive[0]?.members.map((member) => member.breakpoint)).toEqual(['sm', 'xl'])
    expect(slice.derivation.length).toBeGreaterThan(0)

    // 6. The envelope a consumer receives: self-identifying, valid JSON data.
    const envelope = sliceEnvelope(slice) as { sliceHash: string; nodes: unknown[] }
    expect(envelope.sliceHash).toMatch(/^slice:v4:sha256:/)
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope)

    // 7. The same scenario, twice: byte-identical the whole way down.
    const again = await acquireSnapshot({
      client: fixtureClient(design([variant('1', 375), variant('2', 1440)], STYLES)),
      fileKey: fileKey('SYNTHETICFILEKEY0001'),
      roots: ['1:1', '2:1'],
      now: () => '2027-12-31T23:59:59.000Z',
    })
    const doc2 = fromSnapshot(again)
    expect(doc2.canonicalHash).toBe(doc.canonicalHash)
    const slice2 = cutSlice(doc2, deriveFacts(doc2, {
      responsive: {
        namePattern: '{section}_{width}',
        breakpoints: [
          { slot: 'sm', designWidthPx: 375 },
          { slot: 'xl', designWidthPx: 1440 },
        ],
      },
      styleNames: { pattern: '{group}/{purpose}/{breakpoint}/{language}', allowed: { breakpoint: ['sm', 'md', 'lg', 'xl'], language: ['ja', 'en', 'all'] } },
    }), { roots: ['1:20'] }, runRules(deriveFacts(doc2, {
      responsive: {
        namePattern: '{section}_{width}',
        breakpoints: [
          { slot: 'sm', designWidthPx: 375 },
          { slot: 'xl', designWidthPx: 1440 },
        ],
      },
      styleNames: { pattern: '{group}/{purpose}/{breakpoint}/{language}', allowed: { breakpoint: ['sm', 'md', 'lg', 'xl'], language: ['ja', 'en', 'all'] } },
    }), loadRuleset(RULESET)).findings)
    expect(JSON.stringify(sliceEnvelope(slice2))).toBe(JSON.stringify(sliceEnvelope(slice)))
  })
})
