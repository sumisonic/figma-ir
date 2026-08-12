/**
 * Figma REST access.
 *
 * The client is an interface rather than a concrete fetch call so that tests
 * replay recorded fixtures. A test that reaches the network is not testing
 * determinism; it is testing whether Figma is up.
 */
import { Schema } from 'effect'

import type { ReasonCode } from '../diagnostics/reason.js'

/** Identifies a file. Not a secret; the token is. */
export type FileKey = string & { readonly __fileKeyBrand: unique symbol }

/**
 * Every transport failure carries a reason code.
 *
 * Without one, a 429 or a DNS failure arrives at the job layer as a bare
 * exception and cannot be told apart from "the design says nothing here" —
 * which is how an outage turns into a confident wrong answer.
 */
export class FigmaClientError extends Error {
  readonly _tag = 'FigmaClientError'
  readonly reason: ReasonCode
  readonly status?: number

  constructor(message: string, reason: ReasonCode, options?: { readonly status?: number; readonly cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'FigmaClientError'
    this.reason = reason
    if (options?.status !== undefined) this.status = options.status
  }
}

export const fileKey = (raw: string): FileKey => {
  if (!/^[A-Za-z0-9]{10,}$/.test(raw)) throw new FigmaClientError(`implausible file key: ${raw}`, 'CONFIG_ERROR')
  return raw as FileKey
}

/**
 * Figma node ids: `1:23`, or `I1:23;4:56` for a node inside an instance.
 *
 * Validated rather than trusted, because these ids are concatenated into a
 * query string — and because an id that is malformed here is a bug we would
 * otherwise discover as a confusing 400 from the API.
 */
const NODE_ID = /^I?\d+:\d+(?:;\d+:\d+)*$/

export const assertNodeId = (id: string): string => {
  if (!NODE_ID.test(id)) throw new FigmaClientError(`malformed node id: ${id}`, 'CONFIG_ERROR')
  return id
}

/**
 * The file envelope, validated at the boundary.
 *
 * Node documents are checked only far enough to know we received a node at all:
 * a plain object carrying `id` and `type`. Reproducing Figma's full node union
 * here would mean maintaining that surface twice, and the canonical layer is
 * where the detailed reading belongs — but accepting `null` as a successful
 * fetch would let a hole in the input pass for an answer.
 */
export const FileMetaSchema = Schema.Struct({
  name: Schema.String,
  lastModified: Schema.String,
  version: Schema.String,
})
export type FileMeta = typeof FileMetaSchema['Type']

/**
 * A page in the file, as `depth=1` reports it.
 *
 * The children come back empty at this depth — the page's contents need their
 * own request — so this is a table of contents and nothing more.
 */
export const PageEntrySchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.String,
})
export type PageEntry = typeof PageEntrySchema['Type']

export const FileOutlineSchema = Schema.Struct({
  name: Schema.String,
  lastModified: Schema.String,
  version: Schema.String,
  document: Schema.Struct({ children: Schema.Array(PageEntrySchema) }),
})
export type FileOutline = typeof FileOutlineSchema['Type']

export const StyleEntrySchema = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  styleType: Schema.String,
  remote: Schema.Boolean,
  description: Schema.optional(Schema.String),
})
export type StyleEntry = typeof StyleEntrySchema['Type']

export const NodeDocumentSchema = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String,
    type: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
export type NodeDocument = typeof NodeDocumentSchema['Type']

export const NodesResponseSchema = Schema.Struct({
  nodes: Schema.Record(
    Schema.String,
    Schema.NullOr(
      Schema.Struct({
        document: NodeDocumentSchema,
        components: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
        componentSets: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
        styles: Schema.optional(Schema.Record(Schema.String, StyleEntrySchema)),
      }),
    ),
  ),
})
export type NodesResponse = typeof NodesResponseSchema['Type']

export interface GetNodesOptions {
  readonly geometry?: 'paths'
}

export interface FigmaClient {
  /** Cheap metadata read used to bracket an acquisition with a version check. */
  readonly getFileMeta: (key: FileKey) => Promise<FileMeta>
  /**
   * Subtrees for the given node ids.
   *
   * Vector paths (`fillGeometry` / `strokeGeometry`) come back only when
   * asked for with `geometry: 'paths'` — the API omits them otherwise, which
   * a consumer once read as "the IR has no shape" (REG-ACQ-015).
   */
  readonly getNodes: (key: FileKey, ids: ReadonlyArray<string>, options?: GetNodesOptions) => Promise<NodesResponse>
  /**
   * The file's pages, without their contents.
   *
   * The entry point for finding anything: without it, a consumer has to be
   * handed node ids by a person, which is the manual step this pipeline exists
   * to remove.
   */
  readonly getFileOutline?: (key: FileKey) => Promise<FileOutline>
  /** A subtree cut at a given depth. Used to list what a page contains. */
  readonly getNodesShallow?: (
    key: FileKey,
    ids: ReadonlyArray<string>,
    depth: number,
  ) => Promise<NodesResponse>
}

const API_ROOT = 'https://api.figma.com/v1'

/**
 * Maps an HTTP status onto a reason code.
 *
 * Authentication and permission problems are configuration: retrying will not
 * fix a token that lacks access. Rate limiting and server errors are transient
 * infrastructure. Neither is ever a statement about the design.
 */
const reasonForStatus = (status: number): ReasonCode => {
  if (status === 401 || status === 403 || status === 404) return 'CONFIG_ERROR'
  if (status === 429) return 'RESOURCE_EXCEEDED'
  return 'INCOMPLETE_EXECUTION'
}

const decodeMeta = Schema.decodeUnknownSync(FileMetaSchema)
const decodeOutline = Schema.decodeUnknownSync(FileOutlineSchema)
const decodeNodes = Schema.decodeUnknownSync(NodesResponseSchema)

const decodeOrFail = <A>(decode: (input: unknown) => A, input: unknown, what: string): A => {
  try {
    return decode(input)
  } catch (cause) {
    // A response we cannot parse means the API changed shape under us. That is
    // a supply-chain problem, not a design that failed to match.
    throw new FigmaClientError(`unexpected shape for ${what}`, 'SUPPLY_CHAIN_ERROR', { cause })
  }
}

/**
 * HTTP client.
 *
 * The token is taken as an argument and never logged or stored in any artifact,
 * so a snapshot can travel -- into a cache, a private repository -- without
 * carrying the credential. Whether it belongs in a shared repository is the
 * project's call: it quotes the design.
 */
export const httpFigmaClient = (token: string, fetchImpl: typeof fetch = fetch): FigmaClient => {
  if (token.length === 0) throw new FigmaClientError('a Figma token is required', 'CONFIG_ERROR')

  const request = async (path: string, what: string): Promise<unknown> => {
    let response: Response
    try {
      response = await fetchImpl(`${API_ROOT}${path}`, { headers: { 'X-Figma-Token': token } })
    } catch (cause) {
      // DNS, TLS, timeouts: we did not see the file, so we know nothing about it.
      throw new FigmaClientError(`GET ${path} could not be completed`, 'INCOMPLETE_EXECUTION', { cause })
    }
    if (!response.ok) {
      // The path is safe to include; the token travels in a header.
      throw new FigmaClientError(`GET ${path} failed with ${response.status}`, reasonForStatus(response.status), {
        status: response.status,
      })
    }
    try {
      return (await response.json()) as unknown
    } catch (cause) {
      throw new FigmaClientError(`GET ${path} returned malformed JSON`, 'SUPPLY_CHAIN_ERROR', { cause })
    }
  }

  const fetchNodes = async (key: FileKey, ids: ReadonlyArray<string>, depth?: number, options: GetNodesOptions = {}) => {
    if (ids.length === 0) throw new FigmaClientError('getNodes requires at least one node id', 'CONFIG_ERROR')
    for (const id of ids) assertNodeId(id)
    const query = new URLSearchParams({ ids: ids.join(',') })
    if (depth !== undefined) query.set('depth', String(depth))
    if (options.geometry === 'paths') query.set('geometry', 'paths')
    return decodeOrFail(decodeNodes, await request(`/files/${key}/nodes?${query.toString()}`, 'nodes'), 'nodes')
  }

  return {
    getFileMeta: async (key) =>
      decodeOrFail(decodeMeta, await request(`/files/${key}?depth=1`, 'file metadata'), 'file metadata'),
    getFileOutline: async (key) =>
      decodeOrFail(decodeOutline, await request(`/files/${key}?depth=1`, 'file outline'), 'file outline'),
    getNodes: async (key, ids, options) => fetchNodes(key, ids, undefined, options),
    getNodesShallow: async (key, ids, depth) => fetchNodes(key, ids, depth),
  }
}
