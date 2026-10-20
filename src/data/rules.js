/**
 * Every tell bot-tells looks for. Patterns run against a copy of the text with curly
 * quotes and apostrophes straightened (same length, so offsets line up), so they are
 * written with straight ones only.
 *
 * A leak is chat output that should never reach a reader: a placeholder, the model
 * talking about itself, the "Here's a draft:" wrapper. Any leak fails the message.
 * A tell is wording readers associate with bots. Tells add to the score; none of them
 * decides anything alone, because people write every one of them too.
 *
 * Weights run from 1 (people use it all the time; it only counts in company) to 6
 * (almost nobody writes this by hand any more).
 */

/**
 * @typedef {'leak'|'tell'} Level
 *
 * @typedef {'placeholder'|'ai_disclosure'|'chat_preamble'|'chat_postamble'|'markdown'
 *   |'stock_opener'|'stock_closer'|'stock_phrase'|'ai_vocabulary'|'not_x_but_y'
 *   |'rhetorical_reveal'|'sycophancy'|'em_dash'|'emoji_bullets'|'exclamations'} Code
 *
 * @typedef {'drop-sentence'|'drop-line'|'unwrap-markdown'|'em-dash'
 *   |{ replace: Record<string, string> }} Fix
 *   drop-sentence and drop-line only apply when the match is most of the sentence or
 *   line, so nothing the writer meant is cut along with it.
 *
 * @typedef {object} Rule
 * @property {string} id Stable, unique.
 * @property {Code} code
 * @property {RegExp} pattern Global.
 * @property {number} weight Points for the first match.
 * @property {number} [decay] Each further match is worth this much of the one before.
 *   Default 0.5.
 * @property {number} [cap] Matches that score, after which they are listed for 0.
 *   Default 3.
 * @property {number} [minCount] Only a tell once it happens this often. Default 1.
 * @property {string} suggest What to do instead, for a person.
 * @property {Fix} [fix] A mechanical fix that is safe to apply without reading.
 * @property {boolean} [plainTextOnly] Only where Markdown is not rendered.
 *
 * @typedef {object} CodeInfo
 * @property {Level} level
 * @property {string} title
 * @property {string} why Why a reader notices it.
 */

/** @type {Record<Code, CodeInfo>} */
export const CODES = {
  placeholder: {
    level: 'leak',
    title: 'Placeholder left in',
    why:
      'A template slot nobody filled. It tells the reader at once that the message was ' +
      'generated and that nobody read it before it went out.',
  },
  ai_disclosure: {
    level: 'leak',
    title: 'The model talking about itself',
    why: 'The writer describes itself as an AI or a language model, mid-message.',
  },
  chat_preamble: {
    level: 'leak',
    title: 'Chat wrapper at the start',
    why:
      'The reply to the prompt, not the message: "Here\'s a draft", "Sure! Here is the ' +
      'email", a Subject line pasted into the body.',
  },
  chat_postamble: {
    level: 'leak',
    title: 'Chat wrapper at the end',
    why:
      'An offer to edit the draft, addressed to whoever asked for it, sent to the ' +
      'recipient instead.',
  },
  markdown: {
    level: 'leak',
    title: 'Markdown that will not render',
    why:
      'Email clients, SMS and most social posts show Markdown as typed, so the reader ' +
      'sees the asterisks and pound signs.',
  },
  stock_opener: {
    level: 'tell',
    title: 'Stock opener',
    why:
      'Readers have seen these lines at the top of a thousand automated emails, and ' +
      'stop reading at them.',
  },
  stock_closer: {
    level: 'tell',
    title: 'Stock closer',
    why: 'Filler at the end that every assistant adds and few people bother to type.',
  },
  stock_phrase: {
    level: 'tell',
    title: 'Stock phrase',
    why: 'Phrases that turn up far more in generated text than in anything a person writes.',
  },
  ai_vocabulary: {
    level: 'tell',
    title: 'Words people now read as AI',
    why:
      'Real words, but ones language models use far more than people do, so readers ' +
      'have learned to spot them.',
  },
  not_x_but_y: {
    level: 'tell',
    title: '"Not X, but Y"',
    why:
      'Setting up a claim nobody made in order to knock it down. Once is a device; ' +
      'models reach for it constantly.',
  },
  rhetorical_reveal: {
    level: 'tell',
    title: 'Rhetorical reveal',
    why: '"The result?" "The best part?" A question asked only to answer it in the next breath.',
  },
  sycophancy: {
    level: 'tell',
    title: 'Customer-service sycophancy',
    why: 'Agreement and apology on autopilot, before anything has been said.',
  },
  em_dash: {
    level: 'tell',
    title: 'Em dashes',
    why:
      'People use em dashes too, and good writers use them well. But they are now the ' +
      'best-known sign of generated text, and a reader who believes that will judge the ' +
      'message by it.',
  },
  emoji_bullets: {
    level: 'tell',
    title: 'Emoji bullets',
    why: 'Lists where every line starts with an emoji, the house style of generated social posts.',
  },
  exclamations: {
    level: 'tell',
    title: 'Exclamation marks',
    why: 'Enthusiasm at a steady rate reads as manufactured.',
  },
}

/** Words where a sentence can end. */
const S = String.raw`(?<=^|[.!?]["')]?\s+|\n)`

/** @type {Rule[]} */
export const RULES = [
  // Leaks.
  {
    id: 'bracket_placeholder',
    code: 'placeholder',
    pattern:
      /\[(?:your|my|their|his|her|recipient|insert|add|company|first|last|full|client|customer|prospect|product|service|business|date|time|day|name|contact|title|job|position|role|phone|number|email|link|url|address|city|location|amount|price|team|manager|specific|relevant|x)\b[^\]\n]{0,60}\]/gi,
    weight: 6,
    cap: 5,
    suggest: 'Fill it in, or cut the sentence.',
  },
  {
    id: 'template_variable',
    code: 'placeholder',
    pattern:
      /\{\{\s*[\w.-]{1,40}\s*\}\}|\{(?:first_?name|last_?name|full_?name|name|company|company_?name|recipient|title|city|date)\}|<(?:your|recipient'?s?|insert|company|first) [^<>\n]{1,40}>/gi,
    weight: 6,
    cap: 5,
    suggest: 'A merge field that was never merged. Check the template and the data behind it.',
  },
  {
    id: 'as_an_ai',
    code: 'ai_disclosure',
    pattern:
      /\bas an AI(?: language model| assistant| model| chatbot)?\b|\bas a (?:large )?language model\b|\bI(?: am|'m) (?:just )?an AI\b|\bmy (?:knowledge cutoff|training data)\b|\bI (?:don't|do not|can't|cannot) (?:have|browse|access) (?:personal (?:opinions|experiences|feelings|preferences)|real-time (?:information|data)|the internet)\b/gi,
    weight: 6,
    suggest: 'Cut it, and check what else in the message was written for the person who prompted it.',
  },
  {
    id: 'heres_a_draft',
    code: 'chat_preamble',
    pattern:
      /^\s*(?:(?:sure|certainly|absolutely|of course|okay|ok|great)[!,.]?\s*)?(?:here(?:'s| is| are)|below is|i've (?:written|drafted|put together)) (?:a |an |the |your |my )?(?:(?:quick|short|brief|polished|revised|rewritten|updated|improved|professional|friendly|final|possible|suggested),? )*(?:draft|version|rewrite|email|message|reply|response|text|post|note|letter|copy|options?)\b[^\n]*/gi,
    weight: 6,
    suggest: 'Cut the line. It was the reply to the prompt.',
    fix: 'drop-line',
  },
  {
    id: 'subject_in_body',
    code: 'chat_preamble',
    pattern: /^[ \t]*\**subject(?: line)?:\**[^\n]*/gim,
    weight: 5,
    cap: 1,
    suggest:
      'A Subject line inside the body. Put it in the subject field and cut it from the text.',
    fix: 'drop-line',
  },
  {
    id: 'offer_to_edit',
    code: 'chat_postamble',
    pattern:
      /\b(?:let me know|tell me) if you(?:'d| would)? (?:like|want|need) (?:me to )?(?:adjust|change|tweak|modify|revise|rewrite|shorten|lengthen|soften|polish|refine)(?:\s+(?:the|this|its|any))? (?:tone|wording|length|draft|message|email|text|style|version|anything)\b[^.!?\n]*[.!?]?|\b(?:let me know|tell me) if you(?:'d| would)? (?:like|want|need) (?:a |any )?(?:different|another|shorter|longer|more formal|more casual|alternative) (?:version|tone|draft|take|options?)\b[^.!?\n]*[.!?]?/gi,
    weight: 6,
    suggest: 'Cut it. That was for whoever asked for the draft, not for the reader.',
    fix: 'drop-sentence',
  },
  {
    id: 'feel_free_to_customize',
    code: 'chat_postamble',
    pattern:
      /\b(?:feel free to|you can|you may want to) (?:customi[sz]e|adjust|tweak|modify|personali[sz]e|tailor|edit) (?:this|it|the (?:draft|template|message|email|text|wording|tone|details))\b[^.!?\n]*[.!?]?|\b(?:this|the) (?:draft|template) can be (?:customi[sz]ed|adjusted|tailored)\b[^.!?\n]*[.!?]?/gi,
    weight: 6,
    suggest: 'Cut it. That was for whoever asked for the draft, not for the reader.',
    fix: 'drop-sentence',
  },
  {
    id: 'markdown_bold',
    code: 'markdown',
    pattern: /\*\*[^*\n]{1,120}\*\*|(?<![\w_])__[^_\n]{1,120}__(?![\w_])/g,
    weight: 3,
    decay: 0.8,
    cap: 5,
    plainTextOnly: true,
    suggest: 'Remove the asterisks. The reader will see them, not bold text.',
    fix: 'unwrap-markdown',
  },
  {
    id: 'markdown_heading',
    code: 'markdown',
    pattern: /^#{1,6}[ \t]+\S[^\n]*/gm,
    weight: 4,
    decay: 0.8,
    plainTextOnly: true,
    suggest: 'Remove the pound signs, or the heading: emails rarely need one.',
    fix: 'unwrap-markdown',
  },
  {
    id: 'markdown_link',
    code: 'markdown',
    pattern: /\[[^\]\n]{1,120}\]\((?:https?:\/\/|mailto:)[^)\s]{1,500}\)/g,
    weight: 3,
    decay: 0.8,
    plainTextOnly: true,
    suggest: 'Write the link out. The brackets and parentheses will show as typed.',
    fix: 'unwrap-markdown',
  },

  // Openers.
  {
    id: 'finds_you_well',
    code: 'stock_opener',
    pattern:
      /\b(?:I |we )?(?:hope|trust) (?:this|my|our) (?:e-?mail|message|note|letter|text) (?:finds|reaches) you (?:well|in good (?:health|spirits)|safe and well)\b/gi,
    weight: 5,
    suggest: 'Cut it. Start with the reason you are writing.',
    fix: 'drop-sentence',
  },
  {
    id: 'hope_youre_well',
    code: 'stock_opener',
    pattern:
      /\bI (?:hope|trust) (?:you(?:'re| are)|you(?:'ve| have) been|all is|everything is|this week is|your week is) (?:doing |going )?(?:well|great|good|wonderful)\b|\bI hope you(?:'re| are) having an? (?:great|wonderful|fantastic|good|lovely|productive) (?:day|week|weekend|start to the week)\b/gi,
    weight: 2,
    suggest: 'Cut it, unless you know them and mean it.',
    fix: 'drop-sentence',
  },
  {
    id: 'reaching_out',
    code: 'stock_opener',
    pattern: /\bI(?:'m| am| wanted to| want to| just wanted to|'d like to| would like to) (?:quickly )?reach(?:ing)? out\b/gi,
    weight: 2,
    cap: 1,
    suggest: 'Say what you want instead of announcing that you are writing.',
  },
  {
    id: 'thanks_for_reaching_out',
    code: 'stock_opener',
    pattern: /\bthank(?:s| you) (?:so much )?for reaching out\b/gi,
    weight: 2,
    cap: 1,
    suggest: '"Thanks for your message" is fine, or skip straight to the answer.',
  },
  {
    id: 'great_question',
    code: 'stock_opener',
    pattern: new RegExp(
      `${S}(?:great|excellent|good|what a great|that's a great|fantastic) question[!.,]?[ \\t]*`,
      'gi',
    ),
    weight: 4,
    cap: 1,
    suggest: 'Cut it and answer the question.',
    fix: 'drop-sentence',
  },
  {
    id: 'certainly',
    code: 'stock_opener',
    pattern: new RegExp(`${S}(?:certainly|absolutely|of course|sure thing)![ \\t]*`, 'gi'),
    weight: 3,
    cap: 1,
    suggest: 'Cut it. Start with the answer.',
    fix: 'drop-sentence',
  },

  // Closers.
  {
    id: 'hope_this_helps',
    code: 'stock_closer',
    pattern: /\bI hope (?:this|that|the above) (?:helps|is helpful|was helpful|clarifies(?: things)?|answers your question)\b/gi,
    weight: 3,
    cap: 1,
    suggest: 'Cut it. If it helps, they will know.',
    fix: 'drop-sentence',
  },
  {
    id: 'dont_hesitate',
    code: 'stock_closer',
    pattern:
      /\b(?:please )?(?:don't|do not) hesitate to (?:reach out|contact (?:me|us)|get in touch|let (?:me|us) know|ask)\b/gi,
    weight: 3,
    cap: 1,
    suggest: '"Any questions, just reply here." Or nothing: they know how email works.',
    fix: 'drop-sentence',
  },
  {
    id: 'feel_free_to_reach_out',
    code: 'stock_closer',
    pattern: /\bfeel free to (?:reach out|contact (?:me|us)|get in touch)\b/gi,
    weight: 2,
    cap: 1,
    suggest: '"Any questions, just reply here." Or nothing.',
    fix: 'drop-sentence',
  },
  {
    id: 'any_questions',
    code: 'stock_closer',
    pattern:
      /\b(?:please )?let (?:me|us) know if you have any (?:other |further |additional |more )?(?:questions|concerns)(?: or (?:need|require) (?:any )?(?:further |additional )?(?:assistance|help|information))?\b/gi,
    weight: 2,
    cap: 1,
    suggest: 'Cut it, or ask the one question you actually need answered.',
    fix: 'drop-sentence',
  },
  {
    id: 'happy_to_help',
    code: 'stock_closer',
    pattern: /\bI(?:'d| would| am|'m) (?:be )?(?:more than )?(?:happy|glad|delighted) to (?:help|assist)(?: (?:you )?(?:with|further))?\b/gi,
    weight: 2,
    cap: 1,
    suggest: 'Offer the specific thing: "I can send the quote today."',
  },

  // Phrases.
  {
    id: 'in_todays_world',
    code: 'stock_phrase',
    pattern:
      /\bin today's (?:(?:fast-paced|digital|ever-changing|ever-evolving|rapidly (?:changing|evolving)|competitive|modern|busy|hyper-connected|data-driven) )*(?:world|landscape|age|era|environment|market(?:place)?|economy|business (?:world|landscape|environment))\b/gi,
    weight: 4,
    cap: 1,
    suggest: 'Cut it. Every era has thought itself fast-paced.',
  },
  {
    id: 'ever_evolving',
    code: 'stock_phrase',
    pattern: /\bever-(?:evolving|changing|growing|expanding) (?:world|landscape|field|realm|industry|space)\b/gi,
    weight: 3,
    cap: 1,
    suggest: 'Name the change you mean, or cut it.',
  },
  {
    id: 'worth_noting',
    code: 'stock_phrase',
    pattern: /\bit(?:'s| is) (?:also )?(?:worth noting|important to note|worth mentioning|crucial to (?:note|remember|understand)|important to remember|essential to (?:note|understand)) that\s*/gi,
    weight: 3,
    suggest: 'Cut the throat-clearing and say the thing.',
  },
  {
    id: 'dive_in',
    code: 'stock_phrase',
    pattern: /\b(?:let's|let us) (?:dive|delve|jump) (?:in|into|deeper)\b|\bdive deep(?:er)? into\b/gi,
    weight: 3,
    cap: 1,
    suggest: 'Cut it and start.',
  },
  {
    id: 'navigate_complexities',
    code: 'stock_phrase',
    pattern: /\bnavigat(?:e|es|ing) the (?:complexities|intricacies|challenges|nuances|landscape|world|maze) of\b/gi,
    weight: 4,
    cap: 1,
    suggest: 'Say what the hard part is.',
  },
  {
    id: 'testament_to',
    code: 'stock_phrase',
    pattern: /\b(?:is|stands as|serves as|was) a (?:true |real |living )?testament to\b/gi,
    weight: 4,
    cap: 1,
    suggest: '"shows", or just say what it proves.',
  },
  {
    id: 'crucial_role',
    code: 'stock_phrase',
    pattern: /\bplay(?:s|ed|ing)? an? (?:crucial|pivotal|vital|key|significant|instrumental|integral|essential) role in\b/gi,
    weight: 3,
    cap: 1,
    suggest: 'Say what it does.',
  },
  {
    id: 'unlock_potential',
    code: 'stock_phrase',
    pattern: /\bunlock(?:s|ing)? (?:the |your |its |their |our )?(?:full |true )?(?:potential|power)\b/gi,
    weight: 4,
    cap: 1,
    suggest: 'Say what they will be able to do.',
  },
  {
    id: 'next_level',
    code: 'stock_phrase',
    pattern: /\b(?:take|takes|taking|took) (?:it|this|that|things|your [\w-]+(?: [\w-]+)?) to the next level\b/gi,
    weight: 3,
    cap: 1,
    suggest: 'Say what gets better, and by how much.',
  },
  {
    id: 'whether_youre',
    code: 'stock_phrase',
    pattern: /\bwhether you(?:'re| are) an? [^,.!?\n]{1,40},? or (?:an? |just |simply )?[^,.!?\n]{1,40}/gi,
    weight: 3,
    cap: 1,
    suggest: 'Write to the one reader you have.',
  },
  {
    id: 'in_conclusion',
    code: 'stock_phrase',
    pattern: /\bin (?:conclusion|summary)\b,?/gi,
    weight: 3,
    cap: 1,
    suggest: 'Cut it. A message short enough to read does not need a conclusion marked.',
  },
  {
    id: 'realm_of',
    code: 'stock_phrase',
    pattern: /\b(?:in|into|within) the (?:realm|world|landscape|sphere) of\b/gi,
    weight: 2,
    cap: 1,
    suggest: 'Usually cuttable: "in marketing", not "in the world of marketing".',
  },
  {
    id: 'game_changer',
    code: 'stock_phrase',
    pattern: /\bgame[- ]chang(?:er|ers|ing)\b/gi,
    weight: 2,
    cap: 1,
    suggest: 'Say what it changes.',
  },
  {
    id: 'rest_assured',
    code: 'stock_phrase',
    pattern: /\brest assured\b,?\s*/gi,
    weight: 2,
    cap: 1,
    suggest: 'Cut it and give the reason they can stop worrying.',
  },
  {
    id: 'heres_the_thing',
    code: 'stock_phrase',
    pattern: /\bhere's (?:the thing|the kicker|the catch|why (?:it|this|that) matters|what (?:you need to know|matters|I learned|I've learned|nobody tells you))\b[:.]?/gi,
    weight: 2,
    cap: 1,
    suggest: 'Cut it and say the thing.',
  },
  {
    id: 'let_that_sink_in',
    code: 'stock_phrase',
    pattern: /\blet that sink in\b[.!]?/gi,
    weight: 4,
    cap: 1,
    suggest: 'Cut it.',
    fix: 'drop-sentence',
  },
  {
    id: 'no_fluff',
    code: 'stock_phrase',
    pattern: /\bno fluff\b|\bno-nonsense\b|\bwithout the fluff\b/gi,
    weight: 2,
    cap: 1,
    suggest: 'Show it rather than claim it.',
  },
  {
    id: 'not_just_but',
    code: 'not_x_but_y',
    pattern: /\bnot (?:just|only|merely|simply) (?:about )?[^.!?\n;]{1,60}?,? but (?:also )?/gi,
    weight: 3,
    decay: 0.8,
    suggest: 'Say the second half. Nobody claimed the first.',
  },
  {
    id: 'its_not_its',
    code: 'not_x_but_y',
    pattern:
      /\b(?:it|this|that|they|we|you)(?:'s| is|'re| are) not (?:just |only |about )?[^.!?\n;,]{1,50}?(?:,|;|\.| -|—|–) ?(?:it|this|that|they|we|you)(?:'s| is|'re| are)\b/gi,
    weight: 3,
    decay: 0.8,
    suggest: 'Say the second half. Nobody claimed the first.',
  },
  {
    id: 'dont_just',
    code: 'not_x_but_y',
    pattern:
      /\b(?:don't|doesn't|didn't|do not|does not|did not) (?:just|only|merely|simply) [^.!?\n;]{1,50}?(?:,|;|\.| -|\u2014|\u2013) ?(?:we|they|it|you|I|he|she)\b/gi,
    weight: 3,
    decay: 0.8,
    suggest: 'Say the second half. Nobody claimed the first.',
  },
  {
    id: 'question_reveal',
    code: 'rhetorical_reveal',
    pattern: new RegExp(
      `${S}(?:the (?:result|results|answer|kicker|catch|best part|truth|secret|difference|twist|outcome|reason|problem|takeaway|bottom line|fix|solution)|the best part|why|how)\\?(?=\\s)`,
      'gi',
    ),
    weight: 3,
    decay: 0.8,
    suggest: 'Make it a statement: "It cut onboarding to two days."',
  },

  // Sycophancy.
  {
    id: 'absolutely_right',
    code: 'sycophancy',
    pattern: /\byou(?:'re| are) (?:absolutely|completely|totally|so|100%) right\b/gi,
    weight: 3,
    cap: 1,
    suggest: 'Cut it, or say what they are right about.',
  },
  {
    id: 'great_point',
    code: 'sycophancy',
    pattern: /\b(?:that's|that is|what) (?:a |such a )?(?:great|excellent|fantastic|wonderful|valid) (?:point|observation|insight)\b[!.]?/gi,
    weight: 3,
    cap: 1,
    suggest: 'Cut it and respond to the point.',
  },
  {
    id: 'apologize_inconvenience',
    code: 'sycophancy',
    pattern: /\b(?:I|we) (?:sincerely |truly |deeply )?apologi[sz]e for any (?:inconvenience|confusion|frustration|trouble)(?: (?:this|that) (?:may have|has|might have) caused(?: you)?)?\b/gi,
    weight: 3,
    cap: 1,
    suggest: 'Apologise for the specific thing, or not at all.',
  },
  {
    id: 'understand_frustration',
    code: 'sycophancy',
    pattern: /\bI (?:completely |totally |fully |truly )?understand (?:your|how) frustrat(?:ion|ing)\b/gi,
    weight: 3,
    cap: 1,
    suggest: 'Show it by fixing the problem in the next sentence.',
  },

  // Punctuation and layout.
  {
    id: 'em_dash',
    code: 'em_dash',
    pattern: /(?<=[\p{L}\p{N},.'")])[ \t]*—[ \t]*(?=[\p{L}\p{N}"'(])|(?<=\p{L}) – (?=\p{L})/gu,
    weight: 1.5,
    decay: 0.85,
    cap: 8,
    suggest: 'A comma, a full stop, or brackets usually does the same job.',
    fix: 'em-dash',
  },
  {
    id: 'emoji_bullets',
    code: 'emoji_bullets',
    pattern: /^[ \t]*(?:[-*•][ \t]*)?\p{Extended_Pictographic}/gmu,
    weight: 2,
    decay: 0.7,
    cap: 5,
    minCount: 2,
    suggest: 'Plain bullets, or sentences.',
  },
  {
    id: 'exclamations',
    code: 'exclamations',
    pattern: /!+/g,
    weight: 0.7,
    decay: 0.8,
    cap: 6,
    minCount: 3,
    suggest: 'Keep the one you mean most.',
  },
]

/**
 * Words. Each is a tell on its own only lightly; it is the pile-up that readers notice.
 *
 * @typedef {object} Word
 * @property {string} forms Regex source for the word and its inflections.
 * @property {number} weight
 * @property {string} instead
 * @property {Record<string, string>} [replace] Safe one-for-one swaps, lower case.
 */

/** @type {Word[]} */
export const VOCABULARY = [
  { forms: 'delv(?:e|es|ed|ing)', weight: 4, instead: '"look at", "dig into"' },
  { forms: 'tapestr(?:y|ies)', weight: 4, instead: '"mix", "range", or the actual things' },
  { forms: 'multifaceted', weight: 3, instead: '"complex", or name the facets' },
  {
    forms: '(?:a )?myriad(?: of)?',
    weight: 3,
    instead: '"many"',
    replace: { 'a myriad of': 'many', 'myriad of': 'many', myriad: 'many' },
  },
  {
    forms: '(?:a )?plethora(?: of)?',
    weight: 3,
    instead: '"lots of"',
    replace: { 'a plethora of': 'lots of', 'plethora of': 'lots of' },
  },
  { forms: 'bustling', weight: 3, instead: '"busy"', replace: { bustling: 'busy' } },
  { forms: 'pivotal', weight: 3, instead: '"key"' },
  { forms: 'paramount', weight: 3, instead: '"most important"' },
  { forms: 'meticulous(?:ly)?', weight: 3, instead: '"careful", "carefully"' },
  { forms: 'embark(?:s|ed|ing)? on', weight: 3, instead: '"start"' },
  { forms: 'underscor(?:e|es|ed|ing)', weight: 3, instead: '"show", "stress"' },
  { forms: 'nestled', weight: 3, instead: '"set", "tucked"' },
  { forms: 'commendable', weight: 3, instead: '"good", or say what was good' },
  { forms: 'transformative', weight: 3, instead: 'say what changes' },
  { forms: 'synerg(?:y|ies|istic)', weight: 3, instead: 'say what works better together' },
  { forms: 'unleash(?:es|ed|ing)?', weight: 3, instead: '"release", "let loose"' },
  {
    forms: 'moreover',
    weight: 3,
    instead: '"also", or nothing',
    replace: { moreover: 'also' },
  },
  {
    forms: 'furthermore',
    weight: 2,
    instead: '"also", or nothing',
    replace: { furthermore: 'also' },
  },
  { forms: 'realm', weight: 2, instead: '"area", "field"' },
  { forms: 'vibrant', weight: 2, instead: '"lively", or show it' },
  { forms: 'intricate', weight: 2, instead: '"detailed", "complicated"' },
  { forms: 'seamless(?:ly)?', weight: 2, instead: '"smooth", or cut it' },
  { forms: 'robust', weight: 2, instead: '"strong", "solid"' },
  { forms: 'holistic(?:ally)?', weight: 2, instead: '"whole", "complete"' },
  { forms: 'leverag(?:e|es|ed|ing)', weight: 2, instead: '"use"' },
  {
    forms: 'utiliz(?:e|es|ed|ing|ation)|utilis(?:e|es|ed|ing|ation)',
    weight: 2,
    instead: '"use"',
    replace: {
      utilize: 'use', utilizes: 'uses', utilized: 'used', utilizing: 'using', utilization: 'use',
      utilise: 'use', utilises: 'uses', utilised: 'used', utilising: 'using', utilisation: 'use',
    },
  },
  { forms: 'elevat(?:e|es|ed|ing)', weight: 2, instead: '"improve", "raise"' },
  { forms: 'empower(?:s|ed|ing)?', weight: 2, instead: '"help", "let"' },
  { forms: 'harness(?:es|ed|ing)?', weight: 2, instead: '"use"' },
  { forms: 'resonat(?:e|es|ed|ing)', weight: 2, instead: '"land", "matter to"' },
  { forms: 'cutting-edge', weight: 2, instead: '"new", "latest", or say what it does' },
  { forms: 'endeavou?rs?', weight: 2, instead: '"effort", "project"' },
  { forms: 'noteworthy', weight: 2, instead: '"worth knowing", or just say it' },
  { forms: 'boasts', weight: 2, instead: '"has"', replace: { boasts: 'has' } },
  { forms: 'showcas(?:e|es|ed|ing)', weight: 1, instead: '"show"' },
  { forms: 'streamlin(?:e|es|ed|ing)', weight: 1, instead: '"simplify", "speed up"' },
  { forms: 'comprehensive', weight: 1, instead: '"full", "complete"' },
  { forms: 'crucial', weight: 1, instead: '"important", "key"' },
  { forms: 'invaluable', weight: 1, instead: '"very useful"' },
  { forms: 'facilitat(?:e|es|ed|ing)', weight: 1, instead: '"help", "run"' },
  { forms: 'additionally', weight: 1, instead: '"also"', replace: { additionally: 'also' } },
  { forms: 'enhanc(?:e|es|ed|ing)', weight: 1, instead: '"improve"' },
]
