import { describe, expect, it } from 'vitest'

import { unsafeUnwrap, type Untrusted } from '../text/untrusted.js'
import { design, frame, type RawNodeSpec } from '../testing/builders.js'
import { fileKey } from '../figma/client.js'
import { fixtureClient } from '../figma/fixtureClient.js'
import { acquireSnapshot } from '../figma/snapshot.js'
import { fromSnapshot } from '../canonical/adapter.js'
import { loadRuleset, runRules } from '../rules/run.js'
import { deriveFacts } from './derive.js'
import type { FactConfig } from './types.js'

const KEY = fileKey('SYNTHETICFILEKEY0001')
const now = () => '2026-01-01T00:00:00.000Z'

/**
 * A page at four widths where the widest artboard was renamed by hand and no
 * longer parses (REG-RESP-004). Three of four follow `page_{width}`; the
 * fourth is `page_xl_final`, the shape a person produces mid-redesign.
 */
const fourVariants = (): ReadonlyArray<RawNodeSpec> => [
  frame('1:1', 'page_375', { x: 0, y: 0, width: 375, height: 800 }),
  frame('2:1', 'page_768', { x: 400, y: 0, width: 768, height: 800 }),
  frame('3:1', 'page_1024', { x: 1200, y: 0, width: 1024, height: 800 }),
  frame('4:1', 'page_xl_final', { x: 2300, y: 0, width: 1440, height: 800 }),
]

const CONFIG: FactConfig = {
  responsive: {
    namePattern: '{section}_{width}',
    breakpoints: [
      { slot: 'sm', designWidthPx: 375 },
      { slot: 'md', designWidthPx: 768 },
      { slot: 'lg', designWidthPx: 1024 },
      { slot: 'xl', designWidthPx: 1440 },
    ],
  },
}

const factsFrom = async (config: FactConfig) => {
  const roots = fourVariants()
  const doc = fromSnapshot(
    await acquireSnapshot({
      client: fixtureClient(design(roots)),
      fileKey: KEY,
      roots: roots.map((root) => root.id),
      now,
    }),
  )
  return deriveFacts(doc, config)
}

describe('an artboard that does not follow the convention (REG-RESP-004)', () => {
  it('groups the three that match and leaves out the one that does not', async () => {
    const facts = await factsFrom(CONFIG)
    const group = facts.responsiveGroups.find((entry) => unsafeUnwrap(entry.section as Untrusted) === 'page')
    // Reading `_xl_final` as "this is the 1440 one" would mean inventing the
    // mapping; the pattern simply does not match, so it is not a member.
    expect(group?.members.map((member) => member.breakpoint)).toEqual(['sm', 'md', 'lg'])
  })

  it('reports the missing breakpoint rather than proceeding with three', async () => {
    // The incident this exists for: implementing from three breakpoints and
    // discovering the fourth later. Here it surfaces before any code is written.
    const facts = await factsFrom(CONFIG)
    const run = runRules(
      facts,
      loadRuleset({
        rules: [{ use: 'responsive.group-completeness.v1', params: { breakpoints: ['sm', 'md', 'lg', 'xl'] } }],
      }),
    )
    expect(run.findings).toHaveLength(1)
    expect(run.findings[0]?.message).toContain('xl')
    expect(run.findings[0]?.severity).toBe('warning')
  })

  it('groups all four once the project declares the exception', async () => {
    // The fix is the project saying what its naming actually is — a node id
    // and a breakpoint, one line — not the IR guessing.
    const facts = await factsFrom({
      responsive: {
        ...(CONFIG.responsive as NonNullable<FactConfig['responsive']>),
        explicit: [{ nodeId: '4:1', section: 'page', breakpoint: 'xl' }],
      },
    })
    const group = facts.responsiveGroups.find((entry) => unsafeUnwrap(entry.section as Untrusted) === 'page')
    expect(group?.members.map((member) => member.breakpoint)).toEqual(['sm', 'md', 'lg', 'xl'])
    expect(group?.members.find((member) => member.breakpoint === 'xl')?.designWidthPx).toBe(1440)
  })

  it('stops reporting the missing breakpoint once it is declared', async () => {
    const facts = await factsFrom({
      responsive: {
        ...(CONFIG.responsive as NonNullable<FactConfig['responsive']>),
        explicit: [{ nodeId: '4:1', section: 'page', breakpoint: 'xl' }],
      },
    })
    const run = runRules(
      facts,
      loadRuleset({
        rules: [{ use: 'responsive.group-completeness.v1', params: { breakpoints: ['sm', 'md', 'lg', 'xl'] } }],
      }),
    )
    expect(run.findings).toEqual([])
  })

  it('rejects a declaration naming a breakpoint the config does not have, when the config loads (REG-CONF-017)', async () => {
    await expect(
      factsFrom({
        responsive: {
          ...(CONFIG.responsive as NonNullable<FactConfig['responsive']>),
          explicit: [{ nodeId: '4:1', section: 'page', breakpoint: 'xxl' }],
        },
      }),
    ).rejects.toThrow(/not a declared slot/)
  })

  it('reports a declaration about a root that was not acquired: a configuration that did nothing says so (REG-CONF-017)', async () => {
    const facts = await factsFrom({
      responsive: {
        ...(CONFIG.responsive as NonNullable<FactConfig['responsive']>),
        explicit: [{ nodeId: '99:99', section: 'page', breakpoint: 'sm' }],
      },
    })
    expect(facts.diagnostics.map((diagnostic) => [diagnostic.reason, diagnostic.detail])).toContainEqual([
      'CONFIG_ERROR',
      'explicit declaration for 99:99 names a root that was not acquired',
    ])
  })

  it('checks the widths of the members it did group', async () => {
    const facts = await factsFrom(CONFIG)
    const run = runRules(
      facts,
      loadRuleset({
        rules: [
          {
            use: 'artboard.expected-width.v2',
            params: { expected: { sm: 375, md: 768, lg: 1024 } },
          },
        ],
      }),
    )
    expect(run.findings).toEqual([])
  })
})
