/*
 * Layout check (CI): open every dialog scenario from dev/layout-harness at a
 * few window sizes in a real Chromium (the Electron the desktop app already
 * installs) and fail when a dialog leaves the window, hides a button, can't
 * scroll to its content, or spills sideways. Saves a screenshot per
 * scenario and size for a human look.
 *
 * Run with the repo's Electron against a running vite dev server:
 *   npx vite --port 5199 --strictPort &
 *   apps/desktop/node_modules/.bin/electron scripts/layout-check.cjs \
 *     --url http://localhost:5199/dev/layout-harness/ --out layout-shots [--only join]
 *
 * Exits 1 on any violation, 2 when the harness itself breaks.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const URL = arg('url', 'http://localhost:5199/dev/layout-harness/');
const OUT = path.resolve(arg('out', 'layout-shots'));
const ONLY = arg('only', '');
/** A normal laptop window, and a short, narrow one (split screen, small laptop). */
const SIZES = [
  { name: 'laptop', width: 1280, height: 800 },
  { name: 'small', width: 820, height: 560 },
];

// Its own profile: never touch the app's settings or the user's.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'cm-layout-')));
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(win, expr, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await win.webContents.executeJavaScript(expr).catch(() => false)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${expr}`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ show: false, width: 1280, height: 800, useContentSize: true, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' && !e.message.includes('ResizeObserver loop')) console.error(`[page] ${e.message}`);
  });
  let failures = 0;
  const report = [];
  for (const size of SIZES) {
    win.setContentSize(size.width, size.height);
    await win.loadURL(URL);
    await waitFor(win, `document.body.dataset.ready === '1'`, 180000); // first load compiles the app
    const scenarios = (await win.webContents.executeJavaScript('window.__layout.scenarios')).filter((s) => !ONLY || s.includes(ONLY));
    for (const name of scenarios) {
      let result;
      try {
        result = await win.webContents.executeJavaScript(`window.__layout.run(${JSON.stringify(name)})`);
      } catch (err) {
        console.error(`✗ ${size.name} ${name}: harness error: ${err.message}`);
        process.exitCode = 2;
        continue;
      }
      const shot = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, `${name}--${size.name}.png`), shot.toPNG());
      report.push({ size: size.name, name, ...result });
      if (result.violations.length) {
        failures += result.violations.length;
        console.error(`✗ ${size.name} ${name} (${result.dialogs.join(', ')})`);
        for (const v of result.violations) console.error(`    ${v.rule}: ${v.element}: ${v.detail}`);
      } else {
        console.log(`✓ ${size.name} ${name}`);
      }
    }
    // Each scenario listed for a dialog in coverage.ts must really open it.
    if (!ONLY) {
      const covered = await win.webContents.executeJavaScript('window.__layout.covered');
      for (const [cls, names] of Object.entries(covered)) {
        for (const n of names) {
          const r = report.find((x) => x.size === size.name && x.name === n);
          if (r && !r.dialogs.some((d) => d.split(' ').includes(cls))) {
            console.error(`✗ ${size.name} ${n}: coverage.ts says it opens .${cls}, but it opened ${r.dialogs.join(', ') || 'nothing'}`);
            process.exitCode = 2;
          }
        }
      }
    }
    const left = await win.webContents.executeJavaScript('window.__layout.closeAll()');
    if (left) {
      console.error(`✗ ${size.name}: ${left} dialog(s) would not close`);
      process.exitCode = 2;
    }
  }
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n${report.length} checks, ${failures} problem(s). Screenshots: ${OUT}`);
  if (failures && !process.exitCode) process.exitCode = 1;
}

app.whenReady().then(main).catch((err) => {
  console.error(err);
  process.exitCode = 2;
}).finally(() => app.exit(process.exitCode ?? 0));
