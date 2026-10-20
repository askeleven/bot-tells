#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import {
  checkMessage,
  fixMessage,
  TellsError,
  DEFAULT_REVIEW_AT,
  DEFAULT_FAIL_AT,
} from '../src/index.js'
import { formatText, formatFixSummary } from '../src/report.js'
import { serve } from '../src/mcp.js'
import { VERSION } from '../src/version.js'

const USAGE = `
bot-tells <"message text" | message.txt | ->
bot-tells mcp

  Checks a message before you send it for what makes readers think a bot wrote
  it: placeholders and chat wrappers that leaked in, stock openers and closers,
  words people now read as AI, and the rest. Gives a verdict, a 0-100 bot score,
  and every finding with a suggestion. Runs locally, no network.

Options
  --fix                 Print the message with the safe fixes applied, and a
                        summary on standard error.
  --markdown            The destination renders Markdown (Slack, GitHub), so
                        Markdown is not a leak.
  --ignore <list>       Codes or rule ids to skip, comma-separated, such as
                        em_dash,exclamations.
  --review-at <n>       Review at this score or above. Default ${DEFAULT_REVIEW_AT}.
  --fail-at <n>         Fail at this score or above. Default ${DEFAULT_FAIL_AT}.
  --json                Machine-readable output.
  --no-colour           Plain text.
  --version, --help

  Reads standard input when given "-", or no text and piped input. Trailing
  newlines in a file or standard input are dropped.

Exit codes
  0  OK to send (with --fix: the fixed message is)
  1  do not send as it stands: a leak, or the score is at --review-at or above
  2  could not run

Examples
  npx @askeleven/bot-tells "I hope this email finds you well."
  npx @askeleven/bot-tells draft.txt --json
  npx @askeleven/bot-tells draft.txt --fix > fixed.txt
  npx @askeleven/bot-tells mcp       # MCP server over stdio, for agents
`

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
async function main(argv) {
  if (argv[0] === 'mcp') {
    await serve()
    return 0
  }

  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        fix: { type: 'boolean', default: false },
        markdown: { type: 'boolean', default: false },
        ignore: { type: 'string' },
        'review-at': { type: 'string' },
        'fail-at': { type: 'string' },
        json: { type: 'boolean', default: false },
        // parseArgs has no --no-x negation, so both spellings are declared explicitly.
        'no-colour': { type: 'boolean', default: false },
        'no-color': { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    })
  } catch (error) {
    process.stderr.write(`${/** @type {Error} */ (error).message}\n${USAGE}`)
    return 2
  }
  const { values, positionals } = parsed

  if (values.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  /** @type {Record<string, number>} */
  const thresholds = {}
  for (const name of /** @type {const} */ (['review-at', 'fail-at'])) {
    if (values[name] === undefined) continue
    const n = Number(values[name])
    if (values[name].trim() === '' || !Number.isFinite(n)) {
      process.stderr.write(`--${name} must be a number from 0 to 100, got ${values[name]}\n`)
      return 2
    }
    thresholds[name] = n
  }

  let text
  try {
    text = await readInput(positionals)
  } catch (error) {
    process.stderr.write(`${/** @type {Error} */ (error).message}\n`)
    return 2
  }

  const options = {
    reviewAt: thresholds['review-at'],
    failAt: thresholds['fail-at'],
    markdown: values.markdown,
    ignore: values.ignore
      ? values.ignore.split(',').map((s) => s.trim()).filter(Boolean)
      : [],
  }
  const colour = useColour(values)

  let result
  try {
    result = checkMessage(text, options)
  } catch (error) {
    if (error instanceof TellsError) {
      process.stderr.write(`${error.message}\n`)
      return 2
    }
    throw error
  }

  if (values.fix) {
    const fixed = fixMessage(text, options)
    if (values.json) {
      process.stdout.write(`${JSON.stringify(fixed, null, 2)}\n`)
    } else {
      process.stdout.write(`${fixed.text}\n`)
      process.stderr.write(formatFixSummary(fixed, result))
    }
    return fixed.result.verdict === 'keep' ? 0 : 1
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(formatText(text, result, { colour }))
  }
  return result.verdict === 'keep' ? 0 : 1
}

/**
 * One positional that names a file is read from it; "-", or nothing with input piped
 * in, reads standard input; anything else is the message itself, words joined by
 * single spaces the way the shell split them.
 *
 * @param {string[]} positionals
 * @returns {Promise<string>}
 */
async function readInput(positionals) {
  if (positionals.length === 0 || (positionals.length === 1 && positionals[0] === '-')) {
    if (process.stdin.isTTY) throw new Error(`Give the message, a file, or pipe it in.\n${USAGE}`)
    return dropTrailingNewlines(await readStdin())
  }
  if (positionals.length === 1 && existsSync(positionals[0]) && statSync(positionals[0]).isFile()) {
    return dropTrailingNewlines(await readFile(positionals[0], 'utf8'))
  }
  return positionals.join(' ')
}

/**
 * @param {string} text
 * @returns {string}
 */
function dropTrailingNewlines(text) {
  return text.replace(/[\r\n]+$/, '')
}

/** @returns {Promise<string>} */
async function readStdin() {
  /** @type {Buffer[]} */
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Honours --no-colour, --no-color, NO_COLOR, and a non-TTY stdout.
 *
 * @param {Record<string, unknown>} values
 * @returns {boolean}
 */
function useColour(values) {
  if (values['no-colour'] || values['no-color']) return false
  if (process.env.NO_COLOR) return false
  return process.stdout.isTTY === true
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`)
    process.exitCode = 2
  },
)
