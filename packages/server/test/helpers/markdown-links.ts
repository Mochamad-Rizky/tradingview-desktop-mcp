import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { anchorOf } from '../../scripts/docs/anchor.js';

// The link check of the Markdown documents: every relative link must name a file that exists, and a
// link into a Markdown file, this one included, must name one of its headings. Fenced code is left
// out, because the links in it are examples.

function proseOfFile(path: string): string {
  return readFileSync(path, 'utf8')
    .replaceAll('\r\n', '\n')
    .replaceAll(/^```[\s\S]*?^```/gm, '');
}

export function headingAnchors(path: string): string[] {
  return [...proseOfFile(path).matchAll(/^#{1,6} (.*)$/gm)].map((match) =>
    anchorOf(match[1] ?? ''),
  );
}

// The targets of the Markdown links and images of a file.
export function linksOf(file: string): string[] {
  return [...proseOfFile(file).matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1] ?? '');
}

// The relative links of a file that lead nowhere, each with why.
export function brokenLinks(file: string): string[] {
  const broken: string[] = [];
  for (const link of linksOf(file)) {
    if (/^(https?:|mailto:)/.test(link)) {
      continue;
    }
    const [target = '', fragment] = link.split('#');
    const path = target === '' ? file : resolve(dirname(file), target);
    if (!existsSync(path)) {
      broken.push(`${link}: no such file`);
    } else if (
      fragment !== undefined &&
      path.endsWith('.md') &&
      !headingAnchors(path).includes(fragment)
    ) {
      broken.push(`${link}: no such heading`);
    }
  }
  return broken;
}
