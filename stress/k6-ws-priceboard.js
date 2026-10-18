import ws from 'k6/ws';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const GW = __ENV.GATEWAY || 'http://localhost:8080';
const WS_URL = (__ENV.WS_URL || GW.replace(/^http/, 'ws')) +
  '/ws?symbols=AAPL,MSFT,TSLA,NVDA,AMD,GOOG&channels=ticker,candle,trade';

const messages = new Counter('trading_ws_messages_total');

export const options = {
  scenarios: {
    subscribers: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '30s', target: 100 },
        { duration: '2m', target: 500 },
        { duration: '1m', target: 500 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    trading_ws_messages_total: ['count>1000'],
  },
};

export default function () {
  const res = ws.connect(WS_URL, {}, (socket) => {
    socket.on('message', () => messages.add(1));
    socket.setTimeout(() => socket.close(), 60000);
  });
  check(res, { 'ws status 101': (r) => r && r.status === 101 });
}
