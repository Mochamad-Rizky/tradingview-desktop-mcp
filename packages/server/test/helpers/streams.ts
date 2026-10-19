import { Writable } from 'node:stream';

// A stream that keeps what is written to it, at once, so a test can read it right after the
// write. `tty` makes it pass for a terminal, which is what decides whether output is colored.
export class CaptureStream extends Writable {
  text = '';
  readonly isTTY: boolean;

  constructor(options: { tty?: boolean } = {}) {
    super();
    this.isTTY = options.tty ?? false;
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.text += chunk.toString('utf8');
    callback();
  }
}
