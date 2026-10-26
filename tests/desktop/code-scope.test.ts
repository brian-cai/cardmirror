// @vitest-environment node
/** code-scope.ts: which files main hands the renderer to run as code. */
import { describe, it, expect } from 'vitest';
import { codePathRefusal, type CodePathRules } from '../../apps/desktop/src/code-scope.js';

const mac: CodePathRules = {
  platform: 'darwin',
  files: ['/Users/ant/Library/Application Support/CardMirror/plugins/cardcutter.global.js', '/Users/ant/dev/engine.js'],
  dirs: ['/Users/ant/Library/Application Support/CardMirror/plugins'],
};
const win: CodePathRules = {
  platform: 'win32',
  files: ['C:\\Users\\ant\\AppData\\Roaming\\CardMirror\\plugins\\cardcutter.global.js'],
  dirs: ['C:\\Users\\ant\\AppData\\Roaming\\CardMirror\\plugins'],
};

describe('codePathRefusal', () => {
  it('allows the default engine, a picked file, and files under the plugins folder', () => {
    expect(codePathRefusal('/Users/ant/Library/Application Support/CardMirror/plugins/cardcutter.global.js', mac)).toBeNull();
    expect(codePathRefusal('/Users/ant/dev/engine.js', mac)).toBeNull();
    expect(codePathRefusal('/Users/ant/Library/Application Support/CardMirror/plugins/foo/main.js', mac)).toBeNull();
    expect(codePathRefusal('c:\\users\\ant\\appdata\\roaming\\cardmirror\\plugins\\cardcutter.global.js', win)).toBeNull();
  });

  it('refuses any other path', () => {
    expect(codePathRefusal('/Users/ant/Downloads/engine.js', mac)).not.toBeNull();
    expect(codePathRefusal('/tmp/x.js', mac)).not.toBeNull();
    expect(codePathRefusal('C:\\Users\\ant\\Downloads\\engine.js', win)).not.toBeNull();
    // `..` can't climb out of the plugins folder.
    expect(codePathRefusal('/Users/ant/Library/Application Support/CardMirror/plugins/../../evil.js', mac)).not.toBeNull();
    expect(codePathRefusal('/Users/ant/Library/Application Support/CardMirror/pluginsX/a.js', mac)).not.toBeNull();
  });

  it('refuses UNC and other network paths, even when "picked"', () => {
    const picked: CodePathRules = { ...win, files: ['\\\\attacker.example\\share\\engine.js', '//attacker.example/share/engine.js'] };
    expect(codePathRefusal('\\\\attacker.example\\share\\engine.js', picked)).toMatch(/network/);
    expect(codePathRefusal('//attacker.example/share/engine.js', picked)).toMatch(/network/);
    expect(codePathRefusal('\\\\?\\UNC\\attacker\\share\\engine.js', win)).toMatch(/network/);
    expect(codePathRefusal('//attacker.example/share/engine.js', { ...mac, files: ['//attacker.example/share/engine.js'] })).toMatch(/network/);
    // Windows: only paths on a drive letter.
    expect(codePathRefusal('\\Users\\ant\\x.js', win)).not.toBeNull();
  });

  it('refuses non-.js files, relative paths and junk', () => {
    expect(codePathRefusal('/Users/ant/Library/Application Support/CardMirror/plugins/x.txt', mac)).toMatch(/\.js/);
    expect(codePathRefusal('plugins/x.js', mac)).not.toBeNull();
    expect(codePathRefusal('', mac)).not.toBeNull();
    expect(codePathRefusal(null, mac)).not.toBeNull();
    expect(codePathRefusal(42, mac)).not.toBeNull();
  });
});
