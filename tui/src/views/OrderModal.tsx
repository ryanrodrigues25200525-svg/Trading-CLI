// OrderModal: mutation forms (buy/sell/option/cancel/new/rename/switch) plus
// the first-run setup wizard. Text ports of dashboard.py `prompt_*` and
// `first_run_setup`: same fields, same inline validation messages, Esc aborts
// with no CLI call, success runs the mutation then exactly one re-snapshot
// (no `sleep`). Pure logic (validate/build/submit) is UI-free so tests drive
// it without a renderer; the React component below is a thin form over it.

import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { runCli } from "../engine";
import type { EngineOpts } from "../types";

export type OrderModalKind =
  | "buy"
  | "sell"
  | "option"
  | "cancel"
  | "new"
  | "rename"
  | "switch"
  | "setup";

export interface ModalFields {
  account: string;
  symbol: string;
  qty: string;
  limit: string;
  side: string;
  underlying: string;
  expiry: string;
  optionKind: string;
  strike: string;
  contracts: string;
  orderId: string;
  name: string;
  cash: string;
  oldName: string;
  newName: string;
  profile: string;
}

export function emptyFields(): ModalFields {
  return {
    account: "",
    symbol: "",
    qty: "",
    limit: "",
    side: "buy",
    underlying: "",
    expiry: "",
    optionKind: "C",
    strike: "",
    contracts: "",
    orderId: "",
    name: "",
    cash: "",
    oldName: "",
    newName: "",
    profile: "standard",
  };
}

export function modalTitle(kind: OrderModalKind): string {
  switch (kind) {
    case "buy":
      return "▚ Buy order";
    case "sell":
      return "▚ Sell order";
    case "option":
      return "▚ Option order";
    case "cancel":
      return "▚ Cancel order";
    case "new":
      return "▚ New paper portfolio";
    case "rename":
      return "▚ Rename portfolio";
    case "switch":
      return "▚ Switch default";
    case "setup":
      return "Welcome to tradingcli";
  }
}

/** Mirror of `prompt_*` numeric parsing: blank limit is "market", else a number. */
function parseNum(raw: string): number | null {
  const cleaned = raw.trim().replace(/,/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

function badNumber(raw: string): boolean {
  return Number.isNaN(parseNum(raw));
}

/** TS port of papertrade.build_occ validation (same messages, same order). */
function checkOccParts(
  underlying: string,
  expiry: string,
  kind: string,
  strike: number,
): string | null {
  const root = underlying.trim().toUpperCase();
  if (!/^[A-Z]{1,6}$/.test(root)) return "option underlying must be 1-6 letters";
  if (kind.trim().toUpperCase() !== "C" && kind.trim().toUpperCase() !== "P") {
    return "option kind must be C or P";
  }
  if (!Number.isFinite(strike) || strike <= 0) {
    return "option strike must be a positive finite number";
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry.trim())) {
    return "option expiry must be a real date in YYYY-MM-DD format";
  }
  const [y, m, d] = expiry.trim().split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return "option expiry must be a real date in YYYY-MM-DD format";
  }
  return null;
}

/**
 * Inline validation mirroring dashboard.py `prompt_*` / `first_run_setup`
 * messages. Returns the error line, or null when the form may submit.
 */
export function validateFields(kind: OrderModalKind, f: ModalFields): string | null {
  switch (kind) {
    case "buy":
    case "sell": {
      if (!f.account.trim()) return "account is required";
      if (!f.symbol.trim()) return "symbol is required";
      if (badNumber(f.qty)) return "not a number, aborted";
      if (f.limit.trim() !== "" && badNumber(f.limit)) return "not a number, aborted";
      return null;
    }
    case "option": {
      if (!f.account.trim()) return "account is required";
      if (f.side.trim().toLowerCase() !== "buy" && f.side.trim().toLowerCase() !== "sell") {
        return "side must be buy or sell";
      }
      if (
        !f.underlying.trim() ||
        !f.expiry.trim() ||
        (f.optionKind.trim().toUpperCase() !== "C" && f.optionKind.trim().toUpperCase() !== "P")
      ) {
        return "missing/invalid fields, aborted";
      }
      if (badNumber(f.strike) || badNumber(f.contracts)) return "not a number, aborted";
      if (f.limit.trim() !== "" && badNumber(f.limit)) return "not a number, aborted";
      return checkOccParts(
        f.underlying,
        f.expiry,
        f.optionKind,
        parseNum(f.strike) as number,
      );
    }
    case "cancel": {
      const raw = stripHash(f.orderId.trim());
      if (!raw) return "order id is required";
      if (!/^\d+$/.test(raw)) return "order id must be a number";
      return null;
    }
    case "new": {
      if (!f.name.trim()) return "name is required";
      if (f.cash.trim() !== "" && badNumber(f.cash)) return "not a number, aborted";
      return null;
    }
    case "rename": {
      if (!f.oldName.trim()) return "account is required";
      if (!f.newName.trim()) return "new name is required";
      return null;
    }
    case "switch": {
      if (!f.name.trim()) return "account is required";
      return null;
    }
    case "setup": {
      if (f.cash.trim() !== "" && badNumber(f.cash)) {
        return "starting cash must be a number — try again";
      }
      if (!["conservative", "standard", "unrestricted"].includes(f.profile.trim().toLowerCase())) {
        return "unknown risk profile — try again";
      }
      return null;
    }
  }
}

/**
 * Mutation argv per kind. Setup returns a sequence (new → risk → setup_done),
 * mirroring first_run_setup's single-transaction account + funding + flag.
 */
export function buildModalArgs(kind: OrderModalKind, f: ModalFields): string[][] {
  switch (kind) {
    case "buy":
    case "sell": {
      const qty = String(parseNum(f.qty));
      const argv = [kind, f.symbol.trim().toUpperCase(), qty, "-a", f.account.trim()];
      if (f.limit.trim() !== "") argv.push("--limit", String(parseNum(f.limit)));
      return [argv];
    }
    case "option": {
      const argv = [
        "option",
        f.side.trim().toLowerCase(),
        f.underlying.trim().toUpperCase(),
        f.expiry.trim(),
        f.optionKind.trim().toUpperCase(),
        String(parseNum(f.strike)),
        String(parseNum(f.contracts)),
        "-a",
        f.account.trim(),
      ];
      if (f.limit.trim() !== "") argv.push("--limit", String(parseNum(f.limit)));
      return [argv];
    }
    case "cancel":
      return [["order", "cancel", stripHash(f.orderId.trim())]];
    case "new": {
      const cash = f.cash.trim() === "" ? 100_000 : (parseNum(f.cash) as number);
      return [["new", f.name.trim(), "--cash", String(cash)]];
    }
    case "rename":
      return [["rename", f.oldName.trim(), f.newName.trim()]];
    case "switch":
      return [["use", f.name.trim()]];
    case "setup": {
      const name = f.name.trim() || "main";
      const cash = f.cash.trim() === "" ? 100_000 : (parseNum(f.cash) as number);
      const profile = f.profile.trim().toLowerCase();
      const seq: string[][] = [["new", name, "--cash", String(cash)]];
      if (profile === "conservative") {
        const risk = [
          "risk",
          "-a",
          name,
          "--no-allow-short",
          "--no-allow-naked-options",
          "--max-leverage",
          "1",
        ];
        if (cash > 0) risk.push("--max-order", String(cash * 0.25));
        seq.push(risk);
      } else if (profile === "unrestricted") {
        seq.push([
          "risk",
          "-a",
          name,
          "--allow-short",
          "--allow-naked-options",
          "--max-leverage",
          "10",
          "--clear-max-order",
        ]);
      }
      seq.push(["config", "set", "setup_done", "1"]);
      return seq;
    }
  }
}

export interface SubmitDeps {
  run: (argv: string[]) => Promise<unknown>;
  resnapshot: () => Promise<void>;
}

export type SubmitResult = { ok: true } | { ok: false; error: string };

function engineMessage(e: unknown): string {
  return e instanceof Error ? e.message.replace(/^.*?: /, "") : String(e);
}

/**
 * Validate → run mutation(s) → exactly one re-snapshot. Validation failure
 * performs no CLI call and no refresh; engine failure surfaces inline with no
 * refresh either (the dashboard keeps its last good frame).
 */
export async function submitModal(
  kind: OrderModalKind,
  fields: ModalFields,
  deps: SubmitDeps,
): Promise<SubmitResult> {
  const invalid = validateFields(kind, fields);
  if (invalid !== null) return { ok: false, error: invalid };
  try {
    for (const argv of buildModalArgs(kind, fields)) {
      await deps.run(argv);
    }
  } catch (e) {
    return { ok: false, error: engineMessage(e) };
  }
  await deps.resnapshot();
  return { ok: true };
}

/**
 * First-run gate: true when zero accounts exist and `setup_done` is unset —
 * mirrors dashboard.main's `if not done and empty` check via CLI queries.
 */
export async function needsFirstRun(opts: EngineOpts = {}): Promise<boolean> {
  const accounts = await runCli(["accounts"], opts);
  if (Array.isArray(accounts) && accounts.length > 0) return false;
  try {
    const value = await runCli(["config", "get", "setup_done"], opts);
    const first = Array.isArray(value) ? value[0] : value;
    return String(first ?? "").trim() !== "1";
  } catch {
    return true; // missing key (or any failure) means setup never ran
  }
}

/** Mirror of prompt_cancel's `.lstrip("#")` on the order-id field. */
function stripHash(raw: string): string {
  return raw.replace(/^#+/, "");
}

interface FieldDef {
  id: keyof ModalFields;
  label: string;
  placeholder?: string;
  choices?: string[];
}

const FIELDS: Record<OrderModalKind, FieldDef[]> = {
  buy: [
    { id: "account", label: "account:" },
    { id: "symbol", label: "symbol:", placeholder: "AAPL" },
    { id: "qty", label: "qty:" },
    { id: "limit", label: "limit price (blank = market):" },
  ],
  sell: [
    { id: "account", label: "account:" },
    { id: "symbol", label: "symbol:", placeholder: "AAPL" },
    { id: "qty", label: "qty:" },
    { id: "limit", label: "limit price (blank = market):" },
  ],
  option: [
    { id: "account", label: "account:" },
    { id: "side", label: "buy or sell [buy]:", choices: ["buy", "sell"] },
    { id: "underlying", label: "underlying (e.g. AAPL):" },
    { id: "expiry", label: "expiry YYYY-MM-DD:" },
    { id: "optionKind", label: "call or put [C/P]:", choices: ["C", "P"] },
    { id: "strike", label: "strike:" },
    { id: "contracts", label: "contracts:" },
    { id: "limit", label: "limit premium (blank = market):" },
  ],
  cancel: [{ id: "orderId", label: "order id (# shown on the pending line):" }],
  new: [
    { id: "name", label: "name:" },
    { id: "cash", label: "starting cash (default 100,000):" },
  ],
  rename: [
    { id: "oldName", label: "which:" },
    { id: "newName", label: "new name:" },
  ],
  switch: [{ id: "name", label: "account:" }],
  setup: [
    { id: "name", label: "portfolio name [main]:" },
    { id: "cash", label: "starting cash [100,000]:" },
    {
      id: "profile",
      label: "risk profile (conservative / standard / unrestricted):",
      choices: ["conservative", "standard", "unrestricted"],
    },
  ],
};

export interface OrderModalProps {
  kind: OrderModalKind;
  defaultAccount?: string;
  deps?: SubmitDeps;
  onClose: () => void;
  onSuccess: () => void;
}

/**
 * OpenTUI form: one focused Input/Select at a time, Enter advances (last
 * field submits), Esc aborts with no CLI call. Engine errors render inline.
 */
export function OrderModal({ kind, defaultAccount, deps, onClose, onSuccess }: OrderModalProps) {
  const fields = FIELDS[kind];
  const [values, setValues] = useState<ModalFields>(() => ({
    ...emptyFields(),
    account: defaultAccount ?? "",
    name: kind === "switch" ? (defaultAccount ?? "") : "",
  }));
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useKeyboard((key) => {
    if (busy) return;
    if (key.name === "escape") onClose();
    else if (key.name === "tab") setActive((i) => (i + 1) % fields.length);
  });

  const setValue = (id: keyof ModalFields, value: string) => {
    setValues((v) => ({ ...v, [id]: value }));
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await submitModal(
        kind,
        values,
        deps ?? {
          run: (argv) => runCli(argv),
          resnapshot: async () => {},
        },
      );
      if (result.ok) onSuccess();
      else setError(result.error);
    } finally {
      setBusy(false);
    }
  };

  const advance = (index: number) => {
    if (index + 1 < fields.length) setActive(index + 1);
    else void submit();
  };

  return (
    <box border borderStyle="single" title={modalTitle(kind)} flexDirection="column">
      {fields.map((field, i) => {
        const value = values[field.id];
        return (
          <box key={field.id} flexDirection="row">
            <text>
              {"  "}
              {field.label}{" "}
            </text>
            {field.choices !== undefined ? (
              <select
                focused={active === i}
                options={field.choices.map((c) => ({ name: c, description: "" }))}
                selectedIndex={Math.max(0, field.choices.indexOf(value))}
                showDescription={false}
                onSelect={(_index, option) => {
                  setValue(field.id, option?.name ?? "");
                  advance(i);
                }}
              />
            ) : (
              <input
                focused={active === i}
                value={value}
                placeholder={field.placeholder ?? ""}
                onInput={(v) => setValue(field.id, v)}
                onSubmit={() => advance(i)}
              />
            )}
          </box>
        );
      })}
      {error !== null ? <text>{"  [!] "}{error}</text> : null}
      <text>{"  (Enter) next · (Esc) abort"}</text>
    </box>
  );
}
