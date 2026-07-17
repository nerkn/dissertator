// Promise-backed in-app replacements for window.prompt/confirm/alert.
//
// The renderer (<SystemDialog/>, mounted once at the app root) subscribes to
// `current`; call sites just `await promptDialog({...}})` / `confirmDialog` /
// `alertDialog` and get a value back — no props threaded, no per-call state.
//
// Requests are FIFO-queued so two near-simultaneous calls don't clobber each
// other (rare in practice — these are all user-initiated), but the queue makes
// the contract safe regardless.

import { create } from "zustand";

export type DialogKind = "prompt" | "confirm" | "alert";

export interface DialogOptions {
  /** Dialog title (bold heading). */
  title: string;
  /** Body text shown under the title (confirm/alert, or prompt help). */
  message?: string;
  /** Label above the input (prompt only). */
  label?: string;
  /** Initial input value (prompt only); selected on open like the native box. */
  defaultValue?: string;
  placeholder?: string;
  okLabel?: string;
  cancelLabel?: string;
  /** Style the OK button as danger (confirm/alert for delete actions). */
  destructive?: boolean;
}

interface DialogRequest extends DialogOptions {
  id: number;
  kind: DialogKind;
  resolve: (v: string | boolean | null) => void;
}

interface DialogState {
  current: DialogRequest | null;
  queue: DialogRequest[];
  push: (req: DialogRequest) => void;
  /** Resolve the current request with `value` and advance the queue. */
  resolve: (value: string | boolean | null) => void;
}

let nextId = 1;

export const useDialogStore = create<DialogState>((set, get) => ({
  current: null,
  queue: [],
  push: (req) => {
    const { current, queue } = get();
    if (!current) set({ current: req });
    else set({ queue: [...queue, req] });
  },
  resolve: (value) => {
    const { current, queue } = get();
    current?.resolve(value);
    const [next, ...rest] = queue;
    set({ current: next ?? null, queue: rest });
  },
}));

/**
 * Prompt for a string (replaces window.prompt). Returns the typed value
 * (untrimmed — caller decides what's empty), or `null` if cancelled.
 */
export function promptDialog(opts: DialogOptions): Promise<string | null> {
  return new Promise((resolve) => {
    useDialogStore.getState().push({
      id: nextId++,
      kind: "prompt",
      resolve: (v) => resolve(typeof v === "string" ? v : null),
      ...opts,
    });
  });
}

/** Yes/no confirm (replaces window.confirm). Returns true only on OK. */
export function confirmDialog(opts: DialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    useDialogStore.getState().push({
      id: nextId++,
      kind: "confirm",
      resolve: (v) => resolve(v === true),
      ...opts,
    });
  });
}

/** Dismissible notice (replaces alert). Resolves on OK. */
export function alertDialog(opts: DialogOptions): Promise<void> {
  return new Promise((resolve) => {
    useDialogStore.getState().push({
      id: nextId++,
      kind: "alert",
      resolve: () => resolve(),
      ...opts,
    });
  });
}
