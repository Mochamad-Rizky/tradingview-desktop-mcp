import { deflateSync } from 'node:zlib';

// The pictures the fake debug port answers Page.captureScreenshot with. A picture is a solid one of
// the size Chrome would make of the capture, so that what a tool reads from the header of the image
// is what it asked for, and it is valid as a png or a jpeg while a few kilobytes at most whatever
// its size, since a solid picture compresses to nothing.

export type ImageFormat = 'png' | 'jpeg';

// The largest side a jpeg can have: its frame header holds the sizes in 16 bits.
const MAX_SIDE = 0xffff;

// The CRC-32 that ends every chunk of a png (the checksum of ISO 3309 and zlib).
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let bit = 0; bit < 8; bit += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

// Eight bits of grey for each pixel, all of them the same: a row is a filter byte of 0 and a pixel
// for each column.
function solidPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  const rows = Buffer.alloc(height * (1 + width));
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function jpegSegment(marker: number, body: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

// A Huffman table with the one code of one bit, 0, for one symbol (class 0 for DC, 1 for AC, id 0).
function jpegTable(kind: number, symbol: number): Buffer {
  const counts = Buffer.alloc(16);
  counts.writeUInt8(1, 0);
  return jpegSegment(
    0xc4,
    Buffer.concat([Buffer.from([kind << 4]), counts, Buffer.from([symbol])]),
  );
}

// One shade of grey in a baseline jpeg of one component. Every block of eight by eight pixels has a
// DC coefficient that differs from the one before by nothing, and no AC coefficient, which is two
// bits with the tables of one code each: 0 for a difference of nothing and 0 for the end of the
// block. The bits of the last byte that no block fills are ones.
function solidJpeg(width: number, height: number): Buffer {
  const frame = Buffer.alloc(9);
  frame.writeUInt8(8, 0);
  frame.writeUInt16BE(height, 1);
  frame.writeUInt16BE(width, 3);
  // One component: id 1, sampled once in each direction, quantized with table 0.
  frame.set([1, 1, 0x11, 0], 5);
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8);
  const bits = blocks * 2;
  const scan = Buffer.alloc(Math.ceil(bits / 8));
  if (bits % 8 !== 0) {
    scan.writeUInt8(0xff >> (bits % 8), scan.length - 1);
  }
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 16)])),
    jpegSegment(0xc0, frame),
    jpegTable(0, 0),
    jpegTable(1, 0),
    // The scan: one component, using the DC and AC tables 0, over the whole spectrum.
    jpegSegment(0xda, Buffer.from([1, 1, 0x00, 0, 63, 0])),
    scan,
    Buffer.from([0xff, 0xd9]),
  ]);
}

const pictures = new Map<string, string>();

// A picture of the given size, base64 encoded as the protocol carries it. The same text for the same
// picture.
export function solidImage(format: ImageFormat, width: number, height: number): string {
  for (const side of [width, height]) {
    if (!Number.isInteger(side) || side < 1 || side > MAX_SIDE) {
      throw new RangeError(`A picture cannot be ${String(width)} by ${String(height)} pixels`);
    }
  }
  const key = `${format}:${String(width)}x${String(height)}`;
  let picture = pictures.get(key);
  if (picture === undefined) {
    const bytes = format === 'png' ? solidPng(width, height) : solidJpeg(width, height);
    picture = bytes.toString('base64');
    pictures.set(key, picture);
  }
  return picture;
}
