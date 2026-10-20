// WebSocket session driver shared by the priceboard and fan-out scenarios.
//
// One VU owns one connection at a time, reconnects until the scenario
// deadline, and reports handshake latency, snapshot delivery and messages per
// type. Borrowed from noise-trader-py/noise_trader/market/websocket.py.
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import {
  wsHandshake,
  wsMessages,
  wsReconnects,
  wsSessionError,
  wsSessions,
  wsSnapshotOk,
} from './metrics.js';

export function runWsLoop(url, options) {
  const opts = options || {};
  const durationMs = opts.durationMs || 30000;
  const sessionMs = opts.sessionMs || 30000;
  const deadline = Date.now() + durationMs;
  let sessions = 0;
  let first = true;

  while (Date.now() < deadline) {
    if (!first) {
      wsReconnects.add(1);
    }
    first = false;

    const remaining = Math.max(1000, Math.min(sessionMs, deadline - Date.now()));
    const started = Date.now();
    let openedAt = 0;
    let gotSnapshot = false;
    let messageCount = 0;

    const response = ws.connect(
      url,
      { tags: { operation: 'ws_connect' } },
      (socket) => {
        socket.on('open', () => {
          openedAt = Date.now();
          wsHandshake.add(openedAt - started);
        });
        socket.on('message', (raw) => {
          messageCount++;
          let type = 'unknown';
          try {
            const parsed = JSON.parse(raw);
            type = parsed && parsed.type ? parsed.type : 'unknown';
            if (type === 'snapshot') {
              gotSnapshot = true;
            }
          } catch (err) {
            type = 'malformed';
          }
          wsMessages.add(1, { type: type });
        });
        socket.on('error', () => {
          // counted through wsSessionError below
        });
        socket.setTimeout(() => socket.close(), remaining);
      }
    );

    sessions++;
    wsSessions.add(1);
    wsSnapshotOk.add(gotSnapshot);
    const opened = openedAt > 0;
    wsSessionError.add(!opened || response.status !== 101);
    check(response, {
      'ws status 101': (r) => r && r.status === 101,
      'ws opened': () => opened,
      'ws snapshot received': () => gotSnapshot,
    });

    if (opts.onSession) {
      opts.onSession({ messages: messageCount, snapshot: gotSnapshot, opened: opened });
    }
    if (!opened) {
      sleep(0.5);
    }
  }

  return { sessions: sessions };
}
