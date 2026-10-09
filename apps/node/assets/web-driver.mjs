// Browser driver for test_web tasks. Runs INSIDE the task's sandbox container
// (network: loopback only), started by apps/node/src/agent/web-runner.ts as
//   docker exec -i <container> node /work/.gab-ai-web/driver.mjs
// and spoken to in JSON lines on stdin/stdout:
//   in : {"id": 1, "action": "goto", ...args}
//   out: {"id": 1, "ok": true, "result": ...} | {"id": 1, "ok": false, "error": "..."}
// First line out: {"ready": true} (or {"fatal": "..."} when the browser did not start).
// The model never writes Playwright code: it can only call these actions.
//
// Two modes, by environment: a web page in Chromium (default), or an Electron app
// (GAB_APP=electron, GAB_ELECTRON_ENTRY=<main entry relative to /work>; run under xvfb).
import readline from 'node:readline';
import { _electron, chromium } from 'playwright';

const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$|\?|#)/;
const MAX_TEXT = 6000;
const MAX_LOG = 50;
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

const ELECTRON = process.env.GAB_APP === 'electron';
let browser;
let app;
let page;
const problems = [];
const note = (text) => { problems.push(text.slice(0, 400)); if (problems.length > 200) problems.shift(); };
const blocked = new Set();

/** Records the page's console errors, uncaught exceptions, failed requests and HTTP errors. */
function watch(p) {
  p.on('console', (m) => { if (m.type() === 'error') note(`console.error: ${m.text()}`); });
  p.on('pageerror', (e) => note(`uncaught error: ${e.message}`));
  p.on('requestfailed', (r) => { if (!blocked.has(r.url())) note(`request failed: ${r.url()} (${r.failure()?.errorText ?? 'unknown'})`); });
  p.on('response', (r) => { if (r.status() >= 400) note(`HTTP ${r.status()} ${r.url()}`); });
}

try {
  // Capabilities are dropped in the container, so Chromium's own sandbox cannot start.
  const flags = ['--no-sandbox', '--disable-dev-shm-usage'];
  if (ELECTRON) {
    const entry = process.env.GAB_ELECTRON_ENTRY ?? '';
    if (!/^[A-Za-z0-9._@+/-]{1,200}$/.test(entry) || entry.split('/').includes('..')) throw new Error('bad Electron entry');
    app = await _electron.launch({ args: [...flags, entry], cwd: '/work' });
    page = await app.firstWindow();
    watch(page);
    app.on('window', (w) => watch(w));
  } else {
    browser = await chromium.launch({ args: flags });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    // Only the app under test is reachable: every other address is refused (the container has no network anyway).
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (LOCAL.test(url) || /^(data|blob):/.test(url)) return route.continue();
      blocked.add(url);
      return route.abort();
    });
    page = await context.newPage();
    watch(page);
  }
} catch (err) {
  out({ fatal: `${ELECTRON ? 'app' : 'browser'} did not start: ${err.message}`.slice(0, 500) });
  process.exit(1);
}

const cap = (text, max = MAX_TEXT) => (text.length > max ? `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]` : text);
const need = (args, key) => {
  if (typeof args[key] !== 'string' || !args[key]) throw new Error(`${key} is required`);
  return args[key];
};
const state = async () => ({ url: page.url(), title: await page.title() });

const actions = {
  async goto(args) {
    if (ELECTRON) throw new Error('an Electron app has no address bar: use windows and click');
    const url = need(args, 'url');
    if (!LOCAL.test(url)) throw new Error('only the app under test is reachable (http://localhost:<port>/...)');
    const res = await page.goto(url, { waitUntil: 'load', timeout: 20_000 });
    return { ...(await state()), status: res?.status() ?? null };
  },
  async click(args) {
    await page.locator(need(args, 'selector')).first().click({ timeout: 5_000 });
    await page.waitForLoadState('load', { timeout: 5_000 }).catch(() => {});
    return state();
  },
  async fill(args) {
    if (typeof args.value !== 'string') throw new Error('value is required');
    await page.locator(need(args, 'selector')).first().fill(args.value, { timeout: 5_000 });
    return 'filled';
  },
  async press(args) {
    await page.keyboard.press(need(args, 'key'));
    await page.waitForLoadState('load', { timeout: 5_000 }).catch(() => {});
    return state();
  },
  async text(args) {
    const target = typeof args.selector === 'string' && args.selector ? args.selector : 'body';
    return cap(await page.locator(target).first().innerText({ timeout: 5_000 }));
  },
  async elements() {
    return page.evaluate(() => {
      const label = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      return [...document.querySelectorAll('a[href],button,input,select,textarea,[role=button],[onclick]')].slice(0, 80).map((el) => ({
        tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || undefined, id: el.id || undefined, name: el.getAttribute('name') || undefined,
        text: label(el) || undefined, href: el.getAttribute('href') || undefined, disabled: el.disabled || undefined,
      }));
    });
  },
  async wait(args) {
    await page.locator(need(args, 'selector')).first().waitFor({ timeout: Math.min(Number(args.timeoutMs) || 5_000, 15_000) });
    return 'found';
  },
  async windows() {
    if (!app) throw new Error('only an Electron app has windows');
    return Promise.all(app.windows().map(async (w, index) => ({ index, title: await w.title(), url: w.url(), current: w === page })));
  },
  async window(args) {
    if (!app) throw new Error('only an Electron app has windows');
    const w = app.windows()[Number(args.index)];
    if (!w) throw new Error(`no window ${String(args.index)}: call windows to list them`);
    page = w;
    return state();
  },
  async problems(args) {
    const list = problems.slice(-MAX_LOG);
    if (args.clear) problems.length = 0;
    return list.length ? list : 'none';
  },
};

const rl = readline.createInterface({ input: process.stdin });
out({ ready: true });
rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return out({ id: null, ok: false, error: 'bad JSON' }); }
  try {
    const run = actions[msg.action];
    if (!run) throw new Error(`unknown action ${String(msg.action)}`);
    out({ id: msg.id, ok: true, result: await run(msg) });
  } catch (err) {
    out({ id: msg.id, ok: false, error: String(err.message ?? err).split('\n')[0].slice(0, 400) });
  }
});
rl.on('close', async () => { await (app ?? browser).close().catch(() => {}); process.exit(0); });
