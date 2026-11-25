#!/usr/bin/env node
// After a publish, waits until docs.pincast.fm serves the pushed pages before the checks score
// them. It takes the longest plain line the last commit added to a page, then reads that page's
// Markdown copy every 20 seconds, up to 10 minutes, until the line is there. With no page in the
// commit it returns at once. Run it in a checkout with at least two commits (fetch-depth: 2).
import { execFileSync } from 'node:child_process'

const SITE = (process.env.DOCS_SITE || 'https://docs.pincast.fm').replace(/\/$/, '')
const LIMIT_MS = Number(process.env.WAIT_SECONDS || 600) * 1000
const EVERY_MS = 20000
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })
const plain = (s) => s.replace(/[*_`[\]()<>#|{}]/g, ' ').replace(/\s+/g, ' ').trim()

let base = 'HEAD^'
try { git('rev-parse', '--verify', '--quiet', base) } catch { console.log('wait: no earlier commit, nothing to compare'); process.exit(0) }
const pages = git('diff', '--name-only', '--diff-filter=AM', base, 'HEAD').split('\n').filter((f) => /\.mdx?$/.test(f) && !f.startsWith('.'))
let pick = null
for (const page of pages) {
  const added = git('diff', '-U0', base, 'HEAD', '--', page).split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
    .filter((l) => !/^\s*(```|<|\||import |export |---|[a-z]+:)/.test(l))
    // The Markdown copy writes "- item" as "* item", so a list marker never takes part in the match.
    .map((l) => l.replace(/^\s*(?:[-+*]|\d+\.)\s+/, ''))
    .map(plain)
    .filter((l) => l.length >= 30)
  for (const line of added) if (!pick || line.length > pick.line.length) pick = { page, line }
}
if (!pick) { console.log(`wait: the commit changed no page text (${pages.length} pages touched), nothing to wait for`); process.exit(0) }

const url = `${SITE}/${pick.page.replace(/\.mdx$/, '.md')}`
console.log(`wait: looking for "${pick.line.slice(0, 80)}" in ${url}`)
const start = Date.now()
for (let tries = 1; ; tries++) {
  try {
    const res = await fetch(url, { headers: { 'cache-control': 'no-cache', 'user-agent': 'pincast-docs-checks' } })
    if (res.ok && plain(await res.text()).includes(pick.line)) {
      console.log(`wait: served after ${Math.round((Date.now() - start) / 1000)} s (${tries} reads)`)
      process.exit(0)
    }
  } catch (e) { console.log(`wait: read ${tries} failed: ${e.message}`) }
  if (Date.now() - start + EVERY_MS > LIMIT_MS) break
  await new Promise((r) => setTimeout(r, EVERY_MS))
}
console.log(`wait: ${SITE} did not serve the new text of ${pick.page} within ${LIMIT_MS / 60000} minutes`)
process.exit(1)
