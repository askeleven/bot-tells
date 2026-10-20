import { CODES } from './data/rules.js'

/**
 * @typedef {import('./index.js').Result} Result
 * @typedef {import('./index.js').Finding} Finding
 * @typedef {import('./index.js').Verdict} Verdict
 */

const COLOURS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  markLeak: '\x1b[41;97m',
  markTell: '\x1b[43;30m',
}

/**
 * @param {boolean} enabled
 * @returns {(code: string, text: string) => string}
 */
function painter(enabled) {
  return (code, text) => (enabled ? `${code}${text}${COLOURS.reset}` : text)
}

/**
 * @param {string} text
 * @param {number} width
 * @param {string} indent
 * @returns {string}
 */
function wrap(text, width, indent) {
  /** @type {string[]} */
  const lines = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(line)
  return lines.map((l) => indent + l).join('\n')
}

/**
 * @param {number} n
 * @param {string} one
 * @returns {string}
 */
function plural(n, one) {
  return `${n} ${one}${n === 1 ? '' : 's'}`
}

/**
 * @param {number} score
 * @returns {string}
 */
export function scoreBar(score) {
  const filled = Math.round(score / 5)
  return `[${'#'.repeat(filled)}${'-'.repeat(20 - filled)}]`
}

/**
 * @param {string} text The message that was checked.
 * @param {Result} result
 * @param {{ colour?: boolean, width?: number }} [options]
 * @returns {string}
 */
export function formatText(text, result, options = {}) {
  const { colour = true, width = 76 } = options
  const paint = painter(colour)
  const { facts, findings } = result
  const lines = ['']

  const label = { keep: 'PASS', review: 'REVIEW', fail: 'FAIL' }[result.verdict]
  const tint = { keep: COLOURS.green, review: COLOURS.yellow, fail: COLOURS.red }[result.verdict]
  lines.push(`${paint(tint, label)}  ${paint(COLOURS.bold, result.summary)}`)
  lines.push('')

  const row = (/** @type {string} */ name, /** @type {string} */ value) =>
    lines.push(`      ${paint(COLOURS.dim, name.padEnd(12))} ${value}`)
  row('Bot score', `${paint(tint, `${result.score}/100`)}  ${paint(COLOURS.dim, scoreBar(result.score))}`)
  row('Length', `${plural(facts.words, 'word')}, ${plural(facts.sentences, 'sentence')}`)
  const leaks = findings.filter((f) => f.level === 'leak').length
  const tells = findings.length - leaks
  row(
    'Found',
    findings.length === 0
      ? 'nothing'
      : [leaks ? paint(COLOURS.red, plural(leaks, 'leak')) : '', tells ? plural(tells, 'tell') : '']
          .filter(Boolean)
          .join(', '),
  )

  if (findings.length > 0) {
    lines.push('')
    lines.push(...markedLines(text, findings, colour))
  }

  const sections = /** @type {const} */ ([
    ['fail', 'FAIL', COLOURS.red],
    ['keep', 'TELLS', COLOURS.yellow],
  ])
  for (const [verdict, heading, colourCode] of sections) {
    const reasons = result.reasons.filter((r) => r.verdict === verdict)
    if (reasons.length === 0) continue
    lines.push('')
    lines.push(paint(colourCode, heading))
    for (const reason of reasons) {
      lines.push(`  ${paint(COLOURS.bold, CODES[reason.code].title)}`)
      lines.push(wrap(reason.detail, width - 6, '      '))
    }
  }

  const fixable = findings.filter((f) => f.fix).length
  if (fixable > 0) {
    lines.push('')
    lines.push(
      paint(
        COLOURS.dim,
        wrap(
          `${plural(fixable, 'finding')} may be fixable without a rewrite: run again with ` +
            '--fix to print the message with the safe fixes applied.',
          width - 2,
          '  ',
        ),
      ),
    )
  }

  if (result.notes.length) {
    lines.push('')
    for (const note of result.notes) lines.push(paint(COLOURS.dim, wrap(note, width - 2, '  ')))
  }

  lines.push('')
  return lines.join('\n')
}

/**
 * The lines that have findings, numbered, with each finding marked: highlighted with
 * colour, between >> and << without.
 *
 * @param {string} text
 * @param {Finding[]} findings
 * @param {boolean} colour
 * @returns {string[]}
 */
function markedLines(text, findings, colour) {
  const source = text.split('\n')
  const numberWidth = String(source.length).length
  /** @type {string[]} */
  const out = []
  let offset = 0
  for (const [i, line] of source.entries()) {
    const lineStart = offset
    const lineEnd = offset + line.length
    offset = lineEnd + 1
    const here = findings.filter((f) => f.start < lineEnd && f.end > lineStart)
    if (here.length === 0) continue
    let marked = ''
    let at = lineStart
    for (const f of here) {
      const s = Math.max(f.start, lineStart)
      const e = Math.min(f.end, lineEnd)
      if (s < at) continue
      marked += text.slice(at, s)
      const words = text.slice(s, e)
      marked += colour
        ? `${f.level === 'leak' ? COLOURS.markLeak : COLOURS.markTell}${words}${COLOURS.reset}`
        : `>>${words}<<`
      at = e
    }
    marked += text.slice(at, lineEnd)
    const number = String(i + 1).padStart(numberWidth)
    out.push(`  ${colour ? `${COLOURS.dim}${number}${COLOURS.reset}` : number}  ${marked}`)
  }
  return out
}

/**
 * The one-line summary --fix writes to standard error.
 *
 * @param {import('./fix.js').FixResult} fixed
 * @param {Result} before
 * @returns {string}
 */
export function formatFixSummary(fixed, before) {
  const n = fixed.applied.length
  if (n === 0) {
    const u = fixed.unfixed.length
    return `Nothing could be fixed safely. Score ${before.score}/100. ${plural(u, 'finding')} ${u === 1 ? 'needs' : 'need'} a person.\n`
  }
  const left = fixed.result.findings.length
  return (
    `Fixed ${n} of ${before.findings.length}. Score ${before.score} -> ${fixed.result.score}/100 ` +
    `(${fixed.result.verdict}).${left ? ` ${plural(left, 'finding')} left for a person.` : ''}\n`
  )
}
