// Minimal Prometheus text parser for the /metrics and /actuator/prometheus
// endpoints. It handles the subset these services emit: counters, gauges and
// classic histograms with labels.
import http from 'k6/http';

const SAMPLE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)(?:\s+\S+)?$/;

export function fetchMetrics(url) {
  const res = http.get(url, {
    timeout: '5s',
    tags: { operation: 'metrics_scrape' },
  });
  if (res.status !== 200) {
    return null;
  }
  return parse(res.body);
}

export function parse(text) {
  const out = {};
  String(text || '')
    .split('\n')
    .forEach((line) => {
      if (!line || line.charAt(0) === '#') {
        return;
      }
      const match = line.match(SAMPLE);
      if (!match) {
        return;
      }
      const name = match[1];
      const labels = match[2] || '';
      const raw = match[3];
      let value = Number(raw);
      if (!Number.isFinite(value)) {
        if (raw === '+Inf') {
          value = Infinity;
        } else {
          return;
        }
      }
      if (!out[name]) {
        out[name] = [];
      }
      out[name].push({ labels: labels, value: value });
    });
  return out;
}

export function sum(parsed, name) {
  const series = parsed && parsed[name];
  if (!series) {
    return null;
  }
  let total = 0;
  series.forEach((s) => {
    total += s.value;
  });
  return total;
}

export function max(parsed, name) {
  const series = parsed && parsed[name];
  if (!series || series.length === 0) {
    return null;
  }
  let value = -Infinity;
  series.forEach((s) => {
    if (s.value > value) {
      value = s.value;
    }
  });
  return value;
}

// sumWhere sums only series whose label text contains labelPart, e.g.
// sumWhere(p, 'trading_orders_current', 'status="UNKNOWN"').
export function sumWhere(parsed, name, labelPart) {
  const series = parsed && parsed[name];
  if (!series) {
    return null;
  }
  let total = 0;
  let matched = false;
  series.forEach((s) => {
    if (s.labels.indexOf(labelPart) >= 0) {
      total += s.value;
      matched = true;
    }
  });
  return matched ? total : 0;
}

function leOf(labels) {
  const match = /le="([^"]+)"/.exec(labels || '');
  if (!match) {
    return null;
  }
  return match[1] === '+Inf' ? Infinity : Number(match[1]);
}

// histogram folds every label set of <name>_bucket into one cumulative bucket
// list, which is what a single-service dashboard wants.
export function histogram(parsed, name) {
  const buckets = {};
  const raw = (parsed && parsed[name + '_bucket']) || [];
  raw.forEach((sample) => {
    const le = leOf(sample.labels);
    if (le === null) {
      return;
    }
    if (buckets[le] === undefined) {
      buckets[le] = 0;
    }
    buckets[le] += sample.value;
  });
  const list = Object.keys(buckets)
    .map((key) => ({ le: key === 'Infinity' ? Infinity : Number(key), count: buckets[key] }))
    .sort((a, b) => a.le - b.le);
  return {
    buckets: list,
    count: sum(parsed, name + '_count'),
    sum: sum(parsed, name + '_sum'),
  };
}

export function subtractHistogram(previous, current) {
  if (!current) {
    return null;
  }
  const before = {};
  if (previous) {
    previous.buckets.forEach((b) => {
      before[b.le] = b.count;
    });
  }
  const buckets = current.buckets.map((b) => ({
    le: b.le,
    count: b.count - (before[b.le] === undefined ? 0 : before[b.le]),
  }));
  const count = (current.count || 0) - (previous && previous.count ? previous.count : 0);
  return { buckets: buckets, count: count, sum: current.sum };
}

// quantile follows Prometheus' histogram_quantile: interpolate inside the
// bucket that contains the requested rank.
export function quantile(hist, q) {
  if (!hist || !hist.count || hist.count <= 0) {
    return null;
  }
  const rank = q * hist.count;
  let previousCount = 0;
  let previousLe = 0;
  for (let i = 0; i < hist.buckets.length; i++) {
    const bucket = hist.buckets[i];
    if (bucket.count >= rank) {
      if (!Number.isFinite(bucket.le)) {
        return previousLe;
      }
      const inBucket = bucket.count === previousCount ? 0 : (rank - previousCount) / (bucket.count - previousCount);
      return previousLe + (bucket.le - previousLe) * inBucket;
    }
    previousCount = bucket.count;
    previousLe = bucket.le;
  }
  return previousLe;
}

// counterDelta returns the increase since the previous scrape and the new
// absolute value. The caller divides by the elapsed seconds.
export function counterDelta(parsed, name, previous) {
  const current = sum(parsed, name);
  if (current === null) {
    return { delta: 0, next: previous };
  }
  const delta = previous === null || previous === undefined ? 0 : Math.max(0, current - previous);
  return { delta: delta, next: current };
}

// counterDeltaWhere is counterDelta for one label value, e.g.
// status="SETTLED" on trading_settlements_total.
export function counterDeltaWhere(parsed, name, labelPart, previous) {
  const current = sumWhere(parsed, name, labelPart);
  if (current === null) {
    return { delta: 0, next: previous };
  }
  const delta = previous === null || previous === undefined ? 0 : Math.max(0, current - previous);
  return { delta: delta, next: current };
}
