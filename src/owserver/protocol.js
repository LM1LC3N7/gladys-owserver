// -----------------------------------------------------------------------------
// The owserver network protocol, written from its public description
// (owfs.org, "owserver protocol", "owserver message types", "owserver flag
// word"): a request is a 24-byte header (six 32-bit big-endian words:
// version, payload length, type, flags, size, offset) followed by the path,
// NUL-terminated; an answer has the same header (the third word is the
// return value, negative on error) followed by the payload. While a slow
// read goes on, the server may send "ping" headers (a negative payload
// length): they carry nothing and are skipped. Nothing of the OWFS code is
// used.
// -----------------------------------------------------------------------------

import { FLAGS, HEADER_BYTES, MAX_PAYLOAD, READ_SIZE } from '../constants.js';

/** A path we send: absolute, printable ASCII, no "..", bounded. */
const PATH = /^\/[\x21-\x7e]{0,127}$/;

export class ProtocolError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

/** The bytes of one request. */
export function encodeRequest(type, path, { flags = FLAGS, size = READ_SIZE } = {}) {
  if (typeof path !== 'string' || !PATH.test(path) || path.includes('..')) {
    throw new ProtocolError('bad_path');
  }
  const payload = Buffer.from(`${path}\u0000`, 'latin1');
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeInt32BE(0, 0);
  header.writeInt32BE(payload.length, 4);
  header.writeInt32BE(type, 8);
  header.writeInt32BE(flags, 12);
  header.writeInt32BE(size, 16);
  header.writeInt32BE(0, 20);
  return Buffer.concat([header, payload]);
}

/**
 * Reads one answer from the chunks of a connection. `push(chunk)` returns
 * `{ ret, data }` once the answer is complete (`data`: the payload cut to
 * the size the header gives), `undefined` while more bytes are needed, and
 * throws a ProtocolError as soon as a header is not plausible: a payload
 * announced larger than MAX_PAYLOAD is refused before a byte of it is kept.
 */
export class AnswerReader {
  constructor({ maxPayload = MAX_PAYLOAD } = {}) {
    this.maxPayload = maxPayload;
    this.chunks = [];
    this.length = 0;
    this.header = undefined;
    this.pings = 0;
  }

  push(chunk) {
    this.chunks.push(chunk);
    this.length += chunk.length;
    for (;;) {
      if (!this.header) {
        if (this.length < HEADER_BYTES) return undefined;
        const head = this.take(HEADER_BYTES);
        const payloadLength = head.readInt32BE(4);
        if (payloadLength < 0) {
          // A ping: the server is still working on the answer.
          this.pings += 1;
          continue;
        }
        if (payloadLength > this.maxPayload) {
          throw new ProtocolError('too_big');
        }
        this.header = {
          payloadLength,
          ret: head.readInt32BE(8),
          size: head.readInt32BE(16),
        };
      }
      if (this.length < this.header.payloadLength) return undefined;
      const payload = this.take(this.header.payloadLength);
      const { ret, size } = this.header;
      const used = size >= 0 && size <= payload.length ? size : payload.length;
      return { ret, data: payload.subarray(0, used) };
    }
  }

  /** The first `n` bytes received and not taken yet (n <= this.length). */
  take(n) {
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const head = all.subarray(0, n);
    const rest = all.subarray(n);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.length = rest.length;
    return head;
  }
}
