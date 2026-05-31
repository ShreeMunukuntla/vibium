/**
 * Packaging Tests: the published npm tarball must contain the built dist/.
 * dist/ is generated and git-ignored; publishing without it shipped an empty
 * package and broke require('vibium')/'vibium/sync' and the TypeScript types
 * (#103, #127, #100). `npm pack` runs the prepack hook which rebuilds dist.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PKG_DIR = path.join(__dirname, '../../packages/vibium');

describe('Packaging: npm tarball contents', () => {
  test('npm pack includes the built dist files (#103/#127/#100)', () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'vibium-pack-'));
    // `npm pack --json` writes machine-readable output to stdout; the prepack
    // build logs go to stderr (see scripts/prepack.mjs).
    const out = execFileSync('npm', ['pack', '--json', '--pack-destination', dest], {
      cwd: PKG_DIR,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    try {
      const files = JSON.parse(out)[0].files.map((f) => f.path);
      const required = [
        'dist/index.js', 'dist/index.mjs', 'dist/index.d.ts',
        'dist/sync.js', 'dist/sync.mjs', 'dist/sync.d.ts',
        'dist/worker.js',
      ];
      for (const f of required) {
        assert.ok(files.includes(f), `published tarball must include ${f}; got: ${files.join(', ')}`);
      }
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
});
