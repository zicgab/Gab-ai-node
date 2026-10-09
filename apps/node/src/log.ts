// One JSON line per event on stdout (collected by launchd / systemd / Task Scheduler logs).
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = ORDER[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? 20;

function write(level: Level, msg: string, data?: Record<string, unknown>): void {
  if (ORDER[level] < min) return;
  const extra = data ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v instanceof Error ? v.message : v])) : {};
  process.stdout.write(JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra }) + '\n');
}

export const log = {
  debug: (m: string, d?: Record<string, unknown>) => write('debug', m, d),
  info: (m: string, d?: Record<string, unknown>) => write('info', m, d),
  warn: (m: string, d?: Record<string, unknown>) => write('warn', m, d),
  error: (m: string, d?: Record<string, unknown>) => write('error', m, d),
};
