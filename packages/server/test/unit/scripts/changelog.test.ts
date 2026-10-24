import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../../../package.json' with { type: 'json' };
import { changelogSection } from '../../../scripts/changelog.mjs';

// The release workflow publishes a version only once the CHANGELOG has a dated section for it, and
// the notes of the GitHub release are that section.

const SCRIPT = fileURLToPath(new URL('../../../scripts/changelog.mjs', import.meta.url));
const ROOT_CHANGELOG = fileURLToPath(new URL('../../../../../CHANGELOG.md', import.meta.url));

const CHANGELOG = [
  '# Changelog',
  '',
  'All notable changes to this project are documented in this file.',
  '',
  '## [0.2.0] - Unreleased',
  '',
  '### Added',
  '',
  '- Something new.',
  '',
  '## [0.1.10] - 2026-11-02',
  '',
  '### Fixed',
  '',
  '- A fix in 0.1.10.',
  '',
  '## [0.1.1] - 2026-10-30',
  '',
  'A note before the groups.',
  '',
  '### Fixed',
  '',
  '- The [launcher](docs/launch.md) waits longer.',
  '',
  '## [0.1.0] - 2026-02-30',
  '',
  '### Added',
  '',
  '- The first tools.',
  '',
  '[0.2.0]: https://github.com/o/r/compare/v0.1.10...HEAD',
  '[0.1.10]: https://github.com/o/r/compare/v0.1.1...v0.1.10',
  '[0.1.1]: https://github.com/o/r/compare/v0.1.0...v0.1.1',
  '[0.1.0]: https://github.com/o/r/releases/tag/v0.1.0',
  '',
].join('\n');

test('changelogSection returns the date and the notes of a version, or null without a section', () => {
  expect(changelogSection(CHANGELOG, '0.1.1')).toEqual({
    date: '2026-10-30',
    body: 'A note before the groups.\n\n### Fixed\n\n- The [launcher](docs/launch.md) waits longer.',
  });
  // 0.1.1 is not a prefix match for 0.1.10, nor the other way round.
  expect(changelogSection(CHANGELOG, '0.1.10')).toEqual({
    date: '2026-11-02',
    body: '### Fixed\n\n- A fix in 0.1.10.',
  });
  // Not dated yet, or dated with a day that does not exist: no date. The link references at the
  // end of the file belong to no section.
  expect(changelogSection(CHANGELOG, '0.2.0')).toEqual({
    date: null,
    body: '### Added\n\n- Something new.',
  });
  expect(changelogSection(CHANGELOG, '0.1.0')).toEqual({
    date: null,
    body: '### Added\n\n- The first tools.',
  });
  expect(changelogSection(CHANGELOG, '0.1')).toBeNull();
  expect(changelogSection(CHANGELOG, '1.0.0')).toBeNull();
  // A dot in the version is a dot, not any character.
  expect(changelogSection(CHANGELOG.replace('[0.1.1]', '[0x1y1]'), '0.1.1')).toBeNull();
  // Windows line endings read the same.
  expect(changelogSection(CHANGELOG.replaceAll('\n', '\r\n'), '0.1.1')).toEqual(
    changelogSection(CHANGELOG, '0.1.1'),
  );
});

test('changelogSection ignores headings inside fenced code blocks', () => {
  const markdown = [
    '# Changelog',
    '',
    '## [0.2.0] - 2026-11-10',
    '',
    'The new heading looks like this:',
    '',
    '```md',
    '## [0.1.0] - 2026-01-01',
    '```',
    '',
    '~~~~',
    '## Not a heading',
    '```',
    '## Still not a heading',
    '~~~~',
    '',
    '- After the code.',
    '',
    '## [0.1.0] - 2026-10-30',
    '',
    '- The real one.',
    '',
  ].join('\n');

  expect(changelogSection(markdown, '0.2.0')).toEqual({
    date: '2026-11-10',
    body: [
      'The new heading looks like this:',
      '',
      '```md',
      '## [0.1.0] - 2026-01-01',
      '```',
      '',
      '~~~~',
      '## Not a heading',
      '```',
      '## Still not a heading',
      '~~~~',
      '',
      '- After the code.',
    ].join('\n'),
  });
  expect(changelogSection(markdown, '0.1.0')).toEqual({
    date: '2026-10-30',
    body: '- The real one.',
  });
});

test('the CHANGELOG of the repository has a section for the version of the package', () => {
  const section = changelogSection(readFileSync(ROOT_CHANGELOG, 'utf8'), pkg.version);
  expect(section).not.toBeNull();
  expect(section?.body).toContain('### Added');
});

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tv-mcp-changelog-'));
  writeFileSync(join(dir, 'CHANGELOG.md'), CHANGELOG);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function changelog(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
}

test('the changelog script prints the notes of a dated version and refuses any other', () => {
  const dated = changelog('0.1.1', join(dir, 'CHANGELOG.md'));
  expect(dated.status).toBe(0);
  expect(dated.stdout).toBe(
    'A note before the groups.\n\n### Fixed\n\n- The [launcher](docs/launch.md) waits longer.\n',
  );
  expect(dated.stderr).toBe('');

  const undated = changelog('0.2.0', join(dir, 'CHANGELOG.md'));
  expect(undated.status).toBe(1);
  expect(undated.stdout).toBe('');
  expect(undated.stderr).toContain('"## [0.2.0] - YYYY-MM-DD"');

  const missing = changelog('1.0.0', join(dir, 'CHANGELOG.md'));
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain('no "## [1.0.0]" section');

  const usage = changelog();
  expect(usage.status).toBe(1);
  expect(usage.stderr).toContain('usage: node scripts/changelog.mjs <version> [<CHANGELOG.md>]');

  const noFile = changelog('0.1.1', join(dir, 'missing.md'));
  expect(noFile.status).toBe(1);
  expect(noFile.stderr).toContain('missing.md');

  // A release says what changed.
  writeFileSync(
    join(dir, 'empty.md'),
    CHANGELOG.replace('## [0.2.0]', '## [0.3.0] - 2026-12-01\n\n## [0.2.0]'),
  );
  const empty = changelog('0.3.0', join(dir, 'empty.md'));
  expect(empty.status).toBe(1);
  expect(empty.stderr).toContain('the 0.3.0 section of');
  expect(empty.stderr).toContain('has no notes');
});
