/**
 * JS Library Tests: WebSocket Monitoring
 * Tests page.onWebSocket(), WebSocketInfo.url/onMessage/onClose/isClosed,
 * and removeAllListeners('websocket').
 *
 * Uses a WS echo server (ws library) + HTTP server.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { WebSocketServer } = require('ws');

const { browser } = require('../../../clients/javascript/dist');
const { withTimeout } = require('../helpers/wait');

// onWebSocket() is sync (fire-and-forget under the hood, see page.ts:945).
// Server-side preload-script install races with the next client command.
// 200ms is the hedge until onWebSocket becomes properly async.
const INSTALL_BARRIER_MS = 200;

// --- Local test servers ---

let httpServer;
let wsServer;
let baseURL;
let wsURL;
let bro;

before(async () => {
  httpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><head><title>WS Test</title></head><body>
      <script>
        window.createWS = function(url) {
          return new WebSocket(url);
        };
      </script>
    </body></html>`);
  });

  await new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const { port } = httpServer.address();
      baseURL = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  // WebSocket echo server
  wsServer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wsServer.on('connection', (ws) => {
    ws.on('message', (data) => {
      ws.send(data.toString());
    });
  });

  await new Promise((resolve) => {
    wsServer.on('listening', () => {
      const addr = wsServer.address();
      wsURL = `ws://127.0.0.1:${addr.port}`;
      resolve();
    });
  });

  bro = await browser.start({ headless: true });
});

after(async () => {
  if (bro) await bro.stop();
  if (wsServer) wsServer.close();
  if (httpServer) httpServer.close();
});

// Each test gets a fresh page so onWebSocket listeners don't leak between tests.
async function freshPage() {
  const vibe = await bro.newPage();
  await vibe.go(baseURL);
  return vibe;
}

// --- WebSocket Monitoring ---

describe('WebSocket Monitoring: page.onWebSocket', () => {
  test('onWebSocket fires when page creates a WebSocket', async () => {
    const vibe = await freshPage();
    try {
      const wsCreated = new Promise((resolve) => vibe.onWebSocket(() => resolve()));
      await vibe.wait(INSTALL_BARRIER_MS);
      await vibe.evaluate(`window.createWS('${wsURL}')`);
      await withTimeout(wsCreated, 5000, 'onWebSocket to fire');
    } finally {
      await vibe.close();
    }
  });

  test('ws.url() returns the correct URL', async () => {
    const vibe = await freshPage();
    try {
      let capturedUrl = '';
      const gotUrl = new Promise((resolve) =>
        vibe.onWebSocket((ws) => {
          capturedUrl = ws.url();
          resolve();
        }),
      );
      await vibe.wait(INSTALL_BARRIER_MS);
      await vibe.evaluate(`window.createWS('${wsURL}')`);
      await withTimeout(gotUrl, 5000, 'WS URL to be captured');

      assert.strictEqual(capturedUrl, wsURL);
    } finally {
      await vibe.close();
    }
  });

  test('ws.onMessage() captures sent messages (direction: sent)', async () => {
    const vibe = await freshPage();
    try {
      const messages = [];
      const sentSeen = new Promise((resolve) =>
        vibe.onWebSocket((ws) => {
          ws.onMessage((data, info) => {
            messages.push({ data, direction: info.direction });
            if (info.direction === 'sent') resolve();
          });
        }),
      );

      await vibe.wait(INSTALL_BARRIER_MS);
      await vibe.evaluate(`
        const ws = window.createWS('${wsURL}');
        ws.onopen = () => ws.send('hello');
      `);
      await withTimeout(sentSeen, 5000, 'sent WS message');

      const sent = messages.filter((m) => m.direction === 'sent');
      assert.ok(sent.length > 0, `Should have captured sent messages, got: ${JSON.stringify(messages)}`);
      assert.strictEqual(sent[0].data, 'hello');
    } finally {
      await vibe.close();
    }
  });

  test('ws.onMessage() captures received messages (direction: received)', async () => {
    const vibe = await freshPage();
    try {
      const messages = [];
      const receivedSeen = new Promise((resolve) =>
        vibe.onWebSocket((ws) => {
          ws.onMessage((data, info) => {
            messages.push({ data, direction: info.direction });
            if (info.direction === 'received') resolve();
          });
        }),
      );

      await vibe.wait(INSTALL_BARRIER_MS);
      await vibe.evaluate(`
        const ws = window.createWS('${wsURL}');
        ws.onopen = () => ws.send('echo-me');
      `);
      await withTimeout(receivedSeen, 5000, 'echoed WS message');

      const received = messages.filter((m) => m.direction === 'received');
      assert.ok(received.length > 0, `Should have captured received messages, got: ${JSON.stringify(messages)}`);
      assert.strictEqual(received[0].data, 'echo-me');
    } finally {
      await vibe.close();
    }
  });

  test('ws.onClose() fires when connection closes', async () => {
    const vibe = await freshPage();
    try {
      let closeCode;
      const closed = new Promise((resolve) =>
        vibe.onWebSocket((ws) => {
          ws.onClose((code) => {
            closeCode = code;
            resolve();
          });
        }),
      );

      await vibe.wait(INSTALL_BARRIER_MS);
      await vibe.evaluate(`
        const ws = window.createWS('${wsURL}');
        ws.onopen = () => ws.close(1000, 'done');
      `);
      await withTimeout(closed, 5000, 'WS close event');

      assert.strictEqual(closeCode, 1000);
    } finally {
      await vibe.close();
    }
  });

  test('ws.isClosed() returns true after close', async () => {
    const vibe = await freshPage();
    try {
      let wsInfo;
      const closed = new Promise((resolve) =>
        vibe.onWebSocket((ws) => {
          wsInfo = ws;
          ws.onClose(() => resolve());
        }),
      );

      await vibe.wait(INSTALL_BARRIER_MS);
      await vibe.evaluate(`
        const ws = window.createWS('${wsURL}');
        ws.onopen = () => ws.close();
      `);
      await withTimeout(closed, 5000, 'WS close event');

      assert.ok(wsInfo, 'Should have captured a WebSocket');
      assert.strictEqual(wsInfo.isClosed(), true);
    } finally {
      await vibe.close();
    }
  });

  test('monitoring survives page navigation (preload script persists)', async () => {
    // This test exercises preload-script persistence on the *default* context's
    // default page. Sharing the browser with earlier tests leaves the preload
    // script in a state where re-navigations don't re-fire it, so this test
    // gets its own browser to match the original isolated setup.
    const bro2 = await browser.start({ headless: true });
    try {
      const vibe = await bro2.page();
      await vibe.go(baseURL);

      let wsCount = 0;
      const wsWaiters = [];
      vibe.onWebSocket(() => {
        wsCount++;
        const waiter = wsWaiters.shift();
        if (waiter) waiter();
      });
      const nextWs = () => new Promise((resolve) => wsWaiters.push(resolve));

      await vibe.wait(INSTALL_BARRIER_MS);

      // Create WS on first page
      const firstSeen = nextWs();
      await vibe.evaluate(`window.createWS('${wsURL}')`);
      await withTimeout(firstSeen, 5000, 'first-page WS');
      assert.strictEqual(wsCount, 1, 'Should have captured 1 WS on first page');

      // Navigate to a new page
      await vibe.go(baseURL);
      // No INSTALL_BARRIER here: onWebSocket was already installed before the
      // first navigation, and the preload script is what we're testing.

      // Create WS on second page — preload script should still be active
      const secondSeen = nextWs();
      await vibe.evaluate(`window.createWS('${wsURL}')`);
      await withTimeout(secondSeen, 5000, 'second-page WS after navigation');
      assert.strictEqual(wsCount, 2, 'Should have captured 2 WS total after navigation');
    } finally {
      await bro2.stop();
    }
  });

  test("removeAllListeners('websocket') clears callbacks", async () => {
    const vibe = await freshPage();
    try {
      let wsCount = 0;
      const firstSeen = new Promise((resolve) =>
        vibe.onWebSocket(() => {
          wsCount++;
          resolve();
        }),
      );

      await vibe.wait(INSTALL_BARRIER_MS);
      await vibe.evaluate(`window.createWS('${wsURL}')`);
      await withTimeout(firstSeen, 5000, 'first WS captured');
      assert.strictEqual(wsCount, 1);

      vibe.removeAllListeners('websocket');

      // Second WS should NOT fire the callback. Use the test WS server as a
      // barrier: when the server sees the connection, the preload script has
      // already emitted its ws.created channel message in Chrome. We then do
      // a no-op eval to drain that message through vibium → client before
      // asserting absence of the callback.
      const secondServerConn = new Promise((resolve) => wsServer.once('connection', resolve));
      await vibe.evaluate(`window.createWS('${wsURL}')`);
      await withTimeout(secondServerConn, 5000, 'second WS reaching server');
      await vibe.evaluate('1');
      assert.strictEqual(wsCount, 1, 'Should still be 1 after removing listeners');
    } finally {
      await vibe.close();
    }
  });
});
