// Request signing for api-gateway.
//
// The gateway validates HMAC-SHA256 over the JSON body for POST/PUT and over
// path+query (r.URL.RequestURI()) for every other method. This mirrors
// noise-trader-py/noise_trader/auth.py and http_client.py so the load tests
// exercise the same authentication path real clients use.
import crypto from 'k6/crypto';
import { API_KEY, API_SECRET, INTERNAL_TOKEN, SIGN_REQUESTS } from './env.js';

export function sign(secret, payload) {
  return crypto.hmac('sha256', secret, payload, 'hex');
}

export function queryString(params) {
  if (!params) {
    return '';
  }
  const parts = [];
  Object.keys(params).forEach((key) => {
    const value = params[key];
    if (value === undefined || value === null || value === '') {
      return;
    }
    parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
  });
  return parts.length ? '?' + parts.join('&') : '';
}

// apiHeaders builds the headers for a gateway request. `body` must be the
// exact string that is sent, because the signature covers those bytes.
export function apiHeaders(method, pathWithQuery, body, account, extra) {
  const headers = { Accept: 'application/json' };
  if (extra) {
    Object.keys(extra).forEach((k) => {
      headers[k] = extra[k];
    });
  }
  const accountInfo = account || { apiKey: API_KEY, secret: API_SECRET };
  if (accountInfo.apiKey) {
    headers['X-API-Key'] = accountInfo.apiKey;
  }
  if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json';
  }
  const upper = String(method || 'GET').toUpperCase();
  if (SIGN_REQUESTS && accountInfo.apiKey && accountInfo.secret) {
    const payload = upper === 'POST' || upper === 'PUT' ? String(body || '') : pathWithQuery;
    headers['X-Signature'] = sign(accountInfo.secret, payload);
  }
  return headers;
}

// internalHeaders authenticates against order-service directly. The gateway
// sets X-Account-ID after authentication; bypassing the gateway in a load test
// means we set it ourselves, exactly as the gateway would.
export function internalHeaders(accountID, extra) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Internal-Token': INTERNAL_TOKEN,
    'X-Account-ID': String(accountID),
  };
  if (extra) {
    Object.keys(extra).forEach((k) => {
      headers[k] = extra[k];
    });
  }
  return headers;
}

export function unsignedHeaders(account, extra) {
  const headers = { Accept: 'application/json' };
  if (extra) {
    Object.keys(extra).forEach((k) => {
      headers[k] = extra[k];
    });
  }
  const accountInfo = account || { apiKey: API_KEY };
  if (accountInfo.apiKey) {
    headers['X-API-Key'] = accountInfo.apiKey;
  }
  return headers;
}
