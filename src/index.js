import { CODES, RULES, VOCABULARY } from './data/rules.js'

export { fixMessage } from './fix.js'
export { CODES } from './data/rules.js'

/**
 * @typedef {import('./data/rules.js').Code} ReasonCode
 * @typedef {import('./data/rules.js').Level} Level
 * @typedef {import('./data/rules.js').Rule} Rule
 * @typedef {import('./data/rules.js').Fix} Fix
 *
 * @typedef {'keep'|'review'|'fail'} Verdict
 *
 * @typedef {object} Finding
 * @property {ReasonCode} code
 * @property {string} rule Which rule matched, such as finds_you_well.
 * @property {Level} level
 * @property {string} text The words as written.
 * @property {number} start Offset in the message, in UTF-16 units, as String#slice counts.
 * @property {number} end
 * @property {number} line 1-based.
 * @property {number} column 1-based.
 * @property {number} points What it added to the score. Repeats count for less, and
 *   past a cap for nothing.
 * @property {string} suggestion What to do instead.
 * @property {Fix | null} fix A mechanical fix fixMessage can apply, if there is one.
 *
 * @typedef {object} Reason
 * @property {ReasonCode} code Stable, safe to match on.
 * @property {Verdict} verdict What this reason alone would make of the message: 'fail'
 *   for a leak, 'keep' for a tell, since tells only count through the score.
 * @property {number} count How many findings.
 * @property {string} detail Plain English.
 *
 * @typedef {object} Facts
 * @property {number} words
 * @property {number} sentences
 * @property {number} points Sum of the findings' points.
 * @property {number} reviewAt
 * @property {number} failAt
 * @property {boolean} markdown Whether Markdown was treated as rendered.
 *
 * @typedef {object} Result
 * @property {Verdict} verdict 'fail' on any leak; otherwise from the score.
 * @property {number} score 0 to 100. How much the message reads as written by a bot.
 * @property {string} summary One line for a person.
 * @property {Reason[]} reasons Leaks first, then tells by points.
 * @property {Finding[]} findings Every match, in the order they appear.
 * @property {Facts} facts
 * @property {string[]} notes What the reader needs to know to trust the result.
 *
 * @typedef {object} CheckOptions
 * @property {number} [reviewAt] Review at this score or above. Default 25.
 * @property {number} [failAt] Fail at this score or above. Default 60.
 * @property {boolean} [markdown] The message will be shown with Markdown rendered,
 *   such as in Slack or GitHub, so Markdown is not a leak. Default false.
 * @property {string[]} [ignore] Codes or rule ids to skip, such as em_dash.
 */

export const DEFAULT_REVIEW_AT = 25
export const DEFAULT_FAIL_AT = 60

const VERDICT_ORDER = { keep: 0, review: 1, fail: 2 }

export class TellsError extends Error {
  /**
   * @param {'invalid_option'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'TellsError'
    this.code = code
  }
}

/** Every rule id, so ignore can be checked against something. */
const RULE_IDS = new Set([...RULES.map((r) => r.id), 'ai_vocabulary'])

/** @type {Rule[]} */
const VOCABULARY_RULES = VOCABULARY.map((w) => ({
  id: 'ai_vocabulary',
  code: /** @type {const} */ ('ai_vocabulary'),
  pattern: new RegExp(`(?<![\\p{L}\\p{N}-])(?:${w.forms})(?![\\p{L}\\p{N}-])`, 'giu'),
  weight: w.weight,
  cap: 1,
  suggest: `Try ${w.instead}.`,
  ...(w.replace ? { fix: { replace: w.replace } } : {}),
}))

/**
 * Checks a message for what makes readers think a bot wrote it: chat output that leaked
 * into it, and wording people have learned to associate with AI. Returns a verdict, a
 * 0-100 score, and every finding with where it is and what to do instead. Runs
 * locally, touches no network, and works in a browser.
 *
 * This is not an AI detector. It cannot tell who wrote a message, and does not try:
 * people write every one of these tells too. It finds what a reader would hold against
 * the message.
 *
 * @param {string} text
 * @param {CheckOptions} [options]
 * @returns {Result}
 */
export function checkMessage(text, options = {}) {
  const {
    reviewAt = DEFAULT_REVIEW_AT,
    failAt = DEFAULT_FAIL_AT,
    markdown = false,
    ignore = [],
  } = options
  for (const [name, value] of /** @type {const} */ ([['reviewAt', reviewAt], ['failAt', failAt]])) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new TellsError('invalid_option', `${name} must be a number from 0 to 100, got ${value}.`)
    }
  }
  if (reviewAt > failAt) {
    throw new TellsError('invalid_option', `reviewAt (${reviewAt}) must not be above failAt (${failAt}).`)
  }
  if (!Array.isArray(ignore)) {
    throw new TellsError('invalid_option', 'ignore must be a list of codes or rule ids.')
  }
  for (const id of ignore) {
    if (!(id in CODES) && !RULE_IDS.has(id)) {
      throw new TellsError('invalid_option', `ignore: ${id} is not a code or rule id.`)
    }
  }

  const body = String(text ?? '')
  const findings = findTells(body, { markdown, ignore })
  const points = findings.reduce((sum, f) => sum + f.points, 0)
  const words = countWords(body)
  const score = scoreFor(points, words)

  const leaked = findings.some((f) => f.level === 'leak')
  /** @type {Verdict} */
  const fromScore = score >= failAt ? 'fail' : score >= reviewAt ? 'review' : 'keep'
  const verdict = leaked ? 'fail' : fromScore

  const reasons = reasonsFor(findings)
  /** @type {string[]} */
  const notes = []
  if (!body.trim()) {
    notes.push('The message is empty.')
  } else if (words < 25) {
    notes.push(`Short message (${words} words): one phrase moves the score a long way.`)
  }

  return {
    verdict,
    score,
    summary: summaryFor(verdict, score, leaked, findings.length),
    reasons,
    findings,
    facts: {
      words,
      sentences: countSentences(body),
      points: Math.round(points * 100) / 100,
      reviewAt,
      failAt,
      markdown,
    },
    notes,
  }
}

/**
 * Same length as the input, so offsets carry over.
 *
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
  return text.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"')
}

/**
 * @param {string} body
 * @param {{ markdown: boolean, ignore: string[] }} options
 * @returns {Finding[]}
 */
function findTells(body, { markdown, ignore }) {
  const norm = normalize(body)
  const skip = new Set(ignore)

  /** @type {Array<{ rule: Rule, start: number, end: number }>} */
  const candidates = []
  for (const rule of [...RULES, ...VOCABULARY_RULES]) {
    if (skip.has(rule.code) || skip.has(rule.id)) continue
    if (rule.plainTextOnly && markdown) continue
    const matches = []
    for (const m of norm.matchAll(rule.pattern)) {
      // Patterns may swallow leading spaces; a finding starts at the first word.
      const lead = m[0].length - m[0].trimStart().length
      const trail = m[0].length - m[0].trimEnd().length
      if (m[0].trim() === '') continue
      matches.push({ rule, start: m.index + lead, end: m.index + m[0].length - trail })
    }
    if (matches.length >= (rule.minCount ?? 1)) candidates.push(...matches)
  }

  // Where rules overlap, the leak wins, then the heavier rule, then the longer match.
  candidates.sort(
    (a, b) =>
      levelOf(b.rule) - levelOf(a.rule) ||
      b.rule.weight - a.rule.weight ||
      b.end - b.start - (a.end - a.start) ||
      a.start - b.start,
  )
  /** @type {typeof candidates} */
  const kept = []
  for (const c of candidates) {
    if (!kept.some((k) => c.start < k.end && k.start < c.end)) kept.push(c)
  }
  kept.sort((a, b) => a.start - b.start)

  const lineStarts = [0]
  for (let i = 0; i < body.length; i++) if (body[i] === '\n') lineStarts.push(i + 1)

  /** @type {Map<string, number>} */
  const seen = new Map()
  return kept.map(({ rule, start, end }) => {
    // Vocabulary shares one id, so repeats are counted per word.
    const key = rule.id === 'ai_vocabulary' ? `ai_vocabulary:${rule.pattern.source}` : rule.id
    const n = seen.get(key) ?? 0
    seen.set(key, n + 1)
    const cap = rule.cap ?? 3
    const points = n < cap ? rule.weight * (rule.decay ?? 0.5) ** n : 0
    let line = 0
    while (line + 1 < lineStarts.length && lineStarts[line + 1] <= start) line++
    return {
      code: rule.code,
      rule: rule.id,
      level: CODES[rule.code].level,
      text: body.slice(start, end),
      start,
      end,
      line: line + 1,
      column: start - lineStarts[line] + 1,
      points: Math.round(points * 100) / 100,
      suggestion: rule.suggest,
      fix: rule.fix ?? null,
    }
  })
}

/**
 * @param {Rule} rule
 * @returns {number}
 */
function levelOf(rule) {
  return CODES[rule.code].level === 'leak' ? 1 : 0
}

/**
 * Points become a score on a curve that never reaches 100, scaled by length: the same
 * phrase says more about a three-line email than about a long one. One "I hope this
 * email finds you well" in a 60-word email is about 39.
 *
 * @param {number} points
 * @param {number} words
 * @returns {number}
 */
export function scoreFor(points, words) {
  if (points <= 0) return 0
  const scale = 8 + words / 30
  return Math.min(99, Math.max(1, Math.round(100 * (1 - Math.exp(-points / scale)))))
}

/**
 * @param {Finding[]} findings
 * @returns {Reason[]}
 */
function reasonsFor(findings) {
  /** @type {Map<ReasonCode, Finding[]>} */
  const byCode = new Map()
  for (const f of findings) byCode.set(f.code, [...(byCode.get(f.code) ?? []), f])

  /** @type {Array<Reason & { points: number }>} */
  const reasons = [...byCode].map(([code, list]) => {
    const info = CODES[code]
    const more = list.length > 5 ? `, and ${list.length - 5} more` : ''
    const suggestions = [...new Set(list.map((f) => f.suggestion))]
    let detail
    if (suggestions.length === 1) {
      const shown = list.slice(0, 5).map((f) => `"${clip(f.text)}" (line ${f.line})`)
      detail = `${shown.join(', ')}${more}. ${info.why} ${suggestions[0]}`
    } else {
      const shown = list.slice(0, 5).map((f) => `"${clip(f.text)}" (line ${f.line}): ${f.suggestion}`)
      detail = `${info.why} ${shown.join(' ')}${more ? ` And ${list.length - 5} more.` : ''}`
    }
    return {
      code,
      verdict: /** @type {Verdict} */ (info.level === 'leak' ? 'fail' : 'keep'),
      count: list.length,
      detail,
      points: list.reduce((s, f) => s + f.points, 0),
    }
  })
  reasons.sort((a, b) => VERDICT_ORDER[b.verdict] - VERDICT_ORDER[a.verdict] || b.points - a.points)
  return reasons.map(({ points, ...r }) => r)
}

/**
 * @param {string} text
 * @returns {string}
 */
function clip(text) {
  const flat = text.replace(/\s+/g, ' ')
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat
}

/**
 * @param {Verdict} verdict
 * @param {number} score
 * @param {boolean} leaked
 * @param {number} count
 * @returns {string}
 */
function summaryFor(verdict, score, leaked, count) {
  if (leaked) return 'Chat output leaked into the message. Do not send it as it stands.'
  if (verdict === 'fail') return 'Reads like a bot wrote it.'
  if (verdict === 'review') return 'Some bot tells. A reader may notice them.'
  if (count === 0) return 'No bot tells found.'
  return score === 0 ? 'Reads like a person wrote it.' : 'A few tells, not enough to stand out.'
}

/**
 * @param {string} text
 * @returns {number}
 */
export function countWords(text) {
  return (text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length
}

/**
 * @param {string} text
 * @returns {number}
 */
function countSentences(text) {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((s) => /[\p{L}\p{N}]/u.test(s)).length
}
