// Headless page driver for the dev lab and app pages.
//   node tests/shoot.mjs "/dev/lab.html?sheet=matrix;size=300" [--browser chromium|firefox|webkit] [--timeout 120000]
//        [--throttle 4]   (Chromium only: CDP CPU throttling, 4 = a mid-range phone)
// Waits for window.__done, prints it plus any console errors. Requires the dev server (port 8860).
// Git Bash rewrites a leading-slash argument into "C:/Program Files/Git/dev/..."; that prefix is
// undone below, so MSYS_NO_PATHCONV=1 is not needed.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const { chromium, firefox, webkit } = require(PW);

const args = process.argv.slice(2);
// Use ';' between query params on the command line (Windows shims can swallow '&').
const unmsys = a => a.replace(/^[A-Za-z]:[\\/].*?[\\/]Git[\\/](?=[a-z])/i, '/');
const path = (args.map(unmsys).find(a => a.startsWith('/')) || '/dev/lab.html').replace(/;/g, '&');
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const browserName = opt('browser', 'chromium');
const timeout = +opt('timeout', 180000);
const port = +opt('port', 8860);

const launchers = { chromium, firefox, webkit };
const launchOpts = browserName === 'chromium'
  ? { headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'] }
  : { headless: true };
const browser = await launchers[browserName].launch(launchOpts);
const page = await browser.newPage({ viewport: { width: +opt('w', 1400), height: +opt('h', 900) }, deviceScaleFactor: +opt('dpr', 1) });
const throttle = +opt('throttle', 0);
if (throttle > 1) {
  if (browserName !== 'chromium') throw new Error('--throttle needs --browser chromium (CDP)');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
}
const errors = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
const t0 = Date.now();
await page.goto(`http://localhost:${port}${path}`);
let done = null;
try {
  await page.waitForFunction(() => window.__done, null, { timeout, polling: 250 });
  done = await page.evaluate(() => window.__done);
} catch (e) {
  done = { ok: false, error: 'timeout: ' + e.message };
}
const renderer = await page.evaluate(() => {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
  } catch { return 'no webgl2'; }
});
console.log(JSON.stringify({ browser: browserName, throttle: throttle || 1, path, gpu: renderer, secs: (Date.now() - t0) / 1000, done }, null, 1));
if (errors.length) console.log('console:\n' + errors.slice(0, 40).join('\n'));
await browser.close();
process.exit(done && done.ok ? 0 : 1);
