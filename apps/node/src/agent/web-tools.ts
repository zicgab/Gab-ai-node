import type { ToolDef } from './tools.js';
import type { WebSession } from './web-session.js';

const show = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value, null, 1));

/**
 * The tools of a test_web / test_electron task: the model drives the page only through
 * these. A web page is opened with goto; an Electron app is already open and has windows.
 */
export function createWebTools(session: Pick<WebSession, 'call'>, kind: 'test_web' | 'test_electron' = 'test_web'): ToolDef[] {
  const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDef => ({
    name, description, parameters: { type: 'object', properties, required },
    async run(args) { return show(await session.call(name, args)); },
  });
  const selector = { type: 'string', description: 'Playwright selector: CSS ("#login"), text ("text=Sign in"), or "button:has-text(\\"Save\\")"' };
  const opening = kind === 'test_electron'
    ? [
      tool('windows', 'List the windows of the app (index, title).', {}, []),
      tool('window', 'Switch to another window of the app by index (see windows). Returns its title.', { index: { type: 'integer' } }, ['index']),
    ]
    : [tool('goto', 'Open a page of the app (http://localhost:<port>/path). Returns url, title and HTTP status. Other addresses are refused.', { url: { type: 'string' } }, ['url'])];
  return [
    ...opening,
    tool('elements', 'List the links, buttons and inputs of the current page (tag, id, name, text, href): use it to find what to click.', {}, []),
    tool('text', 'Visible text of the page, or of one element when a selector is given.', { selector }, []),
    tool('click', 'Click the first element that matches the selector. Returns the new url and title.', { selector }, ['selector']),
    tool('fill', 'Type a value into an input.', { selector, value: { type: 'string' } }, ['selector', 'value']),
    tool('press', 'Press a key, e.g. Enter, Tab, Escape. Returns the new url and title.', { key: { type: 'string' } }, ['key']),
    tool('wait', 'Wait until an element exists (up to 15 s).', { selector, timeoutMs: { type: 'integer' } }, ['selector']),
    tool('problems', 'Problems since the start: console errors, uncaught exceptions, failed requests, HTTP errors (>= 400). Check it after every page you open.', { clear: { type: 'boolean' } }, []),
  ];
}
