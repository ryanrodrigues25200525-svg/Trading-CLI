"""Rich-vs-OpenTUI parity: same SQLite book renders the same figures.

Seeds an isolated temp DB (never the real ~/.papertrade.db), drives a
realized gain plus pending stop / trailing-stop orders through the engine,
then compares the Rich dashboard text against the Bun TUI headless snapshot
(`bun tui/src/index.ts --headless --json snapshot`). Also pins the additive
`accounts --detail` plumbing the TUI relies on, the `tradingcli-tui` console
script, and `tradingcli dash [--rich] [-a] [-n]` delegation.

Run: python3 test_tui_parity.py (no pytest dependency, repo convention).
"""

import json
import io
import os
import subprocess
import sys
import tempfile
from pathlib import Path


root = Path(__file__).resolve().parent
tmp = tempfile.TemporaryDirectory()
os.environ["PAPERTRADE_DB"] = str(Path(tmp.name) / "parity.db")
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

import dashboard  # noqa: E402
import papertrade as pt  # noqa: E402
from rich.console import Console  # noqa: E402


def record_console():
    # Capture to a buffer: export_text() still works, but CI output stays clean.
    return Console(record=True, width=150, color_system=None, file=io.StringIO())


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "papertrade.py", *args],
        cwd=root,
        env={**os.environ},
        text=True,
        capture_output=True,
        check=False,
    )


def run_bun(*args):
    return subprocess.run(
        ["bun", *[str(root / "tui" / "src" / p) if p == "index.ts" else p for p in args]],
        cwd=root,
        env={**os.environ},
        text=True,
        capture_output=True,
        check=False,
    )


# --- seed: realized gain, no open positions (quote-independent totals) ---
conn = pt.db()
pt.create_account(conn, "parity", 25_000)
pt.fill(conn, "parity", "MSFT", "buy", 10, 100.0)
pt.fill(conn, "parity", "MSFT", "sell", 10, 110.0)
stop_id = pt.submit_order(
    conn, "parity", "MSFT", "sell", 5, order_type="stop", stop_price=95.0
)
trail_id = pt.submit_order(
    conn,
    "parity",
    "MSFT",
    "sell",
    5,
    order_type="trailing_stop",
    trail_percent=5.0,
    price_fn=lambda _symbol: 100.0,
)
conn.close()

EXPECTED_REALIZED = 100.0
EXPECTED_CASH = 25_100.0
EXPECTED_DEPOSITS = 25_000.0
EXPECTED_RET_PCT = EXPECTED_REALIZED / EXPECTED_DEPOSITS * 100  # 0.40%


def test_accounts_detail():
    """`accounts --detail` exposes deposits/realized; default shape is pinned."""
    default = json.loads(run_cli("accounts", "--json").stdout)
    check(
        default == [{"name": "parity", "cash": 25_000.0 + 100.0, "default": True}],
        f"default accounts shape changed (must stay byte-identical): {default}",
    )
    detailed = run_cli("accounts", "--detail", "--json")
    check(detailed.returncode == 0, f"accounts --detail failed: {detailed.stderr}")
    rows = json.loads(detailed.stdout)
    check(len(rows) == 1, f"expected one account, got {rows}")
    row = rows[0]
    check(row["name"] == "parity", f"wrong account: {row}")
    check(row["cash"] == EXPECTED_CASH, f"cash mismatch: {row}")
    check(
        row["deposits"] == EXPECTED_DEPOSITS and row["realized"] == EXPECTED_REALIZED,
        f"--detail must carry deposits/realized: {row}",
    )
    check("created" in row, f"--detail must carry created: {row}")
    csv_default = run_cli("accounts", "--csv").stdout
    check(
        csv_default.startswith("name,cash,default\n"),
        f"default --csv columns changed: {csv_default!r}",
    )
    csv_detail = run_cli("accounts", "--detail", "--csv").stdout
    check(
        "deposits" in csv_detail.splitlines()[0]
        and "realized" in csv_detail.splitlines()[0],
        f"--detail --csv must gain columns: {csv_detail!r}",
    )


def test_packaging_and_dash():
    """`tradingcli-tui` script exists; `dash` accepts --rich/-a/-n."""
    text = (root / "pyproject.toml").read_text()
    check('tradingcli-tui = "papertrade:main_tui_shim"' in text, "missing tradingcli-tui script")
    check("static/" not in text, "static/ must be dropped from wheel include")
    check(hasattr(pt, "main_tui_shim"), "missing papertrade.main_tui_shim")
    parser = pt._build_parser()
    dash_args = parser.parse_args(["dash", "--rich", "-a", "parity", "-n", "1.5"])
    check(
        dash_args.rich is True and dash_args.account == "parity" and dash_args.interval == 1.5,
        f"dash delegation flags not parsed: {dash_args}",
    )
    plain = parser.parse_args(["dash"])
    check(
        plain.rich is False and plain.account is None and plain.interval == 2.0,
        f"dash defaults wrong: {plain}",
    )


def render_rich_text():
    data, _symbols, default = dashboard.snapshot()
    recording = record_console()
    # No open positions, so quotes are irrelevant — outage map keeps it offline.
    recording.print(dashboard.render(data, {}, default))
    return recording.export_text()


def test_tui_parity():
    rich_text = render_rich_text()
    check("PARITY" in rich_text, "Rich render missing the parity account")
    check("25,100.00" in rich_text, "Rich render missing expected cash")
    check("MSFT" in rich_text, "Rich render missing MSFT symbol")
    check(f"#{stop_id}" in rich_text and "stop 95.00" in rich_text, "Rich missing stop label")
    check(f"#{trail_id}" in rich_text and "trail 5.00%" in rich_text, "Rich missing trail label")
    check("+100.00" in rich_text, "Rich render missing realized/total +100.00")
    check("(+0.40%)" in rich_text, "Rich render missing total +0.40%")

    proc = run_bun("index.ts", "--headless", "--json", "snapshot")
    check(proc.returncode == 0, f"TUI headless snapshot failed: {proc.stderr[-2000:]}")
    envelope = json.loads(proc.stdout)
    check(envelope.get("ok") is True, f"TUI snapshot not ok: {envelope}")
    panels = envelope["data"]["panels"]
    check(len(panels) == 1, f"expected one panel, got {len(panels)}")
    panel = panels[0]
    check(panel["name"] == "parity", f"TUI account name mismatch: {panel['name']}")
    check(panel["cash"] == EXPECTED_CASH, f"TUI cash {panel['cash']} != {EXPECTED_CASH}")
    check(
        panel["realized"] == EXPECTED_REALIZED,
        f"TUI realized {panel['realized']} != Rich +100.00",
    )
    check(
        panel["total"] == EXPECTED_REALIZED,
        f"TUI total {panel['total']} != Rich +100.00",
    )
    check(
        abs(panel["retPct"] - EXPECTED_RET_PCT) < 1e-9,
        f"TUI retPct {panel['retPct']} != Rich +0.40%",
    )
    check(
        panel["deposits"] == EXPECTED_DEPOSITS,
        f"TUI deposits {panel['deposits']} != {EXPECTED_DEPOSITS}",
    )
    check(panel["positions"] == [], f"TUI should show no positions: {panel['positions']}")
    tui_ids = sorted(o["id"] for o in panel["pending"])
    check(
        tui_ids == sorted([stop_id, trail_id]),
        f"TUI pending ids {tui_ids} != Rich #{stop_id}/#{trail_id}",
    )
    check(
        "MSFT" in envelope["data"]["quotes"],
        "TUI quotes map missing MSFT pending symbol",
    )


def test_backtesting_markers():
    """BACKTESTING markers present in both the Rich and TUI backtest views."""
    recording = record_console()
    recording.print(
        dashboard.backtesting_graphs_view(
            "parity",
            [],
            {
                "status": "no_positions",
                "start": "2021-10-03",
                "end": "2026-10-03",
                "message": "No open positions in this portfolio to backtest.",
                "symbols": [],
                "skipped": [],
                "hypothesis": "Today's open quantities and cash were held unchanged.",
                "commission_bps": 10,
                "warnings": [],
            },
        )
    )
    rich_text = recording.export_text()
    check("BACKTESTING & GRAPHS" in rich_text, "Rich backtest view missing marker")
    check("CURRENT PORTFOLIO BACKTEST" in rich_text, "Rich backtest view missing panel")

    engine_bt = run_cli("backtest", "-a", "parity", "--json")
    check(engine_bt.returncode == 0, f"backtest CLI failed: {engine_bt.stderr}")
    payload = json.loads(engine_bt.stdout)
    check(payload["status"] == "no_positions", f"unexpected backtest status: {payload}")
    render = subprocess.run(
        [
            "bun",
            "-e",
            "import { backtestLines } from './tui/src/views/BacktestView.tsx';"
            " const raw = await new Response(Bun.stdin.stream()).text();"
            " const bt = JSON.parse(raw);"
            " const lines = backtestLines({ account: bt.account ?? 'parity',"
            "  lookbackDays: bt.lookback_days ?? 1825, performance: [], backtest: bt });"
            " process.stdout.write(lines.join('\\n') + '\\n');",
        ],
        input=json.dumps(payload),
        cwd=root,
        env={**os.environ},
        text=True,
        capture_output=True,
        check=False,
    )
    check(render.returncode == 0, f"TUI backtestLines render failed: {render.stderr[-2000:]}")
    check("BACKTESTING & GRAPHS" in render.stdout, "TUI backtest view missing marker")
    check("CURRENT PORTFOLIO BACKTEST" in render.stdout, "TUI backtest view missing panel")


test_accounts_detail()
test_packaging_and_dash()
test_tui_parity()
test_backtesting_markers()
print("tui parity checks passed")
