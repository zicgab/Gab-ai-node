// Stands in for assets/web-driver.mjs in tests: same JSON-lines protocol, no browser.
import readline from 'node:readline';
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
if (process.env.STUB_FATAL) { out({ fatal: 'browser did not start: stub' }); process.exit(1); }
out({ ready: true });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.action === 'goto') return out({ id: m.id, ok: true, result: { url: m.url, title: 'Demo', status: 200 } });
  if (m.action === 'problems') return out({ id: m.id, ok: true, result: ['console.error: boom at app.js:3'] });
  if (m.action === 'windows') return out({ id: m.id, ok: true, result: [{ index: 0, title: 'Main', current: true }] });
  if (m.action === 'hang') return; // never answers
  if (m.action === 'die') process.exit(3);
  return out({ id: m.id, ok: false, error: `stub cannot ${m.action}` });
});
