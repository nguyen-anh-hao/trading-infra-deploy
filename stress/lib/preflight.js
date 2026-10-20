// Fail-fast health checks, borrowed from noise-trader-py/loadtest/preflight.py.
//
// Running a scenario against a half-started stack produces thousands of
// connect errors and no useful numbers. setup() calls this first and aborts
// with a message that says what is missing and how to fix it.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE, numberEnv } from './env.js';

const HINT =
  '\nStart the stack with `make up` (or `make infra-up monitor-up app-local`).\n' +
  'If k6 runs inside WSL while Docker Desktop runs on Windows, localhost may not ' +
  'be forwarded; pass the Windows host IP instead, e.g. -e GATEWAY=http://192.168.208.1:8080.';

export const TARGETS = {
  gateway: { url: BASE.gateway + '/health', optional: false },
  order: { url: BASE.order + '/health', optional: false },
  matching: { url: BASE.matching + '/health', optional: false },
  risk: { url: BASE.risk + '/health', optional: false },
  settlement: { url: BASE.settlement + '/actuator/health', optional: false },
  accounting: { url: BASE.accounting + '/actuator/health', optional: false },
  marketData: { url: BASE.marketData + '/health', optional: false },
  promotion: { url: BASE.promotion + '/fee-tiers?account_id=1', optional: false },
};

// checkTargets verifies only the services a scenario actually depends on.
// Spring Boot can accept a TCP connection and close it while it is still
// starting, so a single GET is not a readiness check: retry until the deadline.
export function checkTargets(names) {
  const timeoutSeconds = numberEnv('PREFLIGHT_TIMEOUT_S', 60);
  const deadline = Date.now() + timeoutSeconds * 1000;
  const failures = [];
  const missing = [];

  names.forEach((name) => {
    const target = TARGETS[name];
    if (!target) {
      missing.push(name);
      return;
    }
    let ok = false;
    let lastStatus = 0;
    let lastError = '';
    while (Date.now() < deadline) {
      const res = http.get(target.url, {
        timeout: '5s',
        tags: { operation: 'preflight', target: name },
      });
      lastStatus = res.status;
      lastError = res.error || '';
      if (res.status >= 200 && res.status < 300) {
        ok = true;
        break;
      }
      sleep(1);
    }
    check({ ok: ok }, { ['preflight ' + name + ' reachable']: () => ok });
    if (!ok) {
      failures.push(
        name + ': last HTTP ' + lastStatus + ' from ' + target.url + (lastError ? ' (' + lastError + ')' : '')
      );
    }
  });

  if (missing.length > 0) {
    throw new Error('preflight misconfigured for: ' + missing.join(', ') + HINT);
  }
  if (failures.length > 0) {
    throw new Error(
      'preflight failed after ' + timeoutSeconds + 's:\n  - ' + failures.join('\n  - ') + HINT
    );
  }
}

// Require a JSON object with the expected keys; throws with a readable message.
export function requireJson(res, label) {
  if (res.status < 200 || res.status >= 300) {
    throw new Error(label + ' returned HTTP ' + res.status + ': ' + String(res.body).slice(0, 200));
  }
  try {
    return res.json();
  } catch (err) {
    throw new Error(label + ' returned non-JSON body: ' + String(res.body).slice(0, 200));
  }
}
