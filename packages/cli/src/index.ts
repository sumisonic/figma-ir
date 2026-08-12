/**
 * The command line.
 *
 * A thin wrapper over the library, and deliberately narrow: each command is
 * one thing a consumer needs before or while it works. Anything that only
 * helps a human read the output can wait until a human is reading it.
 *
 * Three commands contact Figma — `list-pages`, `list-frames` and `acquire` —
 * and those are the only ones that read a credential. Every other command
 * reads a snapshot file, so it is safe to run anywhere and answers the same
 * way twice.
 */
import { existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'

import { parse as parseYaml } from 'yaml'

import {
  acquireSnapshot,
  httpFigmaClient,
  fileKey,
  snapshotToStored,
  cutSlice,
  DEFAULT_MAX_NODES,
  decodeFactConfig,
  decodeMeasuredGeometry,
  deriveFacts,
  diffGeometry,
  geometryReportFails,
  listPageContents,
  listPages,
  fromSnapshot,
  loadRuleset,
  runRules,
  sliceEnvelope,
  storedToSnapshot,
  type FactConfig,
  type FigmaClient,
  type Ruleset,
} from '@figma-ir/core'
import { checkObligations, consumptionReportFails, decodeConsumptionLedger, projectWeb, projectionEnvelope } from '@figma-ir/web-projection'

export interface CliIO {
  readonly readFile: (path: string) => string
  readonly exists: (path: string) => boolean
  /** Writes so that the destination is either the old file or the whole new one. */
  readonly writeFile: (path: string, text: string) => void
  readonly write: (text: string) => void
  readonly writeError: (text: string) => void
  readonly env: (name: string) => string | undefined
}

export const nodeIO: CliIO = {
  readFile: (path) => readFileSync(path, 'utf8'),
  exists: (path) => existsSync(path),
  /**
   * Writes beside the destination and renames into place.
   *
   * A snapshot is read back and digest-checked, so a half-written one is caught
   * -- but it is caught later, by someone who thought they had a file. Renaming
   * within the same directory is atomic, so the destination is either the old
   * file or the whole new one.
   */
  writeFile: (path, text) => {
    const temporary = `${path}.partial`
    try {
      writeFileSync(temporary, text, 'utf8')
      renameSync(temporary, path)
    } catch (error) {
      try {
        unlinkSync(temporary)
      } catch {
        // Nothing useful to do about a failed cleanup; the original error matters.
      }
      throw error
    }
  },
  write: (text) => process.stdout.write(`${text}\n`),
  writeError: (text) => process.stderr.write(`${text}\n`),
  env: (name) => process.env[name],
}

export class CliError extends Error {
  readonly _tag = 'CliError'
  readonly exitCode: number
  constructor(message: string, exitCode = 2) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
  }
}

const USAGE = `figma-ir <command> [options]
figma-ir help | figma-ir <command> --help

Commands:
  list-pages --file <fileKey>
      List the file's pages. The entry point when you have no node ids.
      Contacts Figma; needs a credential (reads FIGMA_TOKEN).

  list-frames --file <fileKey> --page <pageId> [--pattern '{section}_{width}'] [--breakpoints sm=375,...]
      List a page's frames (the type is reported), descending into sections:
      a frame inside one carries its sectionPath, and the sections themselves
      are listed apart, since a section is not a root. Grouped by the naming
      convention when one is given: the pattern names {section} and {width}
      (px) and/or {breakpoint} (a slot from --breakpoints). Contacts Figma;
      needs a credential.

  acquire --file <fileKey> --roots <id,id> --out <file> [--geometry paths] [--force]
      Fetch a snapshot from Figma and write it to a file.
      Contacts Figma; needs a credential. Refuses to replace an existing
      file unless --force is given. Vector paths come only with
      --geometry paths (the API omits them otherwise, and a production
      snapshot grows several times larger with them); without it every
      node's shape reads as unknown, never as empty.

  export-slice --snapshot <file> --roots <id,id> [--max-depth N] [--max-nodes N] [--include-hidden] [--config <file>] [--ruleset <file>]
      Print the bounded view of a design that a consumer should read.

  export-projection --snapshot <file> --roots <id,id> [--max-depth N] [--max-nodes N] [--config <file>]
      Print the web projection: layout meaning translated from declarations
      and verified against the geometry. Values outside the supported subset
      come back as unknown; a prediction that misses the observed geometry
      demotes the claim and raises GEOMETRY_CONTRADICTION.

  diff-geometry --snapshot <file> --roots <id,id> --measured <file> [--tolerance 0.25] [--text-tolerance N] [--text-tolerance-per-line N] [--require-coverage] [--require-elements] [--allow-scaling] [--max-depth N] [--max-nodes N] [--include-hidden] [--config <file>]
      Compare browser-measured geometry against the slice. The expected table
      comes from the IR, never from the implementation being verified.
      Exit code 1 on any mismatch or wrong mapping; coverage gaps only inform
      unless --require-coverage (scoring mode: measure everything or fail).
      A viewport that differs from the design width needs --allow-scaling,
      which asserts every length scales with the viewport (a target written in vw).
      Text y/height gets its own budget (base + per-line × estimated lines);
      raw deltas stay on the record either way, and a height jump of about a
      line is reported as a wrap flip, which no budget absorbs.

  check-obligations --snapshot <file> --roots <id,id> --consumption <file> [--max-depth N] [--max-nodes N] [--config <file>]
      Check a consumer's ledger against the projection's obligations. Every
      issued obligation must be consumed or excused with a reason; an entry
      for an obligation that was never issued fails too. Declared exceptions
      are recorded as candidates and fail — approvals are a later problem.

  diagnostics --snapshot <file> --ruleset <file> [--config <file>]
      Print what the rules found. Exit code 1 if anything is blocking.

  verify-fresh --snapshot <file> --current-version <version>
      Compare a stored snapshot's version with one you fetched (list-pages
      prints it). Offline: it compares, it does not ask Figma.

Rulesets and configs may be JSON or YAML; the extension decides.

Node budget: export-slice, export-projection, diff-geometry and
check-obligations stop after --max-nodes nodes (default ${DEFAULT_MAX_NODES}).
A subtree the budget cut off is listed under omitted with reason max-nodes,
never dropped in silence; raise the budget or split the roots.

Options are checked per command: one the command does not take, one given
twice, or one missing its value is an error, not a silent no-op.

list-pages, list-frames and acquire contact Figma and read FIGMA_TOKEN. Every
other command reads a snapshot file and never contacts Figma, so it is safe to
run anywhere and answers the same way twice.`

interface Args {
  readonly command: string
  readonly options: ReadonlyMap<string, string | true>
}

type Parsed = { readonly kind: 'help' } | { readonly kind: 'command'; readonly args: Args }

/**
 * What each command takes: options that carry a value, and bare flags.
 *
 * The table exists because a parser that accepts anything reports nothing.
 * `--max-nodes` on a command that did not read it was a no-op,
 * and so was every typo (REG-CLI-011). An option the command does not take is
 * now an error, and so is one given twice — the second value used to win in
 * silence.
 */
interface OptionSpec {
  readonly values: ReadonlyArray<string>
  readonly flags: ReadonlyArray<string>
}

const BUDGET = ['max-depth', 'max-nodes'] as const

const COMMAND_TABLE: Readonly<Record<string, OptionSpec>> = {
  'list-pages': { values: ['file'], flags: [] },
  'list-frames': { values: ['file', 'page', 'pattern', 'breakpoints'], flags: [] },
  acquire: { values: ['file', 'roots', 'out', 'geometry'], flags: ['force'] },
  'export-slice': { values: ['snapshot', 'roots', ...BUDGET, 'config', 'ruleset'], flags: ['include-hidden'] },
  'export-projection': { values: ['snapshot', 'roots', ...BUDGET, 'config'], flags: [] },
  'diff-geometry': {
    values: ['snapshot', 'roots', 'measured', 'tolerance', 'text-tolerance', 'text-tolerance-per-line', ...BUDGET, 'config'],
    flags: ['require-coverage', 'require-elements', 'allow-scaling', 'include-hidden'],
  },
  'check-obligations': { values: ['snapshot', 'roots', 'consumption', ...BUDGET, 'config'], flags: [] },
  diagnostics: { values: ['snapshot', 'ruleset', 'config'], flags: [] },
  'verify-fresh': { values: ['snapshot', 'current-version'], flags: [] },
}

/**
 * The table, frozen: exported so documentation can be checked against it,
 * and a consumer that reaches in cannot change what the parser accepts.
 */
export const COMMANDS: Readonly<Record<string, OptionSpec>> = Object.freeze(
  Object.fromEntries(
    Object.entries(COMMAND_TABLE).map(([name, spec]) => [
      name,
      Object.freeze({ values: Object.freeze([...spec.values]), flags: Object.freeze([...spec.flags]) }),
    ]),
  ),
)

const isHelp = (token: string): boolean => token === '--help' || token === '-h'

const parseArgs = (argv: ReadonlyArray<string>): Parsed => {
  const [command, ...rest] = argv
  if (command === undefined) throw new CliError(USAGE)
  if (command === 'help' || isHelp(command)) return { kind: 'help' }
  if (command.startsWith('-')) throw new CliError(USAGE)
  const spec = COMMANDS[command]
  if (spec === undefined) throw new CliError(`unknown command: ${command}\n\n${USAGE}`)

  const options = new Map<string, string | true>()
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] as string
    // Asked anywhere on the line, help wins over every other complaint: the
    // person typing it does not have the options right yet, by definition.
    if (isHelp(token)) return { kind: 'help' }
    if (!token.startsWith('--')) throw new CliError(`unexpected argument: ${token}`)
    const key = token.slice(2)
    if (options.has(key)) throw new CliError(`--${key} given twice`)
    if (spec.flags.includes(key)) {
      options.set(key, true)
      continue
    }
    if (!spec.values.includes(key)) {
      throw new CliError(`unknown option --${key} for ${command}; see figma-ir ${command} --help`)
    }
    const next = rest[index + 1]
    if (next === undefined || next.startsWith('--')) throw new CliError(`--${key} needs a value`)
    options.set(key, next)
    index += 1
  }
  return { kind: 'command', args: { command, options } }
}

const requireOption = (args: Args, key: string): string => {
  const value = args.options.get(key)
  if (typeof value !== 'string') throw new CliError(`--${key} is required`)
  return value
}

const integerOption = (args: Args, key: string): number | undefined => {
  const raw = args.options.get(key)
  if (typeof raw !== 'string') return undefined
  const value = Number(raw)
  if (!Number.isInteger(value)) throw new CliError(`--${key} must be an integer`)
  return value
}

/**
 * The slice budget, read the same way by every command that cuts one.
 *
 * `export-slice` and `diff-geometry` did not read `--max-nodes` at all, so a
 * caller who hit the default budget could not raise it, and the parser of
 * the time did not say so (REG-CLI-011).
 */
const budgetOptions = (args: Args): { readonly maxDepth?: number; readonly maxNodes?: number } => {
  const maxDepth = integerOption(args, 'max-depth')
  const maxNodes = integerOption(args, 'max-nodes')
  return {
    ...(maxDepth === undefined ? {} : { maxDepth }),
    ...(maxNodes === undefined ? {} : { maxNodes }),
  }
}

/**
 * Reads a data file, choosing the parser by extension.
 *
 * Rulesets are meant to be written by hand, which is what YAML is for; the
 * comments explaining why a rule exists are half the value of the file.
 */
const readData = (io: CliIO, path: string): unknown => {
  const text = (() => {
    try {
      return io.readFile(path)
    } catch (cause) {
      throw new CliError(`could not read ${path}: ${(cause as Error).message}`)
    }
  })()
  try {
    return path.endsWith('.yaml') || path.endsWith('.yml')
      ? (parseYaml(text) as unknown)
      : (JSON.parse(text) as unknown)
  } catch (cause) {
    throw new CliError(`could not parse ${path}: ${(cause as Error).message}`)
  }
}

/**
 * Reads a stored snapshot, letting the core verify it.
 *
 * The digest check lives in the library rather than here: a truncated file
 * should be caught wherever a snapshot is read, not only when it arrives
 * through this particular door.
 */
const restoreSnapshot = (raw: unknown) => {
  try {
    return storedToSnapshot(raw)
  } catch (cause) {
    throw new CliError((cause as Error).message)
  }
}

const loadConfig = (io: CliIO, args: Args): FactConfig => {
  const path = args.options.get('config')
  // Validated, not cast: a misspelled key in a configuration is a check the
  // project believes is running and is not (REG-CONF-017).
  return typeof path === 'string' ? decodeFactConfig(readData(io, path)) : {}
}

const loadRules = (io: CliIO, args: Args, required: boolean) => {
  const path = args.options.get('ruleset')
  if (typeof path !== 'string') {
    if (required) throw new CliError('--ruleset is required')
    return undefined
  }
  return loadRuleset(readData(io, path) as Ruleset)
}

/**
 * What the CLI depends on beyond files.
 *
 * The Figma client is injected so the success path can be tested against a
 * recorded fixture. A command whose only tested paths are its argument errors
 * is a command whose real behaviour has never run.
 */
export interface CliDeps {
  readonly makeClient: (token: string) => FigmaClient
  readonly now: () => string
}

export const nodeDeps: CliDeps = {
  makeClient: (token) => httpFigmaClient(token),
  now: () => new Date().toISOString(),
}

export const run = (
  argv: ReadonlyArray<string>,
  io: CliIO = nodeIO,
  deps: CliDeps = nodeDeps,
): number | Promise<number> => {
  const parsed = parseArgs(argv)
  if (parsed.kind === 'help') {
    // Usage on stdout with a zero exit: asking how a tool works is not an error.
    io.write(USAGE)
    return 0
  }
  const args = parsed.args

  if (args.command === 'list-pages' || args.command === 'list-frames') {
    const token = io.env('FIGMA_TOKEN')
    if (token === undefined || token.length === 0) {
      throw new CliError('FIGMA_TOKEN is not set; run this through the credential manager that holds it')
    }
    const client = deps.makeClient(token)
    const key = fileKey(requireOption(args, 'file'))

    if (args.command === 'list-pages') {
      return listPages(client, key).then((listing) => {
        // The version rides along so verify-fresh needs no second fetch.
        io.write(JSON.stringify({ version: listing.version, pages: listing.pages }, null, 2))
        return 0
      })
    }

    const pattern = args.options.get('pattern')
    const breakpointsRaw = args.options.get('breakpoints')
    const breakpoints =
      typeof breakpointsRaw === 'string'
        ? breakpointsRaw.split(',').map((entry) => {
            const [slot, width] = entry.split('=')
            if (slot === undefined || width === undefined || !Number.isInteger(Number(width))) {
              throw new CliError(`--breakpoints entries look like sm=375, got: ${entry}`)
            }
            return { slot, designWidthPx: Number(width) }
          })
        : undefined

    return listPageContents(client, key, requireOption(args, 'page'), {
      ...(typeof pattern === 'string' ? { namePattern: pattern } : {}),
      ...(breakpoints === undefined ? {} : { breakpoints }),
    }).then((contents) => {
      io.write(
        JSON.stringify(
          {
            // 2: sections are descended and listed apart; frames inside them
            // carry sectionPath; frameCount counts frames, not page children.
            // The unversioned shape before it counts as 1 (REG-DISC-018).
            schemaVersion: 2,
            page: contents.page,
            frameCount: contents.frames.length,
            // Every field present, absent ones as null. An undefined field
            // vanishes under JSON.stringify, and a consumer cannot read a key
            // whose presence depends on the answer.
            groups: contents.groups.map((group) => ({
              section: group.section,
              members: group.members.map((member) => ({
                breakpoint: member.breakpoint ?? null,
                widthInName: member.widthInName ?? null,
                id: member.frame.id,
                name: member.frame.name,
                // The pattern reads names, not types: a member is whatever
                // carried a matching name, and the type says whether it is
                // something a consumer can acquire.
                type: member.frame.type,
                measuredWidth: member.frame.width ?? null,
                measuredHeight: member.frame.height ?? null,
                sectionPath: member.frame.sectionPath.map((section) => ({ id: section.id, name: section.name })),
              })),
              // Two frames claiming one breakpoint is a fact about the file,
              // not something to resolve by picking one.
              duplicateBreakpoints: [
                ...new Set(
                  group.members
                    .map((member) => member.breakpoint)
                    .filter(
                      (slot, index, all): slot is string =>
                        slot !== undefined && all.indexOf(slot) !== index,
                    ),
                ),
              ],
            })),
            // Listed, never silently dropped: a frame the pattern did not
            // describe is a fact about the file's naming, and a consumer that
            // saw only the groups would think the page was fully covered.
            ungrouped: contents.ungrouped.map((frame) => ({
              id: frame.id,
              name: frame.name,
              type: frame.type,
              measuredWidth: frame.width ?? null,
              measuredHeight: frame.height ?? null,
              sectionPath: frame.sectionPath.map((section) => ({ id: section.id, name: section.name })),
            })),
            // Sections are organising containers, listed so a reader knows
            // where the frames came from; none of them is a root.
            sections: contents.sections.map((section) => ({
              id: section.id,
              name: section.name,
              type: section.type,
              measuredWidth: section.width ?? null,
              measuredHeight: section.height ?? null,
              sectionPath: section.sectionPath.map((outer) => ({ id: outer.id, name: outer.name })),
            })),
          },
          null,
          2,
        ),
      )
      return 0
    })
  }

  if (args.command === 'acquire') {
    // Kept in this binary rather than a separate one: the boundary that matters
    // is which command needs a secret, and saying so plainly beats splitting
    // the tool in two and hoping the split communicates it.
    const token = io.env('FIGMA_TOKEN')
    if (token === undefined || token.length === 0) {
      throw new CliError('FIGMA_TOKEN is not set; run this through the credential manager that holds it')
    }
    const out = requireOption(args, 'out')
    if (io.exists(out) && args.options.get('force') !== true) {
      // A mistyped path should not be able to destroy a capture that took a
      // credential and a network round trip to make.
      throw new CliError(`${out} already exists; pass --force to replace it`)
    }
    const geometryRaw = args.options.get('geometry')
    if (geometryRaw !== undefined && geometryRaw !== 'paths') throw new CliError('--geometry takes only: paths')
    return acquireSnapshot({
      client: deps.makeClient(token),
      fileKey: fileKey(requireOption(args, 'file')),
      roots: requireOption(args, 'roots').split(','),
      now: deps.now,
      geometry: geometryRaw === 'paths' ? 'paths' : 'none',
    }).then((snapshot) => {
      io.writeFile(out, JSON.stringify(snapshotToStored(snapshot)))
      io.write(
        JSON.stringify(
          {
            out,
            snapshotId: snapshot.identity.snapshotId,
            sourceVersion: snapshot.identity.sourceVersionAtEnd,
            geometry: snapshot.identity.geometry,
            nodes: snapshot.parts.nodes.itemCount,
            styles: snapshot.parts.styles.itemCount,
          },
          null,
          2,
        ),
      )
      return 0
    })
  }

  if (args.command === 'export-slice') {
    const doc = fromSnapshot(restoreSnapshot(readData(io, requireOption(args, 'snapshot'))))
    const facts = deriveFacts(doc, loadConfig(io, args))
    const ruleset = loadRules(io, args, false)
    const findings = ruleset === undefined ? [] : runRules(facts, ruleset).findings

    const slice = cutSlice(
      doc,
      facts,
      {
        roots: requireOption(args, 'roots').split(','),
        ...budgetOptions(args),
        includeHidden: args.options.get('include-hidden') === true,
      },
      findings,
    )
    io.write(JSON.stringify(sliceEnvelope(slice), null, 2))
    return 0
  }

  if (args.command === 'export-projection') {
    const doc = fromSnapshot(restoreSnapshot(readData(io, requireOption(args, 'snapshot'))))
    const facts = deriveFacts(doc, loadConfig(io, args))

    const artifact = projectWeb({
      doc,
      facts,
      request: {
        roots: requireOption(args, 'roots').split(','),
        ...budgetOptions(args),
      },
    })
    io.write(JSON.stringify(projectionEnvelope(artifact), null, 2))
    return 0
  }

  if (args.command === 'check-obligations') {
    const doc = fromSnapshot(restoreSnapshot(readData(io, requireOption(args, 'snapshot'))))
    const facts = deriveFacts(doc, loadConfig(io, args))
    const artifact = projectWeb({
      doc,
      facts,
      request: {
        roots: requireOption(args, 'roots').split(','),
        ...budgetOptions(args),
      },
    })
    const ledger = decodeConsumptionLedger(readData(io, requireOption(args, 'consumption')))
    const report = checkObligations(artifact, ledger)
    const failed = consumptionReportFails(report)
    io.write(
      JSON.stringify(
        {
          projectionHash: report.projectionHash,
          obligationCount: report.obligationCount,
          consumedCount: report.consumedCount,
          notApplicableCount: report.notApplicableCount,
          notApplicable: report.notApplicable.map((entry) => ({
            projectionFactId: entry.projectionFactId,
            reason: entry.reason,
          })),
          unaccounted: [...report.unaccounted],
          unknownFactIds: [...report.unknownFactIds],
          exceptions: report.exceptions.map((exception) => ({
            projectionFactId: exception.projectionFactId,
            reason: exception.reason,
          })),
          verdict: failed ? 'unaccounted' : 'accounted',
        },
        null,
        2,
      ),
    )
    return failed ? 1 : 0
  }

  if (args.command === 'diff-geometry') {
    const doc = fromSnapshot(restoreSnapshot(readData(io, requireOption(args, 'snapshot'))))
    const facts = deriveFacts(doc, loadConfig(io, args))

    const slice = cutSlice(doc, facts, {
      roots: requireOption(args, 'roots').split(','),
      ...budgetOptions(args),
      includeHidden: args.options.get('include-hidden') === true,
    })

    const measured = decodeMeasuredGeometry(readData(io, requireOption(args, 'measured')))
    const toleranceRaw = args.options.get('tolerance')
    const tolerance = typeof toleranceRaw === 'string' ? Number(toleranceRaw) : undefined
    if (tolerance !== undefined && (!Number.isFinite(tolerance) || tolerance < 0)) {
      throw new CliError('--tolerance must be a non-negative number')
    }

    const numberOption = (key: string): number | undefined => {
      const raw = args.options.get(key)
      if (typeof raw !== 'string') return undefined
      const value = Number(raw)
      if (!Number.isFinite(value) || value < 0) throw new CliError(`--${key} must be a non-negative number`)
      return value
    }
    const textTolerance = numberOption('text-tolerance')
    const textTolerancePerLine = numberOption('text-tolerance-per-line')
    const report = diffGeometry(slice, measured, {
      ...(tolerance === undefined ? {} : { tolerancePx: tolerance }),
      ...(textTolerance === undefined ? {} : { textTolerancePx: textTolerance }),
      ...(textTolerancePerLine === undefined ? {} : { textTolerancePerLinePx: textTolerancePerLine }),
      allowScaling: args.options.get('allow-scaling') === true,
    })
    const requireCoverage = args.options.get('require-coverage') === true
    const requireElements = args.options.get('require-elements') === true
    const failed = geometryReportFails(report, { requireCoverage, requireElements })
    io.write(
      JSON.stringify(
        {
          snapshotId: slice.snapshotId,
          sourceVersion: slice.sourceVersion,
          rootSourceId: report.rootSourceId,
          measuredSchemaVersion: report.measuredSchemaVersion,
          designWidthPx: report.designWidthPx,
          // The measuring conditions travel with the verdict: a saved "match"
          // must say whether it compared at the design width or was scaled.
          viewportWidthPx: report.viewportWidthPx,
          scaled: report.scaled,
          tolerancePx: report.tolerancePx,
          textTolerancePx: report.textTolerancePx,
          textTolerancePerLinePx: report.textTolerancePerLinePx,
          comparedCount: report.comparedCount,
          matchedCount: report.matchedCount,
          mismatches: report.mismatches.map((mismatch) => ({
            sourceId: mismatch.sourceId,
            slot: mismatch.slot,
            expectedPx: mismatch.expectedPx,
            measuredPx: mismatch.measuredPx,
            deltaPx: mismatch.deltaPx,
          })),
          textMetricDeltas: report.textMetricDeltas.map((delta) => ({
            sourceId: delta.sourceId,
            slot: delta.slot,
            expectedPx: delta.expectedPx,
            measuredPx: delta.measuredPx,
            deltaPx: delta.deltaPx,
            boundPx: delta.boundPx,
            classification: delta.classification,
          })),
          wrapFlips: report.wrapFlips.map((flip) => ({
            sourceId: flip.sourceId,
            expectedPx: flip.expectedPx,
            measuredPx: flip.measuredPx,
            deltaPx: flip.deltaPx,
            lineHeightPx: flip.lineHeightPx,
            lineDelta: flip.lineDelta,
            residualPx: flip.residualPx,
          })),
          exclusions: report.exclusions.map((exclusion) => ({
            sourceId: exclusion.sourceId,
            kind: exclusion.kind,
            targetSourceId: 'targetSourceId' in exclusion ? exclusion.targetSourceId : null,
          })),
          invalidExclusions: report.invalidExclusions.map((entry) => ({
            sourceId: entry.sourceId,
            reason: entry.reason,
          })),
          entriesWithoutElement: [...report.entriesWithoutElement],
          elementsRequired: requireElements,
          sharedElements: report.sharedElements.map((shared) => ({
            element: shared.element,
            sourceIds: [...shared.sourceIds],
          })),
          unknownSourceIds: [...report.unknownSourceIds],
          withoutExpectedBox: [...report.withoutExpectedBox],
          // Coverage, not verdict: "matched what I measured" and "matched
          // everything" are different claims, and the report keeps them apart.
          unmeasuredRenderedCount: report.unmeasuredRendered.length,
          unmeasuredRendered: [...report.unmeasuredRendered],
          // What never entered the comparison. A node the budget cut off is
          // not "unmeasured" — it was never expected — so a match on a cut
          // slice would otherwise read as a match on the whole design.
          omitted: {
            notRendered: slice.omitted.filter((entry) => entry.reason === 'not-rendered').length,
            maxDepth: slice.omitted.filter((entry) => entry.reason === 'max-depth').length,
            maxNodes: slice.omitted.filter((entry) => entry.reason === 'max-nodes').length,
          },
          coverageRequired: requireCoverage,
          verdict: failed ? 'mismatch' : 'match',
        },
        null,
        2,
      ),
    )
    return failed ? 1 : 0
  }

  if (args.command === 'diagnostics') {
    const doc = fromSnapshot(restoreSnapshot(readData(io, requireOption(args, 'snapshot'))))
    const facts = deriveFacts(doc, loadConfig(io, args))
    const ruleset = loadRules(io, args, true)
    if (ruleset === undefined) throw new CliError('--ruleset is required')
    const result = runRules(facts, ruleset)

    io.write(
      JSON.stringify(
        {
          canonicalHash: doc.canonicalHash,
          applied: result.applied,
          // The fact layer's own diagnostics travel alongside the findings: a
          // group that could not be lined up is not a rule violation, and a
          // reader that saw only rule output would think the file was checked
          // more thoroughly than it was.
          derivation: facts.diagnostics,
          // Every field named, as the wire rule asks: a spread would carry
          // whichever keys the domain object happened to have.
          findings: result.findings.map((finding) => ({
            ruleId: finding.ruleId,
            ruleVersion: finding.ruleVersion,
            severity: finding.severity,
            reason: finding.reason,
            findingId: finding.findingId,
            target: finding.target,
            message: finding.message,
            sourceIds: [...finding.sourceIds],
            evidence: finding.evidence.map((value) => value as string),
          })),
        },
        null,
        2,
      ),
    )
    return result.findings.some((finding) => finding.severity === 'error') ? 1 : 0
  }

  if (args.command === 'verify-fresh') {
    const stored = restoreSnapshot(readData(io, requireOption(args, 'snapshot')))
    const current = requireOption(args, 'current-version')
    const storedVersion = stored.identity.sourceVersionAtEnd
    const fresh = storedVersion === current
    io.write(JSON.stringify({ fresh, storedVersion: storedVersion ?? null, currentVersion: current }, null, 2))
    // A non-zero exit so a script does not have to parse the output to notice.
    return fresh ? 0 : 1
  }

  // Unreachable once parseArgs has checked the command table; kept so a
  // command added to the table without a handler fails loudly.
  throw new CliError(`unknown command: ${args.command}\n\n${USAGE}`)
}

const describe = (error: unknown): string =>
  error instanceof CliError ? error.message : `${(error as Error).name}: ${(error as Error).message}`

const codeFor = (error: unknown): number => (error instanceof CliError ? error.exitCode : 2)

export const main = async (
  argv: ReadonlyArray<string>,
  io: CliIO = nodeIO,
  deps: CliDeps = nodeDeps,
): Promise<number> => {
  try {
    return await run(argv, io, deps)
  } catch (error) {
    io.writeError(describe(error))
    return codeFor(error)
  }
}
