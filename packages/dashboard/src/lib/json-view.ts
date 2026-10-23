import type { JsonValue } from '@contract';

// How much of a JSON value the dashboard shows before "Show all".
export const JSON_LIMIT = 20_000;

// `value` as JSON.stringify(value, null, 2) writes it, cut to its first `limit` characters, and
// whether it was cut. The text is written only as far as the limit, so a result of several MB (5000
// bars, an image written into the data) costs no more than a small one until the user asks for all
// of it.
export function formatJson(
  value: JsonValue,
  limit = JSON_LIMIT,
): { text: string; truncated: boolean } {
  if (limit === Infinity) {
    return { text: JSON.stringify(value, null, 2), truncated: false };
  }
  const parts: string[] = [];
  let length = 0;
  // Each write says whether there is room for more.
  const write = (text: string): boolean => {
    parts.push(text);
    length += text.length;
    return length <= limit;
  };
  const walk = (item: JsonValue, indent: string): boolean => {
    if (typeof item === 'string') {
      // No more of a text than the limit can show, so a long one is cut before it is quoted.
      return write(JSON.stringify(item.length > limit ? item.slice(0, limit) : item));
    }
    if (item === null || typeof item !== 'object') {
      return write(JSON.stringify(item));
    }
    const inner = `${indent}  `;
    if (Array.isArray(item)) {
      if (item.length === 0) {
        return write('[]');
      }
      if (!write('[\n')) {
        return false;
      }
      for (let index = 0; index < item.length; index += 1) {
        const last = index === item.length - 1;
        if (!write(inner) || !walk(item[index] ?? null, inner) || !write(last ? '\n' : ',\n')) {
          return false;
        }
      }
      return write(`${indent}]`);
    }
    const keys = Object.keys(item);
    if (keys.length === 0) {
      return write('{}');
    }
    if (!write('{\n')) {
      return false;
    }
    for (const [index, key] of keys.entries()) {
      const last = index === keys.length - 1;
      if (
        !write(`${inner}${JSON.stringify(key)}: `) ||
        !walk(item[key] ?? null, inner) ||
        !write(last ? '\n' : ',\n')
      ) {
        return false;
      }
    }
    return write(`${indent}}`);
  };
  if (walk(value, '')) {
    return { text: parts.join(''), truncated: false };
  }
  return { text: parts.join('').slice(0, limit), truncated: true };
}
