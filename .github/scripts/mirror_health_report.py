#!/usr/bin/env python3
"""Turn the latest _health_runs row into noise.

Reads the most recent weekly health check report (written by
workers/sync/health.js) from D1 over the Cloudflare HTTP API and:
  - writes a markdown summary to $GITHUB_STEP_SUMMARY;
  - writes the issue body to $REPORT_FILE;
  - prints `attention=true|false` and `title=...` to $GITHUB_OUTPUT.

Attention when anything was repaired, any table errored or raised an alert,
or there is no report from the last MAX_AGE_DAYS days (the cron did not run).

Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID,
     GITHUB_STEP_SUMMARY, GITHUB_OUTPUT, REPORT_FILE.
"""

import datetime as dt
import json
import os
import urllib.request

MAX_AGE_DAYS = 8
SQL = 'SELECT id, started_at, repaired, errors, alerts, report FROM "_health_runs" ORDER BY id DESC LIMIT 1'


def latest_run():
    url = (f"https://api.cloudflare.com/client/v4/accounts/{os.environ['CLOUDFLARE_ACCOUNT_ID']}"
           f"/d1/database/{os.environ['D1_DATABASE_ID']}/query")
    req = urllib.request.Request(url, data=json.dumps({"sql": SQL}).encode(), headers={
        "Authorization": f"Bearer {os.environ['CLOUDFLARE_API_TOKEN']}",
        "Content-Type": "application/json",
    })
    body = json.load(urllib.request.urlopen(req, timeout=60))
    rows = body["result"][0]["results"]
    return rows[0] if rows else None


def ids(xs, n=40):
    return ", ".join(map(str, xs[:n])) + (f", … (+{len(xs) - n})" if len(xs) > n else "")


def evaluate(run, now):
    """Return (attention, reasons) for the latest run (None = never ran)."""
    if run is None:
        return True, ["no health check run has ever been recorded"]
    reasons = []
    started = dt.datetime.fromisoformat(run["started_at"].replace("Z", "+00:00"))
    age = (now - started).days
    if age > MAX_AGE_DAYS:
        reasons.append(f"latest run is {age} days old (weekly cron missed?)")
    for key, label in (("repaired", "table(s) repaired"), ("errors", "error(s)"), ("alerts", "alert(s)")):
        if run[key]:
            reasons.append(f"{run[key]} {label}")
    return bool(reasons), reasons


def fmt(v):
    return "-" if v is None else str(v)


def table_row(t):
    action = "ok" if t["action"] == "ok" else f"**{t['action']}**"
    return (f"| {t['tag']} | {fmt(t['upstream'])} | {fmt(t['mirror'])} | {t['stale']} | {t['missing']} "
            f"| {len(t['deleted'])} | {len(t['inserted'])} | {fmt(t['rowCount'])} | {action} |")


def table_details(t):
    out = []
    if t["deleted"]:
        out.append(f"- **{t['tag']}** deleted stale: {ids(t['deleted'])}")
    if t["inserted"]:
        out.append(f"- **{t['tag']}** inserted missing: {ids(t['inserted'])}")
    out.extend(f"- **{t['tag']}** ALERT: {a}" for a in t["alerts"])
    if t["error"]:
        out.append(f"- **{t['tag']}** ERROR: {t['error']}")
    return out


def render(title, run, report):
    lines = [f"## {title}\n"]
    if report:
        lines.extend([
            f"Run `#{run['id']}` started {report['startedAt']}, finished {report['finishedAt']}.\n",
            "| table | upstream | mirror | stale | missing | deleted | inserted | row_count | action |",
            "|---|---:|---:|---:|---:|---:|---:|---:|---|",
        ])
        lines.extend(table_row(t) for t in report["tables"])
        details = [d for t in report["tables"] for d in table_details(t)]
        if details:
            lines.append("\n### Details\n")
            lines.extend(details)
    return "\n".join(lines) + "\n"


def main():
    run = latest_run()
    report = json.loads(run["report"]) if run else None
    attention, reasons = evaluate(run, dt.datetime.now(dt.timezone.utc))
    title = f"Mirror health: {'; '.join(reasons) if reasons else 'clean'}"
    body = render(title, run, report)

    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
        f.write(body)
    with open(os.environ["REPORT_FILE"], "w") as f:
        f.write(body)
    with open(os.environ["GITHUB_OUTPUT"], "a") as f:
        f.write(f"attention={'true' if attention else 'false'}\n")
        f.write(f"title={title}\n")
    print(title)


if __name__ == "__main__":
    main()
