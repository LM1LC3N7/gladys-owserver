// -----------------------------------------------------------------------------
// A client of one owserver: one TCP connection per request (no persistence
// asked), one request at a time, every request bounded in time (connection
// included), in silence and in size. Read-only: only READ and DIRALL
// messages are ever sent, never a WRITE.
// -----------------------------------------------------------------------------

import { createConnection } from 'node:net';
import { IDLE_TIMEOUT, MSG, READ_SIZE, REQUEST_TIMEOUT } from '../constants.js';
import { AnswerReader, ProtocolError, encodeRequest } from './protocol.js';

const defaultTimers = { setTimeout, clearTimeout };

/** System errors of a connection that mean "nobody answers there". */
const UNREACHABLE = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EADDRNOTAVAIL',
]);

/**
 * `code`: 'unreachable' | 'timeout' | 'closed' (the connection ended before
 * a complete answer) | 'too_big' | 'server' (a negative return value: `errno`
 * is its absolute value) | 'bad_path'.
 */
export class OwError extends Error {
  constructor(code, { errno } = {}) {
    super(code);
    this.name = 'OwError';
    this.code = code;
    this.errno = errno;
  }
}

export class OwClient {
  constructor({
    host,
    port,
    connect = createConnection,
    timers = defaultTimers,
    requestTimeout = REQUEST_TIMEOUT,
    idleTimeout = IDLE_TIMEOUT,
  }) {
    this.host = host;
    this.port = port;
    this.connect = connect;
    this.timers = timers;
    this.requestTimeout = requestTimeout;
    this.idleTimeout = idleTimeout;
    /** The requests one after the other: never two connections at once. */
    this.queue = Promise.resolve();
    this.closed = false;
    this.sockets = new Set();
  }

  /** The devices of a directory, in one answer: the raw comma-separated text. */
  async dirall(path = '/') {
    const answer = await this.request(MSG.DIRALL, path, 0);
    if (answer.ret < 0) throw new OwError('server', { errno: -answer.ret });
    // The list ends with a NUL byte: cut at the first one.
    const text = answer.data.toString('latin1');
    const end = text.indexOf('\u0000');
    return end === -1 ? text : text.slice(0, end);
  }

  /** The value of a property, as owserver formats it (spaces included). */
  async read(path) {
    const answer = await this.request(MSG.READ, path, READ_SIZE);
    if (answer.ret < 0) throw new OwError('server', { errno: -answer.ret });
    return answer.data.toString('latin1');
  }

  request(type, path, size) {
    const job = () => this.exchange(type, path, size);
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => {});
    return run;
  }

  /** Ends every connection: a request running rejects at once. */
  close() {
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  exchange(type, path, size) {
    if (this.closed) return Promise.reject(new OwError('closed'));
    let bytes;
    try {
      bytes = encodeRequest(type, path, { size });
    } catch {
      return Promise.reject(new OwError('bad_path'));
    }
    return new Promise((resolve, reject) => {
      const reader = new AnswerReader();
      let settled = false;
      let idle;
      const socket = this.connect({ host: this.host, port: this.port });
      this.sockets.add(socket);
      const finish = (err, answer) => {
        if (settled) return;
        settled = true;
        this.timers.clearTimeout(deadline);
        this.timers.clearTimeout(idle);
        this.sockets.delete(socket);
        socket.destroy();
        if (err) reject(err);
        else resolve(answer);
      };
      const armIdle = () => {
        this.timers.clearTimeout(idle);
        idle = this.timers.setTimeout(() => finish(new OwError('timeout')), this.idleTimeout);
      };
      const deadline = this.timers.setTimeout(
        () => finish(new OwError('timeout')),
        this.requestTimeout,
      );
      armIdle();
      socket.setNoDelay?.(true);
      socket.on('connect', () => {
        armIdle();
        socket.write(bytes);
      });
      socket.on('data', (chunk) => {
        if (settled) return;
        armIdle();
        let answer;
        try {
          answer = reader.push(chunk);
        } catch (err) {
          finish(new OwError(err instanceof ProtocolError ? err.code : 'closed'));
          return;
        }
        if (answer) finish(undefined, answer);
      });
      socket.on('error', (err) => {
        finish(new OwError(UNREACHABLE.has(err?.code) ? 'unreachable' : 'closed'));
      });
      socket.on('close', () => finish(new OwError('closed')));
      if (this.closed) finish(new OwError('closed'));
    });
  }
}
