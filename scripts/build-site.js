import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Assembles the web page into _site/: the page, and the part of the library it runs.
 * The page imports the same src/ the CLI uses, so the two never disagree.
 */
const root = fileURLToPath(new URL('..', import.meta.url))
const out = `${root}_site`

rmSync(out, { recursive: true, force: true })
mkdirSync(`${out}/src/data`, { recursive: true })
cpSync(`${root}site/index.html`, `${out}/index.html`)
for (const file of ['index.js', 'fix.js', 'data/rules.js']) {
  cpSync(`${root}src/${file}`, `${out}/src/${file}`)
}
process.stdout.write(`Built ${out}\n`)
