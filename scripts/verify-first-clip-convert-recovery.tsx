// Real React/event regression; no provider, payment, or production requests.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";
import puppeteer from "puppeteer";

const entry = `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { FirstClipConvertPrompt } from './src/components/convert/first-clip-convert-prompt';
  import { FIRST_CLIP_COMPLETED_EVENT, FIRST_CLIP_VIEWED_EVENT, FIRST_CLIP_EXPORTED_VIEW_EVENT } from './src/lib/first-clip-convert-events';
  window.testState = { requests: 0, errors: [], mode: 'network' };
  window.addEventListener('unhandledrejection', event => {
    window.testState.errors.push(String(event.reason?.message || event.reason));
    event.preventDefault();
  });
  window.fetch = async input => {
    if (String(input) === '/api/user/me') return Response.json({ plan: 'PRO' });
    if (String(input) !== '/api/convert/first-clip') throw new Error('unexpected fixture request');
    window.testState.requests++;
    if (window.testState.mode === 'network') throw new TypeError(new URLSearchParams(location.search).get('network') || 'Load failed');
    if (window.testState.mode === 'typeerror') throw new TypeError('fixture application TypeError');
    if (window.testState.mode === 'application') throw new Error('fixture application failure');
    if (window.testState.mode === 'invalid-json') return new Response('{');
    if (window.testState.mode === 'http') return new Response('', { status: 503 });
    return Response.json({ show: true, monthlyPriceThb: 999, annualMonthlyThb: 833,
      founding: null, benefits: { storageDays: 30, minutesPerMonth: 60, monthlyCredits: 100 } });
  };
  window.trigger = kind => window.dispatchEvent(new Event({
    completed: FIRST_CLIP_COMPLETED_EVENT, viewed: FIRST_CLIP_VIEWED_EVENT,
    exported: FIRST_CLIP_EXPORTED_VIEW_EVENT,
  }[kind]));
  if (new URLSearchParams(location.search).has('armed')) sessionStorage.setItem('hero-first-clip-convert-armed', '1');
  createRoot(document.getElementById('root')).render(<FirstClipConvertPrompt />);
  // React effect installation settles before the test dispatches events.
  setTimeout(() => { window.ready = true; }, 100);
`;

type State = { requests: number; errors: string[]; mode: string };
type FixtureWindow = Window & { testState: State; trigger: (kind: string) => void; ready: boolean };

async function main() {
  const bundled = await build({
    stdin: { contents: entry, loader: 'tsx', resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'browser', format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'external-boundaries', setup(b) {
      b.onResolve({ filter: /^(next\/navigation|@clerk\/nextjs|@\/lib\/client-telemetry)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents:
        args.path === 'next/navigation' ? "export const usePathname = () => '/gallery';" :
        args.path === '@clerk/nextjs' ? 'export const getToken = async () => null;' :
        'export const trackEvent = () => {};', loader: 'js' }));
    } }],
  });
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html');
    res.end(req.url === '/bundle.js' ? bundled.outputFiles[0].text : '<div id="root"></div><script src="/bundle.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_BIN ||
    (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : puppeteer.executablePath()),
    args: ['--no-sandbox'] });
  try {
    for (const [trigger, message] of [
      ['viewed', 'Load failed'], ['completed', 'Failed to fetch'],
      ['exported', 'NetworkError when attempting to fetch resource.'], ['armed', 'Load failed'],
    ]) {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${address.port}/?network=${encodeURIComponent(message)}${trigger === 'armed' ? '&armed' : ''}`);
      await page.waitForFunction(() => (window as FixtureWindow).ready);
      if (trigger !== 'armed') await page.evaluate(kind => (window as FixtureWindow).trigger(kind), trigger);
      await page.waitForFunction(() => (window as FixtureWindow).testState.requests === 1);
      // unhandledrejection fires on the next task, after the rejected fetch settles.
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.deepEqual(await page.evaluate(() => (window as FixtureWindow).testState.errors), [], `${trigger}: network rejection must be handled`);
      assert.equal(await page.$('[role="dialog"]'), null, `${trigger}: failed lookup must not open prompt`);
      await page.evaluate(() => { (window as FixtureWindow).testState.mode = 'success'; (window as FixtureWindow).trigger('viewed'); });
      await page.waitForSelector('[role="dialog"]');
      assert.equal(await page.evaluate(() => (window as FixtureWindow).testState.requests), 2, `${trigger}: later event retries and recovers`);
      await page.close();
    }
    for (const mode of ['application', 'typeerror', 'invalid-json', 'http']) {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${address.port}/`);
      await page.waitForFunction(() => (window as FixtureWindow).ready);
      await page.evaluate(mode => { (window as FixtureWindow).testState.mode = mode; (window as FixtureWindow).trigger('viewed'); }, mode);
      await page.waitForFunction(() => (window as FixtureWindow).testState.requests === 1);
      await new Promise(resolve => setTimeout(resolve, 100));
      const errors = await page.evaluate(() => (window as FixtureWindow).testState.errors);
      if (mode === 'http') assert.deepEqual(errors, [], 'HTTP failure preserves existing quiet behavior');
      else assert.equal(errors.length, 1, `${mode}: actionable errors must stay observable`);
      assert.equal(await page.$('[role="dialog"]'), null);
      await page.evaluate(() => { (window as FixtureWindow).testState.mode = 'success'; (window as FixtureWindow).trigger('viewed'); });
      await page.waitForSelector('[role="dialog"]');
      await page.close();
    }
    console.log('verify-first-clip-convert-recovery: OK (4 real event/mount paths recover; application/JSON errors remain observable; HTTP failure recovers)');
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
void main();
