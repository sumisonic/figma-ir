/**
 * A client backed by recorded responses.
 *
 * Every test in this repository runs against captured payloads. Reaching the
 * live API in a test would make the suite depend on a designer not saving the
 * file, which is the opposite of what these tests are for.
 */
import {
  FigmaClientError,
  type FigmaClient,
  type FileKey,
  type FileMeta,
  type FileOutline,
  type NodesResponse,
} from './client.js'

export interface FixtureData {
  readonly meta: FileMeta
  readonly nodes: NodesResponse
  /** Pages, when a test exercises discovery. */
  readonly pages?: ReadonlyArray<{ readonly id: string; readonly name: string; readonly type: string }>
}

export interface FixtureClientOptions {
  /** Version reported by the second metadata read. Set to simulate a mid-flight edit. */
  readonly versionOnSecondRead?: string
  /** Node ids to omit from the response, to exercise the incomplete-response path. */
  readonly dropNodeIds?: ReadonlyArray<string>
}

/**
 * Builds a client over fixture data.
 *
 * Also records the call sequence, because the version bracket is only worth
 * anything if the reads actually happen in the right order.
 */
const withoutGeometry = (document: unknown): unknown => {
  if (Array.isArray(document)) return document.map(withoutGeometry)
  if (typeof document !== 'object' || document === null) return document
  const stripped: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(document as Record<string, unknown>)) {
    if (key === 'fillGeometry' || key === 'strokeGeometry') continue
    stripped[key] = withoutGeometry(value)
  }
  return stripped
}

export const fixtureClient = (
  data: FixtureData,
  options: FixtureClientOptions = {},
): FigmaClient & { readonly calls: ReadonlyArray<string> } => {
  const calls: string[] = []
  let metaReads = 0

  return {
    calls,
    getFileMeta: async (_key: FileKey): Promise<FileMeta> => {
      calls.push('getFileMeta')
      metaReads += 1
      const override = options.versionOnSecondRead
      return metaReads >= 2 && override !== undefined ? { ...data.meta, version: override } : data.meta
    },
    getFileOutline: async (_key: FileKey): Promise<FileOutline> => {
      calls.push('getFileOutline')
      return { ...data.meta, document: { children: data.pages ?? [] } }
    },
    getNodesShallow: async (
      _key: FileKey,
      ids: ReadonlyArray<string>,
      depth: number,
    ): Promise<NodesResponse> => {
      calls.push(`getNodesShallow:${ids.join(',')}@${depth}`)
      const nodes: Record<string, NodesResponse['nodes'][string]> = {}
      for (const id of ids) {
        const entry = data.nodes.nodes[id]
        if (entry !== undefined) nodes[id] = entry
      }
      return { nodes }
    },
    getNodes: async (_key: FileKey, ids: ReadonlyArray<string>, getOptions = {}): Promise<NodesResponse> => {
      calls.push(`getNodes:${ids.join(',')}${getOptions.geometry === 'paths' ? '?geometry=paths' : ''}`)
      if (ids.length === 0) throw new FigmaClientError('getNodes requires at least one node id', 'CONFIG_ERROR')
      const dropped = new Set(options.dropNodeIds ?? [])
      const nodes: Record<string, NodesResponse['nodes'][string]> = {}
      for (const id of ids) {
        if (dropped.has(id)) continue
        const entry = data.nodes.nodes[id]
        if (entry === undefined || entry === null) continue
        // As the API behaves: paths are in the response only when requested.
        // A fixture that returned them regardless would let a test pass a
        // situation that cannot occur.
        nodes[id] =
          getOptions.geometry === 'paths' ? entry : { ...entry, document: withoutGeometry(entry.document) as never }
      }
      return { nodes }
    },
  }
}
