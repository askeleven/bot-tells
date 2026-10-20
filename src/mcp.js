import { createInterface } from 'node:readline'
import { checkMessage, fixMessage, TellsError, DEFAULT_REVIEW_AT, DEFAULT_FAIL_AT } from './index.js'
import { VERSION } from './version.js'

/**
 * A Model Context Protocol server over stdio, written against the spec directly so the
 * package keeps zero runtime dependencies. Messages are newline-delimited JSON-RPC 2.0.
 */

/** Newest first. The first is offered when a client asks for one we do not know. */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

/** Characters in one message. Longer than this is a document, not a message. */
const MAX_TEXT = 50_000

const INSTRUCTIONS =
  'Call check_message on anything you wrote before it goes to a person: an email, a ' +
  'text, a reply, a post. Never send a message with a leak (verdict fail with a reason ' +
  'such as placeholder, chat_preamble or chat_postamble): fill or cut the placeholder ' +
  'and remove the chat wrapper first. For tells, call fix_message for the mechanical ' +
  'fixes, then rewrite each finding left in unfixed in plain words, following its ' +
  'suggestion, and check again. Do not swap one stock phrase for another. If the ' +
  'verdict is still review after that, show the message and the findings to a person.'

const COMMON_PROPERTIES = {
  text: {
    type: 'string',
    maxLength: MAX_TEXT,
    description: 'The message, exactly as it will be sent.',
  },
  markdown: {
    type: 'boolean',
    description:
      'The destination renders Markdown (Slack, GitHub, a chat UI), so Markdown is not a ' +
      'leak. Default false: email, SMS and most social posts show it as typed.',
  },
  ignore: {
    type: 'array',
    items: { type: 'string' },
    description: 'Codes or rule ids to skip, such as em_dash.',
  },
}

const TOOLS = [
  {
    name: 'check_message',
    title: 'Check a message for bot tells',
    description:
      'Checks a message before you send it for what makes readers think a bot wrote it. ' +
      'Returns verdict (keep, review or fail), score (0-100, how much it reads as ' +
      'written by a bot), and findings, each with the words, line, and a suggestion. ' +
      'Fails on leaks: unfilled placeholders such as [First Name], the model mentioning ' +
      'itself, "Here\'s a draft" wrappers, offers to adjust the tone, and Markdown that ' +
      'will not render. Scores tells: stock openers and closers, words people now read ' +
      'as AI, "not X but Y", rhetorical questions, em dashes, emoji bullets. Runs locally.',
    inputSchema: {
      type: 'object',
      properties: {
        ...COMMON_PROPERTIES,
        review_at: {
          type: 'number',
          minimum: 0,
          maximum: 100,
          description: `Review at this score or above. Default ${DEFAULT_REVIEW_AT}.`,
        },
        fail_at: {
          type: 'number',
          minimum: 0,
          maximum: 100,
          description: `Fail at this score or above. Default ${DEFAULT_FAIL_AT}.`,
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'fix_message',
    title: 'Apply the safe fixes to a message',
    description:
      'Returns the message with the fixes that need no judgement applied: filler ' +
      'sentences and chat wrappers cut, a few words swapped one for one, a pair of em ' +
      'dashes around an aside turned into commas, Markdown unwrapped. Never rewrites a ' +
      'sentence. Returns the new text, what was applied, what is left (unfixed) for you ' +
      'to rewrite, and the new text checked again.',
    inputSchema: {
      type: 'object',
      properties: COMMON_PROPERTIES,
      required: ['text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
]

/**
 * @typedef {object} ServeOptions
 * @property {NodeJS.ReadableStream} [input]
 * @property {NodeJS.WritableStream} [output]
 */

/**
 * Serves until the input stream closes.
 *
 * @param {ServeOptions} [options]
 * @returns {Promise<void>}
 */
export function serve(options = {}) {
  const { input = process.stdin, output = process.stdout } = options
  const send = (/** @type {object} */ message) => {
    output.write(`${JSON.stringify(message)}\n`)
  }

  /** @type {Promise<void>[]} */
  const pending = []
  const lines = createInterface({ input, crlfDelay: Infinity })
  lines.on('line', (line) => {
    if (!line.trim()) return
    pending.push(handleLine(line, send))
  })
  return new Promise((done) => {
    lines.on('close', () => {
      Promise.all(pending).then(() => done())
    })
  })
}

/**
 * @param {string} line
 * @param {(message: object) => void} send
 * @returns {Promise<void>}
 */
async function handleLine(line, send) {
  /** @type {any} */
  let message
  try {
    message = JSON.parse(line)
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }

  const isRequest = message && typeof message === 'object' && 'id' in message
  if (!isRequest) return // Notifications, including notifications/initialized.

  const { id, method, params } = message
  try {
    const result = await dispatch(method, params ?? {})
    send({ jsonrpc: '2.0', id, result })
  } catch (error) {
    const code = error instanceof RpcError ? error.code : -32603
    send({ jsonrpc: '2.0', id, error: { code, message: /** @type {Error} */ (error).message } })
  }
}

class RpcError extends Error {
  /**
   * @param {number} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * @param {string} method
 * @param {any} params
 * @returns {Promise<object>}
 */
async function dispatch(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion)
          ? params.protocolVersion
          : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'bot-tells', title: 'bot-tells', version: VERSION },
        instructions: INSTRUCTIONS,
      }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS }
    case 'tools/call':
      return callTool(params.name, params.arguments ?? {})
    default:
      throw new RpcError(-32601, `Method not found: ${method}`)
  }
}

/**
 * Tool failures are results with isError set, not protocol errors, so the model sees
 * the message and can act on it.
 *
 * @param {string} name
 * @param {any} args
 * @returns {Promise<object>}
 */
async function callTool(name, args) {
  if (name !== 'check_message' && name !== 'fix_message') {
    throw new RpcError(-32602, `Unknown tool: ${name}`)
  }
  try {
    const payload = name === 'check_message' ? checkTool(args) : fixTool(args)
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    }
  } catch (error) {
    if (error instanceof TellsError || error instanceof ToolInputError) {
      return { content: [{ type: 'text', text: error.message }], isError: true }
    }
    throw error
  }
}

class ToolInputError extends Error {}

/**
 * @param {any} args
 * @returns {{ text: string, markdown: boolean, ignore: string[] | undefined }}
 */
function commonArgs(args) {
  if (typeof args.text !== 'string') throw new ToolInputError('text must be a string.')
  if (args.text.length > MAX_TEXT) {
    throw new ToolInputError(`text is over ${MAX_TEXT} characters, which is a document, not a message.`)
  }
  if (args.markdown !== undefined && typeof args.markdown !== 'boolean') {
    throw new ToolInputError('markdown must be true or false.')
  }
  if (
    args.ignore !== undefined &&
    (!Array.isArray(args.ignore) || !args.ignore.every((/** @type {unknown} */ x) => typeof x === 'string'))
  ) {
    throw new ToolInputError('ignore must be a list of strings.')
  }
  return { text: args.text, markdown: args.markdown === true, ignore: args.ignore }
}

/**
 * @param {any} args
 */
function checkTool(args) {
  const { text, ...options } = commonArgs(args)
  for (const key of ['review_at', 'fail_at']) {
    if (args[key] !== undefined && typeof args[key] !== 'number') {
      throw new ToolInputError(`${key} must be a number.`)
    }
  }
  const result = checkMessage(text, { ...options, reviewAt: args.review_at, failAt: args.fail_at })
  return { passed: result.verdict === 'keep', ...result }
}

/**
 * @param {any} args
 */
function fixTool(args) {
  const { text, ...options } = commonArgs(args)
  const fixed = fixMessage(text, options)
  return {
    text: fixed.text,
    changed: fixed.changed,
    applied: fixed.applied.map(({ code, rule, text: words, line }) => ({ code, rule, text: words, line })),
    unfixed: fixed.result.findings,
    verdict: fixed.result.verdict,
    score: fixed.result.score,
  }
}
