// Loaded with `node --import` before every Node sample (and, through NODE_OPTIONS, before every
// Node program a shell sample starts). It sends the API address the docs print to PINCAST_API,
// lets local addresses through, refuses every other address and the no-account route, and writes
// each call to SAMPLES_CALLS so the runner can count them.
import { appendFileSync } from 'node:fs'

const REAL = 'https://api.pincast.fm/v1'
const API = (process.env.PINCAST_API || REAL).replace(/\/$/, '')
const LOG = process.env.SAMPLES_CALLS
const realFetch = globalThis.fetch
const isLocal = (u) => /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u)

globalThis.fetch = async (input, init = {}) => {
  const req = input instanceof Request ? input : null
  let url = String(req ? req.url : input)
  const method = String(init.method || req?.method || 'GET').toUpperCase()
  if (url.startsWith(REAL)) url = API + url.slice(REAL.length)
  const api = url.startsWith(`${API}/`)
  if (!api && !isLocal(url)) throw new Error(`samples: refused ${method} ${url}: a sample may call only the Pincast API`)
  const path = api ? url.slice(API.length).split('?')[0] : new URL(url).pathname
  if (api && method === 'POST' && path === '/test-apps') {
    throw new Error('samples: refused POST /test-apps, the no-account route')
  }
  const res = await realFetch(req ? new Request(url, req) : url, init)
  if (LOG) appendFileSync(LOG, `${api ? 'api' : 'local'} ${method} ${path} ${res.status}\n`)
  return res
}
