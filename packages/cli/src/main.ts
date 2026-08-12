#!/usr/bin/env node
import { main } from './index.js'

/**
 * Sets the exit code rather than calling `process.exit`.
 *
 * `process.exit` terminates immediately, before Node has flushed a pipe. A
 * two-megabyte slice measured 65,536 bytes on the other end of the pipe: a
 * successful exit code with truncated JSON, which is about the worst way for
 * this to fail. Setting the code lets the event loop drain first.
 */
process.exitCode = await main(process.argv.slice(2))
