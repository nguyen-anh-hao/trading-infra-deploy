// Shared environment for every k6 scenario.
//
// All values can be overridden with -e KEY=value. Defaults match
// deployments/docker/docker-compose.local.yml, so a local `make up` works
// without extra flags.

function trim(url) {
  return String(url || '').replace(/\/+$/, '');
}

export const BASE = {
  gateway: trim(__ENV.GATEWAY || 'http://localhost:8080'),
  order: trim(__ENV.ORDER_URL || 'http://localhost:8087'),
  matching: trim(__ENV.MATCHING_URL || 'http://localhost:9001'),
  risk: trim(__ENV.RISK_URL || 'http://localhost:9002'),
  settlement: trim(__ENV.SETTLEMENT_URL || 'http://localhost:8083'),
  accounting: trim(__ENV.ACCOUNTING_URL || 'http://localhost:8086'),
  marketData: trim(__ENV.MARKET_DATA_URL || 'http://localhost:8085'),
  promotion: trim(__ENV.PROMOTION_URL || 'http://localhost:8084'),
};

export const RUN_ID = String(__ENV.RUN_ID || 'local').replace(/[^A-Za-z0-9_.-]/g, '');
export const PROFILE = String(__ENV.PROFILE || 'default').replace(/[^A-Za-z0-9_.-]/g, '');
export const GIT_SHA = __ENV.GIT_SHA || 'unknown';
export const INTERNAL_TOKEN = __ENV.INTERNAL_TOKEN || 'dev-internal-token';

export const API_KEY = __ENV.API_KEY || 'demo-key';
export const API_SECRET = __ENV.API_SECRET || 'demo-secret';
export const SIGN_REQUESTS = String(__ENV.SIGN_REQUESTS || 'true') !== 'false';

export const SYMBOLS = String(__ENV.SYMBOLS || 'AAPL,MSFT,TSLA,NVDA,AMD,GOOG')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

export const DURATION = String(__ENV.DURATION || '60s');
export const REQUEST_TIMEOUT = String(__ENV.REQUEST_TIMEOUT || '10s');

export function gatewayUrl(path) {
  return BASE.gateway + path;
}

export function wsUrl(path) {
  return BASE.gateway.replace(/^http/, 'ws') + path;
}

export function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

export function numberEnv(name, fallback) {
  const raw = __ENV[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function boolEnv(name, fallback) {
  const raw = __ENV[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  return String(raw).toLowerCase() === 'true';
}

export const VUS = numberEnv('VUS', 50);
export const RATE = numberEnv('RATE', 100);
export const SECONDS = numberEnv('SECONDS', 60);
