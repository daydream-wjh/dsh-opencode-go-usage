/**
 * dsh-opencode-go-usage — host half.
 *
 * Serves the OpenCode Go quota readout to this profile's own Web GUI.
 *
 * Why a host half at all: `GET https://opencode.ai/zen/go/v1/usage` answers the
 * provider's three usage windows (rolling / weekly / monthly) as
 * `{usage:{<window>:{status,percent,resetsAt}}}`, but it needs the account API
 * key. The key lives in the credentials store (`OPENCODE_GO_API_KEY`), never in
 * the browser, so the readout fetches upstream here and the client half asks
 * this process instead:
 *
 *   GET /opencode-go/usage          cached reading
 *   GET /opencode-go/usage?force=1  bypass the cache
 *
 * The route sits behind the same connection trust fence as the shipped Web
 * routes (`connection.requestRejection`), so only the owner's authenticated
 * browser can read it. Responses are always JSON with `ok` first: an absent
 * key, an expired key, an upstream failure and a network timeout are ordinary
 * readings for a widget, not HTTP errors the client has to unmarshal.
 */
import { randomUUID } from 'node:crypto'

/** Cordis function-plugin name. */
export const name = 'dsh-opencode-go-usage'

/** The route carrier and its trust fence; credentials are read through `ctx.get`. */
export const inject = ['webServer', 'connection']

/** Browser-facing route (exact path, no trailing slash). */
const ROUTE = '/opencode-go/usage'

/** The gateway's own quota endpoint for the Go plan. */
const UPSTREAM = 'https://opencode.ai/zen/go/v1/usage'

/** Credentials reference the gateway key is stored under. */
const KEY_REF = 'OPENCODE_GO_API_KEY'

/** Windows the gateway reports, in the display order the client uses. */
const WINDOWS = ['rolling', 'weekly', 'monthly']

/** A cached reading answers this long before the next request goes upstream. */
const CACHE_MS = 20_000

/** Upstream budget: the widget re-polls, so a hung request is worthless past this. */
const TIMEOUT_MS = 8_000

/** JSON response, never cached by the browser. */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** Clamp a reported percentage into 0..100, or null when the field is unusable. */
function percentOf(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, value))
}

/** Keep an ISO timestamp only when it parses, so the client never formats garbage. */
function timestampOf(value) {
  if (typeof value !== 'string') return null
  const at = Date.parse(value)
  return Number.isNaN(at) ? null : new Date(at).toISOString()
}

/**
 * Narrow one gateway payload to the shape the client renders.
 *
 * Unknown windows are dropped rather than forwarded: the client has a label
 * table, and a window it cannot name would render as a blank row. A payload
 * with no recognised window is not a reading at all.
 * @param payload - decoded upstream body.
 * @returns `{ windows }` (possibly empty) plus the raw window names found.
 */
export function normalizeUsage(payload) {
  const usage = payload !== null && typeof payload === 'object' ? payload.usage : undefined
  const source = usage !== null && typeof usage === 'object' ? usage : null
  const windows = {}
  if (source === null) return { windows, found: [] }
  for (const window of WINDOWS) {
    const entry = source[window]
    if (entry === null || typeof entry !== 'object') continue
    windows[window] = {
      status: typeof entry.status === 'string' ? entry.status : 'unknown',
      percent: percentOf(entry.percent),
      resetsAt: timestampOf(entry.resetsAt),
    }
  }
  return { windows, found: Object.keys(source) }
}

/**
 * Read the quota once from the gateway.
 *
 * Split out from `apply` so the offline harness can drive it with a stub
 * `fetchImpl`: the interesting part is error mapping, not the network.
 * @param options.key - gateway API key.
 * @param options.fetchImpl - `fetch`-compatible function.
 * @param options.timeoutMs - upstream budget.
 * @returns a response body carrying `ok` first.
 */
export async function readUsage({ key, fetchImpl = fetch, timeoutMs = TIMEOUT_MS }) {
  let response
  try {
    response = await fetchImpl(UPSTREAM, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${key}`,
        accept: 'application/json',
        // The gateway expects its own client session header on inference
        // traffic; the usage endpoint answers without it today, and sending a
        // fresh one keeps this request indistinguishable from a client poll.
        'x-opencode-session': randomUUID(),
        'user-agent': 'dsh-opencode-go-usage/0.1.0',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const timeout = error !== null && typeof error === 'object' && error.name === 'TimeoutError'
    return {
      ok: false,
      code: timeout ? 'timeout' : 'network',
      message: timeout ? '读取上游限额超时' : `无法连接 opencode.ai：${error?.message ?? error}`,
    }
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, code: 'auth', message: 'OPENCODE_GO_API_KEY 无效或已失效' }
  }
  if (!response.ok) {
    return {
      ok: false,
      code: 'upstream',
      message: `上游返回 HTTP ${response.status}`,
      status: response.status,
    }
  }

  let payload
  try {
    payload = await response.json()
  } catch {
    return { ok: false, code: 'payload', message: '上游返回的不是 JSON' }
  }

  const { windows } = normalizeUsage(payload)
  if (Object.keys(windows).length === 0) {
    return { ok: false, code: 'payload', message: '上游返回里没有可识别的限额窗口' }
  }
  return { ok: true, windows }
}

/**
 * Register the readout route.
 * @param ctx - plugin context carrying `webServer`, `connection`, and the
 * optional `credentials` / `launchEnvironment` services the key is read from.
 * @param config - optional `{ cacheMs, timeoutMs }` overrides.
 */
export function apply(ctx, config = {}) {
  const cacheMs = Number.isFinite(config?.cacheMs) ? Math.max(0, config.cacheMs) : CACHE_MS
  const timeoutMs = Number.isFinite(config?.timeoutMs) ? Math.max(500, config.timeoutMs) : TIMEOUT_MS

  let cached = null
  let inflight = null

  /** Resolve the key: credentials store first, then the launch environment. */
  const readKey = async () => {
    try {
      const credentials = ctx.get('credentials')
      const hit = credentials === undefined ? undefined : await credentials.resolve(KEY_REF)
      if (typeof hit?.value === 'string' && hit.value !== '') return hit.value
    } catch {}
    try {
      const env = ctx.get('launchEnvironment')
      const entry = env === undefined ? undefined : env.get(KEY_REF)
      if (typeof entry?.value === 'string' && entry.value !== '') return entry.value
    } catch {}
    return null
  }

  /** One shared upstream read: concurrent polls join the same promise. */
  const reading = async (key) => {
    if (inflight === null) {
      inflight = readUsage({ key, timeoutMs }).finally(() => {
        inflight = null
      })
    }
    return inflight
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: async (req, res) => {
          const rejection = ctx.connection.requestRejection(req)
          if (rejection !== undefined) {
            res.statusCode = rejection
            res.end()
            return
          }
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.statusCode = 405
            res.setHeader('allow', 'GET, HEAD')
            res.end()
            return
          }

          const force = new URL(String(req.url), 'http://localhost').searchParams.get('force') === '1'
          if (!force && cached !== null && Date.now() - cached.at < cacheMs) {
            sendJson(res, 200, { ...cached.body, cached: true })
            return
          }

          const key = await readKey()
          if (key === null) {
            const body = {
              ok: false,
              code: 'no-key',
              message: '未配置 OPENCODE_GO_API_KEY',
            }
            cached = { at: Date.now(), body }
            sendJson(res, 200, body)
            return
          }

          const body = await reading(key)
          // Only a real reading is cached: a transient failure must not pin the
          // widget to an error for the whole TTL.
          cached = body.ok ? { at: Date.now(), body } : null
          sendJson(res, 200, { ...body, fetchedAt: new Date().toISOString() })
        },
      }),
    `opencode-go-usage: GET ${ROUTE}`,
  )
}
