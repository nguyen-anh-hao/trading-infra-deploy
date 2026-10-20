// handleSummary that writes a machine-readable result plus run context.
//
// The report generator groups runs by context.scenario/profile and refuses to
// claim a number when thresholds failed or the context is missing.
import { BASE, GIT_SHA, PROFILE, RUN_ID } from './env.js';

export function handleSummaryFor(scenario, inspect) {
  return function (data) {
    const failed = [];
    const metrics = data.metrics || {};
    Object.keys(metrics).forEach((name) => {
      const thresholds = metrics[name].thresholds;
      if (!thresholds) {
        return;
      }
      Object.keys(thresholds).forEach((key) => {
        if (!thresholds[key].ok) {
          failed.push(name + ': ' + key);
        }
      });
    });

    const output = Object.assign({}, data, {
      context: {
        scenario: scenario,
        runId: RUN_ID,
        profile: PROFILE,
        gitSha: GIT_SHA,
        targets: BASE,
        config: {
          accounts: __ENV.ACCOUNTS || null,
          rateLimitPerSec: __ENV.RATE_LIMIT_PER_SEC || '50',
          floodClients: __ENV.FLOOD_CLIENTS || '20',
          wsClients: __ENV.WS_CLIENTS || '100',
          trades: __ENV.TRADES || '10000',
          replays: __ENV.REPLAYS || '1000',
          duplicates: __ENV.DUPLICATES || '50',
          overdrawVus: __ENV.OVERDRAW_VUS || '50',
          seconds: __ENV.SECONDS || '60',
        },
        generatedAt: new Date().toISOString(),
      },
    });

    const summary = {
      scenario: scenario,
      runId: RUN_ID,
      profile: PROFILE,
      gitSha: GIT_SHA,
      thresholdsFailed: failed,
      key: inspect ? inspect(data) : {},
    };

    const result = {};
    result['stress/results/' + scenario + '-' + RUN_ID + '-' + PROFILE + '.json'] = JSON.stringify(
      output,
      null,
      2
    );
    result.stdout = JSON.stringify(summary, null, 2);
    return result;
  };
}

// Report-friendly values: p99 in ms, rate in req/s.
export function trendStats(data, name) {
  const metric = data.metrics && data.metrics[name];
  if (!metric || !metric.values) {
    return null;
  }
  return metric.values;
}

// Safe accessor used by scripts whose scenario may not have produced a sample
// (for example when preflight fails and every request is a connection error).
export function metricValue(data, name, stat) {
  const metric = data.metrics && data.metrics[name];
  if (!metric || !metric.values) {
    return null;
  }
  const raw = metric.values[stat];
  return raw === undefined ? null : raw;
}
