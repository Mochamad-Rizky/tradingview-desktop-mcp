// How GitHub turns the text of a heading into the anchor that links to it.
export function anchorOf(heading: string): string {
  return heading
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replaceAll(/\s/g, '-');
}
