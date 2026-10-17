import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { checkMessage, fixMessage, scoreFor, countWords, CODES, TellsError } from '../src/index.js'
import { RULES, VOCABULARY } from '../src/data/rules.js'
import { formatText } from '../src/report.js'
import { serve } from '../src/mcp.js'

const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url))

/** Written as escapes: no emoji characters in the source. */
const ROCKET = '\u{1F680}'
const BULB = '\u{1F4A1}'
const FIRE = '\u{1F525}'
const EM = '—'

const GENERATED = `Certainly! Here's a draft of the email:

Subject: Unlocking Growth for Your Business

Hi [First Name],

I hope this email finds you well. In today's fast-paced business landscape, staying ahead is paramount. At Acme, we don't just build software ${EM} we build partnerships.

Our platform seamlessly integrates with your existing tools, empowering your team to unlock their full potential.

Don't hesitate to reach out if you have any questions.

Best regards,
[Your Name]

Let me know if you'd like me to adjust the tone or make it more concise.`

const POLISHED = `Hi Dana,

I hope you're doing well! I wanted to follow up on our conversation last week regarding the website redesign. Our team has delved into your requirements and put together a comprehensive proposal that addresses your key goals ${EM} faster load times, a cleaner layout, and better mobile support.

The result? A site that not only looks great but also converts. We believe this will play a pivotal role in your growth.

Please let me know if you have any questions. I look forward to hearing from you!

Best,
Sam`

/** People, writing the way people write. None of these should be held against them. */
const HUMAN = [
  `Hi Dana,

Quick one: the redesign quote is attached. It's $4,800, two weeks start to finish, and we can start on the 3rd if you sign by Friday.

The big change is the booking page. Right now it takes six taps on a phone; we get it to two.

Want me to hold the 3rd for you?

Sam`,
  'hey - running 10 min late, traffic on 95 is a mess. order me the usual?',
  `Hi Mr. Alvarez, this is Priya from Green Thumb Landscaping. Your spring cleanup is booked for Tuesday the 14th, between 8 and 10am. We'll need the side gate unlocked. Reply C to confirm or call 305-555-0142 to move it.`,
  `Thanks for sending the photos. The crack in the second one is cosmetic, but the one by the drain worries me more. I'd like to come and look at it before we quote. Does Thursday afternoon work? I'm free from 2.`,
  `We placed two kids through foster care this year, and the realm of paperwork alone was enough to make me want to quit. Still worth it. If you're thinking about it, call me.`,
  `I hope you're well. Attached is the signed lease. Keys are with the front desk.`,
]

/** @param {import('../src/index.js').Result} r */
const codes = (r) => [...new Set(r.findings.map((f) => f.code))]

// Rules

test('rules: unique ids, known codes, global patterns, sensible weights', () => {
  const ids = new Set()
  for (const rule of RULES) {
    assert.ok(!ids.has(rule.id), `duplicate id ${rule.id}`)
    ids.add(rule.id)
    assert.ok(rule.code in CODES, `${rule.id} has unknown code ${rule.code}`)
    assert.ok(rule.pattern.global, `${rule.id} must be global`)
    assert.ok(rule.weight > 0 && rule.weight <= 6, rule.id)
    assert.match(rule.suggest, /\.["']?$/, `${rule.id} suggestion ends a sentence`)
    assert.ok(!rule.pattern.test(''), `${rule.id} matches nothing in an empty string`)
    rule.pattern.lastIndex = 0
  }
  for (const word of VOCABULARY) {
    assert.doesNotThrow(() => new RegExp(word.forms), word.forms)
    for (const [from, to] of Object.entries(word.replace ?? {})) {
      assert.equal(from, from.toLowerCase(), 'replace keys are lower case')
      assert.ok(new RegExp(`^(?:${word.forms})$`, 'i').test(from), `${from} matches ${word.forms}`)
      assert.notEqual(to, '')
    }
  }
})

test('score: 0 with no points, never 100, smaller for the same points in a longer message', () => {
  assert.equal(scoreFor(0, 50), 0)
  assert.ok(scoreFor(1000, 10) < 100)
  assert.ok(scoreFor(5, 60) > scoreFor(5, 400))
  assert.equal(scoreFor(0.01, 1000), 1, 'any finding shows as at least 1')
})

test('countWords: contractions and hyphenated words are one word', () => {
  assert.equal(countWords("It's a state-of-the-art, well-known thing."), 5)
  assert.equal(countWords(''), 0)
})

// Checking

test('generated email: every leak fails it, whatever the score', () => {
  const r = checkMessage(GENERATED)
  assert.equal(r.verdict, 'fail')
  assert.ok(r.score >= 90, `score ${r.score}`)
  for (const code of ['chat_preamble', 'placeholder', 'chat_postamble', 'stock_opener', 'stock_closer', 'ai_vocabulary', 'not_x_but_y']) {
    assert.ok(codes(r).includes(code), `missing ${code}`)
  }
  assert.equal(r.reasons[0].verdict, 'fail', 'leaks come first')
  assert.match(r.summary, /leaked/)

  const leaksOnly = checkMessage('Hi [First Name], your order shipped today.')
  assert.equal(leaksOnly.verdict, 'fail', 'a placeholder fails a message even with a low score')
})

test('polished generated email: fails on tells alone, no leaks', () => {
  const r = checkMessage(POLISHED)
  assert.equal(r.verdict, 'fail')
  assert.ok(r.findings.every((f) => f.level === 'tell'))
  assert.ok(r.score >= 60 && r.score < 95, `score ${r.score}`)
  for (const code of ['ai_vocabulary', 'rhetorical_reveal', 'not_x_but_y', 'stock_phrase', 'em_dash']) {
    assert.ok(codes(r).includes(code), `missing ${code}`)
  }
})

test('people writing normally: keep, and nothing worth reviewing', () => {
  for (const text of HUMAN) {
    const r = checkMessage(text)
    assert.equal(r.verdict, 'keep', `${text.slice(0, 40)}: ${r.score} ${r.findings.map((f) => f.text)}`)
    assert.ok(r.score < 25)
  }
  assert.equal(checkMessage(HUMAN[0]).findings.length, 0)
  assert.match(checkMessage(HUMAN[0]).summary, /No bot tells/)
})

test('one stock opener in a short email is worth a look, not a fail', () => {
  const r = checkMessage(
    'Hi Tom, I hope this email finds you well. The invoice for March is attached; it is due on the 30th. Thanks, Ana',
  )
  assert.equal(r.verdict, 'review')
  assert.equal(r.findings.length, 1)
  assert.equal(r.findings[0].rule, 'finds_you_well')
})

test('findings: offsets, lines and columns point at the words as written', () => {
  const text = 'Hello.\nWe ’ll see. I’d be happy to help with that.\nAs an AI, I think so.'
  const r = checkMessage(text)
  for (const f of r.findings) assert.equal(text.slice(f.start, f.end), f.text)
  const happy = r.findings.find((f) => f.rule === 'happy_to_help')
  assert.ok(happy, 'curly apostrophes match straight ones')
  assert.equal(happy.text, 'I’d be happy to help with')
  assert.equal(happy.line, 2)
  assert.equal(happy.column, 13)
  const ai = r.findings.find((f) => f.code === 'ai_disclosure')
  assert.equal(ai?.line, 3)
  assert.equal(ai?.column, 1)
})

test('overlapping rules: one finding, the leak or the heavier rule', () => {
  const r = checkMessage('Moving forward, we will delve into the realm of possibilities.')
  const realm = r.findings.filter((f) => /realm/.test(f.text))
  assert.equal(realm.length, 1)
  assert.equal(realm[0].rule, 'realm_of', 'the phrase outweighs the word')
})

test('repeats count for less, and past the cap for nothing', () => {
  const r = checkMessage(`a${EM}b c${EM}d e${EM}f g${EM}h i${EM}j k${EM}l m${EM}n o${EM}p q${EM}r r${EM}s`)
  const points = r.findings.map((f) => f.points)
  assert.equal(points.length, 10)
  assert.equal(points[0], 1.5)
  assert.ok(points[1] < points[0])
  assert.equal(points[8], 0)
  assert.equal(points[9], 0)
})

test('vocabulary: whole words only, each word counted once', () => {
  assert.deepEqual(codes(checkMessage('Delve, delving, delved.')), ['ai_vocabulary'])
  assert.equal(checkMessage('Delve, delving, delved.').findings.filter((f) => f.points > 0).length, 1)
  assert.equal(checkMessage('The undelveable shelves.').findings.length, 0)
  assert.equal(checkMessage('a robust-looking plan').findings.length, 0, 'part of a hyphenated word')
})

test('emoji bullets and exclamations only count once they pile up', () => {
  assert.equal(checkMessage(`${ROCKET} Shipping today`).findings.length, 0)
  const bullets = checkMessage(`Lessons:\n${ROCKET} Persistence\n${BULB} Data\n- ${FIRE} Network`)
  assert.equal(bullets.findings.filter((f) => f.code === 'emoji_bullets').length, 3)
  assert.equal(checkMessage('Thanks! See you then!').findings.length, 0)
  assert.equal(checkMessage('Thanks! See you then! Bring snacks!').findings.length, 3)
})

test('markdown: a leak unless the destination renders it', () => {
  const text = '## Update\n\nThe **deadline** moved. See [the doc](https://example.com/doc).'
  const plain = checkMessage(text)
  assert.equal(plain.verdict, 'fail')
  assert.deepEqual(
    plain.findings.map((f) => f.rule),
    ['markdown_heading', 'markdown_bold', 'markdown_link'],
  )
  const slack = checkMessage(text, { markdown: true })
  assert.equal(slack.findings.length, 0)
  assert.equal(slack.facts.markdown, true)
})

test('placeholders: bracket slots and unmerged merge fields, not ordinary brackets', () => {
  for (const t of ['Hi [Name],', 'Dear {{ first_name }},', 'Hi {firstName},', 'Regards, <Your Name>', '[Insert link here]']) {
    assert.ok(codes(checkMessage(t)).includes('placeholder'), t)
  }
  for (const t of ['See note [1].', 'The array [a, b] is sorted.', 'Use {} for an empty object.']) {
    assert.equal(checkMessage(t).findings.length, 0, t)
  }
})

test('chat wrappers: at the start and the end', () => {
  assert.ok(codes(checkMessage("Sure! Here's a revised version:\n\nHi Bo,")).includes('chat_preamble'))
  assert.ok(codes(checkMessage('Here is a short, friendly reply:\nThanks!')).includes('chat_preamble'))
  assert.equal(checkMessage("Here's the invoice for March.").findings.length, 0, 'a person saying "here is" something real')
  assert.ok(codes(checkMessage('Thanks. Feel free to customize this template.')).includes('chat_postamble'))
  assert.equal(
    checkMessage("Let me know if you'd like me to adjust the delivery date.").findings.length,
    0,
    'adjusting something real is not a chat wrapper',
  )
})

test('ignore: by code or rule id, and unknown ones are an error', () => {
  const text = `We ship today ${EM} early. I hope this helps.`
  assert.ok(codes(checkMessage(text)).includes('em_dash'))
  assert.ok(!codes(checkMessage(text, { ignore: ['em_dash'] })).includes('em_dash'))
  assert.ok(!codes(checkMessage(text, { ignore: ['hope_this_helps'] })).includes('stock_closer'))
  assert.throws(() => checkMessage(text, { ignore: ['nope'] }), TellsError)
})

test('options: thresholds checked', () => {
  assert.throws(() => checkMessage('x', { reviewAt: 70, failAt: 50 }), /must not be above/)
  assert.throws(() => checkMessage('x', { failAt: 101 }), /0 to 100/)
  assert.throws(() => checkMessage('x', { reviewAt: Number.NaN }), /0 to 100/)
  const strict = checkMessage('Hi Tom, I hope this email finds you well. Thanks, Ana', { reviewAt: 10, failAt: 20 })
  assert.equal(strict.verdict, 'fail')
})

test('empty and short messages say so', () => {
  const empty = checkMessage('')
  assert.equal(empty.verdict, 'keep')
  assert.equal(empty.score, 0)
  assert.deepEqual(empty.notes, ['The message is empty.'])
  assert.match(checkMessage('Delve in!').notes[0], /Short message \(2 words\)/)
})

// Fixing

test('fix: cuts the wrappers and filler, keeps the greeting and the content', () => {
  const fixed = fixMessage(GENERATED)
  assert.ok(fixed.changed)
  assert.ok(fixed.text.startsWith('Hi [First Name],\n\nIn today'), fixed.text)
  assert.ok(!/Here's a draft|Subject:|finds you well|hesitate|adjust the tone/.test(fixed.text), fixed.text)
  assert.ok(fixed.text.endsWith('Best regards,\n[Your Name]'), 'the placeholder needs a person')
  assert.ok(fixed.unfixed.some((f) => f.code === 'placeholder'))
  assert.ok(fixed.result.score < checkMessage(GENERATED).score)
  assert.ok(!/\n{3}/.test(fixed.text), 'no runs of blank lines left behind')
})

test('fix: a greeting on the same line survives the sentence after it', () => {
  const fixed = fixMessage('Hi Sam, I hope this email finds you well. The quote is attached.')
  assert.equal(fixed.text, 'Hi Sam, The quote is attached.')
})

test('fix: never cuts a sentence that carries anything real', () => {
  for (const t of [
    "Please don't hesitate to contact me on 305-555-0100.",
    'I hope this helps you decide by Friday.',
    "I hope you're doing well and the move went smoothly.",
    'Anyway, I hope this helps.',
  ]) {
    const fixed = fixMessage(t)
    assert.equal(fixed.text, t, t)
    assert.equal(fixed.applied.length, 0)
  }
  assert.equal(
    fixMessage("Don't hesitate to reach out if you have any questions. Thanks!").text,
    'Thanks!',
    'known filler after the phrase is cut with it',
  )
})

test('fix: em dashes only as a pair around an aside', () => {
  assert.equal(
    fixMessage(`The plan ${EM} which we signed in May ${EM} covers it.`).text,
    'The plan, which we signed in May, covers it.',
  )
  const single = fixMessage(`Our goals ${EM} speed and price.`)
  assert.equal(single.changed, false, 'a single dash might be a colon')
  assert.equal(single.unfixed[0].code, 'em_dash')
})

test('fix: word swaps keep case, Markdown is unwrapped', () => {
  assert.equal(fixMessage('Moreover, we utilized a myriad of tools.').text, 'Also, we used many tools.')
  assert.equal(
    fixMessage('## Update\n\nThe **deadline** moved. See [the doc](https://example.com/d).').text,
    'Update\n\nThe deadline moved. See the doc (https://example.com/d).',
  )
})

test('fix: nothing to fix leaves the text exactly as it was', () => {
  const t = `${HUMAN[1]}\n\n`
  const fixed = fixMessage(t)
  assert.equal(fixed.text, t)
  assert.equal(fixed.changed, false)
})

// Report

test('report: verdict, score bar, marked lines, sections', () => {
  const text = formatText(GENERATED, checkMessage(GENERATED), { colour: false })
  assert.match(text, /^\nFAIL {2}Chat output leaked/)
  assert.match(text, /Bot score {4}\d+\/100 {2}\[#+-*\]/)
  assert.match(text, /\n {3}5 {2}Hi >>\[First Name\]<<,\n/)
  assert.match(text, /\nFAIL\n {2}Chat wrapper at the start\n/)
  assert.match(text, /\nTELLS\n/)
  assert.match(text, /--fix/)
  assert.ok(!text.includes('\x1b['), 'no colour codes')

  const clean = formatText(HUMAN[0], checkMessage(HUMAN[0]), { colour: false })
  assert.match(clean, /^\nPASS {2}No bot tells found\./)
  assert.match(clean, /Found {8}nothing/)
})

// MCP

/**
 * @param {object[]} messages
 * @returns {Promise<any[]>}
 */
async function mcpSession(messages) {
  const input = new PassThrough()
  const output = new PassThrough()
  /** @type {string[]} */
  const chunks = []
  output.on('data', (c) => chunks.push(String(c)))
  const done = serve({ input, output })
  for (const m of messages) input.write(`${JSON.stringify(m)}\n`)
  input.end()
  await done
  return chunks.join('').trim().split('\n').map((l) => JSON.parse(l))
}

test('mcp: initialize, list tools, check and fix', async () => {
  const replies = await mcpSession([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'check_message', arguments: { text: HUMAN[0] } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'check_message', arguments: { text: GENERATED } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'fix_message', arguments: { text: GENERATED } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'check_message', arguments: { text: 'x', ignore: ['nope'] } } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'check_message', arguments: { text: 42 } } },
    { jsonrpc: '2.0', id: 8, method: 'nope' },
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'check_message', arguments: { text: '**Hi** there', markdown: true } } },
  ])
  const byId = Object.fromEntries(replies.map((r) => [r.id, r]))

  assert.equal(replies.length, 9, 'the notification gets no reply')
  assert.equal(byId[1].result.protocolVersion, '2025-06-18')
  assert.equal(byId[1].result.serverInfo.name, 'bot-tells')
  assert.match(byId[1].result.instructions, /never send/i)
  assert.deepEqual(byId[2].result.tools.map((/** @type {{name: string}} */ t) => t.name), ['check_message', 'fix_message'])

  const ok = byId[3].result.structuredContent
  assert.equal(ok.verdict, 'keep')
  assert.equal(ok.passed, true)
  assert.deepEqual(JSON.parse(byId[3].result.content[0].text), ok)

  assert.equal(byId[4].result.structuredContent.verdict, 'fail')
  assert.equal(byId[4].result.structuredContent.passed, false)

  const fixed = byId[5].result.structuredContent
  assert.ok(fixed.text.startsWith('Hi [First Name]'))
  assert.ok(fixed.applied.length > 0)
  assert.ok(fixed.unfixed.some((/** @type {{code: string}} */ f) => f.code === 'placeholder'))
  assert.equal(fixed.verdict, 'fail')

  assert.equal(byId[6].result.isError, true)
  assert.match(byId[6].result.content[0].text, /nope is not a code/)
  assert.equal(byId[7].result.isError, true)
  assert.equal(byId[8].error.code, -32601)
  assert.equal(byId[9].result.structuredContent.findings.length, 0)
})

// CLI

/**
 * @param {string[]} args
 * @param {string} [stdin]
 */
function cli(args, stdin) {
  return spawnSync(process.execPath, [CLI, ...args], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
}

test('cli: exit codes 0 keep, 1 fail or review, 2 could not run', () => {
  const keep = cli(['Your order shipped. It arrives Tuesday.'])
  assert.equal(keep.status, 0, keep.stderr)
  assert.match(keep.stdout, /^\nPASS/)

  const review = cli(['Hi Tom, I hope this email finds you well. The invoice is attached. Thanks, Ana'])
  assert.equal(review.status, 1)
  assert.match(review.stdout, /^\nREVIEW/)

  const fail = cli(['Hi [First Name], your order shipped.'])
  assert.equal(fail.status, 1)
  assert.match(fail.stdout, /Placeholder left in/)

  assert.equal(cli(['x', '--fail-at', 'high']).status, 2)
  assert.equal(cli(['x', '--review-at', '80', '--fail-at', '50']).status, 2)
  assert.equal(cli(['x', '--ignore', 'nope']).status, 2)
  assert.equal(cli(['x', '--bogus']).status, 2)
  assert.match(cli(['--version']).stdout, /^\d+\.\d+\.\d+\n$/)
})

test('cli: standard input, --json, --fix, --markdown, --ignore', () => {
  const json = cli(['-', '--json'], `${POLISHED}\n`)
  assert.equal(json.status, 1)
  const result = JSON.parse(json.stdout)
  assert.equal(result.verdict, 'fail')
  assert.equal(result.findings[0].rule, 'hope_youre_well')

  const fixed = cli(['--fix'], GENERATED)
  assert.equal(fixed.status, 1, 'the placeholders are still there')
  assert.ok(fixed.stdout.startsWith('Hi [First Name],'))
  assert.match(fixed.stderr, /^Fixed \d+ of \d+\. Score \d+ -> \d+\/100/)

  const fixedJson = JSON.parse(cli(['--fix', '--json'], GENERATED).stdout)
  assert.ok(Array.isArray(fixedJson.applied))

  assert.equal(cli(['**Hi** there, see you at 3.', '--markdown']).status, 0)
  assert.equal(cli([`We ship today ${EM} early.`, '--ignore', 'em_dash']).status, 0)
})
