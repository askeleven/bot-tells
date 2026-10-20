import { checkMessage } from './index.js'

/**
 * @typedef {import('./index.js').Finding} Finding
 * @typedef {import('./index.js').Result} Result
 * @typedef {import('./index.js').CheckOptions} CheckOptions
 *
 * @typedef {object} FixResult
 * @property {string} text The message with every safe fix applied.
 * @property {boolean} changed
 * @property {Finding[]} applied Findings fixed, as found in the original.
 * @property {Finding[]} unfixed Findings that need a person: no mechanical fix, or the
 *   fix would have cut words the writer meant.
 * @property {Result} result The fixed text, checked again.
 */

/** A greeting kept when the rest of its sentence is dropped: "Hi Sam, I hope...". */
const GREETING = /^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening))\b[^,\n]{0,40},[ \t]*/i

/**
 * What may follow a stock phrase in a sentence that is cut whole. Anything else, such
 * as a phone number or a date, means the sentence says something and stays.
 */
const FILLER_TAIL = new RegExp(
  '^[\\s,]*(?:' +
    [
      "(?:if|should) you (?:have|had) any (?:other |further |more |additional )?(?:questions|concerns)(?: or (?:questions|concerns))?",
      "if (?:you need|there(?:'s| is)) anything(?: else)?(?: (?:at all|I can (?:help with|do)))?",
      '(?:with|for|about) any (?:other |further |more )?(?:questions|concerns)',
      'at any time|anytime|in the meantime',
      "(?:and |that )?(?:you(?:'re| are) )?(?:having|have|had) an? (?:great|good|wonderful|lovely) (?:day|week|weekend)",
    ].join('|') +
    ')?[\\s,]*$',
  'i',
)

/**
 * Applies the fixes that are safe without reading the message: cutting filler sentences
 * that are nothing but filler, cutting chat wrappers, swapping a few words one for one,
 * turning a pair of em dashes around an aside into commas, and unwrapping Markdown. It never rewrites a sentence, so what
 * is left in unfixed still needs a person, or a model, to rewrite it.
 *
 * @param {string} text
 * @param {CheckOptions} [options]
 * @returns {FixResult}
 */
export function fixMessage(text, options = {}) {
  const body = String(text ?? '')
  const { findings } = checkMessage(body, options)

  /** @type {Array<{ start: number, end: number, with: string, finding: Finding }>} */
  const edits = []
  /** @type {Finding[]} */
  const unfixed = []
  for (const f of findings) {
    const edit = f.fix ? editFor(body, f) : null
    if (edit && !edits.some((e) => edit.start < e.end && e.start < edit.end)) {
      edits.push({ ...edit, finding: f })
    } else {
      unfixed.push(f)
    }
  }

  let out = body
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.with + out.slice(e.end)
  }
  if (edits.length > 0) out = tidy(out)

  return {
    text: out,
    changed: out !== body,
    applied: edits.map((e) => e.finding),
    unfixed,
    result: checkMessage(out, options),
  }
}

/**
 * @param {string} body
 * @param {Finding} f
 * @returns {{ start: number, end: number, with: string } | null}
 */
function editFor(body, f) {
  const fix = f.fix
  if (fix === 'drop-sentence') return dropSentence(body, f)
  if (fix === 'drop-line') return dropLine(body, f)
  if (fix === 'unwrap-markdown') return { start: f.start, end: f.end, with: unwrap(f.text) }
  if (fix === 'em-dash') {
    // A pair around an aside reads the same with commas. A single dash may stand for a
    // colon, a full stop or a comma, and only reading the sentence says which.
    let s = f.start
    while (s > 0 && !/[.!?\n]/.test(body[s - 1])) s--
    let e = f.end
    while (e < body.length && !/[.!?\n]/.test(body[e])) e++
    if ((body.slice(s, e).match(/—| – /g) ?? []).length !== 2) return null
    let start = f.start
    let end = f.end
    while (start > 0 && /[ \t]/.test(body[start - 1])) start--
    while (end < body.length && /[ \t]/.test(body[end])) end++
    return { start, end, with: /[,.]/.test(body[start - 1] ?? '') ? ' ' : ', ' }
  }
  if (fix && typeof fix === 'object') {
    const to = fix.replace[f.text.toLowerCase().replace(/\s+/g, ' ')]
    if (to === undefined) return null
    return { start: f.start, end: f.end, with: matchCase(f.text, to) }
  }
  return null
}

/**
 * Cuts the sentence around the finding, only when the finding is the whole sentence
 * apart from a greeting in front of it.
 *
 * @param {string} body
 * @param {Finding} f
 * @returns {{ start: number, end: number, with: string } | null}
 */
function dropSentence(body, f) {
  let s = f.start
  while (s > 0 && !/[.!?\n]/.test(body[s - 1])) s--
  while (s < f.start && /\s/.test(body[s])) s++
  const greeting = GREETING.exec(body.slice(s, f.start))
  if (greeting) s += greeting[0].length

  let e = f.end
  if (!/[.!?]$/.test(f.text)) {
    while (e < body.length && !/[.!?\n]/.test(body[e])) e++
  }
  while (e < body.length && /[.!?]/.test(body[e])) e++

  if (/[\p{L}\p{N}]/u.test(body.slice(s, f.start))) return null
  // A leak's whole sentence was meant for someone else. A tell's sentence may carry
  // something real after the stock phrase, so only known filler may follow it.
  const after = body.slice(f.end, e).replace(/[.!?]+$/, '').replace(/[‘’]/g, "'")
  if (f.level === 'tell' && !FILLER_TAIL.test(after)) return null

  while (e < body.length && /[ \t]/.test(body[e])) e++
  return { start: s, end: e, with: '' }
}

/**
 * Cuts the line the finding is on, only when the finding is the whole line.
 *
 * @param {string} body
 * @param {Finding} f
 * @returns {{ start: number, end: number, with: string } | null}
 */
function dropLine(body, f) {
  const s = body.lastIndexOf('\n', f.start - 1) + 1
  const nl = body.indexOf('\n', f.end)
  const e = nl === -1 ? body.length : nl
  const rest = body.slice(s, f.start) + body.slice(f.end, e)
  if (/[\p{L}\p{N}]/u.test(rest)) return null
  return { start: s, end: nl === -1 ? e : e + 1, with: '' }
}

/**
 * @param {string} text
 * @returns {string}
 */
function unwrap(text) {
  const heading = /^#{1,6}[ \t]+(.*)$/.exec(text)
  if (heading) return heading[1].replace(/[ \t]+#+[ \t]*$/, '')
  const link = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(text)
  if (link) {
    const target = link[2].replace(/^mailto:/, '')
    return link[1] === link[2] || link[1] === target ? target : `${link[1]} (${target})`
  }
  return text.replace(/^(\*\*|__)([\s\S]*)\1$/, '$2')
}

/**
 * @param {string} original
 * @param {string} replacement
 * @returns {string}
 */
function matchCase(original, replacement) {
  if (!replacement) return replacement
  return /^\p{Lu}/u.test(original)
    ? replacement[0].toUpperCase() + replacement.slice(1)
    : replacement
}

/**
 * Cleans up the gaps cuts leave: spaces at line ends, runs of blank lines, a blank start.
 *
 * @param {string} text
 * @returns {string}
 */
function tidy(text) {
  return text
    .replace(/[ \t]+$/gm, '')
    .replace(/(\S)[ \t]{2,}/g, '$1 ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+/, '')
    .replace(/\s+$/, '')
    .replace(/^\p{Ll}/u, (c) => c.toUpperCase())
}
