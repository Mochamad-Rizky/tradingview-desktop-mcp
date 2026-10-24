// The prepack step of the server package, which `pnpm pack` and `npm publish` run before they pack:
// puts the README, the LICENSE and the CHANGELOG of the repository into the package, where npm
// looks for them. npm shows the README outside the repository, where a relative link leads
// nowhere, so the links of the package's copy are made absolute: images point at the raw file and
// every other link at the file on GitHub. Each run writes the three files again; Git ignores them.
//
// Plain JavaScript without dependencies. It finds the repository from its own place in it, whatever
// directory it runs from.
// Usage: node scripts/prepare-package.mjs (the prepack script of the package runs it).

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const BLOB_BASE = 'https://github.com/Mochamad-Rizky/tradingview-mcp/blob/main/';
const RAW_BASE = 'https://raw.githubusercontent.com/Mochamad-Rizky/tradingview-mcp/main/';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PACKAGE = fileURLToPath(new URL('../', import.meta.url));
const FILES = ['README.md', 'LICENSE', 'CHANGELOG.md'];

// A target that names a scheme (https:, mailto:, data: and so on), a protocol-relative URL, a pure
// fragment or nothing at all stays as it is. Anything else is a path in the repository.
function isRelative(target) {
  return target !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^(\/\/|#)/.test(target);
}

// The absolute URL of a relative target, with its query and fragment. `./` and a leading `/` both
// mean the root of the repository, where the README is.
function absolute(target, kind) {
  if (!isRelative(target)) {
    return target;
  }
  const path = target.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  return `${kind === 'image' ? RAW_BASE : BLOB_BASE}${path}`;
}

// A label as Markdown matches it: without case, and with runs of white space as one space.
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

// Where the run of backticks at `start` ends.
function runEnd(text, start) {
  let end = start;
  while (text[end] === '`') {
    end += 1;
  }
  return end;
}

// The end of the code span that the run of `length` backticks before `from` opens: the end of the
// next run of exactly that many backticks, or -1 when there is none and the run is plain text.
function codeSpanEnd(text, from, length) {
  for (let at = text.indexOf('`', from); at !== -1; at = text.indexOf('`', at)) {
    const end = runEnd(text, at);
    if (end - at === length) {
      return end;
    }
    at = end;
  }
  return -1;
}

// The destination of an inline link or image, as `(` at `open` starts it: where the destination
// starts and ends, and where the whole `(destination "title")` ends. Null when what follows is not
// a destination, so that `[text]` stays plain text.
function inlineTail(text, open) {
  let at = open + 1;
  const skipSpace = () => {
    while (at < text.length && /\s/.test(text[at])) {
      at += 1;
    }
  };
  skipSpace();
  let start;
  let end;
  if (text[at] === '<') {
    start = at + 1;
    end = start;
    while (end < text.length && !'<>\n'.includes(text[end])) {
      end += text[end] === '\\' ? 2 : 1;
    }
    if (text[end] !== '>') {
      return null;
    }
    at = end + 1;
  } else {
    start = at;
    end = at;
    let depth = 0;
    // Up to a space or an ASCII control character, which a bare destination cannot hold.
    while (end < text.length && text.charCodeAt(end) > 0x20 && text.charCodeAt(end) !== 0x7f) {
      const char = text[end];
      if (char === '\\') {
        end += 2;
        continue;
      }
      if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        if (depth === 0) {
          break;
        }
        depth -= 1;
      }
      end += 1;
    }
    if (depth !== 0) {
      return null;
    }
    at = end;
  }
  skipSpace();
  const quote = { '"': '"', "'": "'", '(': ')' }[text[at]];
  if (quote !== undefined && at > end) {
    at += 1;
    while (at < text.length && text[at] !== quote) {
      at += text[at] === '\\' ? 2 : 1;
    }
    if (at >= text.length) {
      return null;
    }
    at += 1;
    skipSpace();
  }
  return text[at] === ')' ? { start, end, close: at + 1 } : null;
}

// `<img src>` and `<a href>`, whatever the case of the names and the quoting of the value.
const HTML_TAG = /<(img|a)(?=[\s/>])[^>]*>/iy;
const ATTRIBUTE = /(\s)(src|href)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

function rewriteTag(tag, name) {
  const kind = name.toLowerCase() === 'img' ? 'image' : 'link';
  const wanted = kind === 'image' ? 'src' : 'href';
  return tag.replace(ATTRIBUTE, (whole, space, attribute, equals, double, single, bare) => {
    if (attribute.toLowerCase() !== wanted) {
      return whole;
    }
    const value = double ?? single ?? bare;
    const quote = double !== undefined ? '"' : single !== undefined ? "'" : '';
    return `${space}${attribute}${equals}${quote}${absolute(value, kind)}${quote}`;
  });
}

// The inline links, images and HTML tags of one paragraph, outside code spans. `imageLabels`
// collects the labels that reference-style images use, whose definitions point at raw files.
function rewriteParagraph(text, imageLabels) {
  let out = '';
  let at = 0;
  // The brackets still open, each with the kind of what it opens and where its text starts.
  const open = [];
  while (at < text.length) {
    const char = text[at];
    if (char === '\\') {
      out += text.slice(at, at + 2);
      at += 2;
      continue;
    }
    if (char === '`') {
      const end = runEnd(text, at);
      const close = codeSpanEnd(text, end, end - at);
      const next = close === -1 ? end : close;
      out += text.slice(at, next);
      at = next;
      continue;
    }
    if (char === '<') {
      HTML_TAG.lastIndex = at;
      const tag = HTML_TAG.exec(text);
      if (tag !== null) {
        out += rewriteTag(tag[0], tag[1]);
        at += tag[0].length;
        continue;
      }
    }
    if (char === '!' && text[at + 1] === '[') {
      open.push({ kind: 'image', from: at + 2 });
      out += '![';
      at += 2;
      continue;
    }
    if (char === '[') {
      open.push({ kind: 'link', from: at + 1 });
      out += '[';
      at += 1;
      continue;
    }
    if (char === ']') {
      const bracket = open.pop();
      out += ']';
      at += 1;
      if (bracket === undefined) {
        continue;
      }
      const tail = text[at] === '(' ? inlineTail(text, at) : null;
      if (tail !== null) {
        const target = text.slice(tail.start, tail.end);
        out += text.slice(at, tail.start) + absolute(target, bracket.kind);
        out += text.slice(tail.end, tail.close);
        at = tail.close;
      } else if (bracket.kind === 'image') {
        // ![text][label], ![text][] or ![text].
        const label = /^\[([^\]]*)\]/.exec(text.slice(at))?.[1] ?? '';
        imageLabels.add(normalizeLabel(label === '' ? text.slice(bracket.from, at - 1) : label));
      }
      continue;
    }
    out += char;
    at += 1;
  }
  return out;
}

// A link reference definition: `[label]: destination "title"`.
const DEFINITION = /^( {0,3}\[((?:[^\]\\]|\\.)+)\]:[ \t]*)(<[^>\n]*>|\S+)/;
// The opening line of a fenced code block, and the fence it needs to close.
const FENCE = /^ *(`{3,}|~{3,})/;

// Rewrites the relative targets of a README (see the top of this file). Code, in fenced blocks or
// in spans, is left as it is.
export function rewriteReadmeLinks(markdown) {
  const lines = markdown.split('\n');
  const blocks = [];
  let prose = [];
  let fence = null;
  for (const line of lines) {
    if (fence !== null) {
      blocks[blocks.length - 1].lines.push(line);
      const closing = FENCE.exec(line);
      if (
        closing !== null &&
        closing[1][0] === fence[0] &&
        closing[1].length >= fence.length &&
        line.slice(closing[0].length).trim() === ''
      ) {
        fence = null;
      }
      continue;
    }
    const opening = FENCE.exec(line);
    if (
      opening !== null &&
      !(opening[1][0] === '`' && line.slice(opening[0].length).includes('`'))
    ) {
      blocks.push({ code: false, lines: prose }, { code: true, lines: [line] });
      prose = [];
      fence = opening[1];
      continue;
    }
    prose.push(line);
  }
  blocks.push({ code: false, lines: prose });

  // The paragraphs first, which tells which reference definitions images use, then the definitions.
  const imageLabels = new Set();
  const rewritten = blocks.map((block) =>
    block.code || block.lines.length === 0
      ? block.lines
      : block.lines
          .join('\n')
          .split(/(\n[ \t]*\n)/)
          .map((part, index) => (index % 2 === 1 ? part : rewriteParagraph(part, imageLabels)))
          .join('')
          .split('\n'),
  );
  return blocks
    .flatMap((block, index) =>
      block.code
        ? rewritten[index]
        : rewritten[index].map((line) =>
            line.replace(DEFINITION, (whole, head, label, destination) => {
              const kind = imageLabels.has(normalizeLabel(label)) ? 'image' : 'link';
              const target = destination.startsWith('<') ? destination.slice(1, -1) : destination;
              const url = absolute(target, kind);
              return `${head}${destination.startsWith('<') ? `<${url}>` : url}`;
            }),
          ),
    )
    .join('\n');
}

// A path as short as the directory this runs from allows, for the log.
function shown(path) {
  return relative(process.cwd(), path) || '.';
}

function main() {
  const missing = FILES.filter((file) => !existsSync(join(ROOT, file)));
  if (missing.length > 0) {
    console.error(
      `prepare-package: ${missing.map((file) => shown(join(ROOT, file))).join(', ')} missing; ` +
        'nothing was written',
    );
    process.exitCode = 1;
    return;
  }
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  writeFileSync(join(PACKAGE, 'README.md'), rewriteReadmeLinks(readme));
  for (const file of ['LICENSE', 'CHANGELOG.md']) {
    writeFileSync(join(PACKAGE, file), readFileSync(join(ROOT, file)));
  }
  console.log(`prepare-package: wrote ${FILES.join(', ')} into ${relative(ROOT, PACKAGE)}`);
}

// Whether Node runs this file, rather than a test importing it.
function isMain() {
  try {
    const run = process.argv[1];
    return run !== undefined && realpathSync(run) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main();
}
