/**
 * Finding things in a file.
 *
 * Every other command starts from node ids, and until now a person had to
 * supply them — which put a manual step at the front of a pipeline built to
 * remove manual steps. These two reads are the entry point: the file's pages,
 * and what a page contains.
 *
 * They report rather than decide. A page's direct children are a mixed bag of
 * frames, sections and offcuts, names repeat, and widths do not always mean
 * what a breakpoint expects; grouping them is a judgement the project makes
 * through its naming convention, not something to infer here.
 */
import { compareCodeUnits } from '../determinism/canonical.js'
import { compileArtboardPattern, matchNamePattern, resolveArtboardName } from '../facts/pattern.js'
import type { FigmaClient, FileKey } from './client.js'
import { FigmaClientError } from './client.js'

export interface PageSummary {
  readonly id: string
  readonly name: string
}

/** A node the page holds — a frame, a stray shape, or a section; `type` says which. */
export interface PageChildSummary {
  readonly id: string
  readonly name: string
  readonly type: string
  readonly width: number | undefined
  readonly height: number | undefined
  /**
   * The sections this node sits inside, outermost first; empty for a direct
   * child of the page. A section is an organising container on the canvas,
   * not a design node: the frames inside it are what a consumer acquires,
   * and this path is how it says where it found them.
   */
  readonly sectionPath: ReadonlyArray<{ readonly id: string; readonly name: string }>
}

/** A set of frames the naming convention says are one view at several widths. */
export interface BreakpointGroup {
  readonly section: string
  readonly members: ReadonlyArray<{
    readonly breakpoint: string | undefined
    /** The design width the name claims, or the declared width of the slot it names; undefined when neither resolves. */
    readonly widthInName: number | undefined
    readonly frame: PageChildSummary
  }>
}

export interface PageContents {
  readonly page: PageSummary
  /** Every node that is not a section, in document order, sections descended depth-first. */
  readonly frames: ReadonlyArray<PageChildSummary>
  /** Frames whose names match the pattern, gathered by section. */
  readonly groups: ReadonlyArray<BreakpointGroup>
  /** Frames the pattern did not describe. Listed, never silently dropped. */
  readonly ungrouped: ReadonlyArray<PageChildSummary>
  /**
   * The sections themselves, in the same order. Kept apart from `frames`
   * because a section cannot be a root (REG-DISC-018): a section whose name
   * happens to match the pattern must not be grouped as if it were a view.
   */
  readonly sections: ReadonlyArray<PageChildSummary>
}

export interface PageListing {
  /**
   * The file version the listing was read at.
   *
   * The outline response carried this all along and the old shape dropped it,
   * which forced a consumer that wanted verify-fresh to fetch the metadata
   * again by hand. Discovery and freshness now share one read.
   */
  readonly version: string
  readonly pages: ReadonlyArray<PageSummary>
}

export const listPages = async (client: FigmaClient, key: FileKey): Promise<PageListing> => {
  if (client.getFileOutline === undefined) {
    throw new FigmaClientError('this client cannot read the file outline', 'CONFIG_ERROR')
  }
  const outline = await client.getFileOutline(key)
  return {
    version: outline.version,
    pages: outline.document.children
      .filter((child) => child.type === 'CANVAS')
      .map((child) => ({ id: child.id, name: child.name })),
  }
}

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

export interface ListPageOptions {
  /**
   * Name template over `{section}` and `{width}` and/or `{breakpoint}`, the
   * same one the fact layer takes. Omitted means no grouping is attempted.
   */
  readonly namePattern?: string
  /** Design widths and what the project calls them. */
  readonly breakpoints?: ReadonlyArray<{ readonly slot: string; readonly designWidthPx: number }>
}

type RawChild = Record<string, unknown>
type ShallowDocument = { name: string; children?: ReadonlyArray<RawChild> }

const summarize = (child: RawChild, sectionPath: PageChildSummary['sectionPath']): PageChildSummary => {
  const box = child.absoluteBoundingBox as Record<string, unknown> | undefined
  return {
    id: String(child.id),
    name: String(child.name ?? ''),
    type: String(child.type ?? ''),
    width: asNumber(box?.width),
    height: asNumber(box?.height),
    sectionPath,
  }
}

/**
 * A container answers with `children`, empty or not; a document without the
 * key is a shape this code does not know, not a container with nothing in
 * it. Reading absence as emptiness would let an API change pass as a
 * quieter page.
 */
const childrenOrFail = (document: ShallowDocument, what: string): ReadonlyArray<RawChild> => {
  const children: unknown = document.children
  if (!Array.isArray(children)) {
    throw new FigmaClientError(`${what} came back without a children array; unexpected shape`, 'SUPPLY_CHAIN_ERROR')
  }
  return children as ReadonlyArray<RawChild>
}

/** Ids per request. Bounds the URL, which the ids travel in, whatever a level holds. */
const IDS_PER_READ = 50

/**
 * Reads the children of every section the page holds, level by level.
 *
 * A section is an organising container, and what a consumer acquires sits
 * inside it. The page read stops at depth 1, so the sections' own children
 * are read in a second pass — one request per bounded batch per level of
 * nesting — rather than reading the whole page deep, whose cost is every
 * frame's subtree. The result maps a section id to its direct children,
 * for the assembly below to lay out in document order.
 *
 * A section the page listed a moment ago and the read does not return is
 * not "empty": an empty section answers with `children: []`. Whatever the
 * cause — a save between the reads, a hole in the response — the listing
 * would describe a page that never existed, so it fails and says to retry.
 */
const readSectionChildren = async (
  key: FileKey,
  read: NonNullable<FigmaClient['getNodesShallow']>,
  firstLevel: ReadonlyArray<RawChild>,
): Promise<Map<string, ReadonlyArray<RawChild>>> => {
  const childrenOf = new Map<string, ReadonlyArray<RawChild>>()
  let level = firstLevel.filter((child) => child.type === 'SECTION')
  while (level.length > 0) {
    const ids = [...new Set(level.map((section) => String(section.id)))].filter((id) => !childrenOf.has(id))
    const next: RawChild[] = []
    for (let start = 0; start < ids.length; start += IDS_PER_READ) {
      const batch = ids.slice(start, start + IDS_PER_READ)
      const response = await read(key, batch, 1)
      for (const id of batch) {
        const entry = response.nodes[id]
        if (entry === undefined || entry === null) {
          throw new FigmaClientError(`section ${id} was listed by the page but not returned when read; retry`, 'INCOMPLETE_EXECUTION')
        }
        const children = childrenOrFail(entry.document as unknown as ShallowDocument, `section ${id}`)
        childrenOf.set(id, children)
        next.push(...children.filter((child) => child.type === 'SECTION'))
      }
    }
    level = next
  }
  return childrenOf
}

/**
 * Lists what a page holds, grouped where the naming convention allows.
 *
 * Sections are descended: a frame inside one lists with its `sectionPath`,
 * and the section itself lists under `sections`, never among the frames —
 * it is not a root, and a name that fits the pattern does not make it one.
 *
 * A frame whose declared width disagrees with the width in its own name is
 * still reported — it is grouped by what the name claims, and the measured
 * width travels alongside so a rule downstream can notice the discrepancy.
 */
export const listPageContents = async (
  client: FigmaClient,
  key: FileKey,
  pageId: string,
  options: ListPageOptions = {},
): Promise<PageContents> => {
  const read = client.getNodesShallow
  if (read === undefined) {
    throw new FigmaClientError('this client cannot read a shallow subtree', 'CONFIG_ERROR')
  }

  // Several reads must describe one file. Like an acquisition, the reads
  // are bracketed by a version check: the version is taken before the page
  // is read — not after, or a save between the page and its sections would
  // slip through — and taken again only when sections made a second read.
  const before = await client.getFileMeta(key)
  const response = await read(key, [pageId], 1)
  const entry = response.nodes[pageId]
  if (entry === undefined || entry === null) {
    throw new FigmaClientError(`page ${pageId} is not in this file`, 'CONFIG_ERROR')
  }

  const document = entry.document as unknown as ShallowDocument
  const topLevel = childrenOrFail(document, `page ${pageId}`)

  const hasSections = topLevel.some((child) => child.type === 'SECTION')
  const childrenOf = await readSectionChildren(key, read, topLevel)
  if (hasSections) {
    const after = await client.getFileMeta(key)
    if (before.version !== after.version) {
      throw new FigmaClientError(
        `file changed while its sections were being listed (${before.version} -> ${after.version}); retry`,
        'INCOMPLETE_EXECUTION',
      )
    }
  }

  // Document order, depth-first: a section's contents follow the section,
  // so a reader sees the page as the canvas shows it. An id met twice is
  // the source contradicting itself; picking one occurrence would hide that.
  const frames: PageChildSummary[] = []
  const sections: PageChildSummary[] = []
  const seen = new Set<string>()
  const visit = (children: ReadonlyArray<RawChild>, sectionPath: PageChildSummary['sectionPath']): void => {
    for (const child of children) {
      const summary = summarize(child, sectionPath)
      if (seen.has(summary.id)) {
        throw new FigmaClientError(`node ${summary.id} appears twice in the page listing`, 'SUPPLY_CHAIN_ERROR')
      }
      seen.add(summary.id)
      if (child.type === 'SECTION') {
        sections.push(summary)
        visit(childrenOf.get(summary.id) ?? [], [...sectionPath, { id: summary.id, name: summary.name }])
      } else {
        frames.push(summary)
      }
    }
  }
  visit(topLevel, [])

  if (options.namePattern === undefined) {
    return { page: { id: pageId, name: document.name }, frames, groups: [], ungrouped: frames, sections }
  }

  const breakpoints = options.breakpoints ?? []
  const pattern = compileArtboardPattern(
    options.namePattern,
    breakpoints.map((entry_) => entry_.slot),
  )
  const widthToSlot = new Map(breakpoints.map((entry_) => [entry_.designWidthPx, entry_.slot]))
  const slotToWidth = new Map(breakpoints.map((entry_) => [entry_.slot, entry_.designWidthPx]))
  const bySection = new Map<string, BreakpointGroup['members'][number][]>()
  const ungrouped: PageChildSummary[] = []

  for (const frame of frames) {
    const parts = matchNamePattern(pattern, frame.name)
    if (parts === undefined) {
      ungrouped.push(frame)
      continue
    }
    const value = (segment: string) => parts.find((part) => part.segment === segment)?.value
    const section = value('section') as string
    // Reported by what the name claims, resolved where the declaration
    // allows; a name that claims a width nobody declared, or that
    // contradicts itself, still lists, with breakpoint unresolved.
    const resolved = resolveArtboardName(pattern, frame.name, widthToSlot, slotToWidth)
    const width = value('width')
    const widthInName =
      width !== undefined ? Number(width) : resolved !== undefined && 'slot' in resolved ? resolved.designWidthPx : undefined
    const members = bySection.get(section) ?? []
    members.push({
      breakpoint: resolved !== undefined && 'slot' in resolved ? resolved.slot : undefined,
      widthInName,
      frame,
    })
    bySection.set(section, members)
  }

  const groups = [...bySection.keys()].sort(compareCodeUnits).map((section) => ({
    section,
    members: (bySection.get(section) ?? []).sort(
      (a, b) => (a.widthInName ?? Infinity) - (b.widthInName ?? Infinity) || compareCodeUnits(a.frame.id, b.frame.id),
    ),
  }))

  return { page: { id: pageId, name: document.name }, frames, groups, ungrouped, sections }
}
