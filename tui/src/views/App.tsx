// Dashboard root: logo banner, market-clock strip, per-account panels,
// refresh scheduler, and the full keymap. Mutation keys (b/s/o/c/n/e/u)
// suspend the live loop and open an OrderModal; `g` opens the backtest flow;
// success runs the mutation then one re-snapshot (no `sleep`). Esc aborts
// with no CLI call. First launch with zero accounts + no `setup_done` opens
// the setup wizard instead of an empty dashboard.

import { useCallback, useEffect, useRef, useState } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import { EngineError, runCli, tick } from "../engine";
import { loadSnapshot, type DashboardSnapshot } from "../store";
import type { EngineOpts, SpawnFn } from "../types";
import { BacktestPrompt, BacktestView, type BacktestData } from "./BacktestView";
import { OrderModal, needsFirstRun, type OrderModalKind } from "./OrderModal";
import { PortfolioPanels, YELLOW } from "./PortfolioPanels";
import { LOGO, StatusBar } from "./StatusBar";

export type ModalState =
  | { view: "order"; kind: OrderModalKind }
  | { view: "backtest-prompt" }
  | { view: "backtest"; data: BacktestData }
  | { view: "setup" };

/**
 * Collapse a raw engine error for the one-line error panel. Single-line
 * errors pass through; multi-line dumps (e.g. a yfinance traceback) collapse
 * to the informative last line; known transient states get a human sentence.
 */
export function shortError(message: string): string {
  const clean = message.trim();
  if (/YFRateLimitError|Rate limited|Too Many Requests|\b429\b/.test(clean)) {
    return "Yahoo Finance is rate-limiting quotes — showing last data; pending orders fill when quotes return.";
  }
  if (/database is (locked|busy)/i.test(clean)) return "Database busy — retrying…";
  const lines = clean
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const oneLine = lines.length <= 2 ? clean : (lines[lines.length - 1] ?? clean);
  return oneLine.length > 210 ? `${oneLine.slice(0, 209)}…` : oneLine;
}

export interface AppProps {
  account?: string;
  /** Refresh cadence in seconds (mirrors `-n`, default 2.0). */
  intervalSec?: number;
  spawn?: SpawnFn;
  /** Injectable loader (tests bypass the engine). Defaults to loadSnapshot. */
  loader?: (prev: Record<string, number>) => Promise<DashboardSnapshot>;
  /** Injectable tick (tests bypass the engine). Defaults to engine tick. */
  ticker?: () => Promise<unknown>;
  /** Injectable first-run gate (tests bypass the engine). */
  checkFirstRun?: (opts: EngineOpts) => Promise<boolean>;
  onQuit?: () => void;
}

export function App({
  account,
  intervalSec = 2.0,
  spawn,
  loader,
  ticker,
  checkFirstRun,
  onQuit,
}: AppProps) {
  const renderer = useRenderer();
  const [snap, setSnap] = useState<DashboardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);
  const prevRef = useRef<Record<string, number>>({});
  const loadRef = useRef(loader);
  loadRef.current = loader;
  const tickRef = useRef(ticker);
  tickRef.current = ticker;
  const gateRef = useRef(checkFirstRun);
  gateRef.current = checkFirstRun;
  const gatedRef = useRef(false);
  const mountedRef = useRef(false);

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
      // A successful refresh clears hard errors. A failed auto-tick does not
      // raise here — it rides along on the snapshot as a subtle notice below.
      setError(null);
    } catch (e) {
      const message = e instanceof EngineError ? e.message : String(e);
      setError(message); // keep the last good frame underneath
    }
  }, [account, spawn]);

  const tickNow = useCallback(async () => {
    try {
      await (tickRef.current ?? (() => tick({ spawn })))();
    } catch (e) {
      const message = e instanceof EngineError ? e.message : String(e);
      setError(message);
      return;
    }
    await refresh();
  }, [refresh, spawn]);

  // First-run wizard gate: zero accounts + no `setup_done` → onboard once.
  useEffect(() => {
    if (gatedRef.current) return;
    gatedRef.current = true;
    (gateRef.current ?? needsFirstRun)({ spawn }).then(
      (need) => {
        if (need) setModal({ view: "setup" });
      },
      () => {},
    );
  }, [spawn]);

  useEffect(() => {
    if (modal !== null) return; // suspended while a modal/view owns the screen
    // Immediate refresh only on mount; modal close paths refresh explicitly
    // (abort/return) or already refreshed (mutation success), so resuming the
    // loop never double-refreshes.
    if (!mountedRef.current) {
      mountedRef.current = true;
      void refresh();
    }
    const timer = setInterval(() => void refresh(), Math.max(intervalSec, 0.25) * 1000);
    return () => clearInterval(timer);
  }, [refresh, intervalSec, modal]);

  /** Open a mutation modal (suspends the refresh loop until it closes). */
  const openOrderModal = useCallback((kind: OrderModalKind) => {
    setModal({ view: "order", kind });
  }, []);

  const closeModal = useCallback(() => {
    setModal(null); // abort path: no CLI call was made
  }, []);

  const closeModalRefresh = useCallback(() => {
    setModal(null);
    void refresh(); // abort/return path: one fresh read, no mutation happened
  }, [refresh]);

  // Success path: submitModal already ran exactly one re-snapshot via
  // `modalDeps.resnapshot`, so closing needs no second refresh (no sleep).
  // Engine wiring for the modals: mutations go through the CLI bridge with
  // the App's spawn, then one refresh.
  const modalDeps = {
    run: (argv: string[]) => runCli(argv, { spawn }),
    resnapshot: () => refresh(),
  };

  useKeyboard((key) => {
    if (modal !== null) return; // the modal/view owns the keyboard (Esc aborts)
    switch (key.name) {
      case "q":
        if (onQuit) onQuit();
        else renderer.destroy();
        break;
      case "r":
        void refresh();
        break;
      case "t":
        void tickNow();
        break;
      case "b":
        openOrderModal("buy");
        break;
      case "s":
        openOrderModal("sell");
        break;
      case "o":
        openOrderModal("option");
        break;
      case "c":
        openOrderModal("cancel");
        break;
      case "n":
        openOrderModal("new");
        break;
      case "e":
        openOrderModal("rename");
        break;
      case "u":
        openOrderModal("switch");
        break;
      case "g":
        setModal({ view: "backtest-prompt" });
        break;
    }
  });

  const defaultName = snap?.panels.find((p) => p.isDefault)?.name ?? account;

  return (
    <box flexDirection="column" gap={1}>
      <text fg="#ff2b4a">{LOGO}</text>
      {error !== null ? (
        <box border borderStyle="single" borderColor="red" padding={1}>
          <text fg="red">engine error: {shortError(error)}</text>
        </box>
      ) : null}
      {snap === null ? (
        <text>loading…</text>
      ) : (
        <box flexDirection="column">
          <StatusBar clock={snap.clock} asOf={snap.asOf} />
          {snap.tickError !== null ? (
            <text fg={YELLOW}>◌ {shortError(snap.tickError)}</text>
          ) : null}
          <PortfolioPanels panels={snap.panels} />
        </box>
      )}
      {modal?.view === "order" ? (
        <OrderModal
          kind={modal.kind}
          defaultAccount={defaultName}
          deps={modalDeps}
          onClose={closeModalRefresh}
          onSuccess={closeModal}
        />
      ) : null}
      {modal?.view === "setup" ? (
        <OrderModal
          kind="setup"
          deps={modalDeps}
          onClose={closeModalRefresh}
          onSuccess={closeModal}
        />
      ) : null}
      {modal?.view === "backtest-prompt" ? (
        <BacktestPrompt
          defaultAccount={defaultName}
          spawn={spawn}
          onClose={closeModalRefresh}
          onPick={(data) => setModal({ view: "backtest", data })}
        />
      ) : null}
      {modal?.view === "backtest" ? (
        <BacktestView data={modal.data} onClose={closeModalRefresh} />
      ) : null}
    </box>
  );
}
