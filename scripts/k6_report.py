#!/usr/bin/env python3
"""Turn k6 summary JSON into a measured metrics table and CV bullets.

The report deliberately refuses to invent numbers:
  * only metrics present in the JSON are shown;
  * a bullet is rendered only when every required metric exists and every
    threshold in every run passed;
  * by default at least three runs of the same scenario/profile are required.

Usage:
    python scripts/k6_report.py
    python scripts/k6_report.py --results stress/results --min-runs 3
    python scripts/k6_report.py --allow-single        # smoke run only
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

import yaml

OPERATIONS = [
    "ticker", "book", "trades_tape", "ohlcv", "balances", "positions", "pnl",
    "buying_power", "fee_tiers", "leaderboard", "ledger", "reference_price",
    "place_order", "modify_order", "cancel_order", "bulk_cancel",
    "open_orders", "order_history", "trades", "create_account",
    "create_api_key", "deposit", "withdraw", "settle", "settlement_ledger",
    "risk_check", "risk_reserve", "risk_release", "risk_balances",
    "risk_deposit", "matching_place", "matching_cancel", "matching_book",
    "matching_ticker", "accounting_summary", "accounting_counts",
    "promotion_fee_tiers", "promotion_leaderboard", "promotion_redeem",
    "promotion_faucet", "health", "metrics_scrape",
]

DISPLAY = {
    "http_rps": "HTTP throughput",
    "http_failed_ratio": "Failed HTTP requests",
    "checks_ratio": "Check pass ratio",
    "place_order_rps": "Orders placed",
    "place_order_p99_ms": "Place-order p99",
    "modify_order_p99_ms": "Modify-order p99",
    "cancel_order_p99_ms": "Cancel-order p99",
    "open_orders_p99_ms": "Open-orders read p99",
    "ticker_p99_ms": "Ticker p99",
    "book_p99_ms": "Order-book p99",
    "trades_tape_p99_ms": "Trade-tape p99",
    "ohlcv_p99_ms": "OHLCV p99",
    "settle_rate": "Settlements",
    "settle_p99_ms": "Settlement p99",
    "invoices_checked": "Trades verified in the journal",
    "ledger_balanced": "Journal balanced",
    "matching_p99_ms": "Matching p99 (server)",
    "matching_place_p99_ms": "Matching HTTP p99",
    "trades_per_s": "Executed trades",
    "fill_ratio": "Crossing order fill ratio",
    "risk_check_p99_ms": "Risk check p99",
    "risk_reserve_p99_ms": "Risk reserve p99",
    "overdraw_success": "Reservations accepted",
    "overdraw_conflict": "Reservations rejected (409)",
    "journal_lag_p95_s": "Risk journal lag p95",
    "replay_same_order": "Replays returning the same order",
    "duplicate_conflicts": "Duplicate claims rejected (409)",
    "accounting_summary_p99_ms": "Accounting summary p99",
    "accounting_counts_p99_ms": "Trade-counts p99",
    "freshness_p95_ms": "Settlement -> aggregate p95",
    "freshness_p99_ms": "Settlement -> aggregate p99",
    "freshness_timeouts": "Freshness timeouts",
    "gateway_flood_allowed": "Flood clients allowed",
    "gateway_control_allowed": "Control client allowed",
    "gateway_429": "Rate-limited responses (429)",
    "ws_sessions": "WebSocket sessions",
    "ws_connections_max": "WebSocket connections (server max)",
    "ws_handshake_p95_ms": "WebSocket handshake p95",
    "ws_messages_per_s": "WebSocket messages",
    "ws_snapshot_ok": "Snapshot on connect",
    "ws_dropped_per_s": "Dropped WebSocket frames/s",
    "fee_tiers_p99_ms": "Fee-tier p99",
    "leaderboard_p99_ms": "Leaderboard p99",
    "redeem_p99_ms": "Voucher redemption p99",
    "redeem_rate": "Voucher redemptions",
    "redeem_accepted_ratio": "Voucher accepted ratio",
    "redeem_rejected": "Voucher rejected",
}

SLO = {
    "place_order_p99_ms": "<= 500 ms",
    "modify_order_p99_ms": "<= 500 ms",
    "cancel_order_p99_ms": "<= 500 ms",
    "open_orders_p99_ms": "<= 300 ms",
    "ticker_p99_ms": "<= 200 ms",
    "book_p99_ms": "<= 300 ms",
    "trades_tape_p99_ms": "<= 300 ms",
    "ohlcv_p99_ms": "<= 300 ms",
    "settle_p99_ms": "<= 500 ms",
    "matching_p99_ms": "<= 5 ms",
    "journal_lag_p95_s": "<= 30 s",
    "ledger_balanced": "== 100%",
    "ws_snapshot_ok": ">= 99%",
    "ws_dropped_per_s": "== 0",
    "freshness_timeouts": "== 0",
    "http_failed_ratio": "<= 0.5%",
    "checks_ratio": ">= 99%",
}

PERCENT_KEYS = {
    "http_failed_ratio", "checks_ratio", "ledger_balanced", "replay_same_order",
    "fill_ratio", "gateway_flood_allowed", "gateway_control_allowed",
    "ws_snapshot_ok", "redeem_accepted_ratio", "ws_session_errors",
}

COUNT_KEYS = {
    "invoices_checked", "trades_checked", "overdraw_success", "overdraw_conflict",
    "duplicate_conflicts", "gateway_429", "ws_sessions", "ws_connections_max",
    "freshness_timeouts", "redeem_rejected", "run_count",
}


def metric_values(summary: dict, name: str) -> dict:
    metric = (summary.get("metrics") or {}).get(name)
    if not metric:
        return {}
    return metric.get("values") or {}


def value(summary: dict, name: str, stat: str):
    raw = metric_values(summary, name).get(stat)
    if raw is None:
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def threshold_failures(summary: dict) -> list[str]:
    failures = []
    for name, metric in (summary.get("metrics") or {}).items():
        for expr, state in (metric.get("thresholds") or {}).items():
            if not state.get("ok"):
                failures.append(name + " " + expr)
    return failures


def normalize(summary: dict) -> dict:
    """Flatten one k6 summary into stable, report-friendly keys."""
    out = {}
    out["http_rps"] = value(summary, "http_reqs", "rate")
    out["http_failed_ratio"] = value(summary, "http_req_failed", "rate")
    out["checks_ratio"] = value(summary, "checks", "rate")

    for op in OPERATIONS:
        trend = value(summary, "op_" + op + "_ms", "p(99)")
        rate = value(summary, "cnt_" + op + "_total", "rate")
        if trend is not None:
            out[op + "_p99_ms"] = trend
        if rate is not None:
            out[op + "_rps"] = rate

    out["place_order_p99_ms"] = value(summary, "op_place_order_ms", "p(99)")
    out["modify_order_p99_ms"] = value(summary, "op_modify_order_ms", "p(99)")
    out["cancel_order_p99_ms"] = value(summary, "op_cancel_order_ms", "p(99)")
    out["open_orders_p99_ms"] = value(summary, "op_open_orders_ms", "p(99)")
    out["ticker_p99_ms"] = value(summary, "op_ticker_ms", "p(99)")
    out["book_p99_ms"] = value(summary, "op_book_ms", "p(99)")
    out["trades_tape_p99_ms"] = value(summary, "op_trades_tape_ms", "p(99)")
    out["ohlcv_p99_ms"] = value(summary, "op_ohlcv_ms", "p(99)")
    out["place_order_rps"] = value(summary, "cnt_place_order_total", "rate")
    out["settle_rate"] = value(summary, "cnt_settle_total", "rate")
    out["settle_p99_ms"] = value(summary, "op_settle_ms", "p(99)")
    out["matching_place_p99_ms"] = value(summary, "op_matching_place_ms", "p(99)")

    out["invoices_checked"] = value(summary, "ledger_trades_checked_total", "count")
    out["ledger_balanced"] = value(summary, "ledger_balanced", "rate")
    out["matching_p99_ms"] = value(summary, "prom_matching_p99_ms", "med")
    out["trades_per_s"] = value(summary, "prom_matching_trades_per_s", "avg")
    out["fill_ratio"] = value(summary, "order_fill_ratio", "rate")
    out["risk_check_p99_ms"] = value(summary, "op_risk_check_ms", "p(99)")
    out["risk_reserve_p99_ms"] = value(summary, "op_risk_reserve_ms", "p(99)")
    out["overdraw_success"] = value(summary, "overdraw_success_total", "count")
    out["overdraw_conflict"] = value(summary, "overdraw_conflict_total", "count")
    out["journal_lag_p95_s"] = value(summary, "prom_risk_journal_lag_s", "p(95)")
    out["replay_same_order"] = value(summary, "replay_same_order", "rate")
    out["duplicate_conflicts"] = value(summary, "duplicate_conflict_total", "count")
    out["accounting_summary_p99_ms"] = value(summary, "op_accounting_summary_ms", "p(99)")
    out["accounting_counts_p99_ms"] = value(summary, "op_accounting_counts_ms", "p(99)")
    out["freshness_p95_ms"] = value(summary, "accounting_lag_ms", "p(95)")
    out["freshness_p99_ms"] = value(summary, "accounting_lag_ms", "p(99)")
    out["freshness_timeouts"] = value(summary, "accounting_freshness_timeout_total", "count")
    out["gateway_flood_allowed"] = value(summary, "gateway_flood_allowed", "rate")
    out["gateway_control_allowed"] = value(summary, "gateway_control_allowed", "rate")
    out["gateway_429"] = value(summary, "gateway_429_total", "count")
    out["ws_sessions"] = value(summary, "ws_sessions_total", "count")
    out["ws_handshake_p95_ms"] = value(summary, "ws_handshake_ms", "p(95)")
    out["ws_messages_per_s"] = value(summary, "ws_messages_total", "rate")
    out["ws_snapshot_ok"] = value(summary, "ws_snapshot_ok", "rate")
    out["ws_connections_max"] = value(summary, "prom_ws_connections", "max")
    out["ws_dropped_per_s"] = value(summary, "prom_ws_dropped_per_s", "max")
    out["fee_tiers_p99_ms"] = value(summary, "op_promotion_fee_tiers_ms", "p(99)")
    out["leaderboard_p99_ms"] = value(summary, "op_promotion_leaderboard_ms", "p(99)")
    out["redeem_p99_ms"] = value(summary, "op_promotion_redeem_ms", "p(99)")
    out["redeem_rate"] = value(summary, "cnt_promotion_redeem_total", "rate")
    out["redeem_accepted_ratio"] = value(summary, "promotion_redeem_accepted", "rate")
    out["redeem_rejected"] = value(summary, "promotion_redeem_rejected_total", "count")

    return {k: v for k, v in out.items() if v is not None}


def fmt(key: str, raw) -> str:
    if raw is None:
        return "n/a"
    if key in PERCENT_KEYS:
        return f"{raw * 100:.2f}%"
    if key in COUNT_KEYS:
        return f"{int(round(raw))}"
    units = {
        "http_rps": "req/s",
        "place_order_rps": "orders/s",
        "settle_rate": "settlements/s",
        "trades_per_s": "trades/s",
        "ws_messages_per_s": "messages/s",
        "redeem_rate": "redemptions/s",
    }
    if key in units:
        return f"{raw:.1f} {units[key]}"
    if key.endswith("_per_s"):
        return f"{raw:.1f}/s"
    if key.endswith("_ms"):
        return f"{raw:.1f} ms"
    if key.endswith("_s"):
        return f"{raw:.2f} s"
    return f"{raw:.2f}"


def slo_ok(key: str, raw):
    spec = SLO.get(key)
    if spec is None or raw is None:
        return None
    try:
        op, target = spec.split(maxsplit=1)
        target_value = float(target.replace("%", "").replace("ms", "").replace("s", "").strip())
    except (ValueError, AttributeError):
        return None
    observed = raw * 100 if "%" in spec else raw
    if op == "<=":
        return observed <= target_value
    if op == "<":
        return observed < target_value
    if op == ">=":
        return observed >= target_value
    if op == ">":
        return observed > target_value
    if op == "==":
        return abs(observed - target_value) < 1e-9
    return None


def load_runs(results_dir: Path) -> list[dict]:
    runs = []
    for path in sorted(results_dir.glob("*.json")):
        try:
            summary = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"skip {path.name}: {exc}", file=sys.stderr)
            continue
        context = summary.get("context") or {}
        if not context or "metrics" not in summary:
            print(f"skip {path.name}: not a summary produced by stress/lib/summary.js", file=sys.stderr)
            continue
        runs.append(
            {
                "path": path,
                "summary": summary,
                "scenario": context.get("scenario") or path.stem.split("-")[0],
                "profile": context.get("profile") or "default",
                "git_sha": context.get("gitSha") or "unknown",
                "config": context.get("config") or {},
                "values": normalize(summary),
                "failures": threshold_failures(summary),
                "duration_s": (summary.get("state") or {}).get("testRunDurationMs", 0) / 1000.0,
            }
        )
    return runs


def aggregate(runs: list[dict]) -> dict:
    groups = {}
    for run in runs:
        groups.setdefault((run["scenario"], run["profile"]), []).append(run)

    out = {}
    for key, group in groups.items():
        common = set(group[0]["values"])
        for run in group[1:]:
            common &= set(run["values"])
        values = {metric: statistics.median(run["values"][metric] for run in group) for metric in common}
        durations = [run["duration_s"] for run in group if run["duration_s"] > 0]
        values["run_count"] = float(len(group))
        values["duration_s"] = statistics.median(durations) if durations else 0.0
        failures = sorted({failure for run in group for failure in run["failures"]})
        config = {}
        for run in group:
            for name, val in run["config"].items():
                if val is not None and name not in config:
                    config[name] = val
        out[key] = {
            "scenario": key[0],
            "profile": key[1],
            "runs": group,
            "values": values,
            "failures": failures,
            "config": config,
            "git_shas": sorted({run["git_sha"] for run in group}),
        }
    return out




def template_context(group: dict) -> dict:
    values = group["values"]
    ctx = {name: fmt(name, raw) for name, raw in values.items()}
    ctx["run_count"] = str(int(values.get("run_count", 0)))
    ctx["duration_s"] = f"{values.get('duration_s', 0):.0f}"
    ctx["profile"] = group["profile"]
    ctx["git_sha"] = ", ".join(group["git_shas"])
    limits = {
        "rateLimitPerSec": "limit_per_sec",
        "floodClients": "flood_clients",
        "replays": "replays",
        "duplicates": "duplicates",
        "overdrawVus": "overdraw_vus",
        "wsClients": "ws_clients_config",
        "trades": "trades",
        "accounts": "accounts",
        "seconds": "seconds",
    }
    for config_name, key in limits.items():
        raw = group["config"].get(config_name)
        if raw is not None:
            ctx[key] = str(raw)
    return ctx


def render_template(template: str, ctx: dict, requires: list[str], present: set) -> str | None:
    if any(key not in present for key in requires):
        return None
    text = template
    for key, val in ctx.items():
        text = text.replace("{{" + key + "}}", val)
    return " ".join(text.split())


def markdown_table(group: dict) -> str:
    values = group["values"]
    keys = [key for key in DISPLAY if key in values]
    lines = ["| Metric | Median | SLO | Verdict |", "| --- | ---: | --- | --- |"]
    for key in keys:
        raw = values[key]
        verdict = slo_ok(key, raw)
        verdict_text = "PASS" if verdict is True else "FAIL" if verdict is False else "â€”"
        lines.append(
            "| " + DISPLAY.get(key, key) + " | " + fmt(key, raw) + " | "
            + SLO.get(key, "â€”") + " | " + verdict_text + " |"
        )
    return "\n".join(lines)


def render_markdown(groups: dict, templates: list[dict], min_runs: int, runs: int) -> tuple[str, str]:
    lines = [
        "# Measured CV metrics",
        "",
        f"Generated from {runs} k6 summary file(s); at least {min_runs} run(s) per scenario/profile are required.",
        "",
        "> Only numbers that k6 actually measured are shown. A bullet is omitted when a required metric is missing or any threshold failed.",
        "",
    ]
    bullet_lines = ["# CV bullets (auto-filled from measured runs)", ""]
    unmeasured = []

    for key in sorted(groups):
        group = groups[key]
        values = group["values"]
        qualifies = len(group["runs"]) >= min_runs and not group["failures"]
        verdict = "PASS" if qualifies else ("INSUFFICIENT RUNS" if len(group["runs"]) < min_runs else "THRESHOLD FAILED")
        lines.append("## " + group["scenario"] + " (profile: " + group["profile"] + ")")
        lines.append("")
        lines.append(
            f"Verdict: **{verdict}** â€” {len(group['runs'])} run(s), "
            f"{values.get('duration_s', 0):.0f}s per run, git `{', '.join(group['git_shas'])}`."
        )
        if group["failures"]:
            lines.append("")
            lines.append("Failed thresholds: `" + "`, `".join(group["failures"]) + "`.")
        lines.append("")
        lines.append(markdown_table(group))
        lines.append("")

        matching = [
            t for t in templates
            if t.get("scenario") == group["scenario"]
            and (not t.get("profile") or t.get("profile") == group["profile"])
        ]
        if matching:
            bullet_lines.append("## " + group["scenario"] + " (" + group["profile"] + ")")
            bullet_lines.append("")
            rendered = 0
            for template in matching:
                requires = template.get("requires") or []
                ctx = template_context(group)
                text = render_template(
                    template.get("template", ""),
                    ctx,
                    requires,
                    set(values) | set(ctx),
                )
                if text is None:
                    missing = [name for name in requires if name not in values]
                    unmeasured.append(
                        f"- `{template.get('id')}` ({group['scenario']}/{group['profile']}): missing `"
                        + "`, `".join(missing) + "`"
                    )
                    continue
                if not qualifies:
                    unmeasured.append(
                        f"- `{template.get('id')}` ({group['scenario']}/{group['profile']}): run not qualified ({verdict})"
                    )
                    continue
                bullet_lines.append("- " + text)
                rendered += 1
            bullet_lines.append("" if rendered else "_No bullet rendered: see the unmeasured list._")
            bullet_lines.append("")

    if len(bullet_lines) == 2:
        bullet_lines.append("_No qualified runs yet. Run each scenario at least " + str(min_runs) + " time(s)._")
        bullet_lines.append("")
    if unmeasured:
        bullet_lines.append("## Not claimed")
        bullet_lines.append("")
        bullet_lines.extend(sorted(set(unmeasured)))
        bullet_lines.append("")

    return "\n".join(lines), "\n".join(bullet_lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Render measured k6 metrics and CV bullets.")
    parser.add_argument("--results", default="stress/results", help="directory with k6 summary JSON")
    parser.add_argument("--templates", default="stress/cv_templates.yaml", help="CV bullet templates")
    parser.add_argument("--out", default=None, help="metrics markdown output")
    parser.add_argument("--bullets-out", default=None, help="CV bullets markdown output")
    parser.add_argument("--json-out", default=None, help="normalized JSON output")
    parser.add_argument("--min-runs", type=int, default=3, help="runs required per scenario/profile")
    parser.add_argument("--allow-single", action="store_true", help="accept one run per scenario/profile")
    parser.add_argument("--profile", default=None, help="only report this profile")
    args = parser.parse_args()

    results_dir = Path(args.results)
    if not results_dir.is_dir():
        print(f"results directory not found: {results_dir}", file=sys.stderr)
        return 1

    min_runs = 1 if args.allow_single else max(1, args.min_runs)
    runs = load_runs(results_dir)
    if args.profile:
        runs = [run for run in runs if run["profile"] == args.profile]
    if not runs:
        print(f"no k6 summary files in {results_dir}", file=sys.stderr)
        return 1

    groups = aggregate(runs)
    templates_path = Path(args.templates)
    templates = []
    if templates_path.is_file():
        doc = yaml.safe_load(templates_path.read_text(encoding="utf-8-sig")) or {}
        templates = doc.get("templates") or []
    else:
        print(f"template file not found: {templates_path}", file=sys.stderr)

    metrics_md, bullets_md = render_markdown(groups, templates, min_runs, len(runs))

    out_path = Path(args.out) if args.out else results_dir / "cv-metrics.md"
    bullets_path = Path(args.bullets_out) if args.bullets_out else results_dir / "cv-bullets.md"
    out_path.write_text(metrics_md, encoding="utf-8")
    bullets_path.write_text(bullets_md, encoding="utf-8")

    if args.json_out:
        payload = {}
        for (scenario, profile), group in groups.items():
            payload.setdefault(scenario, {})[profile] = {
                "runs": len(group["runs"]),
                "git_shas": group["git_shas"],
                "threshold_failures": group["failures"],
                "values": group["values"],
                "config": group["config"],
            }
        Path(args.json_out).write_text(json.dumps(payload, indent=2), encoding="utf-8")

    print(f"wrote {out_path}")
    print(f"wrote {bullets_path}")
    qualified = [key for key, group in groups.items() if len(group["runs"]) >= min_runs and not group["failures"]]
    print(f"qualified scenario/profile groups: {len(qualified)}/{len(groups)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

