import { defineConfig } from 'vite';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// The dev server (`npm run dev`) serves from `/`, and production builds
// default to `/` too. BCai's build ships only the desktop app (built with
// `--base=./`); the web edition and its offline (PWA) service worker were
// dropped 2026-10-07. Override with `VITE_BASE=/foo/` to deploy under a
// subpath.
//
// `@cardcutter/browser` resolves to the separately-versioned, NOT-
// shipped card-cutter package when it's checked out alongside this
// repo. The app imports it dev-only and dynamically (see
// card-cutter-port.ts, `@vite-ignore`d + try/caught), so when the
// sibling is absent the alias just never resolves — harmless.
const cardCutterEntry = path.resolve(__dirname, '../card-cutter/src/browser.ts');
const cardCutterStub = path.resolve(__dirname, 'src/editor/card-cutter-stub.ts');

export default defineConfig(({ command }) => {
  // The card-cutter engine is experimental and NOT shipped: a
  // production build always resolves `@cardcutter/browser` to the
  // in-repo no-op stub, even when the sibling package is checked out.
  // Only the dev server wires the real engine (when present).
  const cardCutterTarget =
    command === 'serve' && existsSync(cardCutterEntry) ? cardCutterEntry : cardCutterStub;

  // The installable-PWA layer (web app manifest + offline service worker) is
  // WEB-ONLY. The Electron renderer reuses THIS build with `--base=./` (see
  // apps/desktop `build:renderer`); a service worker there is unwanted and
  // misbehaves under file://, so detect that relative base and gate the plugin
  // off. PWA is also skipped for the dev server (`serve`) — it's a build-time,
  // production-only concern; test it with `npm run build && npm run preview`.
  const cliBase = (() => {
    const eq = process.argv.find((a) => a.startsWith('--base='));
    if (eq) return eq.slice('--base='.length);
    const i = process.argv.indexOf('--base');
    return i >= 0 ? process.argv[i + 1] : undefined;
  })();
  const isElectronRenderer = cliBase === './';
  // CardMirror Lite (VITE_LITE=1): the no-AI / no-internet build
  // variant (src/editor/lite.ts). The web deployment for it ships a
  // Content-Security-Policy that makes "no outbound requests" a
  // BROWSER-ENFORCED guarantee, emitted as a Cloudflare `_headers`
  // file beside the build.
  const isLite = process.env['VITE_LITE'] === '1';
  const liteHeadersPlugin = {
    name: 'cardmirror-lite-headers',
    closeBundle() {
      if (!isLite || command !== 'build') return;
      const outDir = path.resolve(__dirname, process.env['VITE_OUT_DIR'] ?? 'dist');
      // connect-src 'self': the app may load ITSELF (and the service
      // worker then serves it offline) — and nothing else, ever.
      // 'wasm-unsafe-eval' stays off: Lite ships no wasm consumers.
      const csp = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "worker-src 'self' blob:",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'self'",
      ].join('; ');
      writeFileSync(path.join(outDir, '_headers'), `/*
  Content-Security-Policy: ${csp}
`);
    },
  };

  return {
    base: process.env['VITE_BASE'] ?? '/',
    resolve: {
      // Array form: Lite swaps the endpoint modules by SPECIFIER regex
      // (string keys match specifiers, and these are imported
      // relatively — './llm-endpoints.js' — so path keys never hit).
      alias: [
        { find: '@cardcutter/browser', replacement: cardCutterTarget },
        ...(isLite
          ? [
              {
                find: /^.*\/llm-endpoints\.js$/,
                replacement: path.resolve(__dirname, 'src/editor/ai/llm-endpoints-lite.ts'),
              },
              {
                find: /^.*\/relay-endpoint\.js$/,
                replacement: path.resolve(__dirname, 'src/editor/collab/relay-endpoint-lite.ts'),
              },
            ]
          : []),
      ],
    },
    plugins: [
      liteHeadersPlugin,
      // Dev-only: loro-crdt's loader statically imports its .wasm as an
      // ES module, which the dev server rejects ("ESM integration
      // proposal for Wasm" unsupported). The PRODUCTION build already
      // resolves that import to a URL-exporting asset module, and the
      // loader's normalizer handles the {default: url} shape by
      // fetch+instantiate — so dev resolves the same import to `?url`.
      ...(command === 'serve'
        ? [
            {
              name: 'cardmirror:loro-wasm-url-dev',
              enforce: 'pre' as const,
              resolveId(source: string) {
                if (source.endsWith('loro_wasm_bg.wasm')) {
                  return (
                    path.resolve(__dirname, 'node_modules/loro-crdt/bundler/loro_wasm_bg.wasm') +
                    '?url'
                  );
                }
                return null;
              },
            },
          ]
        : []),
    ],
    server: {
      fs: { allow: [path.resolve(__dirname), path.resolve(__dirname, '../card-cutter')] },
      // Pre-transform the collab chain (and the loro wasm loader
      // behind it) on dev-server start. Without this, the renderer's
      // pairing catch-up poll dynamically imports collab-ui seconds
      // after launch and can race a COLD vite's transform pipeline —
      // one .wasm request slipped through untransformed (served
      // application/wasm, rejected by strict module-script MIME
      // checking), and Chromium caches failed module fetches,
      // poisoning every later import('collab-ui') until reload.
      warmup: {
        clientFiles: ['./src/editor/collab/collab-ui.ts'],
      },
    },
    // Second HTML entry: the floating always-on-top timer window
    // (desktop pop-out; timer.html → timer-popout.ts). Tiny by
    // construction — it pulls the timer UI + settings, never the
    // editor. Also lands in the web build as a harmless dead-end
    // page nothing links to.
    build: {
      // Lite builds land beside the normal dist (VITE_OUT_DIR=dist-lite)
      // so the two variants never clobber each other.
      ...(process.env['VITE_OUT_DIR'] ? { outDir: process.env['VITE_OUT_DIR'] } : {}),
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
          timer: path.resolve(__dirname, 'timer.html'),
        },
      },
    },
    // loro-crdt's wasm loader uses top-level await, which the dev-time
    // dependency pre-bundler (esbuild, pre-es2022 targets) rejects.
    // Excluding the pair serves them as native ESM in dev — modern dev
    // browsers handle TLA fine, and production goes through rollup,
    // which already builds them (into their own lazy chunks).
    optimizeDeps: { exclude: ['loro-crdt', 'loro-prosemirror'] },
  };
});
