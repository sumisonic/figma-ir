import {
  acquireSnapshot,
  fileKey,
  fixtureClient,
  snapshotToStored,
  storedToSnapshot,
} from '@figma-ir/core'
import { design, frame, text } from '@figma-ir/core/testing'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { main, type CliIO } from './index.js'

const KEY_TEXT = 'SYNTHETICFILEKEY0001'
const now = () => '2026-01-01T00:00:00.000Z'

const pageData = () =>
  design(
    [
      frame('1:1', 'page_375', { x: 0, y: 0, width: 375, height: 900 }, {
        children: [
          text('1:2', 'title', 'Spring lineup', { styles: { text: '9:1' } }),
          frame('1:3', 'body', { x: 0, y: 100, width: 375, height: 700 }),
        ],
      }),
    ],
    { '9:1': { name: 'main/title/sm/all' } },
  )

const snapshotJson = async (): Promise<string> => {
  const snapshot = await acquireSnapshot({
    client: fixtureClient(pageData()),
    fileKey: fileKey(KEY_TEXT),
    roots: ['1:1'],
    now,
  })
  return JSON.stringify(snapshotToStored(snapshot))
}

const RULESET = JSON.stringify({
  rules: [
    { use: 'figma.text-style-name.v2', params: {} },
  ],
})

const CONFIG = JSON.stringify({
  styleNames: { pattern: '{group}/{purpose}/{breakpoint}/{language}', allowed: { breakpoint: ['sm', 'md', 'lg', 'xl'], language: ['ja', 'en', 'all'] } },
})

const io = (files: Record<string, string>, env: Record<string, string> = {}) => {
  const out: string[] = []
  const err: string[] = []
  const written: Record<string, string> = {}
  const impl: CliIO = {
    readFile: (path) => {
      const file = files[path] ?? written[path]
      if (file === undefined) throw new Error(`no such file: ${path}`)
      return file
    },
    exists: (path) => files[path] !== undefined || written[path] !== undefined,
    writeFile: (path, textContent) => {
      written[path] = textContent
    },
    write: (textContent) => {
      out.push(textContent)
    },
    writeError: (textContent) => {
      err.push(textContent)
    },
    env: (name) => env[name],
  }
  return { impl, out, err, written }
}

describe('export-slice', () => {
  it('prints a bounded view a consumer can read', async () => {
    const files = { 'snap.json': await snapshotJson() }
    const { impl, out } = io(files)
    const code = await main(['export-slice', '--snapshot', 'snap.json', '--roots', '1:1'], impl)
    expect(code).toBe(0)
    const slice = JSON.parse(out.join('\n')) as { nodes: unknown[]; sliceHash: string; request: { roots: string[] } }
    expect(slice.request.roots).toEqual(['1:1'])
    expect(slice.nodes.length).toBeGreaterThan(0)
    expect(slice.sliceHash).toMatch(/^slice:v4:sha256:/)
  })

  it('honours a depth limit and reports the cut', async () => {
    const files = { 'snap.json': await snapshotJson() }
    const { impl, out } = io(files)
    await main(['export-slice', '--snapshot', 'snap.json', '--roots', '1:1', '--max-depth', '0'], impl)
    const slice = JSON.parse(out.join('\n')) as {
      nodes: ReadonlyArray<{ truncated: unknown }>
      omitted: ReadonlyArray<{ reason: string }>
    }
    expect(slice.nodes.some((node) => node.truncated !== null)).toBe(true)
    expect(slice.omitted.some((entry) => entry.reason === 'max-depth')).toBe(true)
  })

  it('honours a node budget and puts the cut on the record (REG-CLI-011)', async () => {
    const files = { 'snap.json': await snapshotJson() }
    const { impl, out } = io(files)
    const code = await main(['export-slice', '--snapshot', 'snap.json', '--roots', '1:1', '--max-nodes', '1'], impl)
    expect(code).toBe(0)
    const slice = JSON.parse(out.join('\n')) as {
      request: { maxNodes: number }
      nodes: ReadonlyArray<unknown>
      omitted: ReadonlyArray<{ reason: string }>
    }
    expect(slice.request.maxNodes).toBe(1)
    expect(slice.nodes).toHaveLength(1)
    // The gap is listed, not left to be inferred from a suspiciously round count.
    expect(slice.omitted.some((entry) => entry.reason === 'max-nodes')).toBe(true)
  })

  it('gives the same bytes for the same request', async () => {
    const files = { 'snap.json': await snapshotJson() }
    const first = io(files)
    const second = io(files)
    await main(['export-slice', '--snapshot', 'snap.json', '--roots', '1:1'], first.impl)
    await main(['export-slice', '--snapshot', 'snap.json', '--roots', '1:1'], second.impl)
    expect(second.out).toEqual(first.out)
  })

  it('reports a missing option instead of guessing', async () => {
    const { impl, err } = io({ 'snap.json': await snapshotJson() })
    expect(await main(['export-slice', '--snapshot', 'snap.json'], impl)).toBe(2)
    expect(err.join()).toContain('--roots is required')
  })
})

describe('export-projection', () => {
  it('prints a projection envelope with its hash', async () => {
    const files = { 'snap.json': await snapshotJson() }
    const { impl, out } = io(files)
    const code = await main(['export-projection', '--snapshot', 'snap.json', '--roots', '1:1'], impl)
    expect(code).toBe(0)
    const projection = JSON.parse(out.join('\n')) as {
      projectionHash: string
      nodes: ReadonlyArray<{ sourceId: string; container: { kind: string } }>
      obligations: unknown[]
    }
    expect(projection.projectionHash).toMatch(/^projection:v2:sha256:/)
    expect(projection.nodes.length).toBeGreaterThan(0)
    expect(projection.obligations.length).toBeGreaterThan(0)
  })
})

describe('diff-geometry', () => {
  const measured = (entries: ReadonlyArray<Record<string, unknown>>, over: Record<string, unknown> = {}) =>
    JSON.stringify({
      schemaVersion: 1,
      designWidthPx: 375,
      viewportWidthPx: 375,
      rootSourceId: '1:1',
      entries,
      ...over,
    })

  it('exits 0 and says match for a faithful render', async () => {
    const files = {
      'snap.json': await snapshotJson(),
      'measured.json': measured([{ sourceId: '1:1', x: 0, y: 0, width: 375, height: 900 }]),
    }
    const { impl, out } = io(files)
    const code = await main(
      ['diff-geometry', '--snapshot', 'snap.json', '--roots', '1:1', '--measured', 'measured.json'],
      impl,
    )
    expect(code).toBe(0)
    const report = JSON.parse(out.join('\n')) as {
      verdict: string
      matchedCount: number
      unmeasuredRendered: string[]
    }
    expect(report.verdict).toBe('match')
    expect(report.matchedCount).toBe(1)
    // The body frame was never mapped: coverage is reported, not failed.
    // (The text node has no geometry in the fixture, so it is not listed.)
    expect(report.unmeasuredRendered).toEqual(['1:3'])
  })

  it('exits 1 with the offending slot when the render drifts', async () => {
    const files = {
      'snap.json': await snapshotJson(),
      'measured.json': measured([{ sourceId: '1:3', x: 0, y: 126, width: 375, height: 700 }]),
    }
    const { impl, out } = io(files)
    const code = await main(
      ['diff-geometry', '--snapshot', 'snap.json', '--roots', '1:1', '--measured', 'measured.json'],
      impl,
    )
    expect(code).toBe(1)
    const report = JSON.parse(out.join('\n')) as {
      verdict: string
      mismatches: ReadonlyArray<{ sourceId: string; slot: string; deltaPx: number }>
    }
    expect(report.verdict).toBe('mismatch')
    expect(report.mismatches).toEqual([{ sourceId: '1:3', slot: 'y', expectedPx: 100, measuredPx: 126, deltaPx: 26 }])
  })

  it('scales by the viewport factor only when the caller owns the assumption', async () => {
    const k = 500 / 375
    const files = {
      'snap.json': await snapshotJson(),
      'measured.json': measured([{ sourceId: '1:3', x: 0, y: 100 * k, width: 375 * k, height: 700 * k }], {
        viewportWidthPx: 500,
      }),
    }
    // Without --allow-scaling the width mismatch is an error, not a guess.
    const denied = io(files)
    expect(
      await main(['diff-geometry', '--snapshot', 'snap.json', '--roots', '1:1', '--measured', 'measured.json'], denied.impl),
    ).toBe(2)
    expect(denied.err.join()).toContain('allowScaling')

    const allowed = io(files)
    const code = await main(
      ['diff-geometry', '--snapshot', 'snap.json', '--roots', '1:1', '--measured', 'measured.json', '--allow-scaling'],
      allowed.impl,
    )
    expect(code).toBe(0)
  })

  it('turns coverage gaps into failure under --require-coverage', async () => {
    const files = {
      'snap.json': await snapshotJson(),
      'measured.json': measured([{ sourceId: '1:1', x: 0, y: 0, width: 375, height: 900 }]),
    }
    const relaxed = io(files)
    expect(
      await main(['diff-geometry', '--snapshot', 'snap.json', '--roots', '1:1', '--measured', 'measured.json'], relaxed.impl),
    ).toBe(0)

    const scored = io(files)
    const code = await main(
      ['diff-geometry', '--snapshot', 'snap.json', '--roots', '1:1', '--measured', 'measured.json', '--require-coverage'],
      scored.impl,
    )
    expect(code).toBe(1)
    const report = JSON.parse(scored.out.join('\n')) as { verdict: string; coverageRequired: boolean }
    expect(report.coverageRequired).toBe(true)
    expect(report.verdict).toBe('mismatch')
  })

  it('reads the node budget too, and says what the budget kept out (REG-CLI-011)', async () => {
    const files = {
      'snap.json': await snapshotJson(),
      'measured.json': measured([{ sourceId: '1:1', x: 0, y: 0, width: 375, height: 900 }]),
    }
    const { impl, out } = io(files)
    const code = await main(
      ['diff-geometry', '--snapshot', 'snap.json', '--roots', '1:1', '--measured', 'measured.json', '--max-nodes', '1'],
      impl,
    )
    expect(code).toBe(0)
    const report = JSON.parse(out.join('\n')) as {
      verdict: string
      unmeasuredRendered: string[]
      omitted: { notRendered: number; maxDepth: number; maxNodes: number }
    }
    // The body frame never entered the slice, so it is not a coverage gap —
    // but a "match" that quietly compared one node would be a lie, so the
    // report says what the budget kept out.
    expect(report.verdict).toBe('match')
    expect(report.unmeasuredRendered).toEqual([])
    expect(report.omitted.maxNodes).toBeGreaterThan(0)
  })

  it('spells out the measured contract version and every exclusion field, target or not', async () => {
    // A v2 file: the text node is excused as the inside of a placeholder,
    // and the body frame is excluded with a claim the slice refutes.
    const files = {
      'snap.json': await snapshotJson(),
      'measured.json': measured(
        [{ sourceId: '1:1', x: 0, y: 0, width: 375, height: 900, tagName: 'SECTION' }],
        {
          schemaVersion: 2,
          exclusions: [
            { sourceId: '1:3', kind: 'derived-from-children' },
            { sourceId: '1:2', kind: 'native-control-internal', targetSourceId: '1:1' },
          ],
        },
      ),
    }
    const { impl, out } = io(files)
    await main(['diff-geometry', '--snapshot', 'snap.json', '--roots', '1:1', '--measured', 'measured.json'], impl)
    const report = JSON.parse(out.join('\n')) as {
      measuredSchemaVersion: number
      exclusions: ReadonlyArray<{ sourceId: string; kind: string; targetSourceId: string | null }>
      invalidExclusions: ReadonlyArray<{ sourceId: string; reason: string }>
    }
    expect(report.measuredSchemaVersion).toBe(2)
    expect(report.exclusions).toEqual([
      { sourceId: '1:2', kind: 'native-control-internal', targetSourceId: '1:1' },
      { sourceId: '1:3', kind: 'derived-from-children', targetSourceId: null },
    ])
    // Both claims fail against this design, and each failure names its condition.
    expect(report.invalidExclusions.map((entry) => entry.sourceId)).toEqual(['1:2', '1:3'])
  })

  it('rejects a malformed measured file loudly', async () => {
    const files = { 'snap.json': await snapshotJson(), 'measured.json': JSON.stringify({ schemaVersion: 1 }) }
    const { impl } = io(files)
    expect(
      await main(['diff-geometry', '--snapshot', 'snap.json', '--roots', '1:1', '--measured', 'measured.json'], impl),
    ).toBe(2)
  })
})

describe('diagnostics', () => {
  it('exits zero when the design passes', async () => {
    const files = { 'snap.json': await snapshotJson(), 'rules.json': RULESET, 'config.json': CONFIG }
    const { impl, out } = io(files)
    const code = await main(
      ['diagnostics', '--snapshot', 'snap.json', '--ruleset', 'rules.json', '--config', 'config.json'],
      impl,
    )
    expect(code).toBe(0)
    const report = JSON.parse(out.join('\n')) as { findings: unknown[]; applied: unknown[]; derivation: unknown[] }
    expect(report.findings).toEqual([])
    expect(report.applied).toHaveLength(1)
    expect(Array.isArray(report.derivation)).toBe(true)
  })

  it('exits non-zero on a blocking finding, so a script need not parse the output', async () => {
    const files = {
      'snap.json': await snapshotJson(),
      'rules.json': JSON.stringify({ rules: [{ use: 'figma.text-style-name.v2', params: {} }] }),
      // A convention this design deliberately does not follow.
      'config.json': JSON.stringify({
        styleNames: { pattern: '{group}/{purpose}/{breakpoint}/{language}', allowed: { breakpoint: ['xs'], language: ['fr'] } },
      }),
    }
    const { impl, out } = io(files)
    const code = await main(
      ['diagnostics', '--snapshot', 'snap.json', '--ruleset', 'rules.json', '--config', 'config.json'],
      impl,
    )
    expect(code).toBe(1)
    expect((JSON.parse(out.join('\n')) as { findings: unknown[] }).findings.length).toBeGreaterThan(0)
  })

  it('refuses a configuration with a misspelled key rather than checking nothing (REG-CONF-017)', async () => {
    const files = {
      'snap.json': await snapshotJson(),
      'rules.json': JSON.stringify({ rules: [{ use: 'figma.text-style-name.v2', params: {} }] }),
      'config.json': JSON.stringify({ styleNames: { pattern: '{group}/{purpose}/{breakpoint}/{language}', alowed: {} } }),
    }
    const { impl, err } = io(files)
    expect(
      await main(['diagnostics', '--snapshot', 'snap.json', '--ruleset', 'rules.json', '--config', 'config.json'], impl),
    ).toBe(2)
    expect(err.join()).toContain('unknown key')
  })

  it('refuses to run a naming rule without a declared convention', async () => {
    const files = {
      'snap.json': await snapshotJson(),
      'rules.json': JSON.stringify({ rules: [{ use: 'figma.text-style-name.v2', params: {} }] }),
    }
    const { impl, err } = io(files)
    expect(await main(['diagnostics', '--snapshot', 'snap.json', '--ruleset', 'rules.json'], impl)).toBe(2)
    expect(err.join()).toContain('styleNames declaration')
  })

  it('refuses to run without a ruleset', async () => {
    const { impl, err } = io({ 'snap.json': await snapshotJson() })
    expect(await main(['diagnostics', '--snapshot', 'snap.json'], impl)).toBe(2)
    expect(err.join()).toContain('--ruleset is required')
  })
})

describe('verify-fresh', () => {
  it('accepts a snapshot whose file has not moved', async () => {
    const { impl, out } = io({ 'snap.json': await snapshotJson() })
    const code = await main(['verify-fresh', '--snapshot', 'snap.json', '--current-version', '1000000000000000001'], impl)
    expect(code).toBe(0)
    expect((JSON.parse(out.join('\n')) as { fresh: boolean }).fresh).toBe(true)
  })

  it('exits non-zero when the design has moved on', async () => {
    const { impl, out } = io({ 'snap.json': await snapshotJson() })
    const code = await main(['verify-fresh', '--snapshot', 'snap.json', '--current-version', '9999'], impl)
    expect(code).toBe(1)
    const result = JSON.parse(out.join('\n')) as { fresh: boolean; storedVersion: string }
    expect(result.fresh).toBe(false)
    expect(result.storedVersion).toBe('1000000000000000001')
  })
})

describe('the shipped examples', () => {
  it('load and run together: the config declares the conventions, the ruleset reads them', async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../examples')
    const files = {
      'snap.json': await snapshotJson(),
      'config.yaml': readFileSync(resolve(root, 'example-web.config.yaml'), 'utf8'),
      'rules.yaml': readFileSync(resolve(root, 'example-web.ruleset.yaml'), 'utf8'),
    }
    const { impl, out, err } = io(files)
    const code = await main(
      ['diagnostics', '--snapshot', 'snap.json', '--ruleset', 'rules.yaml', '--config', 'config.yaml'],
      impl,
    )
    expect(err).toEqual([])
    // The synthetic page follows the convention, so the examples report a clean file.
    expect(code).toBe(0)
    const report = JSON.parse(out.join('\n')) as { applied: Array<{ id: string }> }
    expect(report.applied.map((entry) => entry.id)).toEqual([
      'figma.text-style-name.v2',
      'responsive.text-style-font-consistency.v2',
      'artboard.expected-width.v2',
      'responsive.group-completeness.v1',
      'responsive.item-count-consistency.v1',
      'layout.content-root-auto-layout.v2',
    ])
  })
})

describe('rulesets in YAML', () => {
  it('reads a hand-written ruleset with its comments', async () => {
    const files = {
      'snap.json': await snapshotJson(),
      'rules.yaml': [
        '# The convention this project actually uses.',
        'rules:',
        '  - use: figma.text-style-name.v2',
        '    severity: error',
        '    params:',
        '      # Styles from another library live outside this convention on purpose.',
        '      exemptPrefixes: [promo/]',
      ].join('\n'),
      'config.json': CONFIG,
    }
    const { impl, out } = io(files)
    const code = await main(
      ['diagnostics', '--snapshot', 'snap.json', '--ruleset', 'rules.yaml', '--config', 'config.json'],
      impl,
    )
    expect(code).toBe(0)
    expect((JSON.parse(out.join('\n')) as { applied: unknown[] }).applied).toHaveLength(1)
  })

  it('reports a YAML syntax error against the file it came from', async () => {
    const files = { 'snap.json': await snapshotJson(), 'rules.yaml': 'rules:\n  - use: [unclosed' }
    const { impl, err } = io(files)
    expect(await main(['diagnostics', '--snapshot', 'snap.json', '--ruleset', 'rules.yaml'], impl)).toBe(2)
    expect(err.join()).toContain('rules.yaml')
  })
})

describe('reading a snapshot file', () => {
  it('rejects one whose contents no longer match its digests', async () => {
    const stored = JSON.parse(await snapshotJson()) as { styles: Array<[string, { name: string }]> }
    const first = stored.styles[0]
    if (first !== undefined) first[1].name = 'tampered'
    const { impl, err } = io({ 'snap.json': JSON.stringify(stored) })
    expect(await main(['export-slice', '--snapshot', 'snap.json', '--roots', '1:1'], impl)).toBe(2)
    expect(err.join()).toContain('digests')
  })

  it('rejects a file that is not a snapshot', async () => {
    const { impl, err } = io({ 'snap.json': '{"hello":"world"}' })
    expect(await main(['export-slice', '--snapshot', 'snap.json', '--roots', '1:1'], impl)).toBe(2)
    expect(err.join()).toContain('not a snapshot file')
  })
})

describe('list-frames', () => {
  // A page whose views sit inside a section; the section is registered as a
  // root too, since a shallow read of its id answers with its children.
  const sectioned = () => {
    const section = frame('6:1', 'hours', { x: 0, y: 0, width: 3000, height: 1000 }, {
      type: 'SECTION',
      children: [
        frame('6:2', 'hours_375', { x: 0, y: 0, width: 375, height: 100 }),
        frame('6:3', 'hours_768', { x: 0, y: 0, width: 768, height: 100 }),
      ],
    })
    const page = frame('1:1', 'page', { x: 0, y: 0, width: 0, height: 0 }, {
      type: 'CANVAS',
      children: [frame('2:1', 'nav_375', { x: 0, y: 0, width: 375, height: 100 }), section],
    })
    return { ...design([page, section]), pages: [{ id: '1:1', name: 'page', type: 'CANVAS' }] }
  }
  const deps = { makeClient: () => fixtureClient(sectioned()), now }
  type Listed = {
    schemaVersion: number
    ungrouped: Array<Record<string, unknown>>
    groups: Array<{ members: Array<Record<string, unknown>> }>
    sections: Array<Record<string, unknown>>
  }

  it('spells out sectionPath on every frame and lists the sections apart, whether or not a pattern is given (REG-DISC-018)', async () => {
    const plain = io({}, { FIGMA_TOKEN: 'token' })
    expect(await main(['list-frames', '--file', KEY_TEXT, '--page', '1:1'], plain.impl, deps)).toBe(0)
    const listed = JSON.parse(plain.out.join('\n')) as Listed
    expect(listed.schemaVersion).toBe(2)
    // Exact shapes: a field that goes missing on one kind of entry is the
    // defect the wire rule exists to prevent, so nothing here is "contains".
    expect(listed.ungrouped).toEqual([
      { id: '2:1', name: 'nav_375', type: 'FRAME', measuredWidth: 375, measuredHeight: 100, sectionPath: [] },
      { id: '6:2', name: 'hours_375', type: 'FRAME', measuredWidth: 375, measuredHeight: 100, sectionPath: [{ id: '6:1', name: 'hours' }] },
      { id: '6:3', name: 'hours_768', type: 'FRAME', measuredWidth: 768, measuredHeight: 100, sectionPath: [{ id: '6:1', name: 'hours' }] },
    ])
    expect(listed.sections).toEqual([
      { id: '6:1', name: 'hours', type: 'SECTION', measuredWidth: 3000, measuredHeight: 1000, sectionPath: [] },
    ])

    const grouped = io({}, { FIGMA_TOKEN: 'token' })
    expect(
      await main(
        ['list-frames', '--file', KEY_TEXT, '--page', '1:1', '--pattern', '{section}_{width}', '--breakpoints', 'sm=375,md=768'],
        grouped.impl,
        deps,
      ),
    ).toBe(0)
    const byPattern = JSON.parse(grouped.out.join('\n')) as Listed
    expect(byPattern.groups.flatMap((group) => group.members)).toEqual([
      { breakpoint: 'sm', widthInName: 375, id: '6:2', name: 'hours_375', type: 'FRAME', measuredWidth: 375, measuredHeight: 100, sectionPath: [{ id: '6:1', name: 'hours' }] },
      { breakpoint: 'md', widthInName: 768, id: '6:3', name: 'hours_768', type: 'FRAME', measuredWidth: 768, measuredHeight: 100, sectionPath: [{ id: '6:1', name: 'hours' }] },
      { breakpoint: 'sm', widthInName: 375, id: '2:1', name: 'nav_375', type: 'FRAME', measuredWidth: 375, measuredHeight: 100, sectionPath: [] },
    ])
    expect(byPattern.sections).toHaveLength(1)
  })
})

describe('acquire', () => {
  const deps = {
    makeClient: () => fixtureClient(pageData()),
    now,
  }

  it('refuses to run without a credential, and says where it looks', async () => {
    const { impl, err } = io({})
    expect(await main(['acquire', '--file', KEY_TEXT, '--roots', '1:1', '--out', 'snap.json'], impl)).toBe(2)
    expect(err.join()).toContain('FIGMA_TOKEN')
  })

  it('requires an output path rather than picking one', async () => {
    const { impl, err } = io({}, { FIGMA_TOKEN: 'token-for-tests' })
    expect(await main(['acquire', '--file', KEY_TEXT, '--roots', '1:1'], impl)).toBe(2)
    expect(err.join()).toContain('--out is required')
  })

  it('rejects an implausible file key before reaching the network', async () => {
    const { impl, err } = io({}, { FIGMA_TOKEN: 'token-for-tests' })
    expect(await main(['acquire', '--file', 'x', '--roots', '1:1', '--out', 'snap.json'], impl)).toBe(2)
    expect(err.join()).toContain('file key')
  })

  it('writes a snapshot the rest of the pipeline can read', async () => {
    const { impl, out, written } = io({}, { FIGMA_TOKEN: 'token-for-tests' })
    const code = await main(['acquire', '--file', KEY_TEXT, '--roots', '1:1', '--out', 'snap.json'], impl, deps)
    expect(code).toBe(0)
    const restored = storedToSnapshot(JSON.parse(written['snap.json'] as string) as unknown)
    expect(restored.nodes.size).toBe(1)
    const summary = JSON.parse(out.join('\n')) as { nodes: number; sourceVersion: string }
    expect(summary.nodes).toBe(1)
    expect(summary.sourceVersion).toBe('1000000000000000001')
  })

  it('asks for vector paths only when told to, and says which it did (REG-ACQ-015)', async () => {
    const plain = io({}, { FIGMA_TOKEN: 'token-for-tests' })
    await main(['acquire', '--file', KEY_TEXT, '--roots', '1:1', '--out', 'snap.json'], plain.impl, deps)
    expect((JSON.parse(plain.out.join('\n')) as { geometry: string }).geometry).toBe('none')
    const withPaths = io({}, { FIGMA_TOKEN: 'token-for-tests' })
    await main(
      ['acquire', '--file', KEY_TEXT, '--roots', '1:1', '--out', 'snap.json', '--geometry', 'paths'],
      withPaths.impl,
      deps,
    )
    expect((JSON.parse(withPaths.out.join('\n')) as { geometry: string }).geometry).toBe('paths')
    const restored = storedToSnapshot(JSON.parse(withPaths.written['snap.json'] as string) as unknown)
    expect(restored.identity.geometry).toBe('paths')
    const wrong = io({}, { FIGMA_TOKEN: 'token-for-tests' })
    expect(
      await main(['acquire', '--file', KEY_TEXT, '--roots', '1:1', '--out', 'x.json', '--geometry', 'all'], wrong.impl, deps),
    ).toBe(2)
    expect(wrong.err.join()).toContain('--geometry takes only: paths')
  })

  it('refuses to replace an existing capture without being told to', async () => {
    // A mistyped path should not destroy something that cost a credential and
    // a network round trip.
    const { impl, err, written } = io({ 'snap.json': '{"existing":true}' }, { FIGMA_TOKEN: 'token-for-tests' })
    const code = await main(['acquire', '--file', KEY_TEXT, '--roots', '1:1', '--out', 'snap.json'], impl, deps)
    expect(code).toBe(2)
    expect(err.join()).toContain('--force')
    expect(written['snap.json']).toBeUndefined()
  })

  it('replaces it when told to', async () => {
    const { impl, written } = io({ 'snap.json': '{"existing":true}' }, { FIGMA_TOKEN: 'token-for-tests' })
    const code = await main(
      ['acquire', '--file', KEY_TEXT, '--roots', '1:1', '--out', 'snap.json', '--force'],
      impl,
      deps,
    )
    expect(code).toBe(0)
    expect(written['snap.json']).toBeDefined()
  })

  it('turns a rejected request into an exit code without printing the token', async () => {
    const failing = {
      makeClient: () => ({
        getFileMeta: () => Promise.reject(new Error('GET /files/x failed with 403')),
        getNodes: () => Promise.reject(new Error('unreachable')),
      }),
      now,
    }
    const { impl, err, written } = io({}, { FIGMA_TOKEN: 'secret-value-for-tests' })
    const code = await main(['acquire', '--file', KEY_TEXT, '--roots', '1:1', '--out', 'snap.json'], impl, failing as never)
    expect(code).toBe(2)
    expect(err.join()).toContain('403')
    expect(err.join()).not.toContain('secret-value-for-tests')
    expect(written['snap.json']).toBeUndefined()
  })
})

describe('usage', () => {
  it('explains itself when asked for nothing', async () => {
    const { impl, err } = io({})
    expect(await main([], impl)).toBe(2)
    expect(err.join()).toContain('export-slice')
  })

  it('names an unknown command', async () => {
    const { impl, err } = io({})
    expect(await main(['frobnicate'], impl)).toBe(2)
    expect(err.join()).toContain('unknown command')
  })

  it('prints usage on stdout with a zero exit when asked, wherever --help sits (REG-CLI-011)', async () => {
    for (const argv of [['help'], ['--help'], ['diff-geometry', '--help'], ['export-slice', '--snapshot', 'snap.json', '--help']]) {
      const { impl, out, err } = io({})
      expect(await main(argv, impl), argv.join(' ')).toBe(0)
      expect(out.join('\n')).toContain('diff-geometry --snapshot')
      expect(err).toEqual([])
    }
  })

  it('rejects an option the command does not take instead of ignoring it (REG-CLI-011)', async () => {
    const { impl, err, out } = io({ 'snap.json': await snapshotJson() })
    expect(await main(['export-slice', '--snapshot', 'snap.json', '--roots', '1:1', '--max-nodez', '5'], impl)).toBe(2)
    expect(err.join()).toContain('unknown option --max-nodez for export-slice')
    expect(out).toEqual([])
  })

  it('rejects an option given twice rather than letting the last one win (REG-CLI-011)', async () => {
    const { impl, err } = io({})
    expect(await main(['export-slice', '--snapshot', 'a.json', '--snapshot', 'b.json', '--roots', '1:1'], impl)).toBe(2)
    expect(err.join()).toContain('--snapshot given twice')
  })

  it('rejects an option that is missing its value (REG-CLI-011)', async () => {
    const { impl, err } = io({})
    expect(await main(['export-slice', '--snapshot', '--roots', '1:1'], impl)).toBe(2)
    expect(err.join()).toContain('--snapshot needs a value')
  })

  it('does not let a flag swallow the token after it', async () => {
    const { impl, err } = io({})
    // --force takes no value; the file key after it is a stray argument, not its value.
    expect(await main(['acquire', '--force', 'KEY', '--file', 'KEY', '--roots', '1:1', '--out', 'x'], impl)).toBe(2)
    expect(err.join()).toContain('unexpected argument: KEY')
  })
})
