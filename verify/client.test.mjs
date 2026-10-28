/**
 * Offline harness for dsh-opencode-go-usage/lib/client.js.
 *
 * Executes the real bundle the browser will receive, with a fake module loader,
 * a minimal React (hooks + createElement) and a scripted state sequence, then
 * renders the component and inspects the produced element tree. It proves the
 * bundle's own logic and its three render states; it cannot prove what the page
 * paints.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** Run the bundle, returning its exported module. */
function load(factoryRequire) {
  let captured = null
  const windowStub = {
    localStorage: { getItem: () => null, setItem() {} },
    __ModuleLoader__: {
      load({ id, factory }) {
        captured = { id, factory }
      },
    },
  }
  const run = new Function('window', 'document', SOURCE)
  run(windowStub, { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' })
  assert.ok(captured !== null, 'bundle registered no module')
  return captured.factory(factoryRequire)
}

/** Minimal React stand-in; `script` feeds successive `useState` calls. */
function fakeReact(script) {
  let index = 0
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity) }
    },
    useState(initial) {
      const value = index < script.length ? script[index] : typeof initial === 'function' ? initial() : initial
      index += 1
      return [value, () => {}]
    },
    useRef(initial) {
      return { current: initial }
    },
    useEffect() {},
    useMemo(fn) {
      return fn()
    },
    useCallback(fn) {
      return fn
    },
  }
}

/** All text under one element tree, resolving nested function components. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  return textOf(node.children)
}

/** Depth-first search for every node matching a predicate. */
function findAll(node, predicate, found = []) {
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found)
    return found
  }
  if (predicate(node)) found.push(node)
  // A function element is rendered on demand: the rows live inside WindowRow.
  if (typeof node.type === 'function') {
    findAll(node.type(node.props), predicate, found)
    return found
  }
  for (const child of node.children ?? []) findAll(child, predicate, found)
  return found
}

/** A reading shaped like the host route's success body. */
function readingBody() {
  const at = (ms) => new Date(Date.now() + ms).toISOString()
  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    windows: {
      rolling: { status: 'ok', percent: 4, resetsAt: at(2 * 3600_000) },
      weekly: { status: 'ok', percent: 38, resetsAt: at(72 * 3600_000) },
      monthly: { status: 'warning', percent: 82, resetsAt: at(200 * 3600_000) },
    },
  }
}

test('the bundle registers one client module and exports its seekers', () => {
  const module = load((name) => fakeReact([]))
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual(module.inject, ['slots'])
  assert.equal(typeof module.parseReading, 'function')
})

test('formatting helpers keep sub-percent readings and minute-scale countdowns', () => {
  const module = load((name) => fakeReact([]))
  assert.equal(module.formatPercent(0.4), '0.4%')
  assert.equal(module.formatPercent(38), '38%')
  assert.equal(module.formatPercent(null), '—')
  assert.equal(module.formatCountdown(3 * 3600_000 + 12 * 60_000), '3 小时 12 分')
  assert.equal(module.formatCountdown(20_000), '不到 1 分钟')
  assert.equal(module.formatCountdown(-1), '即将重置')
  assert.equal(module.toneOf(4), 'ok')
  assert.equal(module.toneOf(70), 'warn')
  assert.equal(module.toneOf(100), 'danger')
})

test('a success reading renders one summary line and three detail rows', () => {
  const module = load((name) => fakeReact([readingBody(), 'ready', true, 0]))
  const tree = module.OpenCodeGoUsage()
  const meta = findAll(tree, (node) => node.props['data-opencode-go-meta'] === 'true')[0]
  const summary = textOf(meta)
  assert.match(summary, /滚动 4%/)
  assert.match(summary, /周 38%/)
  assert.match(summary, /月 82%/)
  assert.match(summary, /后重置/)

  const rows = findAll(tree, (node) => node.props['data-opencode-go-window'] !== undefined)
  assert.equal(rows.length, 3)
  assert.equal(rows[0].props['data-opencode-go-window'], 'rolling')
  assert.equal(rows[2].props['data-opencode-go-window'], 'monthly')
  assert.match(textOf(tree), /本周/)
  assert.match(textOf(tree), /接近上限/)
  // The dot takes the worst window's tone, not the first one's.
  assert.equal(findAll(tree, (node) => node.props['data-opencode-go-dot'] !== undefined)[0].props['data-opencode-go-dot'], 'warn')
})

test('a collapsed reading renders the summary only, with no detail rows', () => {
  const module = load((name) => fakeReact([readingBody(), 'ready', false, 0]))
  const tree = module.OpenCodeGoUsage()
  assert.equal(findAll(tree, (node) => node.props['data-opencode-go-window'] !== undefined).length, 0)
  assert.equal(findAll(tree, (node) => node.props['data-opencode-go-details'] !== undefined).length, 0)
  assert.match(textOf(tree), /滚动 4%/)
})

test('a failed reading surfaces its message in place of the numbers', () => {
  const module = load((name) => fakeReact([{ ok: false, code: 'auth', message: 'OPENCODE_GO_API_KEY 无效或已失效' }, 'ready', false, 0]))
  const tree = module.OpenCodeGoUsage()
  assert.match(textOf(tree), /OPENCODE_GO_API_KEY 无效或已失效/)
  assert.equal(findAll(tree, (node) => node.props['data-opencode-go-window'] !== undefined).length, 0)
})

test('an unconfigured key renders one quiet line instead of an empty widget', () => {
  const module = load((name) => fakeReact([{ ok: false, code: 'no-key', message: '未配置 OPENCODE_GO_API_KEY' }, 'ready', false, 0]))
  const tree = module.OpenCodeGoUsage()
  assert.equal(tree.props['data-opencode-go-state'], 'no-key')
  assert.match(textOf(tree), /未配置 OPENCODE_GO_API_KEY/)
})

test('the root row refuses to shrink inside the height-constrained hero stack', () => {
  // Regression: on the new-conversation screen the composer stack is a flex
  // column whose height is pinned by the hero shell. As a shrinkable item with
  // `overflow: hidden`, the row collapsed to 9px and clipped its own text; the
  // fix is `flex: 0 0 auto` on both render roots (reading and no-key).
  const ready = load((name) => fakeReact([readingBody(), 'ready', false, 0]))
  assert.equal(ready.OpenCodeGoUsage().props.style.flex, '0 0 auto')

  const unconfigured = load((name) => fakeReact([{ ok: false, code: 'no-key', message: '未配置 OPENCODE_GO_API_KEY' }, 'ready', false, 0]))
  const quiet = unconfigured.OpenCodeGoUsage()
  assert.equal(quiet.props.style.flex, '0 0 auto')
  assert.equal(quiet.props.style.width, '100%')
})

test('parseReading drops unnamed windows and unparsable resets', () => {
  const module = load((name) => fakeReact([]))
  const parsed = module.parseReading({
    ok: true,
    windows: {
      rolling: { status: 'ok', percent: 12, resetsAt: 'not-a-date' },
      unknownWindow: { percent: 50 },
      weekly: { percent: 'nope' },
    },
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.windows.length, 1)
  assert.equal(parsed.windows[0].resetsAt, null)
  assert.equal(module.parseReading({ ok: true, windows: {} }).ok, false)
})
