// -----------------------------------------------------------------------------
// The owserver client against real local TCP servers (127.0.0.1, a free
// port): the bytes of a request, real answers captured from `owserver
// --fake`, pings, errors, silences, oversized and cut answers. Every wait is
// bounded; every server is closed in t.after.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection, createServer } from 'node:net';
import { OwClient, OwError } from '../src/owserver/client.js';
import { AnswerReader, encodeRequest } from '../src/owserver/protocol.js';

/** An answer header + payload, as owserver writes it. */
function answer(ret, payload = Buffer.alloc(0), { size = payload.length, flags = 0x100 } = {}) {
  const head = Buffer.alloc(24);
  head.writeInt32BE(0, 0);
  head.writeInt32BE(payload.length, 4);
  head.writeInt32BE(ret, 8);
  head.writeInt32BE(flags, 12);
  head.writeInt32BE(size, 16);
  head.writeInt32BE(0, 20);
  return Buffer.concat([head, payload]);
}
const PING = (() => {
  const head = Buffer.alloc(24);
  head.writeInt32BE(-1, 4);
  return head;
})();

/** A server: `onRequest(bytes, socket)` per connection, counters of connections. */
async function server(t, onRequest) {
  const srv = { connections: 0, open: 0, peak: 0, received: [] };
  const sockets = new Set();
  const net = createServer((socket) => {
    sockets.add(socket);
    srv.connections += 1;
    srv.open += 1;
    srv.peak = Math.max(srv.peak, srv.open);
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= 24 && buffer.length >= 24 + buffer.readInt32BE(4)) {
        srv.received.push(buffer);
        onRequest(buffer, socket);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      srv.open -= 1;
      sockets.delete(socket);
    });
  });
  await new Promise((resolve) => net.listen(0, '127.0.0.1', resolve));
  srv.port = net.address().port;
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => net.close(resolve));
  });
  return srv;
}

const client = (srv, options = {}) =>
  new OwClient({
    host: '127.0.0.1',
    port: srv.port,
    requestTimeout: 2000,
    idleTimeout: 1000,
    ...options,
  });

test('the bytes of a request: six big-endian words then the path, NUL-terminated', () => {
  const bytes = encodeRequest(2, '/28.4AEC29CDBAAB/temperature', { size: 4096 });
  assert.equal(bytes.readInt32BE(0), 0);
  assert.equal(bytes.readInt32BE(4), 29);
  assert.equal(bytes.readInt32BE(8), 2);
  assert.equal(bytes.readInt32BE(12), 0x100, 'ownet, Celsius, f.i, no persistence');
  assert.equal(bytes.readInt32BE(16), 4096);
  assert.equal(bytes.readInt32BE(20), 0);
  assert.equal(bytes.subarray(24).toString('latin1'), '/28.4AEC29CDBAAB/temperature\u0000');
  for (const bad of ['28', '/a/../b', '/a b', '/a\nb', `/${'a'.repeat(200)}`]) {
    assert.throws(() => encodeRequest(2, bad), /bad_path/, bad);
  }
});

test('a read: the value, spaces kept, cut to the size of the header', async (t) => {
  const srv = await server(t, (req, socket) => {
    // Real bytes of owserver --fake: payload 12, ret 12, size 12.
    socket.end(answer(12, Buffer.from('     53.1376')));
  });
  assert.equal(await client(srv).read('/28.4AEC29CDBAAB/temperature'), '     53.1376');
  const req = srv.received[0];
  assert.equal(req.readInt32BE(8), 2, 'READ');
  assert.equal(req.readInt32BE(16), 4096);
});

test('a read: a payload longer than the size is cut to the size', async (t) => {
  const srv = await server(t, (req, socket) => {
    socket.end(answer(5, Buffer.from('21.50\u0000\u0000\u0000'), { size: 5 }));
  });
  assert.equal(await client(srv).read('/28.4AEC29CDBAAB/temperature'), '21.50');
});

test('dirall: one answer, the trailing NUL removed', async (t) => {
  const srv = await server(t, (req, socket) => {
    socket.end(answer(0, Buffer.from('/10.67C6697351FF,/28.4AEC29CDBAAB\u0000'), { size: 33 }));
  });
  assert.equal(await client(srv).dirall('/'), '/10.67C6697351FF,/28.4AEC29CDBAAB');
  assert.equal(srv.received[0].readInt32BE(8), 7, 'DIRALL');
});

test('pings are skipped, even split across chunks', async (t) => {
  const srv = await server(t, (req, socket) => {
    socket.write(PING);
    socket.write(PING.subarray(0, 10));
    setTimeout(() => {
      socket.write(
        Buffer.concat([PING.subarray(10), answer(4, Buffer.from('12.5'))]).subarray(0, 30),
      );
      setTimeout(
        () =>
          socket.end(
            Buffer.concat([PING.subarray(10), answer(4, Buffer.from('12.5'))]).subarray(30),
          ),
        20,
      );
    }, 20);
  });
  assert.equal(await client(srv).read('/28.4AEC29CDBAAB/temperature'), '12.5');
});

test('a negative return value is an error of owserver with its errno', async (t) => {
  const srv = await server(t, (req, socket) => socket.end(answer(-2)));
  await assert.rejects(client(srv).read('/28.000000000000/temperature'), (err) => {
    assert.ok(err instanceof OwError);
    assert.equal(err.code, 'server');
    assert.equal(err.errno, 2);
    return true;
  });
});

test('an oversized answer is cut at its header, before the payload is read', async (t) => {
  const srv = await server(t, (req, socket) => {
    const head = answer(0, Buffer.alloc(0));
    head.writeInt32BE(10 * 1024 * 1024, 4);
    socket.write(head);
    // Then a flood: never read whole.
    const chunk = Buffer.alloc(64 * 1024, 0x41);
    const flood = () => {
      if (!socket.destroyed && socket.write(chunk)) setImmediate(flood);
    };
    flood();
  });
  await assert.rejects(client(srv).read('/x'), (err) => err.code === 'too_big');
});

test('an HTTP server on the port is not taken for an owserver', async (t) => {
  const srv = await server(t, (req, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
  });
  await assert.rejects(client(srv).read('/x'), (err) => ['too_big', 'closed'].includes(err.code));
});

test('a connection closed before a complete answer', async (t) => {
  const srv = await server(t, (req, socket) =>
    socket.end(answer(12, Buffer.from('  21.5')).subarray(0, 28)),
  );
  await assert.rejects(client(srv).read('/x'), (err) => err.code === 'closed');
});

test('silence: given up after the idle delay, the connection closed', async (t) => {
  const srv = await server(t, () => {});
  const started = performance.now();
  await assert.rejects(
    client(srv, { idleTimeout: 300 }).read('/x'),
    (err) => err.code === 'timeout',
  );
  const took = performance.now() - started;
  assert.ok(took >= 250 && took < 1500, `${took} ms`);
  for (let i = 0; i < 100 && srv.open > 0; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(srv.open, 0);
});

test('pings forever: given up at the deadline of the request', async (t) => {
  const timers = [];
  t.after(() => timers.forEach(clearInterval));
  const srv = await server(t, (req, socket) => {
    timers.push(setInterval(() => !socket.destroyed && socket.write(PING), 50));
  });
  const started = performance.now();
  await assert.rejects(
    client(srv, { idleTimeout: 300, requestTimeout: 600 }).read('/x'),
    (err) => err.code === 'timeout',
  );
  const took = performance.now() - started;
  assert.ok(took >= 550 && took < 2000, `${took} ms`);
});

test('a refused port is unreachable', async (t) => {
  const srv = await server(t, () => {});
  const port = srv.port;
  // A port of a server just closed refuses.
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const free = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  assert.notEqual(free, port);
  await assert.rejects(
    new OwClient({ host: '127.0.0.1', port: free, requestTimeout: 2000 }).read('/x'),
    (err) => err.code === 'unreachable',
  );
});

test('one connection at a time, closed after each answer', async (t) => {
  const srv = await server(t, (req, socket) => {
    setTimeout(() => socket.end(answer(2, Buffer.from('1,0'))), 30);
  });
  const opened = [];
  let overlap = 0;
  const c = client(srv, {
    connect: (options) => {
      if (opened.some((s) => !s.destroyed)) overlap += 1;
      const socket = createConnection(options);
      opened.push(socket);
      return socket;
    },
  });
  const results = await Promise.all([c.read('/a'), c.read('/b'), c.read('/c')]);
  assert.deepEqual(results, ['1,0', '1,0', '1,0']);
  assert.equal(srv.connections, 3);
  assert.equal(overlap, 0, 'the previous connection is closed before the next one');
  assert.ok(opened.every((s) => s.destroyed));
});

test('close() ends a request running at once', async (t) => {
  const srv = await server(t, () => {});
  const c = client(srv, { idleTimeout: 5000, requestTimeout: 5000 });
  const pending = c.read('/x');
  for (let i = 0; i < 100 && srv.open === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
  const started = performance.now();
  c.close();
  await assert.rejects(pending, (err) => err.code === 'closed');
  assert.ok(performance.now() - started < 500);
  await assert.rejects(c.read('/y'), (err) => err.code === 'closed');
});

test('the answer reader: header and payload byte by byte', () => {
  const reader = new AnswerReader();
  const bytes = Buffer.concat([PING, answer(3, Buffer.from('1,0'))]);
  let result;
  for (const byte of bytes) {
    assert.equal(result, undefined);
    result = reader.push(Buffer.from([byte]));
  }
  assert.deepEqual({ ret: result.ret, data: result.data.toString() }, { ret: 3, data: '1,0' });
  assert.equal(reader.pings, 1);
});
