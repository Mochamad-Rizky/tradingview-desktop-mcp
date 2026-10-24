import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CLIENT_IDS, renderClientConfig, type ClientId } from '../../src/cli/clients.js';
import { runScript } from '../re/session.js';

// Fills the configuration blocks of the client tutorials (`pnpm docs:clients`). Each block holds the
// snippet and the notes that `config <client>` prints, so a tutorial cannot say anything else. Only
// what stands between the markers is written; the text around them is the author's.
//
//   <!-- config:cursor -->          the snippet for macOS
//   <!-- config:cursor:win32 -->    only where the Windows snippet or notes differ
//   <!-- /config -->

export const CLIENTS_DIR = fileURLToPath(new URL('../../../../docs/clients/', import.meta.url));
export const TROUBLESHOOTING_PATH = fileURLToPath(
  new URL('../../../../docs/troubleshooting.md', import.meta.url),
);

export type BlockPlatform = 'darwin' | 'win32';

export function clientDocPath(client: ClientId): string {
  return `${CLIENTS_DIR}${client}.md`;
}

// What the fence of a snippet is tagged with: the claude command is shell, the codex file is TOML,
// the ChatGPT address is plain text, and the rest is JSON.
const FENCE_LANGUAGE: Partial<Record<ClientId, string>> = {
  'claude-code': 'sh',
  'codex-cli': 'toml',
  chatgpt: 'text',
};

function render(client: ClientId, platform: BlockPlatform) {
  return renderClientConfig(client, { platform, command: { kind: 'npx' } });
}

// Whether a Windows reader needs a block of their own.
export function needsWindowsBlock(client: ClientId): boolean {
  const mac = render(client, 'darwin');
  const win = render(client, 'win32');
  return mac.snippet !== win.snippet || mac.notes.join('\n') !== win.notes.join('\n');
}

// A placeholder such as <TV_MCP_AUTH_TOKEN> would be read as an HTML tag and vanish from the page,
// so a note shows it as code.
export function markdownNote(note: string): string {
  return note.replaceAll(/<[A-Za-z_][\w-]*>/g, (placeholder) => `\`${placeholder}\``);
}

// What stands between the markers: the fenced snippet, then the notes as a list, each part set off
// by blank lines so that Markdown reads each marker as a line of its own.
export function renderConfigBlock(client: ClientId, platform: BlockPlatform): string {
  const { snippet, notes } = render(client, platform);
  const language = FENCE_LANGUAGE[client] ?? 'json';
  return `\n\n\`\`\`${language}\n${snippet}\`\`\`\n\n${notes.map((note) => `- ${markdownNote(note)}`).join('\n')}\n\n`;
}

function markerOf(client: ClientId, platform: BlockPlatform): string {
  return platform === 'win32' ? `<!-- config:${client}:win32 -->` : `<!-- config:${client} -->`;
}

const CLOSING = '<!-- /config -->';

// Replaces the inside of one block. A page without the block it needs, or with one it does not
// need, is refused: an author has to place the markers, because only they know where on the page
// each one belongs.
export function fillBlock(
  text: string,
  client: ClientId,
  platform: BlockPlatform,
  wanted: boolean,
): string {
  const marker = markerOf(client, platform);
  const start = text.indexOf(marker);
  if (start === -1) {
    if (wanted) {
      throw new Error(`The page of ${client} has no ${marker} block`);
    }
    return text;
  }
  if (!wanted) {
    throw new Error(`The page of ${client} has a ${marker} block, but the snippet is the same`);
  }
  const from = start + marker.length;
  const end = text.indexOf(CLOSING, from);
  if (end === -1) {
    throw new Error(`The ${marker} block of ${client} is not closed with ${CLOSING}`);
  }
  return `${text.slice(0, from)}${renderConfigBlock(client, platform)}${text.slice(end)}`;
}

// The page with its blocks rewritten and everything else as it was.
export function syncClientDoc(client: ClientId, text: string): string {
  const withMac = fillBlock(text, client, 'darwin', true);
  return fillBlock(withMac, client, 'win32', needsWindowsBlock(client));
}

function main(): void {
  for (const client of CLIENT_IDS) {
    const path = clientDocPath(client);
    const before = readFileSync(path, 'utf8');
    const after = syncClientDoc(client, before.replaceAll('\r\n', '\n'));
    writeFileSync(path, after);
    process.stdout.write(`${after === before ? 'Kept' : 'Wrote'} ${path}\n`);
  }
}

// Whether this module is the script that node was started with and not a module that a test
// imports. Both paths are resolved, so a link in the path does not keep the script from running.
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  runScript(() => {
    main();
    return Promise.resolve();
  });
}
