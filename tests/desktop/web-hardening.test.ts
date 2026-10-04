// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import { isAppUrl, isExternalOpenable, permissionAllowed } from '../../apps/desktop/src/web-hardening.js';

const rendererDir = path.resolve('/Applications/CardMirror.app/Contents/Resources/renderer');
const packaged = { devServerUrl: null, rendererDir };
const dev = { devServerUrl: 'http://localhost:5173', rendererDir };
const page = (f: string) => pathToFileURL(path.join(rendererDir, f)).href;

describe('isAppUrl', () => {
  it('accepts the packaged renderer pages and nothing else on disk', () => {
    expect(isAppUrl(page('index.html'), packaged)).toBe(true);
    expect(isAppUrl(page('timer.html') + '#x', packaged)).toBe(true);
    expect(isAppUrl(pathToFileURL('/etc/passwd').href, packaged)).toBe(false);
    expect(isAppUrl(pathToFileURL(rendererDir + '-evil/index.html').href, packaged)).toBe(false);
    expect(isAppUrl(page('../app.asar/x.js'), packaged)).toBe(false);
  });

  it('accepts the dev server only in a dev run', () => {
    expect(isAppUrl('http://localhost:5173/', dev)).toBe(true);
    expect(isAppUrl('http://localhost:5173/', packaged)).toBe(false);
    expect(isAppUrl('http://localhost:5174/', dev)).toBe(false);
    expect(isAppUrl('https://evil.example/', dev)).toBe(false);
    expect(isAppUrl('not a url', dev)).toBe(false);
  });
});

describe('external links', () => {
  it('only http(s) and mailto leave the app', () => {
    expect(isExternalOpenable('https://github.com')).toBe(true);
    expect(isExternalOpenable('mailto:a@b.c')).toBe(true);
    expect(isExternalOpenable('file:///etc/passwd')).toBe(false);
    expect(isExternalOpenable('javascript:alert(1)')).toBe(false);
  });
});

describe('permissionAllowed', () => {
  it('grants only the app’s own pages the permissions it uses', () => {
    expect(permissionAllowed('media', page('index.html'), packaged, ['audio'])).toBe(true);
    expect(permissionAllowed('media', page('index.html'), packaged, ['video'])).toBe(false);
    expect(permissionAllowed('clipboard-read', page('index.html'), packaged)).toBe(true);
    expect(permissionAllowed('geolocation', page('index.html'), packaged)).toBe(false);
    expect(permissionAllowed('media', 'https://evil.example/', packaged, ['audio'])).toBe(false);
  });
});
