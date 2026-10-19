#!/usr/bin/env python3
"""Render the baseline catalog into Prometheus rules and Grafana dashboards.

`docs/baselines.yaml` is the single source of truth. This script generates:

  * deployments/observability/prometheus/recording_rules_baselines.yml
  * deployments/observability/grafana/dashboards/baseline_scorecard.json
  * the "Baseline legend" text panel (id 100) in the service dashboards

Usage:
    python scripts/render_baselines.py
    python scripts/render_baselines.py --check   # CI drift check
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "docs" / "baselines.yaml"
RULES = ROOT / "deployments" / "observability" / "prometheus" / "recording_rules_baselines.yml"
DOCS = ROOT / "docs" / "BASELINES.md"
DASHBOARDS = ROOT / "deployments" / "observability" / "grafana" / "dashboards"
SCORECARD = DASHBOARDS / "baseline_scorecard.json"
LEGEND_DASHBOARDS = [DASHBOARDS / "service_overview.json", DASHBOARDS / "service_detail.json"]

COMPARATORS = {"<=", "<", ">=", ">", "=="}
LABEL_COMPARATOR = {"<=": "le", "<": "lt", ">=": "ge", ">": "gt", "==": "eq"}
VIOLATION_OP = {"<=": ">", "<": ">=", ">=": "<", ">": "<=", "==": "!="}
SEVERITIES = {"critical", "warning"}
UNITS = {"s", "percentunit", "short", "bytes", "ops", "reqps"}


def load_catalog() -> list[dict]:
    data = yaml.safe_load(CATALOG.read_text(encoding="utf-8"))
    baselines = data.get("baselines") if isinstance(data, dict) else None
    if not isinstance(baselines, list) or not baselines:
        raise SystemExit(f"{CATALOG}: expected a non-empty `baselines:` list")

    seen: set[str] = set()
    for item in baselines:
        missing = {"id", "title", "category", "expr", "comparator", "target", "unit", "severity"} - set(item)
        if missing:
            raise SystemExit(f"{CATALOG}: baseline missing fields {sorted(missing)}: {item!r}")
        if item["id"] in seen:
            raise SystemExit(f"{CATALOG}: duplicate baseline id {item['id']!r}")
        seen.add(item["id"])
        if item["comparator"] not in COMPARATORS:
            raise SystemExit(f"{CATALOG}: invalid comparator {item['comparator']!r} in {item['id']}")
        if item["severity"] not in SEVERITIES:
            raise SystemExit(f"{CATALOG}: invalid severity {item['severity']!r} in {item['id']}")
        if item["unit"] not in UNITS:
            raise SystemExit(f"{CATALOG}: unsupported unit {item['unit']!r} in {item['id']}")
        if not isinstance(item["target"], (int, float)):
            raise SystemExit(f"{CATALOG}: target must be numeric in {item['id']}")
    return baselines


def fmt_number(value: float) -> str:
    return f"{value:.12g}"


def rule_labels(item: dict) -> dict:
    return {
        "baseline": item["id"],
        "title": item["title"],
        "category": item["category"],
        "target": fmt_number(item["target"]),
        "comparator": LABEL_COMPARATOR[item["comparator"]],
        "severity": item["severity"],
        "unit": item["unit"],
    }


def render_rules(baselines: list[dict]) -> str:
    rules = []
    for item in baselines:
        expr = item["expr"].strip()
        target = fmt_number(item["target"])
        labels = rule_labels(item)
        rules.append({"record": "baseline:value", "expr": expr, "labels": dict(labels)})
        violation = f"({expr}) {VIOLATION_OP[item['comparator']]} bool {target}"
        rules.append({"record": "baseline:violation", "expr": violation, "labels": dict(labels)})

    doc = {
        "groups": [
            {
                "name": "baseline-scorecard",
                "interval": "30s",
                "rules": rules,
            }
        ]
    }
    return yaml.safe_dump(doc, sort_keys=False, default_flow_style=False, width=120)


def legend_markdown(baselines: list[dict]) -> str:
    rows = [b for b in baselines if b.get("legend")]
    shown = rows[:6]
    lines = [
        "### Baseline legend",
        "",
        "| Baseline | Target | Severity |",
        "|---|---|---|",
    ]
    for item in shown:
        lines.append(
            f"| {item['title']} | {item['comparator']} {fmt_number(item['target'])} {item['unit']} "
            f"| {item['severity']} |"
        )
    if len(rows) > len(shown):
        lines.append(f"| ... {len(rows) - len(shown)} more | see Baseline Scorecard | |")
    lines.append("")
    lines.append("Full catalog and sources: `docs/BASELINES.md` / `docs/baselines.yaml`.")
    return "\n".join(lines)


def _ds() -> dict:
    return {"type": "prometheus", "uid": "prometheus"}


def _table_panel() -> dict:
    selector = '{service=~"$service", category=~"$category", severity=~"$severity"}'
    return {
        "id": 1,
        "type": "table",
        "title": "Baseline scorecard",
        "description": (
            "PASS/FAIL against docs/baselines.yaml. Click a baseline id to open its "
            "definition and source. Values use the unit shown in the `unit` column."
        ),
        "gridPos": {"h": 18, "w": 24, "x": 0, "y": 4},
        "datasource": _ds(),
        "targets": [
            {
                "refId": "A",
                "datasource": _ds(),
                "expr": f"baseline:value{selector}",
                "instant": True,
                "format": "table",
            },
            {
                "refId": "B",
                "datasource": _ds(),
                "expr": f"baseline:violation{selector}",
                "instant": True,
                "format": "table",
            },
        ],
        "transformations": [
            {"id": "merge", "options": {}},
            {
                "id": "organize",
                "options": {
                    "excludeByName": {
                        "Time": True,
                        "__name__": True,
                        "job": True,
                        "instance": True,
                        "tier": True,
                        "pod": True,
                        "namespace": True,
                        "container": True,
                        "endpoint": True,
                    },
                    "renameByName": {
                        "Value #A": "Current",
                        "Value #B": "Status",
                        "Value 1": "Current",
                        "Value 2": "Status",
                        "baseline": "Baseline",
                        "service": "Service",
                        "category": "Category",
                        "severity": "Severity",
                        "target": "Target",
                        "comparator": "Cmp",
                        "unit": "Unit",
                        "title": "Title",
                    },
                    "indexByName": {
                        "Status": 0,
                        "Baseline": 1,
                        "Title": 2,
                        "Service": 3,
                        "Current": 4,
                        "Cmp": 5,
                        "Target": 6,
                        "Unit": 7,
                        "Category": 8,
                        "Severity": 9,
                    },
                },
            },
        ],
        "fieldConfig": {
            "defaults": {"custom": {"align": "auto", "cellOptions": {"type": "auto"}}},
            "overrides": [
                {
                    "matcher": {"id": "byName", "options": "Status"},
                    "properties": [
                        {
                            "id": "mappings",
                            "value": [
                                {
                                    "type": "value",
                                    "options": {
                                        "0": {"text": "PASS", "color": "green", "index": 0},
                                        "1": {"text": "FAIL", "color": "red", "index": 1},
                                    },
                                }
                            ],
                        },
                        {"id": "custom.cellOptions", "value": {"type": "color-background"}},
                    ],
                },
                {
                    "matcher": {"id": "byName", "options": "Baseline"},
                    "properties": [
                        {
                            "id": "links",
                            "value": [
                                {
                                    "title": "Open baseline definition",
                                    "url": "https://github.com/nguyen-anh-hao/trading-infra-deploy/blob/main/docs/BASELINES.md#${__field.labels.baseline}",
                                }
                            ],
                        }
                    ],
                },
                {
                    "matcher": {"id": "byName", "options": "Severity"},
                    "properties": [
                        {
                            "id": "mappings",
                            "value": [
                                {
                                    "type": "value",
                                    "options": {
                                        "critical": {"text": "critical", "color": "red", "index": 0},
                                        "warning": {"text": "warning", "color": "orange", "index": 1},
                                    },
                                }
                            ],
                        },
                        {"id": "custom.cellOptions", "value": {"type": "color-text"}},
                    ],
                },
            ],
        },
        "options": {"showHeader": True, "sortBy": [{"displayName": "Status", "desc": True}]},
    }



def _stat_panel(panel_id: int, title: str, expr: str, x: int, color: str) -> dict:
    return {
        "id": panel_id,
        "type": "stat",
        "title": title,
        "gridPos": {"h": 4, "w": 6, "x": x, "y": 0},
        "datasource": _ds(),
        "targets": [{"refId": "A", "datasource": _ds(), "expr": expr}],
        "fieldConfig": {
            "defaults": {
                "unit": "short",
                "color": {"mode": "fixed", "fixedColor": color},
                "thresholds": {"mode": "absolute", "steps": [{"color": color, "value": None}]},
            },
            "overrides": [],
        },
        "options": {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False}},
    }


def render_scorecard(baselines: list[dict]) -> str:
    selector = '{service=~"$service", category=~"$category", severity=~"$severity"}'
    dash = {
        "uid": "trading-baseline-scorecard",
        "title": "Trading — Baseline Scorecard",
        "description": "PASS/FAIL view of docs/baselines.yaml. Generated by scripts/render_baselines.py.",
        "tags": ["trading", "baseline", "slo"],
        "timezone": "browser",
        "schemaVersion": 39,
        "version": 1,
        "refresh": "10s",
        "time": {"from": "now-1h", "to": "now"},
        "links": [
            {
                "title": "Baseline documentation",
                "url": "https://github.com/nguyen-anh-hao/trading-infra-deploy/blob/main/docs/BASELINES.md",
                "targetBlank": True,
            }
        ],
        "templating": {
            "list": [
                {
                    "name": "service",
                    "label": "Service",
                    "type": "query",
                    "datasource": _ds(),
                    "query": "label_values(baseline:value, service)",
                    "includeAll": True,
                    "multi": True,
                    "refresh": 2,
                    "sort": 1,
                },
                {
                    "name": "category",
                    "label": "Category",
                    "type": "query",
                    "datasource": _ds(),
                    "query": "label_values(baseline:value, category)",
                    "includeAll": True,
                    "multi": True,
                    "refresh": 2,
                },
                {
                    "name": "severity",
                    "label": "Severity",
                    "type": "query",
                    "datasource": _ds(),
                    "query": "label_values(baseline:value, severity)",
                    "includeAll": True,
                    "multi": True,
                    "refresh": 2,
                },
            ]
        },
        "panels": [
            _stat_panel(10, "Baselines failing", f"sum(baseline:violation{selector}) or vector(0)", 0, "red"),
            _stat_panel(
                11,
                "Baselines passing",
                f"count(baseline:value{selector}) - sum(baseline:violation{selector}) or vector(0)",
                6,
                "green",
            ),
            _stat_panel(12, "Baselines evaluated", f"count(baseline:value{selector}) or vector(0)", 12, "blue"),
            _stat_panel(13, "Catalog entries", f"vector({len(baselines)})", 18, "text"),
            _table_panel(),
        ],
    }
    return json.dumps(dash, indent=2, ensure_ascii=False) + "\n"



def update_legend(dashboard_path: Path, content: str) -> str | None:
    if not dashboard_path.exists():
        return None
    dash = json.loads(dashboard_path.read_text(encoding="utf-8"))
    changed = False
    for panel in dash.get("panels", []):
        if panel.get("id") == 100 and panel.get("type") == "text":
            panel.setdefault("options", {})["content"] = content
            panel.setdefault("options", {})["mode"] = "markdown"
            panel.setdefault("gridPos", {})["h"] = 8
            changed = True
    return json.dumps(dash, indent=2, ensure_ascii=False) + "\n" if changed else None


def render_docs(baselines: list[dict]) -> str:
    lines = [
        "# Baseline catalog",
        "",
        "This file is generated from [`docs/baselines.yaml`](baselines.yaml) by",
        "`scripts/render_baselines.py`. Do not edit the catalog sections by hand.",
        "",
        "## How to use the baselines in Grafana",
        "",
        "- Open **Trading — Baseline Scorecard** for a PASS/FAIL table with the",
        "  current value, target, severity and a link back to this page.",
        "- Open **Trading — Service Detail** and pick a service: panels carry the",
        "  same thresholds and dashed baseline lines.",
        "- The **Baseline legend** at the top of each service dashboard is generated",
        "  from the `legend: true` entries in `baselines.yaml`.",
        "",
        "## The three tiers",
        "",
        "| Tier | Examples | Hardware independent? | Use as a dev gate? |",
        "|---|---|---|---|",
        "| Invariant | outbox age, UNKNOWN orders, WS drops, Kafka lag | Yes (correctness) | Yes |",
        "| Ratio | 5xx %, CPU throttle %, memory/limit, GC CPU %, p99/p50 | Yes (normalised) | Yes |",
        "| Absolute | p99 latency, throughput per vCPU | No (needs the same CPU quota) | Only with quota parity |",
        "",
        "### Reference numbers used above",
        "",
        "| Reference | Number | Source |",
        "|---|---|---|",
        "| 99.5% availability | 3.6 hours/month (18 seconds/hour) | Google SRE availability table |",
        "| 99.9% availability | 43.2 minutes/month (3.6 seconds/hour) | Google SRE availability table |",
        "| Fast burn alert | 14.4x over 1h, 6x over 6h, 1x over 3d | Google SRE Workbook ch.5 |",
        "| HIGH_FAST latency bucket | p90 100ms, p99 200ms at 99.9% | Google SRE Workbook Table 5-10 |",
        "| Matching reference ceiling | 6M orders/s on one thread (LMAX) | Martin Fowler, The LMAX Architecture |",
        "| Fluid interaction | ~100ms response | The Tail at Scale |",
        "",
        "## Catalog",
        "",
    ]

    categories = [
        ("availability", "Availability"),
        ("latency", "Latency and tail"),
        ("saturation", "Saturation and runtime"),
        ("pipeline", "Data pipeline"),
        ("business", "Business correctness"),
    ]
    for key, title in categories:
        rows = [b for b in baselines if b["category"] == key]
        if not rows:
            continue
        lines += [f"### {title}", ""]
        for item in rows:
            lines += [
                f'#### <a id="{item["id"]}"></a>{item["title"]}',
                "",
                f"- **Baseline:** `{item['comparator']} {fmt_number(item['target'])} {item['unit']}`",
                f"- **Severity:** `{item['severity']}`",
                f"- **Expression:** `{item['expr']}`",
                f"- **Source:** <{item['source']}>",
                "",
                item.get("description", ""),
                "",
            ]

    lines += [
        "## Dev gate",
        "",
        "1. Pin CPU/memory limits in `deployments/docker/docker-compose.local.yml`",
        "   so absolute latency is comparable between machines.",
        "2. Run `make baseline` (k6). The thresholds fail on error ratio, order p99",
        "   and the ticker p99; server-side invariants are shown on the scorecard.",
        "3. Treat any failing critical baseline as a release blocker. A dev machine",
        "   that fails an invariant/ratio baseline will also fail in production.",
        "",
        "## Sources",
        "",
        "The source URL is attached to every baseline above. Overview references:",
        "",
        "- Google SRE: four golden signals, SLO/availability table, overload, cascading failures",
        "- Google SRE Workbook: multi-window multi-burn-rate alerting, latency buckets",
        "- Brendan Gregg: USE method; Grafana: RED method",
        "- Prometheus: histograms, alerting practices",
        "- The Tail at Scale (Dean & Barroso), LMAX architecture",
        "- HikariCP, PostgreSQL, Redis, Kafka, NATS and Linux CFS documentation",
        "- Go GC guide and Oracle JVM GC tuning guide",
        "",
    ]
    return "\n".join(lines)


def build_outputs(baselines: list[dict]) -> dict[Path, str]:
    outputs: dict[Path, str] = {
        RULES: render_rules(baselines),
        SCORECARD: render_scorecard(baselines),
        DOCS: render_docs(baselines),
    }
    legend = legend_markdown(baselines)
    for path in LEGEND_DASHBOARDS:
        rendered = update_legend(path, legend)
        if rendered is not None:
            outputs[path] = rendered
    return outputs


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if generated files are stale")
    args = parser.parse_args()

    baselines = load_catalog()
    outputs = build_outputs(baselines)

    stale = []
    for path, content in outputs.items():
        current = path.read_text(encoding="utf-8") if path.exists() else None
        if current != content:
            stale.append(path)
            if not args.check:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8", newline="\n")
                print(f"wrote {path.relative_to(ROOT)}")

    if args.check:
        if stale:
            for path in stale:
                print(f"stale: {path.relative_to(ROOT)}", file=sys.stderr)
            print("run `make baseline-render` and commit the result", file=sys.stderr)
            return 1
        print(f"baseline artifacts are up to date ({len(baselines)} entries)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

