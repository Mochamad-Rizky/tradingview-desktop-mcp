import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_IDS } from '../../src/cli/clients.js';
import {
  brokenLinks,
  explicitAnchors,
  headingAnchors,
  linksOf,
} from '../helpers/markdown-links.js';

// The README is the first page a user reads. These tests fail when it stops pointing at the
// tutorials, the troubleshooting guide and the tool reference, when its commands stop naming the
// published package, and when a link or an anchor of it leads nowhere.

const README_PATH = fileURLToPath(new URL('../../../../README.md', import.meta.url));
const readme = readFileSync(README_PATH, 'utf8').replaceAll('\r\n', '\n');

describe('README.md', () => {
  test('the README links every client tutorial, the troubleshooting guide and the tool reference', () => {
    const links = linksOf(README_PATH);
    for (const client of CLIENT_IDS) {
      expect(links, client).toContain(`docs/clients/${client}.md`);
    }
    expect(links).toContain('docs/troubleshooting.md');
    expect(links).toContain('docs/tools.md');
    expect(links).toContain('SECURITY.md#tunnels-and-remote-clients');
  });

  test('the README install and config commands name the published package', () => {
    expect(readme).toContain('npx -y tradingview-desktop-mcp launch');
    expect(readme).toContain('npx -y tradingview-desktop-mcp doctor');
    for (const client of CLIENT_IDS) {
      expect(readme, client).toContain(`npx -y tradingview-desktop-mcp config ${client}`);
    }
    expect(readme).toMatch(/Node\.js 20\.19 or newer/);
    expect(readme).toContain('config <client> --local');
  });

  test('every relative link and anchor of the README resolves', () => {
    expect(brokenLinks(README_PATH)).toEqual([]);
  });
});

// The translations of the README live in docs/i18n, one per language, and each keeps the English
// anchors on its translated headings, so that a fragment such as #install works in every language.
const I18N_DIR = fileURLToPath(new URL('../../../../docs/i18n/', import.meta.url));
const translations = readdirSync(I18N_DIR)
  .filter((name) => /^README\.[A-Za-z-]+\.md$/.test(name))
  .sort();
const englishAnchors = headingAnchors(README_PATH).slice(1);

describe('the translations of the README', () => {
  test('there are translations, and the README links each of them', () => {
    expect(translations.length).toBeGreaterThan(0);
    const links = linksOf(README_PATH);
    for (const name of translations) {
      expect(links, name).toContain(`docs/i18n/${name}`);
    }
  });

  test.each(translations)('%s links the English README and every other translation', (name) => {
    const links = linksOf(join(I18N_DIR, name));
    expect(links).toContain('../../README.md');
    for (const other of translations.filter((each) => each !== name)) {
      expect(links, other).toContain(other);
    }
  });

  test.each(translations)('%s keeps the English anchors of the headings', (name) => {
    expect(explicitAnchors(join(I18N_DIR, name))).toEqual(englishAnchors);
  });

  test.each(translations)('%s keeps the commands of the README', (name) => {
    const text = readFileSync(join(I18N_DIR, name), 'utf8');
    expect(text).toContain('npx -y tradingview-desktop-mcp launch');
    expect(text).toContain('npx -y tradingview-desktop-mcp doctor');
    for (const client of CLIENT_IDS) {
      expect(text, client).toContain(`npx -y tradingview-desktop-mcp config ${client}`);
    }
  });

  test.each(translations)('every relative link and anchor of %s resolves', (name) => {
    expect(brokenLinks(join(I18N_DIR, name))).toEqual([]);
  });
});
