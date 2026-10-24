// Reads the section of one version from the CHANGELOG, in the form of Keep a Changelog. The release
// workflow uses it twice: to refuse a tag whose version has no dated section, and to take the notes
// of the GitHub release from that section.
//
// Plain JavaScript without dependencies.
// Usage: node scripts/changelog.mjs <version> [<CHANGELOG.md>]
// It prints the notes of the version and exits with 0 when the section is dated, and otherwise
// says why on stderr and exits with 1. The file defaults to the CHANGELOG.md at the root of the
// repository.

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT_CHANGELOG = fileURLToPath(new URL('../../../CHANGELOG.md', import.meta.url));

// A day as the CHANGELOG writes it, and one that exists.
function isDay(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return false;
  }
  const day = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === text;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A link reference definition, such as the version links at the end of the file.
const DEFINITION = /^ {0,3}\[[^\]]+\]:\s*\S/;

/**
 * The section of `version`: `date` is its day (YYYY-MM-DD), or null while it is not dated, as in
 * `## [0.1.0] - Unreleased`, and `body` is what it says, without the heading, the blank lines
 * around it and the link references that end the file. Null when there is no such section.
 */
export function changelogSection(markdown, version) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\](.*)$`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) {
    return null;
  }
  const rest = heading.exec(lines[start])[1];
  const dated = /^ - (\S+)\s*$/.exec(rest);
  const date = dated !== null && isDay(dated[1]) ? dated[1] : null;

  let end = lines.findIndex((line, index) => index > start && /^#{1,2} /.test(line));
  if (end === -1) {
    end = lines.length;
  }
  const body = lines.slice(start + 1, end);
  // The definitions at the end belong to the whole file, not to the last section.
  while (body.length > 0 && (body.at(-1).trim() === '' || DEFINITION.test(body.at(-1)))) {
    body.pop();
  }
  while (body.length > 0 && body[0].trim() === '') {
    body.shift();
  }
  return { date, body: body.join('\n') };
}

function main(args) {
  const [version, file = ROOT_CHANGELOG] = args;
  if (version === undefined || version === '') {
    throw new Error('usage: node scripts/changelog.mjs <version> [<CHANGELOG.md>]');
  }
  let markdown;
  try {
    markdown = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error.message}`, { cause: error });
  }
  const section = changelogSection(markdown, version);
  if (section === null) {
    throw new Error(`${file} has no "## [${version}]" section`);
  }
  if (section.date === null) {
    throw new Error(
      `the ${version} section of ${file} is not dated: write "## [${version}] - YYYY-MM-DD", ` +
        'with the day of the release, before you tag it',
    );
  }
  if (section.body.trim() === '') {
    throw new Error(`the ${version} section of ${file} has no notes`);
  }
  process.stdout.write(`${section.body}\n`);
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
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`changelog: ${error.message}`);
    process.exitCode = 1;
  }
}
