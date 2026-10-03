"""Server-side quote-cache checks: read-path marks are delayed, fills stay live."""

import os
import tempfile
import time

import yfinance as yf

os.environ["PAPERTRADE_DB"] = tempfile.mktemp(suffix=".db")

import papertrade as pt


class _FakeTicker:
    def __init__(self, *args, **kwargs):
        pass

    @property
    def info(self):
        return {"bid": 99.0, "ask": 101.0}


calls = []


def _stub_live(symbol):
    calls.append(symbol)
    return 100.0


_real_ticker, _real_live = yf.Ticker, pt.live_price
yf.Ticker = _FakeTicker
pt.live_price = _stub_live
try:
    pt.clear_quote_cache()

    first = pt.latest_quote("AAPL")
    assert first["last"] == 100.0 and first["bid"] == 99.0, first
    assert calls == ["AAPL"], calls

    # Within the TTL: no new Yahoo/live_price work, same timestamp (delayed).
    second = pt.latest_quote("aapl")
    assert second["timestamp"] == first["timestamp"], (first, second)
    assert calls == ["AAPL"], calls

    # TTL expiry refetches.
    pt._QUOTE_CACHE["AAPL"] = (first, time.monotonic() - pt.QUOTE_TTL_SEC - 1)
    third = pt.latest_quote("AAPL")
    assert third["timestamp"] >= first["timestamp"], (first, third)
    assert calls == ["AAPL", "AAPL"], calls

    # Explicit clear refetches too.
    pt.clear_quote_cache()
    pt.latest_quote("AAPL")
    assert calls == ["AAPL", "AAPL", "AAPL"], calls

    # Outages are never cached: every failure retries live.
    pt.clear_quote_cache()
    pt.live_price = lambda s: (_ for _ in ()).throw(SystemExit("no price"))
    for _ in range(2):
        try:
            pt.latest_quote("MSFT")
            raise AssertionError("expected SystemExit")
        except SystemExit:
            pass
    assert "MSFT" not in pt._QUOTE_CACHE
finally:
    yf.Ticker = _real_ticker
    pt.live_price = _real_live
    pt.clear_quote_cache()

print("quote-cache checks passed")
