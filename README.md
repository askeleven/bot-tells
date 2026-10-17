# bot-tells

**Check a message before you send it for what makes readers think a bot wrote it.**

```bash
npx @askeleven/bot-tells "I hope this email finds you well. I wanted to reach out..."
```

Or paste one into the web page: **[askeleven.github.io/bot-tells](https://askeleven.github.io/bot-tells)**. It runs in
your browser, and nothing you paste leaves the page.

A reader decides in one line whether a person wrote to them. "I hope this email finds you
well" and the message is filed with the other thousand. A `[First Name]` nobody filled in,
or a "Let me know if you'd like me to adjust the tone" left at the bottom, and it is worse:
the reader now knows nobody read it before it went out. bot-tells finds those things
first. It is a CLI for pipelines, an MCP server so an agent can check its own writing, a
library, and a web page. It returns a verdict, a 0-100 bot score, every finding with where
it is and what to write instead, and the fixes that are safe to make without a rewrite.

Zero dependencies. No signup, no account, no network.

---

## Not an AI detector

bot-tells cannot tell who wrote a message, and does not try. People write every one of
these phrases too. It finds what a reader would hold against the message, whoever wrote it.
A person who opens every email with "I hope this finds you well" gets the same score as a
model that does, and should hear the same advice.

## What it checks

**Leaks** are chat output that should never reach a reader. Any leak fails the message,
whatever the score.

| Leak | Example |
|---|---|
| **Placeholder** left in | `[First Name]`, `[Insert link]`, `{{ company }}`, `<Your Name>` |
| **The model talking about itself** | "As an AI language model", "my training data" |
| **Chat wrapper at the start** | "Sure! Here's a draft of the email:", a `Subject:` line in the body |
| **Chat wrapper at the end** | "Let me know if you'd like me to adjust the tone", "Feel free to customize this template" |
| **Markdown that will not render** | `**bold**`, `## Heading`, `[link](https://...)` in an email, SMS or post (`--markdown` turns this off for Slack and GitHub) |

**Tells** are wording readers now associate with bots. They add to the score; none of them
decides anything alone.

| Tell | Example |
|---|---|
| **Stock openers** | "I hope this email finds you well", "I wanted to reach out", "Great question!" |
| **Stock closers** | "Don't hesitate to reach out", "I hope this helps", "I'd be happy to help" |
| **Stock phrases** | "In today's fast-paced world", "navigate the complexities of", "a testament to", "unlock your full potential" |
| **Words people now read as AI** | delve, tapestry, pivotal, seamless, leverage, utilize, moreover, and about 35 more |
| **"Not X, but Y"** | "It's not just a tool, it's a game-changer" |
| **Rhetorical reveals** | "The result?" "The best part?" |
| **Customer-service sycophancy** | "You're absolutely right", "I apologize for any inconvenience" |
| **Em dashes** | People use them well. Readers now count them anyway. |
| **Emoji bullets**, from two lines up | The house style of generated posts |
| **Exclamation marks**, from three up | Enthusiasm at a steady rate |

Every rule is in [`src/data/rules.js`](src/data/rules.js), with its weight and the reason
for it.

## The score

Each finding has a weight from 1 (people say it all the time; it only counts in company) to
6 (almost nobody types this by hand any more). Repeats of the same thing count for less
each time, and past a cap for nothing. The points become a score from 0 to 99 on a curve
scaled by length, because one stock phrase says more about a three-line email than about a
long one: one "I hope this email finds you well" in a 60-word email is 39.

**Keep** below 25. **Review** from 25: a reader may notice. **Fail** from 60, or on any
leak. Both thresholds are options.

## What it does not do

**It does not rewrite.** `--fix` makes only the changes that need no judgement: it cuts a
filler sentence when the sentence is nothing but filler, cuts chat wrappers, swaps a few
words one for one (utilize to use, a myriad of to many), turns a pair of em dashes around
an aside into commas, and unwraps Markdown. "Please don't hesitate to contact me on
305-555-0100" stays, because cutting it would cut the number. The rest is listed for a
person, or a model, to rewrite with the suggestion beside it.

**It only reads English.**

**It does not know your reader.** "I hope you're well" to a friend is warm. The score is
about strangers.

---

## Example

```
$ npx @askeleven/bot-tells draft.txt

FAIL  Reads like a bot wrote it.

      Bot score    83/100  [#################---]
      Length       90 words, 11 sentences
      Found        8 tells

   3  >>I hope you're doing well<<! I wanted to follow up on our conversation last week regarding the website redesign. Our team has >>delved<< into your requirements and put together a >>comprehensive<< proposal that addresses your key goals >>—<< faster load times, a cleaner layout, and better mobile support.
   5  >>The result?<< A site that >>not only looks great but also<< converts. We believe this will >>play a pivotal role in<< your growth.
   7  >>Please let me know if you have any questions<<. I look forward to hearing from you!

TELLS
  Words people now read as AI
      Real words, but ones language models use far more than people do, so
      readers have learned to spot them. "delved" (line 3): Try "look at",
      "dig into". "comprehensive" (line 3): Try "full", "complete".
  Rhetorical reveal
      "The result?" (line 5). "The result?" "The best part?" A question
      asked only to answer it in the next breath. Make it a statement: "It
      cut onboarding to two days."
  ...
```

In a terminal the findings are highlighted rather than marked with `>>` and `<<`.

```
$ npx @askeleven/bot-tells draft.txt --fix > fixed.txt
Fixed 2 of 8. Score 83 -> 77/100 (fail). 6 findings left for a person.
```

## Options

```
--fix                 Print the message with the safe fixes applied, and a
                      summary on standard error.
--markdown            The destination renders Markdown (Slack, GitHub), so
                      Markdown is not a leak.
--ignore <list>       Codes or rule ids to skip, comma-separated, such as
                      em_dash,exclamations.
--review-at <n>       Review at this score or above. Default 25.
--fail-at <n>         Fail at this score or above. Default 60.
--json                Machine-readable output.
--no-colour           Plain text.
```

The message is the text on the command line, a file, or standard input (`-`, or piped in
with no text).

Exit code `0` means OK to send, `1` means do not send it as it stands (a leak, or the score
is at `--review-at` or above), `2` means it could not run. So it gates a pipeline:

```bash
npx @askeleven/bot-tells reply.txt && ./send reply.txt
```

## For agents: MCP server

```bash
npx @askeleven/bot-tells mcp
```

It serves two tools over stdio: `check_message` (the verdict, score and findings) and
`fix_message` (the text with the safe fixes applied, what was applied, and what is left to
rewrite). The server tells the model never to send a message with a leak, to apply the safe
fixes, to rewrite what is left in plain words rather than swap one stock phrase for
another, and to check again.

**Claude Code**

```bash
claude mcp add bot-tells -- npx -y @askeleven/bot-tells mcp
```

**Claude Desktop, Cursor, and other clients** that take a JSON config:

```json
{
  "mcpServers": {
    "bot-tells": {
      "command": "npx",
      "args": ["-y", "@askeleven/bot-tells", "mcp"]
    }
  }
}
```

## As a library

```js
import { checkMessage, fixMessage } from '@askeleven/bot-tells'

const result = checkMessage(draft)
if (result.verdict !== 'keep') {
  const { text, unfixed } = fixMessage(draft)
  // unfixed: findings with line, column, text and suggestion, for a rewrite
}
```

`checkMessage(text, options)` takes `reviewAt`, `failAt`, `markdown` and `ignore`. It
returns `verdict`, `score`, `summary`, `reasons` (one per kind, with a stable `code` to
match on and a `detail` to show a person) and `findings` (each with `start` and `end`
offsets, `line`, `column`, the `text` as written, and a `suggestion`).

`fixMessage(text, options)` returns the fixed `text`, `applied`, `unfixed`, and `result`,
the fixed text checked again.

The library has no Node-only imports, so it runs in a browser as is: the web page imports
the same `src/index.js`.

## Privacy

Nothing leaves your machine. There is no network code. The web page is static, loads no
fonts, scripts or analytics from anywhere else, and the score card it makes is drawn in
your browser.

## Requirements

Node 20 or newer. No dependencies.

---

## Why we built it

[AskEleven](https://askeleven.com) runs AI employees that email and text candidates and
customers for small businesses. A message from one of them has to read like it came from
the business, because to the person receiving it, it did. This is the check for how it
reads, run before anything is sent.

## Contributing

Issues and pull requests welcome, especially:

- **False positives.** A normal sentence a person would write that bot-tells holds against
  them. Include the sentence. These matter more than anything else here.
- **Tells we miss**, with two or three real examples. A phrase only gets in if people
  outside this repo already read it as a sign of a bot.
- **Weights** that look wrong.
- **Other languages.** The rules are English only.

Run the tests with `npm test`, and build the web page into `_site/` with
`npm run build:site`.

## License

MIT. See [LICENSE](LICENSE).
