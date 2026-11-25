#!/usr/bin/env node
// Runs the code samples in the published pages the way a reader would, and checks the JSON
// examples against the API file. Every fenced block in a published page needs a marker in
// checks/samples.json, matched by page, position and first line:
//
//   runs      run as written (bash, sh, js), or written to the file its fence names for a later
//             block to use
//   response  JSON checked against a schema in api-reference/openapi.json instead of being run
//   skipped   not run, with the reason (and a syntax check where the block parses on its own)
//
// A block with no marker, or a marker whose block has moved or changed, fails the run.
//
// Calls go to PINCAST_API (default https://api.pincast.fm/v1) with the key in PINCAST_TEST_KEY,
// which must be a test key. shim.sh and shim.mjs refuse POST /test-apps (the no-account route)
// and every other address, and count each call against the budget in samples.json.
//
//   node checks/run-samples.mjs            run everything
//   node checks/run-samples.mjs --markers  only check that every block has a marker
//
// Local runs: SAMPLES_LINK="api=/path/to/pincast-api,cli=/path/to/pincast-cli" links local
// checkouts instead of installing from npm; SAMPLES_TEMPLATE=/path/to/create-pincast/template uses
// a local template instead of the published create-pincast; SAMPLES_ROOT reads another copy of
// the pages; SAMPLES_KEEP=1 keeps the work folder.
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync, symlinkSync,
  cpSync, renameSync, mkdtempSync, realpathSync,
} from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(process.env.SAMPLES_ROOT || join(HERE, '..'))
const API = (process.env.PINCAST_API || 'https://api.pincast.fm/v1').replace(/\/$/, '')
const KEY = process.env.PINCAST_TEST_KEY || ''
const MARKS = JSON.parse(readFileSync(join(HERE, 'samples.json'), 'utf8'))
const MARKERS_ONLY = process.argv.includes('--markers')

const stop = (msg) => { console.error(`samples: ${msg}`); process.exit(2) }
const firstLine = (body) => (body.split('\n').find((l) => l.trim()) || '').trim().slice(0, 60)
const clip = (s, n = 1500) => (s.length > n ? `${s.slice(0, n)}\n...` : s)

// The published pages: every .md and .mdx file Mintlify would serve.
function pages() {
  const ignoreFile = join(ROOT, '.mintignore')
  const ignore = existsSync(ignoreFile)
    ? readFileSync(ignoreFile, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
    : []
  const ignored = (rel) => ignore.some((p) => (p.endsWith('/') ? `${rel}/`.startsWith(p) : rel === p))
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      const rel = relative(ROOT, full)
      if (name === 'node_modules' || name.startsWith('.') || ignored(rel)) continue
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.mdx?$/.test(name)) out.push(rel)
    }
  }
  walk(ROOT)
  return out
}

const FENCE = /^([ \t]*)(`{3,})([^\n]*)\n([\s\S]*?)^\1\2[ \t]*$/gm
function blocksOf(page) {
  const text = readFileSync(join(ROOT, page), 'utf8')
  return [...text.matchAll(FENCE)].map((m, n) => {
    const indent = m[1]
    const body = m[4].replace(/\n$/, '').split('\n').map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n')
    const [lang = '', second = ''] = m[3].trim().split(/\s+/)
    const name = /^(wrap|expandable|lines)$/.test(second) ? '' : second
    return { page, n, lang, name, body, line: text.slice(0, m.index).split('\n').length, first: firstLine(body) }
  })
}

// 1. Every block has a marker, and every marker has its block.
const byKey = new Map(MARKS.blocks.map((m) => [`${m.page}#${m.n}`, m]))
const problems = []
const all = []
for (const page of pages()) {
  for (const b of blocksOf(page)) {
    const key = `${page}#${b.n}`
    const m = byKey.get(key)
    const where = `${page}:${b.line} block ${b.n} (${b.lang || 'no language'})`
    if (!m) { problems.push(`${where} has no marker in checks/samples.json`); continue }
    byKey.delete(key)
    if (m.first !== b.first) problems.push(`${where} moved or changed: its marker expects "${m.first}", the page has "${b.first}"`)
    if (!['runs', 'response', 'skipped'].includes(m.mark)) problems.push(`${where}: unknown mark "${m.mark}"`)
    if (m.mark === 'skipped' && !m.reason) problems.push(`${where} is skipped with no reason`)
    if (m.mark === 'response' && !m.schema) problems.push(`${where} is a response with no schema`)
    all.push({ ...b, m })
  }
}
for (const key of byKey.keys()) problems.push(`marker ${key} has no block in the pages`)
const tally = (mark) => all.filter((b) => b.m.mark === mark).length
console.log(`${all.length} blocks in ${new Set(all.map((b) => b.page)).size} pages: ${tally('runs')} runs, ${tally('response')} response, ${tally('skipped')} skipped`)
if (problems.length) {
  for (const p of problems) console.log(`MARKER ${p}`)
  console.log(`${problems.length} marker problems. Each block needs a marker: see "Code samples" in AGENTS.md.`)
  process.exit(1)
}
if (MARKERS_ONLY) process.exit(0)

// 2. The key: the standing test app's, never a live key, never a new app.
if (!KEY) stop("PINCAST_TEST_KEY is not set. The samples run only with the standing test app's key, never through the no-account route.")
if (!KEY.startsWith('pck_test-')) stop('PINCAST_TEST_KEY is not a test key (pck_test-...). The samples never run with a live key.')

const WORK = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'pincast-samples-'))
const CALLS = join(WORK, 'calls.log')
writeFileSync(CALLS, '')
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, {
  encoding: 'utf8', cwd: opts.cwd, env: opts.env || process.env, timeout: (opts.seconds || 600) * 1000, maxBuffer: 64 << 20,
})
function must(r, what) {
  if (r.status === 0) return r
  console.error(clip(`${r.stdout || ''}${r.stderr || ''}${r.error ? r.error.message : ''}`, 4000))
  stop(`${what} failed`)
}

// 3. The typed package and the command, where a reader would have installed them.
const SHARED = join(WORK, 'shared')
mkdirSync(join(SHARED, 'node_modules', '@pincast'), { recursive: true })
if (process.env.SAMPLES_LINK) {
  for (const pair of process.env.SAMPLES_LINK.split(',')) {
    const [name, path] = pair.split('=')
    symlinkSync(resolve(path), join(SHARED, 'node_modules', '@pincast', name))
  }
  mkdirSync(join(SHARED, 'node_modules', '.bin'))
  symlinkSync(join(SHARED, 'node_modules', '@pincast', 'cli', 'bin', 'pincast.js'), join(SHARED, 'node_modules', '.bin', 'pincast'))
} else {
  writeFileSync(join(SHARED, 'package.json'), '{ "private": true }\n')
  must(run('npm', ['install', '--no-audit', '--no-fund', '@pincast/api', '@pincast/cli'], { cwd: SHARED }), 'npm install @pincast/api @pincast/cli')
}
const pkgPath = (name) => realpathSync(join(SHARED, 'node_modules', '@pincast', name))
const version = (name) => JSON.parse(readFileSync(join(pkgPath(name), 'package.json'), 'utf8')).version
console.log(`@pincast/api ${version('api')}, @pincast/cli ${version('cli')}, API ${API === 'https://api.pincast.fm/v1' ? API : 'a local copy'}`)

// 4. create-pincast's template, installed once: the app `npm create pincast` makes, minus the test app.
let templateBase = null
function template() {
  if (templateBase) return templateBase
  let src = process.env.SAMPLES_TEMPLATE
  if (!src) {
    // From 0.2.0 on, create-pincast holds only the command's name and the starter ships inside the
    // @pincast/cli version it pins. 0.1.0 pinned no @pincast/cli and carried its own template.
    const v = must(run('npm', ['view', 'create-pincast@latest', 'version', 'dependencies', '--json'], { cwd: WORK }), 'npm view create-pincast')
    const info = JSON.parse(v.stdout)
    const cli = info.dependencies?.['@pincast/cli']
    const spec = cli ? `@pincast/cli@${cli}` : `create-pincast@${info.version}`
    const r = must(run('npm', ['pack', spec, '--pack-destination', WORK, '--json'], { cwd: WORK }), `npm pack ${spec}`)
    const packed = JSON.parse(r.stdout)[0]
    console.log(`create-pincast ${info.version}, template from ${packed.name} ${packed.version}`)
    must(run('tar', ['-xzf', join(WORK, packed.filename), '-C', WORK]), `unpacking ${packed.name}`)
    src = join(WORK, 'package', 'template')
  }
  const base = join(WORK, 'template')
  cpSync(src, base, { recursive: true, filter: (s) => !s.split('/').includes('node_modules') })
  for (const [from, to] of [['_package-lock.json', 'package-lock.json'], ['_gitignore', '.gitignore'], ['_env.example', '.env.example']]) {
    if (existsSync(join(base, from))) renameSync(join(base, from), join(base, to))
  }
  must(run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: base, env: { ...process.env, NODE_OPTIONS: '' } }), "npm ci in create-pincast's template")
  templateBase = base
  return base
}

function writeEnv(dir) {
  writeFileSync(join(dir, '.env'), `PINCAST_KEY=${KEY}\nPINCAST_API=${API}\nPINCAST_ACTOR=test_demo\n`, { mode: 0o600 })
}

// "empty": a new folder. "template": the app create-pincast makes. "template-deps": the
// template's packages only, for a page that writes its own app files.
function workspace(page, kind = 'empty') {
  const ws = join(WORK, 'pages', page.replace(/[/.]/g, '_'))
  if (kind === 'template') cpSync(template(), ws, { recursive: true, verbatimSymlinks: true })
  else if (kind === 'template-deps') {
    mkdirSync(ws, { recursive: true })
    for (const f of ['package.json', 'package-lock.json']) cpSync(join(template(), f), join(ws, f))
    cpSync(join(template(), 'node_modules'), join(ws, 'node_modules'), { recursive: true, verbatimSymlinks: true })
  } else mkdirSync(ws, { recursive: true })
  const scope = join(ws, 'node_modules', '@pincast')
  mkdirSync(scope, { recursive: true })
  for (const name of ['api', 'cli']) if (!existsSync(join(scope, name))) symlinkSync(pkgPath(name), join(scope, name))
  writeEnv(ws)
  return ws
}

// 5. The run.
const DOC = JSON.parse(readFileSync(join(ROOT, 'api-reference', 'openapi.json'), 'utf8'))
const { validate } = await import(pathToFileURL(join(pkgPath('api'), 'src', 'validate.js')))
function checkJson(body, schemaName) {
  let value
  try { value = JSON.parse(body) } catch (e) { return `not valid JSON: ${e.message}` }
  const schema = DOC.components?.schemas?.[schemaName]
  if (!schema) return `the API file has no schema ${schemaName}`
  const found = validate(schema, value, DOC)
  return found.length ? `doesn't fit ${schemaName}: ${found.slice(0, 3).map((p) => `${p.path || '(top)'} ${p.message}`).join('; ')}` : null
}

const NAMES = ['Pincast', 'PincastError', 'testActor', 'testPerson', 'isTestPerson', 'isTestKey']
function prelude(code) {
  const imported = new Set([...code.matchAll(/import\s*\{([^}]*)\}/g)].flatMap((m) => m[1].split(',').map((s) => s.trim())))
  const consts = new Set([...code.matchAll(/const\s+(?:\{([^}]*)\}|(\w+))/g)].flatMap((m) => (m[1] ? m[1].split(',').map((s) => s.trim()) : [m[2]])))
  const names = NAMES.filter((n) => !imported.has(n))
  return [names.length ? `import { ${names.join(', ')} } from '@pincast/api'` : '', consts.has('pincast') ? '' : 'const pincast = new Pincast()'].join('\n')
}

const SYNTAX = join(WORK, 'syntax')
mkdirSync(SYNTAX)
function syntax(b) {
  const file = join(SYNTAX, `${b.page.replace(/[/.]/g, '_')}-${b.n}.${b.lang === 'js' ? 'mjs' : 'sh'}`)
  writeFileSync(file, b.body)
  const r = b.lang === 'js' ? run('node', ['--check', file]) : run('bash', ['-n', file])
  return r.status === 0 ? null : clip(r.stderr || 'syntax check failed', 600)
}

const shimEnv = (cwd) => ({
  ...process.env,
  PINCAST_KEY: KEY,
  PINCAST_TEST_KEY: '',
  PINCAST_API: API,
  SAMPLES_CALLS: CALLS,
  DO_NOT_TRACK: '1',
  NODE_OPTIONS: `--import ${pathToFileURL(join(HERE, 'shim.mjs')).href}`,
  PATH: [join(SHARED, 'node_modules', '.bin'), join(cwd, 'node_modules', '.bin'), process.env.PATH].join(':'),
})
const callCount = () => readFileSync(CALLS, 'utf8').split('\n').filter((l) => l.startsWith('api ')).length

const order = [...(MARKS.order || []), ...new Set(all.map((b) => b.page))].filter((p, i, a) => a.indexOf(p) === i)
const results = []
for (const page of order) {
  const conf = MARKS.pages?.[page] || {}
  let cwd = null
  for (const b of all.filter((x) => x.page === page)) {
    const { m } = b
    const label = `${page}:${b.line} block ${b.n} (${b.lang})`
    let status = 'PASS'
    let detail = ''
    const before = callCount()
    if (m.mark === 'response') {
      const bad = checkJson(b.body, m.schema)
      if (bad) { status = 'FAIL'; detail = bad } else detail = `fits ${m.schema}`
    } else if (m.mark === 'skipped') {
      status = 'SKIP'
      detail = m.reason
      if (m.syntax) {
        const bad = syntax(b)
        if (bad) { status = 'FAIL'; detail = `syntax: ${bad}` } else detail += ' (syntax checked)'
      }
    } else {
      cwd ??= workspace(page, conf.workspace)
      if (b.name) {
        mkdirSync(dirname(join(cwd, b.name)), { recursive: true })
        writeFileSync(join(cwd, b.name), `${b.body}\n`)
        detail = `wrote ${b.name}`
        const bad = m.schema ? checkJson(b.body, m.schema) : null
        if (bad) { status = 'FAIL'; detail = bad } else if (m.schema) detail += `, fits ${m.schema}`
      } else {
        mkdirSync(join(cwd, '.samples'), { recursive: true })
        const slug = `${page.replace(/[/.]/g, '_')}-${b.n}`
        const env = { ...shimEnv(cwd), SAMPLES_EXPECT: m.expect ? String(m.expect) : '' }
        let r
        if (b.lang === 'js') {
          const file = join(cwd, '.samples', `${slug}.mjs`)
          writeFileSync(file, conf.prelude ? `${prelude(b.body)}\n${b.body}\n` : `${b.body}\n`)
          r = run('node', [file], { cwd, env, seconds: m.seconds || 120 })
        } else {
          const file = join(cwd, '.samples', `${slug}.sh`)
          writeFileSync(file, `source ${JSON.stringify(join(HERE, 'shim.sh'))}\n${b.body}\n`)
          r = run('bash', ['-eo', 'pipefail', file], { cwd, env, seconds: m.seconds || 300 })
        }
        if (r.status !== 0) {
          status = 'FAIL'
          detail = `exit ${r.status ?? r.signal}: ${clip(`${r.stdout || ''}${r.stderr || ''}${r.error ? r.error.message : ''}`.trim(), 1200)}`
        } else detail = 'ran'
      }
      if (m.cwd) { cwd = join(cwd, m.cwd); writeEnv(cwd) }
    }
    const calls = callCount() - before
    if (calls) detail += `, ${calls} call${calls === 1 ? '' : 's'}`
    results.push({ page, n: b.n, line: b.line, lang: b.lang, mark: m.mark, status, detail })
    console.log(`${status} ${label} ${m.mark}: ${detail}`)
  }
}

// 6. The count, against the test app's day.
const lines = readFileSync(CALLS, 'utf8').split('\n').filter(Boolean)
const apiCalls = lines.filter((l) => l.startsWith('api '))
const budget = MARKS.budget || {}
const failed = results.filter((r) => r.status === 'FAIL')
console.log(`${apiCalls.length} calls to the API in this run (budget ${budget.maxCallsPerRun} a run; the test app allows ${budget.testAppCallsPerDay} a day), ${lines.length - apiCalls.length} local`)
if (budget.maxCallsPerRun && apiCalls.length > budget.maxCallsPerRun) {
  failed.push({ page: '(run)', detail: 'over budget' })
  console.log(`FAIL the run made ${apiCalls.length} calls, over its budget of ${budget.maxCallsPerRun}`)
}
const summary = {
  blocks: all.length,
  runs: tally('runs'), response: tally('response'), skipped: tally('skipped'),
  passed: results.filter((r) => r.status === 'PASS').length,
  failed: failed.length,
  apiCalls: apiCalls.length,
  calls: apiCalls.map((l) => l.slice(4)),
}
if (process.env.SAMPLES_REPORT) writeFileSync(process.env.SAMPLES_REPORT, `${JSON.stringify({ summary, results }, null, 2)}\n`)
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = results.filter((r) => r.status === 'FAIL').map((r) => `| ${r.page}:${r.line} | ${r.n} | ${r.detail.split('\n')[0].replace(/\|/g, '/')} |`)
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, [
    '## Code samples',
    `${summary.blocks} blocks: ${summary.runs} runs, ${summary.response} response, ${summary.skipped} skipped. ${summary.failed} failed. ${summary.apiCalls} calls to the API.`,
    rows.length ? '\n| Page | Block | Why |\n|:-|:-|:-|' : '',
    ...rows,
    '',
  ].join('\n'), { flag: 'a' })
}
console.log(`${results.length} blocks checked, ${failed.length} failed`)
if (!process.env.SAMPLES_KEEP) rmSync(WORK, { recursive: true, force: true })
else console.log(`work folder kept: ${WORK}`)
process.exit(failed.length ? 1 : 0)
