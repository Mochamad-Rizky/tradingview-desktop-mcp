import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { crc32, solidImage } from '../../helpers/fake-cdp/images.js';
import { fixturePath } from '../../helpers/fixture-path.js';

// The pictures the fake debug port answers a screenshot with: a solid picture of the size Chrome
// would make, valid as a png or a jpeg and a few kilobytes at most, whatever its size.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Chunk {
  type: string;
  data: Buffer;
  crc: number;
  // The CRC of the type and the data, which is what a valid chunk ends with.
  expectedCrc: number;
}

function chunksOf(png: Buffer): Chunk[] {
  const chunks: Chunk[] = [];
  let at = PNG_SIGNATURE.length;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const typeAndData = png.subarray(at + 4, at + 8 + length);
    chunks.push({
      type: typeAndData.subarray(0, 4).toString('latin1'),
      data: typeAndData.subarray(4),
      crc: png.readUInt32BE(at + 8 + length),
      expectedCrc: crc32(typeAndData),
    });
    at += 12 + length;
  }
  return chunks;
}

const decode = (format: 'png' | 'jpeg', width: number, height: number): Buffer =>
  Buffer.from(solidImage(format, width, height), 'base64');

describe('crc32', () => {
  test('crc32 is the checksum PNG chunks end with', () => {
    // The check value of the CRC-32 of the ISO 3309 family.
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
    expect(crc32(Buffer.from('IEND'))).toBe(0xae426082);
  });
});

describe('solidImage as a png', () => {
  test('solidImage gives a png with a header of the size asked for', () => {
    const png = decode('png', 321, 123);

    expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    const [header] = chunksOf(png);
    expect(header?.type).toBe('IHDR');
    expect(header?.data.readUInt32BE(0)).toBe(321);
    expect(header?.data.readUInt32BE(4)).toBe(123);
    // 8 bits a pixel, one shade of grey, no interlace.
    expect([...(header?.data.subarray(8) ?? [])]).toEqual([8, 0, 0, 0, 0]);
  });

  test('solidImage has the chunks of a png an encoder wrote: header, data, end', () => {
    const encoded = readFileSync(fixturePath('png/1x1.png'));

    expect(chunksOf(decode('png', 1, 1)).map(({ type }) => type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(chunksOf(encoded).map(({ type }) => type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(decode('png', 1, 1).subarray(-12)).toEqual(encoded.subarray(-12));
  });

  test('every chunk of the png ends with the checksum of its type and data', () => {
    for (const chunk of chunksOf(decode('png', 640, 480))) {
      expect(chunk.crc, chunk.type).toBe(chunk.expectedCrc);
    }
  });

  test('the data of the png is one row for each line, a filter byte and a pixel for each column', () => {
    const [, data] = chunksOf(decode('png', 37, 11));

    const rows = inflateSync(data?.data ?? Buffer.alloc(0));

    expect(rows.length).toBe(11 * (1 + 37));
    expect(rows.every((byte) => byte === 0)).toBe(true);
  });

  test('a png of a large picture is a few kilobytes', () => {
    expect(decode('png', 3200, 2000).length).toBeLessThan(20_000);
  });
});

describe('solidImage as a jpeg', () => {
  // The segments of a jpeg, up to its scan: the marker and the length of each.
  function segmentsOf(jpeg: Buffer): { marker: number; at: number; length: number }[] {
    const found: { marker: number; at: number; length: number }[] = [];
    let at = 2;
    for (;;) {
      expect(jpeg[at]).toBe(0xff);
      const marker = jpeg.readUInt8(at + 1);
      const length = jpeg.readUInt16BE(at + 2);
      found.push({ marker, at, length });
      if (marker === 0xda) {
        return found;
      }
      at += 2 + length;
    }
  }

  test('solidImage gives a jpeg from the start-of-image to the end-of-image marker', () => {
    const jpeg = decode('jpeg', 77, 55);

    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(jpeg.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
  });

  test('the segments of the jpeg are a quantization table, a frame header, two Huffman tables and a scan', () => {
    const segments = segmentsOf(decode('jpeg', 77, 55));

    expect(segments.map(({ marker }) => marker.toString(16))).toEqual([
      'db',
      'c0',
      'c4',
      'c4',
      'da',
    ]);
  });

  test('the frame header of the jpeg holds the height and the width asked for', () => {
    const jpeg = decode('jpeg', 3200, 2000);

    const frame = segmentsOf(jpeg).find(({ marker }) => marker === 0xc0);

    expect(frame).toBeDefined();
    const at = frame?.at ?? 0;
    // Precision, then the height and the width.
    expect(jpeg.readUInt8(at + 4)).toBe(8);
    expect(jpeg.readUInt16BE(at + 5)).toBe(2000);
    expect(jpeg.readUInt16BE(at + 7)).toBe(3200);
  });

  test('the scan holds two bits for each block of eight by eight pixels, padded with ones', () => {
    // 77 by 55 pixels are 10 by 7 blocks, and 70 blocks are 140 bits, which is 17 bytes and 4 bits.
    const jpeg = decode('jpeg', 77, 55);
    const scan = segmentsOf(jpeg).at(-1);
    const start = (scan?.at ?? 0) + 2 + (scan?.length ?? 0);

    const entropy = jpeg.subarray(start, -2);

    expect(entropy.length).toBe(18);
    expect([...entropy.subarray(0, 17)].every((byte) => byte === 0)).toBe(true);
    expect(entropy.at(-1)).toBe(0b00001111);
  });

  test('the scan of a jpeg whose bits fill whole bytes has no padding, and never holds a marker', () => {
    // 16 by 16 pixels are 4 blocks, which are 8 bits.
    const jpeg = decode('jpeg', 16, 16);

    const entropy = jpeg.subarray(-3, -2);

    expect([...entropy]).toEqual([0]);
    for (const [width, height] of [
      [1, 1],
      [8, 8],
      [9, 9],
      [333, 222],
    ] as const) {
      const body = decode('jpeg', width, height);
      const scanEnd = body.length - 2;
      const scan = segmentsOf(body).at(-1);
      const data = body.subarray((scan?.at ?? 0) + 2 + (scan?.length ?? 0), scanEnd);
      expect(data.includes(0xff), `${String(width)}x${String(height)}`).toBe(false);
    }
  });

  test('a jpeg of a large picture is a few kilobytes', () => {
    expect(decode('jpeg', 3200, 2000).length).toBeLessThan(30_000);
  });
});

describe('solidImage in general', () => {
  test('solidImage gives base64 text, and the same text for the same picture', () => {
    const first = solidImage('png', 20, 10);

    expect(first).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(solidImage('png', 20, 10)).toBe(first);
    expect(solidImage('png', 20, 11)).not.toBe(first);
    expect(solidImage('jpeg', 20, 10)).not.toBe(first);
  });

  test.each([
    ['no width', 0, 10],
    ['no height', 10, 0],
    ['a negative width', -1, 10],
    ['a width that is not whole', 1.5, 10],
    ['a height that is not whole', 10, 2.5],
    ['a width over what a jpeg can hold', 65_536, 10],
    ['a height over what a jpeg can hold', 10, 65_536],
    ['a width that is not a number', Number.NaN, 10],
  ])('solidImage refuses %s', (_case, width, height) => {
    expect(() => solidImage('png', width, height)).toThrow(RangeError);
    expect(() => solidImage('jpeg', width, height)).toThrow(RangeError);
  });
});
