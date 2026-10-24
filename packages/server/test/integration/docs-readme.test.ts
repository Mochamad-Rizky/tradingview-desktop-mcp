import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CLIENT_IDS } from '../../src/cli/clients.js';
import { brokenLinks, linksOf } from '../helpers/markdown-links.js';

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
