// -----------------------------------------------------------------------------
// A small owserver on 127.0.0.1 (a free port) for the tests on a real
// clock: it answers DIRALL and READ messages from a table of paths, as
// owserver frames them, and counts the requests by type and path.
// -----------------------------------------------------------------------------

import { createServer } from 'node:net';

export function frame(ret, text = '') {
  const payload = Buffer.from(text, 'latin1');
  const head = Buffer.alloc(24);
  head.writeInt32BE(payload.length, 4);
  head.writeInt32BE(ret, 8);
  head.writeInt32BE(0x100, 12);
  head.writeInt32BE(payload.length, 16);
  return Buffer.concat([head, payload]);
}

export async function owfake(table, { latencyMs = 0 } = {}) {
  const fake = { requests: [], at: [], sockets: new Set() };
  const server = createServer((socket) => {
    fake.sockets.add(socket);
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 24 || buffer.length < 24 + buffer.readInt32BE(4)) return;
      const type = buffer.readInt32BE(8);
      const path = buffer
        .subarray(24, 24 + buffer.readInt32BE(4))
        .toString('latin1')
        .split('\u0000')[0];
      fake.requests.push(`${type} ${path}`);
      fake.at.push(performance.now());
      const value = table[path];
      const reply =
        value === undefined
          ? frame(-1)
          : type === 7
            ? frame(0, `${value}\u0000`)
            : frame(value.length, value);
      setTimeout(() => !socket.destroyed && socket.end(reply), latencyMs);
    });
    socket.on('error', () => {});
    socket.on('close', () => fake.sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.port = server.address().port;
  fake.count = (prefix) => fake.requests.filter((r) => r === prefix).length;
  fake.close = async () => {
    for (const s of fake.sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  };
  return fake;
}
