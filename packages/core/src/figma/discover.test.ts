import { describe, expect, it } from 'vitest'

import { design, frame } from '../testing/builders.js'
import { fileKey, type FileKey } from './client.js'
import { fixtureClient } from './fixtureClient.js'
import { listPageContents, listPages } from './discover.js'

const KEY = fileKey('SYNTHETICFILEKEY0001')

/**
 * A page as real files have them: some frames follow the convention, some
 * claim the same breakpoint, and plenty are working material nobody meant to
 * ship.
 */
const pageWithMess = () => {
  const data = design([
    frame('1:1', 'page', { x: 0, y: 0, width: 0, height: 0 }, {
      type: 'CANVAS',
      children: [
        frame('2:1', 'nav_375', { x: 0, y: 0, width: 375, height: 100 }),
        frame('2:2', 'nav_768', { x: 0, y: 0, width: 768, height: 100 }),
        frame('2:3', 'nav_1024', { x: 0, y: 0, width: 1024, height: 100 }),
        frame('2:4', 'nav_1440', { x: 0, y: 0, width: 1440, height: 100 }),
        // Two frames claiming md — an old version left beside the new one.
        frame('3:1', 'hero_375', { x: 0, y: 0, width: 375, height: 100 }),
        frame('3:2', 'hero_768', { x: 0, y: 0, width: 768, height: 100 }),
        frame('3:3', 'hero_768', { x: 0, y: 0, width: 768, height: 100 }),
        // A width the project never declared.
        frame('4:1', 'panel_640', { x: 0, y: 0, width: 640, height: 100 }),
        // Working material: no width in the name at all.
        frame('5:1', 'scratch', { x: 0, y: 0, width: 2000, height: 100 }),
      ],
    }),
  ])
  return { ...data, pages: [{ id: '1:1', name: 'page', type: 'CANVAS' }] }
}

const BREAKPOINTS = [
  { slot: 'sm', designWidthPx: 375 },
  { slot: 'md', designWidthPx: 768 },
  { slot: 'lg', designWidthPx: 1024 },
  { slot: 'xl', designWidthPx: 1440 },
]

describe('listPages', () => {
  it('lists the pages and the version they were read at', async () => {
    const listing = await listPages(fixtureClient(pageWithMess()), KEY)
    expect(listing.pages).toEqual([{ id: '1:1', name: 'page' }])
    // The version rides along so a consumer can verify-fresh from one read.
    expect(listing.version.length).toBeGreaterThan(0)
  })

  it('ignores anything that is not a page', async () => {
    const data = pageWithMess()
    const withNoise = {
      ...data,
      pages: [...(data.pages ?? []), { id: '9:9', name: 'not-a-page', type: 'FRAME' }],
    }
    const listing = await listPages(fixtureClient(withNoise), KEY)
    expect(listing.pages.map((page) => page.id)).toEqual(['1:1'])
  })
})

describe('listPageContents', () => {
  it('groups the frames the convention describes', async () => {
    const contents = await listPageContents(fixtureClient(pageWithMess()), KEY, '1:1', {
      namePattern: '{section}_{width}',
      breakpoints: BREAKPOINTS,
    })
    const nav = contents.groups.find((group) => group.section === 'nav')
    expect(nav?.members.map((member) => member.breakpoint)).toEqual(['sm', 'md', 'lg', 'xl'])
    // Ready to hand straight to acquire.
    expect(nav?.members.map((member) => member.frame.id)).toEqual(['2:1', '2:2', '2:3', '2:4'])
  })

  it('reports two frames claiming one breakpoint rather than picking one', async () => {
    const contents = await listPageContents(fixtureClient(pageWithMess()), KEY, '1:1', {
      namePattern: '{section}_{width}',
      breakpoints: BREAKPOINTS,
    })
    const hero = contents.groups.find((group) => group.section === 'hero')
    expect(hero?.members.filter((member) => member.breakpoint === 'md')).toHaveLength(2)
  })

  it('leaves an undeclared width unnamed instead of inventing a breakpoint', async () => {
    const contents = await listPageContents(fixtureClient(pageWithMess()), KEY, '1:1', {
      namePattern: '{section}_{width}',
      breakpoints: BREAKPOINTS,
    })
    const panel = contents.groups.find((group) => group.section === 'panel')
    expect(panel?.members[0]?.breakpoint).toBeUndefined()
    expect(panel?.members[0]?.widthInName).toBe(640)
  })

  it('lists what the pattern did not describe, so a page cannot look fully covered', async () => {
    const contents = await listPageContents(fixtureClient(pageWithMess()), KEY, '1:1', {
      namePattern: '{section}_{width}',
      breakpoints: BREAKPOINTS,
    })
    expect(contents.ungrouped.map((frame_) => frame_.name)).toEqual(['scratch'])
  })

  it('carries the measured width beside the one the name claims', async () => {
    // A frame drawn narrower than its name says is a real failure mode; both
    // numbers travel so a rule downstream can notice.
    const data = pageWithMess()
    const shrunk = data.nodes.nodes['1:1'] as unknown as {
      document: { children: Array<{ name: string; absoluteBoundingBox: { width: number } }> }
    }
    const target = shrunk.document.children.find((child) => child.name === 'nav_1024')
    if (target !== undefined) target.absoluteBoundingBox.width = 666
    const contents = await listPageContents(fixtureClient(data), KEY, '1:1', {
      namePattern: '{section}_{width}',
      breakpoints: BREAKPOINTS,
    })
    const lg = contents.groups
      .find((group) => group.section === 'nav')
      ?.members.find((member) => member.breakpoint === 'lg')
    expect(lg?.widthInName).toBe(1024)
    expect(lg?.frame.width).toBe(666)
  })

  it('groups by a breakpoint name when that is the convention, and refuses a pattern it cannot use', async () => {
    const page = () => {
      const data = design([
        frame('1:1', 'page', { x: 0, y: 0, width: 0, height: 0 }, {
          type: 'CANVAS',
          children: [
            frame('2:1', 'Home / sm', { x: 0, y: 0, width: 375, height: 100 }),
            frame('2:2', 'Home / xl', { x: 0, y: 0, width: 1440, height: 100 }),
          ],
        }),
      ])
      return { ...data, pages: [{ id: '1:1', name: 'page', type: 'CANVAS' }] }
    }
    const contents = await listPageContents(fixtureClient(page()), KEY, '1:1', {
      namePattern: '{section} / {breakpoint}',
      breakpoints: BREAKPOINTS,
    })
    const home = contents.groups.find((group) => group.section === 'Home')
    expect(home?.members.map((member) => [member.breakpoint, member.widthInName])).toEqual([
      ['sm', 375],
      ['xl', 1440],
    ])
    await expect(
      listPageContents(fixtureClient(page()), KEY, '1:1', { namePattern: '{section}', breakpoints: BREAKPOINTS }),
    ).rejects.toThrow(/\{width\} or \{breakpoint\}/)
  })

  it('returns every frame ungrouped when no convention is given', async () => {
    const contents = await listPageContents(fixtureClient(pageWithMess()), KEY, '1:1')
    expect(contents.groups).toEqual([])
    expect(contents.ungrouped).toHaveLength(contents.frames.length)
  })

  it('refuses a page the file does not contain', async () => {
    await expect(listPageContents(fixtureClient(pageWithMess()), KEY, '9:9')).rejects.toThrow()
  })
})

/**
 * A page organised with sections, as designers keep large files: the views
 * live inside a section, one section nests another, and one section is
 * named the way a view would be (REG-DISC-018).
 */
const pageWithSections = () => {
  const inner = frame('7:1', 'legal', { x: 0, y: 0, width: 3000, height: 400 }, {
    type: 'SECTION',
    children: [
      frame('7:2', 'policy_375', { x: 0, y: 0, width: 375, height: 100 }),
      frame('7:3', 'policy_1440', { x: 0, y: 0, width: 1440, height: 100 }),
    ],
  })
  const outer = frame('6:1', 'hours_375', { x: 0, y: 0, width: 3000, height: 1000 }, {
    type: 'SECTION',
    children: [
      frame('6:2', 'hours_375', { x: 0, y: 0, width: 375, height: 100 }),
      frame('6:3', 'hours_768', { x: 0, y: 0, width: 768, height: 100 }),
      inner,
    ],
  })
  const page = frame('1:1', 'page', { x: 0, y: 0, width: 0, height: 0 }, {
    type: 'CANVAS',
    children: [frame('2:1', 'nav_375', { x: 0, y: 0, width: 375, height: 100 }), outer, frame('8:1', 'scratch', { x: 0, y: 0, width: 2000, height: 100 })],
  })
  // The sections are registered as roots too: a shallow read of a section id
  // answers with the section and its direct children, as the API does.
  const data = design([page, outer, inner])
  return { ...data, pages: [{ id: '1:1', name: 'page', type: 'CANVAS' }] }
}

describe('listPageContents descends into sections (REG-DISC-018)', () => {
  it('lists the frames inside a section, with the path that leads to them, in document order', async () => {
    const client = fixtureClient(pageWithSections())
    const contents = await listPageContents(client, KEY, '1:1')
    expect(contents.frames.map((frame_) => frame_.id)).toEqual(['2:1', '6:2', '6:3', '7:2', '7:3', '8:1'])
    expect(contents.frames.find((frame_) => frame_.id === '2:1')?.sectionPath).toEqual([])
    expect(contents.frames.find((frame_) => frame_.id === '6:3')?.sectionPath).toEqual([{ id: '6:1', name: 'hours_375' }])
    expect(contents.frames.find((frame_) => frame_.id === '7:3')?.sectionPath).toEqual([
      { id: '6:1', name: 'hours_375' },
      { id: '7:1', name: 'legal' },
    ])
  })

  it('takes the version before the page, reads each level of sections in one request, and checks the version after', async () => {
    const client = fixtureClient(pageWithSections())
    await listPageContents(client, KEY, '1:1')
    // The version comes first: taken after the page, a save between the
    // page and its sections would go unnoticed.
    expect(client.calls).toEqual([
      'getFileMeta',
      'getNodesShallow:1:1@1',
      'getNodesShallow:6:1@1',
      'getNodesShallow:7:1@1',
      'getFileMeta',
    ])
  })

  it('reads a page without sections once after the version, with no second check to pay for', async () => {
    const client = fixtureClient(pageWithMess())
    await listPageContents(client, KEY, '1:1')
    expect(client.calls).toEqual(['getFileMeta', 'getNodesShallow:1:1@1'])
  })

  it('refuses a section that came back without a children key: that is a shape it does not know, not an empty section', async () => {
    const bare = { id: '6:1', type: 'SECTION', name: 'spare', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 } }
    const page = frame('1:1', 'page', { x: 0, y: 0, width: 0, height: 0 }, { type: 'CANVAS', children: [bare] })
    const data = { ...design([page, bare]), pages: [{ id: '1:1', name: 'page', type: 'CANVAS' }] }
    await expect(listPageContents(fixtureClient(data), KEY, '1:1')).rejects.toMatchObject({ reason: 'SUPPLY_CHAIN_ERROR' })
  })

  it('refuses a section listed twice as firmly as a frame listed twice', async () => {
    const section = frame('6:1', 'kept', { x: 0, y: 0, width: 100, height: 100 }, { type: 'SECTION', children: [] })
    const page = frame('1:1', 'page', { x: 0, y: 0, width: 0, height: 0 }, { type: 'CANVAS', children: [section, section] })
    const data = { ...design([page, section]), pages: [{ id: '1:1', name: 'page', type: 'CANVAS' }] }
    await expect(listPageContents(fixtureClient(data), KEY, '1:1')).rejects.toMatchObject({ reason: 'SUPPLY_CHAIN_ERROR' })
  })

  it('gives the same listing however the source orders the keys of its response', async () => {
    // Three sections on one level, so one read asks for three ids and the
    // response has three keys to reverse; a single-key response would make
    // the reversal a no-op and the test say nothing.
    const level = ['a', 'b', 'c'].map((letter, index) =>
      frame(`6:${index + 1}`, letter, { x: 0, y: 0, width: 100, height: 100 }, {
        type: 'SECTION',
        children: [frame(`7:${index + 1}`, `view_${letter}_375`, { x: 0, y: 0, width: 375, height: 10 })],
      }),
    )
    const page = frame('1:1', 'page', { x: 0, y: 0, width: 0, height: 0 }, { type: 'CANVAS', children: level })
    const data = () => ({ ...design([page, ...level]), pages: [{ id: '1:1', name: 'page', type: 'CANVAS' }] })
    const straight = fixtureClient(data())
    const reversed = fixtureClient(data())
    const original = reversed.getNodesShallow!
    let widest = 0
    const shuffled = {
      ...reversed,
      getNodesShallow: async (key: FileKey, ids: ReadonlyArray<string>, depth: number) => {
        const response = await original(key, ids, depth)
        const entries = Object.entries(response.nodes)
        widest = Math.max(widest, entries.length)
        return { nodes: Object.fromEntries(entries.reverse()) }
      },
    }
    const a = await listPageContents(straight, KEY, '1:1', { namePattern: '{section}_{width}', breakpoints: BREAKPOINTS })
    const b = await listPageContents(shuffled, KEY, '1:1', { namePattern: '{section}_{width}', breakpoints: BREAKPOINTS })
    expect(widest).toBe(3)
    expect(b.frames.map((frame_) => frame_.id)).toEqual(['7:1', '7:2', '7:3'])
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
  })

  it('refuses a page whose children are not an array, and a page with none at all, as shapes it does not know', async () => {
    const bare = { id: '1:1', type: 'CANVAS', name: 'page', absoluteBoundingBox: { x: 0, y: 0, width: 0, height: 0 } }
    const noKey = { ...design([bare]), pages: [{ id: '1:1', name: 'page', type: 'CANVAS' }] }
    await expect(listPageContents(fixtureClient(noKey), KEY, '1:1')).rejects.toMatchObject({ reason: 'SUPPLY_CHAIN_ERROR' })
    const notArray = { ...design([{ ...bare, children: null as never }]), pages: [{ id: '1:1', name: 'page', type: 'CANVAS' }] }
    await expect(listPageContents(fixtureClient(notArray), KEY, '1:1')).rejects.toMatchObject({ reason: 'SUPPLY_CHAIN_ERROR' })
  })

  it('refuses a listing that spans two file versions', async () => {
    const client = fixtureClient(pageWithSections(), { versionOnSecondRead: 'later' })
    await expect(listPageContents(client, KEY, '1:1')).rejects.toMatchObject({ reason: 'INCOMPLETE_EXECUTION' })
  })

  it('reads many sections on one level in bounded batches, in order', async () => {
    const sections = Array.from({ length: 120 }, (_, index) =>
      frame(`9:${index + 1}`, `group ${index + 1}`, { x: 0, y: 0, width: 100, height: 100 }, {
        type: 'SECTION',
        children: [frame(`10:${index + 1}`, `view_375`, { x: 0, y: 0, width: 375, height: 10 })],
      }),
    )
    const page = frame('1:1', 'page', { x: 0, y: 0, width: 0, height: 0 }, { type: 'CANVAS', children: sections })
    const data = { ...design([page, ...sections]), pages: [{ id: '1:1', name: 'page', type: 'CANVAS' }] }
    const client = fixtureClient(data)
    const contents = await listPageContents(client, KEY, '1:1')
    const reads = client.calls.filter((call) => call.startsWith('getNodesShallow:9:'))
    expect(reads).toHaveLength(3)
    expect(reads[0]?.split(',')).toHaveLength(50)
    expect(contents.frames.map((frame_) => frame_.id)).toEqual(sections.map((_, index) => `10:${index + 1}`))
  })

  it('groups frames found inside sections by the convention, and keeps a section out of the groups even when its name fits', async () => {
    const contents = await listPageContents(fixtureClient(pageWithSections()), KEY, '1:1', {
      namePattern: '{section}_{width}',
      breakpoints: BREAKPOINTS,
    })
    const hours = contents.groups.find((group) => group.section === 'hours')
    expect(hours?.members.map((member) => member.frame.id)).toEqual(['6:2', '6:3'])
    expect(contents.groups.find((group) => group.section === 'policy')?.members).toHaveLength(2)
    // The section named hours_375 is not a member, not ungrouped, and not lost.
    expect(contents.ungrouped.map((frame_) => frame_.id)).toEqual(['8:1'])
    expect(contents.sections.map((section) => section.id)).toEqual(['6:1', '7:1'])
    expect(contents.sections[1]?.sectionPath).toEqual([{ id: '6:1', name: 'hours_375' }])
  })

  it('fails, and says to retry, when a section the page listed is not returned — that is not an empty section', async () => {
    const data = pageWithSections()
    const withoutInner = { ...data, nodes: { nodes: Object.fromEntries(Object.entries(data.nodes.nodes).filter(([id]) => id !== '7:1')) } }
    await expect(listPageContents(fixtureClient(withoutInner), KEY, '1:1')).rejects.toMatchObject({ reason: 'INCOMPLETE_EXECUTION' })
  })

  it('lists a section that really is empty as a section with nothing under it', async () => {
    const empty = frame('6:1', 'spare', { x: 0, y: 0, width: 100, height: 100 }, { type: 'SECTION', children: [] })
    const page = frame('1:1', 'page', { x: 0, y: 0, width: 0, height: 0 }, { type: 'CANVAS', children: [empty] })
    const data = { ...design([page, empty]), pages: [{ id: '1:1', name: 'page', type: 'CANVAS' }] }
    const contents = await listPageContents(fixtureClient(data), KEY, '1:1')
    expect(contents.sections.map((section) => section.id)).toEqual(['6:1'])
    expect(contents.frames).toEqual([])
  })

  it('refuses a page in which one id appears twice rather than listing either occurrence', async () => {
    const twice = frame('6:1', 'kept', { x: 0, y: 0, width: 100, height: 100 }, {
      type: 'SECTION',
      children: [frame('2:1', 'view_375', { x: 0, y: 0, width: 375, height: 10 })],
    })
    const page = frame('1:1', 'page', { x: 0, y: 0, width: 0, height: 0 }, {
      type: 'CANVAS',
      children: [frame('2:1', 'view_375', { x: 0, y: 0, width: 375, height: 10 }), twice],
    })
    const data = { ...design([page, twice]), pages: [{ id: '1:1', name: 'page', type: 'CANVAS' }] }
    await expect(listPageContents(fixtureClient(data), KEY, '1:1')).rejects.toMatchObject({ reason: 'SUPPLY_CHAIN_ERROR' })
  })
})
