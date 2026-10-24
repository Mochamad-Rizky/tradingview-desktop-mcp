import { readdirSync, readFileSync } from 'node:fs';
import {
  clientDocPath,
  markdownNote,
  renderConfigBlock,
  syncClientDoc,
  TROUBLESHOOTING_PATH,
  type BlockPlatform,
} from '../../scripts/docs/clients.js';
import { CLIENT_IDS, renderClientConfig } from '../../src/cli/clients.js';
import { renderHelp } from '../../src/cli/output.js';
import { ERROR_CODES } from '../../src/core/errors.js';
import { brokenLinks, linksOf } from '../helpers/markdown-links.js';

// The tutorials in docs/clients/ hold the configuration snippet of each client between markers, which
// `pnpm docs:clients` fills from the code that `config <client>` runs. These tests fail when a
// snippet has fallen behind that code, when the guide misses an error code, when a link is broken
// and when the docs name a flag or a variable the program does not know.

const DOCS_DIR = new URL('../../../../docs/', import.meta.url);
const CLIENTS_DIR = new URL('clients/', DOCS_DIR);

// The files as the repository stores them, whatever line endings a checkout gave them.
function readText(path: string | URL): string {
  return readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
}

function snippetOf(client: (typeof CLIENT_IDS)[number], platform: BlockPlatform) {
  return renderClientConfig(client, { platform, command: { kind: 'npx' } });
}

const BLOCK = /<!-- config:([\w-]+)(?::(win32))? -->(\n[\s\S]*?)<!-- \/config -->/g;

function blocksOf(text: string): { client: string; platform: string; inner: string }[] {
  return [...text.matchAll(BLOCK)].map((match) => ({
    client: match[1] ?? '',
    platform: match[2] ?? 'darwin',
    inner: match[3] ?? '',
  }));
}

// The page with its generated blocks and its fenced code taken out, for tests about the prose.
function proseOf(text: string): string {
  return text.replaceAll(BLOCK, '').replaceAll(/^```[\s\S]*?^```/gm, '');
}

function differs(client: (typeof CLIENT_IDS)[number]): boolean {
  const mac = snippetOf(client, 'darwin');
  const win = snippetOf(client, 'win32');
  return mac.snippet !== win.snippet || mac.notes.join('\n') !== win.notes.join('\n');
}

describe('docs/clients', () => {
  test('there is one tutorial for each client and no other file', () => {
    expect(readdirSync(CLIENTS_DIR).sort()).toEqual(CLIENT_IDS.map((id) => `${id}.md`).sort());
  });

  test.each(CLIENT_IDS)('every client tutorial holds the snippet config prints: %s', (client) => {
    const text = readText(clientDocPath(client));
    const blocks = blocksOf(text).filter((block) => block.client === client);

    expect(blocks.map((block) => block.platform)).toEqual(
      differs(client) ? ['darwin', 'win32'] : ['darwin'],
    );
    for (const block of blocks) {
      const platform = block.platform as BlockPlatform;
      const { snippet, notes } = snippetOf(client, platform);
      expect(block.inner).toContain(snippet);
      for (const note of notes) {
        expect(block.inner).toContain(`- ${markdownNote(note)}\n`);
      }
      expect(block.inner).toBe(renderConfigBlock(client, platform));
    }
    expect(blocksOf(text).filter((block) => block.client !== client)).toEqual([]);
    expect(text).toContain(`npx -y tradingview-desktop-mcp config ${client}`);
    expect(text).toContain('npx -y tradingview-desktop-mcp doctor');
    expect(text).toContain('troubleshooting.md');
  });

  test('docs:clients leaves text outside the config blocks untouched', () => {
    const client = 'cursor';
    const text = readText(clientDocPath(client));
    const stale = text.replace(/<!-- config:cursor -->[\s\S]*?<!-- \/config -->/, (block) =>
      block.replace('mcpServers', 'oldServers'),
    );
    const edited = `Words before the blocks.\n\n${stale.replace(
      '<!-- /config -->',
      '<!-- /config -->\n\nWords between.',
    )}\nWords after.\n`;

    const synced = syncClientDoc(client, edited);

    expect(synced).not.toContain('oldServers');
    expect(synced).toContain('Words before the blocks.');
    expect(synced).toContain('Words between.');
    expect(synced.endsWith('Words after.\n')).toBe(true);
    expect(proseOf(synced)).toBe(proseOf(edited));
    expect(syncClientDoc(client, synced)).toBe(synced);
    expect(syncClientDoc(client, text)).toBe(text);
  });

  test.each(CLIENT_IDS)('a generated note holds no bare <placeholder>: %s', (client) => {
    for (const platform of ['darwin', 'win32'] as const) {
      const notes = renderConfigBlock(client, platform)
        .replaceAll(/^```[\s\S]*?^```/gm, '')
        .replaceAll(/`[^`]*`/g, '');
      expect(notes).not.toMatch(/<[A-Za-z_][\w-]*>/);
    }
    expect(markdownNote('with <TV_MCP_AUTH_TOKEN> here')).toBe('with `<TV_MCP_AUTH_TOKEN>` here');
  });

  test('the line about config for your own system follows the last block', () => {
    for (const client of CLIENT_IDS) {
      const text = readText(clientDocPath(client));
      const line = `\`npx -y tradingview-desktop-mcp config ${client}`;
      const last = text.lastIndexOf('<!-- /config -->');
      expect(text.indexOf(line), client).toBeGreaterThan(last);
      // The remote clients print one address for every system, with your own tunnel host.
      const wording = ['chatgpt', 'openai-api'].includes(client)
        ? /your own tunnel host/
        : /for your own system, Linux included/;
      expect(text.slice(text.indexOf(line)), client).toMatch(wording);
    }
  });

  test('docs:clients refuses an unclosed marker and a surplus Windows block', () => {
    const text = readText(clientDocPath('chatgpt'));
    expect(() =>
      syncClientDoc('chatgpt', text.replace('<!-- /config -->', '<!-- /confg -->')),
    ).toThrow(/not closed/);
    const surplus = text.replace(
      '<!-- /config -->',
      '<!-- /config -->\n\n<!-- config:chatgpt:win32 -->\n<!-- /config -->',
    );
    expect(() => syncClientDoc('chatgpt', surplus)).toThrow(/snippet is the same/);
  });

  test('docs:clients refuses a page whose blocks do not match the client', () => {
    expect(() => syncClientDoc('cursor', '# No blocks\n')).toThrow(/config:cursor/);
    const text = readText(clientDocPath('chatgpt'));
    expect(() => syncClientDoc('chatgpt', text.replace('<!-- config:chatgpt -->', ''))).toThrow(
      /config:chatgpt/,
    );
  });

  test('the remote tutorials carry the warning and point to SECURITY.md', () => {
    for (const client of ['chatgpt', 'openai-api'] as const) {
      const text = readText(clientDocPath(client));
      expect(text).toContain('--profile readonly');
      expect(text).toContain('TV_MCP_ALLOWED_HOSTS');
      expect(text).toContain('TV_MCP_AUTH_TOKEN');
      expect(text).toMatch(/SECURITY\.md#tunnels-and-remote-clients/);
    }
  });
});

describe('docs/troubleshooting.md', () => {
  const text = readText(TROUBLESHOOTING_PATH);

  test('troubleshooting documents every error code', () => {
    const headings = [...text.matchAll(/^### ([A-Z_]+)$/gm)].map((match) => match[1]);

    expect(headings).toEqual(expect.arrayContaining([...ERROR_CODES]));
    expect(headings.filter((heading) => !ERROR_CODES.includes(heading as never))).toEqual([]);
    expect(new Set(headings).size).toBe(headings.length);
  });

  test('it covers the common situations', () => {
    for (const phrase of [
      'Automation',
      'TV_APP_PATH',
      'TV_MCP_ALLOWED_HOSTS',
      '--log-level debug',
      'launch --restart',
      'in the background',
    ]) {
      expect(text).toContain(phrase);
    }
  });
});

describe('the tutorials and the troubleshooting guide', () => {
  const files = [...CLIENT_IDS.map((id) => clientDocPath(id)), TROUBLESHOOTING_PATH];

  test('tutorial and troubleshooting links resolve to files in the repo', () => {
    for (const file of files) {
      expect(linksOf(file).length, file).toBeGreaterThan(0);
      expect(brokenLinks(file), file).toEqual([]);
    }
  });

  test('the profiles link points to the README', () => {
    const text = readText(clientDocPath('cursor'));
    expect(text).toContain('](../../README.md#tool-profiles)');
  });

  test('docs name only flags and environment variables the CLI knows', () => {
    const help = renderHelp();
    const knownFlags = new Set(help.match(/--[a-z][a-z-]*/g));
    // TV_NOT_INSTALLED and TV_NOT_RUNNING are error codes, which start like the variables do.
    const knownVariables = new Set([...(help.match(/\bTV_[A-Z0-9_]+/g) ?? []), ...ERROR_CODES]);
    expect(knownFlags.size).toBeGreaterThan(10);

    for (const file of files) {
      // The generated blocks are compared with the output of config, so they are left out here.
      const prose = readText(file).replaceAll(BLOCK, '');
      for (const flag of prose.match(/(?<![\w-])--[a-z][a-z-]*/g) ?? []) {
        expect(knownFlags.has(flag), `${file}: ${flag}`).toBe(true);
      }
      for (const variable of prose.match(/\bTV_[A-Z0-9_]*[A-Z0-9]/g) ?? []) {
        expect(knownVariables.has(variable), `${file}: ${variable}`).toBe(true);
      }
    }
  });
});
