// The types of changelog.mjs, for the test that imports it.

export interface ChangelogSection {
  /** The day of the release (YYYY-MM-DD), or null while the section is not dated. */
  date: string | null;
  /** The notes, without the heading and the link references that end the file. */
  body: string;
}

/** The section of `version` in a CHANGELOG in the form of Keep a Changelog, or null without one. */
export function changelogSection(markdown: string, version: string): ChangelogSection | null;
