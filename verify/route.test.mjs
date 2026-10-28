/**
 * Offline harness for dsh-opencode-go-usage/lib/index.js.
 *
 * Drives the real host half with a fake `fetch`, a fake Cordis context and a
 * fake `http.ServerResponse`, so the parts that decide what the widget shows —
 * key resolution, error mapping, caching, method and trust-fence handling — are
 * proven without touching the network or the running GUI.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, normalizeUsage, readUsage } from '../lib/index.js'

const PAYLOAD = {
  usage: {
    rolling: { status: 'ok', percent: 4, resetsAt: '2026-10-28T21:26:02.000Z' },
    weekly: { status: 'ok', percent: 1, resetsAt: '2026-11-02T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 0, resetsAt: '2026-11-28T15:58:16.000Z' },
  },
}

/** One `fetch`-compatible stub answering with `body` and `status`. */
function stubFetch({ status = 200, body = PAYLOAD } = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }
  }
  return { impl, calls }
}

/** A fake `http.ServerResponse` collecting what the handler wrote. */
function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    end(chunk) {
      if (chunk !== undefined) this.body = String(chunk)
    },
  }
}

/** A fake Cordis context with the services the route reads. */
function fakeContext({ key = 'oc_test_key', rejection, fetchImpl } = {}) {
  const routes = []
  const ctx = {
    connection: {
      requestRejection: () => rejection,
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    get(name) {
      if (name === 'credentials') {
        return {
          resolve: async () => (key === null ? undefined : { value: key }),
        }
      }
      return undefined
    },
    effect(fn) {
      return fn()
    },
  }
  return { ctx, routes, fetchImpl }
}

/** Run one request through the registered route. */
async function request(ctx, routes, { method = 'GET', url = '/opencode-go/usage' } = {}) {
  const res = fakeResponse()
  await routes[0].handler({ method, url }, res)
  return { res, body: res.body === '' ? null : JSON.parse(res.body) }
}

test('normalizeUsage keeps the three known windows and drops junk', () => {
  const { windows } = normalizeUsage(PAYLOAD)
  assert.deepEqual(Object.keys(windows), ['rolling', 'weekly', 'monthly'])
  assert.equal(windows.rolling.percent, 4)
  assert.equal(windows.weekly.resetsAt, '2026-11-02T00:00:00.000Z')
  assert.equal(normalizeUsage({ usage: { rolling: { percent: 140 } } }).windows.rolling.percent, 100)
  assert.equal(normalizeUsage({ usage: { rolling: { percent: '1' } } }).windows.rolling.percent, null)
  assert.deepEqual(normalizeUsage(null).windows, {})
})

test('readUsage maps auth, upstream and payload failures', async () => {
  const auth = await readUsage({ key: 'k', fetchImpl: stubFetch({ status: 401 }).impl })
  assert.equal(auth.ok, false)
  assert.equal(auth.code, 'auth')

  const broken = await readUsage({ key: 'k', fetchImpl: stubFetch({ status: 502 }).impl })
  assert.equal(broken.code, 'upstream')

  const junk = await readUsage({ key: 'k', fetchImpl: stubFetch({ body: { usage: {} } }).impl })
  assert.equal(junk.code, 'payload')

  const offline = await readUsage({
    key: 'k',
    fetchImpl: async () => {
      throw Object.assign(new Error('boom'), { name: 'TimeoutError' })
    },
  })
  assert.equal(offline.code, 'timeout')
})

test('the route answers a reading, caches it, and honours force=1', async () => {
  const { impl, calls } = stubFetch()
  const original = globalThis.fetch
  globalThis.fetch = impl
  try {
    const { ctx, routes } = fakeContext()
    apply(ctx)
    assert.equal(routes.length, 1)
    assert.equal(routes[0].kind, 'exact')
    assert.equal(routes[0].path, '/opencode-go/usage')

    const first = await request(ctx, routes)
    assert.equal(first.res.statusCode, 200)
    assert.equal(first.body.ok, true)
    assert.equal(first.body.windows.rolling.percent, 4)
    assert.ok(first.body.fetchedAt)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].init.headers.authorization, 'Bearer oc_test_key')

    const second = await request(ctx, routes)
    assert.equal(second.body.cached, true)
    assert.equal(calls.length, 1)

    await request(ctx, routes, { url: '/opencode-go/usage?force=1' })
    assert.equal(calls.length, 2)
  } finally {
    globalThis.fetch = original
  }
})

test('a missing key is a reading, not an error', async () => {
  const { ctx, routes } = fakeContext({ key: null })
  apply(ctx)
  const { res, body } = await request(ctx, routes)
  assert.equal(res.statusCode, 200)
  assert.equal(body.ok, false)
  assert.equal(body.code, 'no-key')
})

test('the trust fence and method guard answer before any upstream read', async () => {
  const { impl, calls } = stubFetch()
  const original = globalThis.fetch
  globalThis.fetch = impl
  try {
    const blocked = fakeContext({ rejection: 401 })
    apply(blocked.ctx)
    const denied = await request(blocked.ctx, blocked.routes)
    assert.equal(denied.res.statusCode, 401)
    assert.equal(calls.length, 0)

    const open = fakeContext()
    apply(open.ctx)
    const wrongMethod = await request(open.ctx, open.routes, { method: 'POST' })
    assert.equal(wrongMethod.res.statusCode, 405)
    assert.equal(wrongMethod.res.headers.allow, 'GET, HEAD')
    assert.equal(calls.length, 0)
  } finally {
    globalThis.fetch = original
  }
})
