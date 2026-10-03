// Dashboard root: logo banner, market-clock strip, per-account panels,
// refresh scheduler, and the read-only keymap (`t` tick, `r` refresh,
// `q` quit). Mutation keys (b/s/o/g/c/n/e/u) land in Task 3.

import { useCallback, useEffect, useRef, useState } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import { EngineError, tick } from "../engine";
import { loadSnapshot, type DashboardSnapshot } from "../store";
import type { SpawnFn } from "../types";
import { PortfolioPanels } from "./PortfolioPanels";
import { LOGO, StatusBar } from "./StatusBar";

export interface AppProps {
  account?: string;
  /** Refresh cadence in seconds (mirrors `-n`, default 2.0). */
  intervalSec?: number;
  spawn?: SpawnFn;
  /** Injectable loader (tests bypass the engine). Defaults to loadSnapshot. */
  loader?: (prev: Record<string, number>) => Promise<DashboardSnapshot>;
  /** Injectable tick (tests bypass the engine). Defaults to engine tick. */
  ticker?: () => Promise<unknown>;
  onQuit?: () => void;
}

export function App({ account, intervalSec = 2.0, spawn, loader, ticker, onQuit }: AppProps) {
  const renderer = useRenderer();
  const [snap, setSnap] = useState<DashboardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prevRef = useRef<Record<string, number>>({});
  const loadRef = useRef(loader);
  loadRef.current = loader;
  const tickRef = useRef(ticker);
  tickRef.current = ticker;

  const refresh = useCallback(async () => {
    try {
      const load =
        loadRef.current ??
        ((prev: Record<string, number>) => loadSnapshot({ account, prev, spawn }));
      const next = await load(prevRef.current);
      // Keep the last good price per symbol (mirror `prev = prices or prev`).
      const merged = { ...prevRef.current };
      for (const symbol of Object.keys(next.quotes)) {
        const quote = next.quotes[symbol];
        if (quote !== null && quote !== undefined) merged[symbol] = quote[0];
      }
      prevRef.current = merged;
      setSnap(next);
      setError(null);
    } catch (e) {
      const message = e instanceof EngineError ? e.message : String(e);
      setError(message); // keep the last good frame underneath
    }
  }, [account, spawn]);

  const tickNow = useCallback(async () => {
    try {
      await (tickRef.current ?? (() => tick({ spawn })) )();
    } catch (e) {
      const message = e instanceof EngineError ? e.message : String(e);
      setError(message);
      return;
    }
    await refresh();
  }, [refresh, spawn]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), Math.max(intervalSec, 0.25) * 1000);
    return () => clearInterval(timer);
  }, [refresh, intervalSec]);

  useKeyboard((key) => {
    if (key.name === "q") {
      if (onQuit) onQuit();
      else renderer.destroy();
    } else if (key.name === "r") {
      void refresh();
    } else if (key.name === "t") {
      void tickNow();
    }
  });

  return (
    <box flexDirection="column">
      <text>{LOGO}</text>
      {error !== null ? (
        <box border borderStyle="single">
          <text>engine error: {error}</text>
        </box>
      ) : null}
      {snap === null ? (
        <text>loading…</text>
      ) : (
        <box flexDirection="column">
          <StatusBar clock={snap.clock} asOf={snap.asOf} />
          <PortfolioPanels panels={snap.panels} />
        </box>
      )}
    </box>
  );
}
