// Request wrappers that keep tags and metric recording consistent.
import http from 'k6/http';
import { BASE, REQUEST_TIMEOUT } from './env.js';
import { apiHeaders, internalHeaders } from './auth.js';
import { recordOp } from './metrics.js';

export function gwGet(account, path, operation) {
  const res = http.get(BASE.gateway + path, {
    headers: apiHeaders('GET', path, null, account),
    timeout: REQUEST_TIMEOUT,
    tags: { operation: operation },
  });
  recordOp(operation, res);
  return res;
}

export function gwPost(account, path, body, operation, extraHeaders) {
  const res = http.post(BASE.gateway + path, body, {
    headers: apiHeaders('POST', path, body, account, extraHeaders),
    timeout: REQUEST_TIMEOUT,
    tags: { operation: operation },
  });
  recordOp(operation, res);
  return res;
}

export function gwDelete(account, path, operation) {
  const res = http.del(BASE.gateway + path, null, {
    headers: apiHeaders('DELETE', path, null, account),
    timeout: REQUEST_TIMEOUT,
    tags: { operation: operation },
  });
  recordOp(operation, res);
  return res;
}

// direct calls are used when a scenario targets a service on its own port.
export function directGet(url, operation, headers) {
  const res = http.get(url, {
    headers: headers || { Accept: 'application/json' },
    timeout: REQUEST_TIMEOUT,
    tags: { operation: operation },
  });
  recordOp(operation, res);
  return res;
}

export function directPost(url, body, operation, headers) {
  const res = http.post(url, body, {
    headers: headers || { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
    tags: { operation: operation },
  });
  recordOp(operation, res);
  return res;
}

export function directDelete(url, operation, headers) {
  const res = http.del(url, null, {
    headers: headers || { Accept: 'application/json' },
    timeout: REQUEST_TIMEOUT,
    tags: { operation: operation },
  });
  recordOp(operation, res);
  return res;
}

export function internalGet(accountID, path, operation) {
  return directGet(BASE.order + path, operation, internalHeaders(accountID));
}

export function internalPost(accountID, path, body, operation) {
  return directPost(BASE.order + path, body, operation, internalHeaders(accountID));
}

export function internalDelete(accountID, path, operation) {
  return directDelete(BASE.order + path, operation, internalHeaders(accountID));
}
