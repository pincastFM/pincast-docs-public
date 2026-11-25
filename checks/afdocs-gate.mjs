#!/usr/bin/env node
// Reads an AFDocs result (afdocs check --format json --score) and compares it with the recorded
// baseline in afdocs-baseline.json. It fails when the overall score drops below the baseline's, or
// when any of the 28 checks does worse than it did there (pass or skip, then warn, then fail).
//
//   node checks/afdocs-gate.mjs result.json                   compare
//   node checks/afdocs-gate.mjs result.json --write-baseline  record this result as the baseline
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASELINE = join(HERE, 'afdocs-baseline.json')
const [file] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
if (!file) { console.error('usage: afdocs-gate.mjs result.json [--write-baseline]'); process.exit(2) }
const result = JSON.parse(readFileSync(file, 'utf8'))
const overall = result.scoring?.overall
if (typeof overall !== 'number') { console.error('afdocs: no score in the result; run afdocs with --score'); process.exit(2) }
const statuses = Object.fromEntries(result.results.map((r) => [r.id, r.status]))

if (process.argv.includes('--write-baseline')) {
  const baseline = {
    about: 'The AFDocs result the docs checks compare against. Rewrite it with --write-baseline only after reading why a check changed.',
    afdocs: result.specUrl,
    url: result.url,
    recorded: result.timestamp,
    overall,
    grade: result.scoring.grade,
    checks: statuses,
  }
  writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`)
  console.log(`baseline written: ${overall} (${result.scoring.grade}), ${Object.keys(statuses).length} checks`)
  process.exit(0)
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
const rank = { pass: 0, skip: 0, warn: 1, fail: 2, error: 2 }
const worse = []
for (const [id, was] of Object.entries(baseline.checks)) {
  const now = statuses[id] ?? 'missing'
  if ((rank[now] ?? 2) > (rank[was] ?? 0)) worse.push({ id, was, now })
}
for (const id of Object.keys(statuses)) if (!(id in baseline.checks)) console.log(`note: new check ${id} (${statuses[id]}), not in the baseline`)
const message = (id) => result.results.find((r) => r.id === id)?.message || ''

const lines = [`AFDocs ${overall} (${result.scoring.grade}) for ${result.url}; baseline ${baseline.overall} (${baseline.grade}) from ${baseline.recorded}`]
for (const [cat, s] of Object.entries(result.scoring.categoryScores || {})) lines.push(`  ${cat}: ${s.score} (${s.grade})`)
const counts = result.summary || {}
lines.push(`  checks: ${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail, ${counts.skip} skip, ${counts.error} error, of ${counts.total}`)
for (const w of worse) lines.push(`WORSE ${w.id}: ${w.was} -> ${w.now}: ${message(w.id)}`)
if (overall < baseline.overall) lines.push(`WORSE overall: ${baseline.overall} -> ${overall}`)
console.log(lines.join('\n'))

const failed = worse.length > 0 || overall < baseline.overall
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = worse.map((w) => `| ${w.id} | ${w.was} | ${w.now} | ${message(w.id).replace(/\|/g, '/')} |`)
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, [
    '## Docs score (AFDocs)',
    `${overall} (${result.scoring.grade}) against a baseline of ${baseline.overall}. ${failed ? 'Worse than the baseline.' : 'No check did worse than the baseline.'}`,
    rows.length ? '\n| Check | Baseline | Now | Message |\n|:-|:-|:-|:-|' : '',
    ...rows,
    '',
  ].join('\n'), { flag: 'a' })
}
process.exit(failed ? 1 : 0)
