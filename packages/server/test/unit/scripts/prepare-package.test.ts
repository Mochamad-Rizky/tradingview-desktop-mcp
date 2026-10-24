import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rewriteReadmeLinks } from '../../../scripts/prepare-package.mjs';

// The prepack step of the server package: it puts the README, the LICENSE and the CHANGELOG of the
// repository into the package, with the links of the README made absolute, because npm shows the
// README outside the repository, where a relative link leads nowhere.

const SCRIPT = fileURLToPath(new URL('../../../scripts/prepare-package.mjs', import.meta.url));
const ROOT_README = fileURLToPath(new URL('../../../../../README.md', import.meta.url));
const BLOB = 'https://github.com/Mochamad-Rizky/tradingview-mcp/blob/main/';
const RAW = 'https://raw.githubusercontent.com/Mochamad-Rizky/tradingview-mcp/main/';

test('rewriteReadmeLinks makes relative links and images absolute and leaves absolute ones alone', () => {
  const readme = [
    '# Title',
    '',
    '[![CI](https://github.com/o/r/actions/workflows/ci.yml/badge.svg)](https://github.com/o/r/actions)',
    '[![Logo](docs/images/logo.png)](docs/index.md)',
    '',
    'See the [tool reference](docs/tools.md), [SECURITY.md](SECURITY.md#the-dashboard), the',
    '[testing guide](./docs/testing.md?plain=1#smoke-test), [contributing](/CONTRIBUTING.md), a',
    '[link with a title](LICENSE "The license"), a [spaced](<docs/my file.md>) one, a',
    '[parenthesised](docs/a_(b).md) one and a [link that spans',
    'two lines](docs/examples.md#1-read-the-chart).',
    '',
    '![The status page](docs/images/dashboard-status.png)',
    "![A titled image](./docs/images/log.png 'The log')",
    '',
    'Left alone: [Dashboard](#dashboard), [MCP](https://modelcontextprotocol.io),',
    '[plain http](http://example.com/a.md), [mail](mailto:someone@example.com), a',
    '[protocol-relative](//example.com/x.png) one, an escaped \\[bracket](docs/x.md) and an',
    '[empty]() one.',
    '',
    '<p align="center"><img src="docs/images/logo.png" alt="Logo" width="120"></p>',
    '<IMG SRC=\'./docs/images/b.png\'> <a href="LICENSE">MIT</a> <a href="https://example.com">x</a>',
    '<a href="#top">top</a> <abbr title="docs/x.md">x</abbr>',
    '',
    'A [reference link][tools], a ![reference image][shot] and a [collapsed][] one.',
    '',
    '[tools]: docs/tools.md',
    '[shot]: ./docs/images/shot.png "A shot"',
    '[collapsed]: <docs/clients/cursor.md>',
    '[npm]: https://www.npmjs.com/package/tradingview-desktop-mcp',
  ].join('\n');

  expect(rewriteReadmeLinks(readme)).toBe(
    [
      '# Title',
      '',
      '[![CI](https://github.com/o/r/actions/workflows/ci.yml/badge.svg)](https://github.com/o/r/actions)',
      `[![Logo](${RAW}docs/images/logo.png)](${BLOB}docs/index.md)`,
      '',
      `See the [tool reference](${BLOB}docs/tools.md), [SECURITY.md](${BLOB}SECURITY.md#the-dashboard), the`,
      `[testing guide](${BLOB}docs/testing.md?plain=1#smoke-test), [contributing](${BLOB}CONTRIBUTING.md), a`,
      `[link with a title](${BLOB}LICENSE "The license"), a [spaced](<${BLOB}docs/my file.md>) one, a`,
      `[parenthesised](${BLOB}docs/a_(b).md) one and a [link that spans`,
      `two lines](${BLOB}docs/examples.md#1-read-the-chart).`,
      '',
      `![The status page](${RAW}docs/images/dashboard-status.png)`,
      `![A titled image](${RAW}docs/images/log.png 'The log')`,
      '',
      'Left alone: [Dashboard](#dashboard), [MCP](https://modelcontextprotocol.io),',
      '[plain http](http://example.com/a.md), [mail](mailto:someone@example.com), a',
      '[protocol-relative](//example.com/x.png) one, an escaped \\[bracket](docs/x.md) and an',
      '[empty]() one.',
      '',
      `<p align="center"><img src="${RAW}docs/images/logo.png" alt="Logo" width="120"></p>`,
      `<IMG SRC='${RAW}docs/images/b.png'> <a href="${BLOB}LICENSE">MIT</a> <a href="https://example.com">x</a>`,
      '<a href="#top">top</a> <abbr title="docs/x.md">x</abbr>',
      '',
      'A [reference link][tools], a ![reference image][shot] and a [collapsed][] one.',
      '',
      `[tools]: ${BLOB}docs/tools.md`,
      `[shot]: ${RAW}docs/images/shot.png "A shot"`,
      `[collapsed]: <${BLOB}docs/clients/cursor.md>`,
      '[npm]: https://www.npmjs.com/package/tradingview-desktop-mcp',
    ].join('\n'),
  );
  // An absolute link stays as it is, so a second pass changes nothing.
  expect(rewriteReadmeLinks(rewriteReadmeLinks(readme))).toBe(rewriteReadmeLinks(readme));
});

test('rewriteReadmeLinks leaves code spans and fenced code blocks alone', () => {
  const readme = [
    'Run `[x](docs/x.md)` or ``a `[y](docs/y.md)` b`` and read [the guide](docs/testing.md).',
    'An unmatched ` backtick keeps [this link](docs/a.md) a link.',
    '',
    '```md',
    '[x](docs/x.md) ![y](docs/y.png) <img src="docs/z.png">',
    '```',
    '',
    '  ~~~~',
    '  [inside](docs/inside.md)',
    '  ```',
    '  [still inside](docs/inside.md)',
    '  ~~~~',
    '',
    '[after](docs/after.md)',
  ].join('\n');

  expect(rewriteReadmeLinks(readme)).toBe(
    [
      `Run \`[x](docs/x.md)\` or \`\`a \`[y](docs/y.md)\` b\`\` and read [the guide](${BLOB}docs/testing.md).`,
      `An unmatched \` backtick keeps [this link](${BLOB}docs/a.md) a link.`,
      '',
      '```md',
      '[x](docs/x.md) ![y](docs/y.png) <img src="docs/z.png">',
      '```',
      '',
      '  ~~~~',
      '  [inside](docs/inside.md)',
      '  ```',
      '  [still inside](docs/inside.md)',
      '  ~~~~',
      '',
      `[after](${BLOB}docs/after.md)`,
    ].join('\n'),
  );
  // Blocks at the very start and next to each other keep every line, and no more.
  const fences = '```\n[a](docs/a.md)\n```\n~~~\n[b](docs/b.md)\n~~~\n';
  expect(rewriteReadmeLinks(fences)).toBe(fences);
});

test('rewriteReadmeLinks rewrites only valid reference definitions', () => {
  const readme = [
    '[Note]: this is important',
    '[Tip]: docs/tips.md and more',
    '[unclosed title]: docs/u.md "A title',
    '[text after the title]: docs/x.md "A title" and more',
    '    [indented]: docs/code.md',
    '[plain]: docs/plain.md',
    '[double]: docs/double.md "A title"',
    "[single]: ./docs/single.md 'A title'",
    '[parenthesised]: docs/paren.md (A title)',
    '[angle]: <docs/a b.md> "A title"',
    '[spaces]:   docs/spaces.md   ',
  ].join('\n');

  expect(rewriteReadmeLinks(readme)).toBe(
    [
      '[Note]: this is important',
      '[Tip]: docs/tips.md and more',
      '[unclosed title]: docs/u.md "A title',
      '[text after the title]: docs/x.md "A title" and more',
      '    [indented]: docs/code.md',
      `[plain]: ${BLOB}docs/plain.md`,
      `[double]: ${BLOB}docs/double.md "A title"`,
      `[single]: ${BLOB}docs/single.md 'A title'`,
      `[parenthesised]: ${BLOB}docs/paren.md (A title)`,
      `[angle]: <${BLOB}docs/a b.md> "A title"`,
      `[spaces]:   ${BLOB}docs/spaces.md   `,
    ].join('\n'),
  );
});

test('rewriteReadmeLinks rewrites every URL of srcset in img and source tags', () => {
  const readme = [
    '<picture>',
    '  <source media="(prefers-color-scheme: dark)" srcset="docs/dark.png 1x, ./docs/dark@2x.png 2x">',
    '  <img src="docs/light.png" srcset="docs/light.png 480w,docs/big.png 960w, https://example.com/x.png 1440w" alt="Logo">',
    '</picture>',
    '<img srcset="data:image/png;base64,AAAA,BBBB 1x, docs/b.png 2x">',
    '<SOURCE SRCSET=\'docs/c.webp\'> <source src="docs/demo.mp4" type="video/mp4">',
    '<div srcset="docs/not-an-image.png"></div> <a srcset="docs/a.png" href="docs/a.md">a</a>',
  ].join('\n');

  expect(rewriteReadmeLinks(readme)).toBe(
    [
      '<picture>',
      `  <source media="(prefers-color-scheme: dark)" srcset="${RAW}docs/dark.png 1x, ${RAW}docs/dark@2x.png 2x">`,
      `  <img src="${RAW}docs/light.png" srcset="${RAW}docs/light.png 480w,${RAW}docs/big.png 960w, https://example.com/x.png 1440w" alt="Logo">`,
      '</picture>',
      `<img srcset="data:image/png;base64,AAAA,BBBB 1x, ${RAW}docs/b.png 2x">`,
      `<SOURCE SRCSET='${RAW}docs/c.webp'> <source src="${RAW}docs/demo.mp4" type="video/mp4">`,
      `<div srcset="docs/not-an-image.png"></div> <a srcset="docs/a.png" href="${BLOB}docs/a.md">a</a>`,
    ].join('\n'),
  );
});

test('rewriteReadmeLinks leaves no relative link in the README of the repository', () => {
  const rewritten = rewriteReadmeLinks(readFileSync(ROOT_README, 'utf8'));
  // Outside code, every link, image, reference definition and HTML attribute that names a target
  // names an absolute one.
  const prose = rewritten.replace(/^ *(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ *\1[^\n]*$/gm, '');
  expect(prose).not.toMatch(/\]\(\s*<?(?!https?:|mailto:|#)[^)\s]/);
  expect(prose).not.toMatch(
    /^ {0,3}\[[^\]]+\]:[ \t]*<?(?!https?:|mailto:|#)[^\s>]+>?(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*$/m,
  );
  expect(prose).not.toMatch(/\b(?:src|srcset|href)\s*=\s*["']?(?!https?:|mailto:|#)[^"'\s>]/i);
  // Every candidate of a srcset, not only the first.
  for (const [, srcset = ''] of prose.matchAll(/\bsrcset\s*=\s*["']([^"']*)["']/gi)) {
    for (const candidate of srcset.split(/,\s+/)) {
      expect(candidate).toMatch(/^\s*(?:https?:|data:)/);
    }
  }
  expect(rewritten).toContain(`](${RAW}docs/images/dashboard-status.png)`);
});

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tv-mcp-prepare-package-'));
  mkdirSync(join(root, 'packages', 'server', 'scripts'), { recursive: true });
  copyFileSync(SCRIPT, join(root, 'packages', 'server', 'scripts', 'prepare-package.mjs'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

// From the root of the made-up repository: the script finds the files from its own place, whatever
// directory it runs from.
function preparePackage() {
  return spawnSync(
    process.execPath,
    [join(root, 'packages', 'server', 'scripts', 'prepare-package.mjs')],
    { cwd: root, encoding: 'utf8' },
  );
}

test('prepare-package writes README, LICENSE and CHANGELOG into the package', () => {
  const readme =
    '# Synthetic\n\nSee [the tools](docs/tools.md).\n\n![Shot](docs/images/shot.png)\n';
  const license = 'MIT License\n\nCopyright (c) 2026 Example\n';
  const changelog = '# Changelog\n\n## [0.1.0] - Unreleased\n\n### Added\n\n- Everything.\n';
  write('README.md', readme);
  write('LICENSE', license);

  // Without a CHANGELOG nothing is written, and the message names what is missing.
  const missing = preparePackage();
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain('CHANGELOG.md');
  expect(existsSync(join(root, 'packages', 'server', 'README.md'))).toBe(false);
  expect(existsSync(join(root, 'packages', 'server', 'LICENSE'))).toBe(false);

  write('CHANGELOG.md', changelog);
  // Left by an earlier pack: each run writes the three files again.
  write('packages/server/README.md', 'stale\n');
  write('packages/server/CHANGELOG.md', 'stale\n');
  const prepared = preparePackage();
  expect(prepared.status).toBe(0);
  expect(prepared.stderr).toBe('');
  expect(read('packages/server/README.md')).toBe(
    `# Synthetic\n\nSee [the tools](${BLOB}docs/tools.md).\n\n![Shot](${RAW}docs/images/shot.png)\n`,
  );
  expect(read('packages/server/LICENSE')).toBe(license);
  expect(read('packages/server/CHANGELOG.md')).toBe(changelog);
  // The sources stay as they were.
  expect(read('README.md')).toBe(readme);
});
