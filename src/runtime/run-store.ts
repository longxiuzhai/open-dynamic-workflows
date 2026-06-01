/**
 * The run directory: the file-backed seam between front and back.
 *
 * A run is a directory under `runsRoot`. The background worker writes to it; the
 * CLI reads from it. They never talk directly, which lets a run outlive the
 * command that started it and be observed from anywhere.
 *
 * Layout of `<runsRoot>/<runId>/`:
 *   meta.json      immutable run description (script, args, source, config)
 *   status.json    mutable state (running/paused/done/failed/stopped, counters)
 *   events.jsonl   append-only progress stream
 *   result.json    final return value (on success)
 *   error.json     message + stack (on failure)
 *   control.json   pause/resume/stop request written by the CLI
 *   worker.log     the worker process's stdout/stderr
 *
 * All JSON writes are atomic (temp file + rename) so a concurrent reader never
 * sees a half-written file.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { EventSink, WorkflowEvent } from "../events.js";

/** Terminal states: a run in one of these will not change again. */
export const TERMINAL_STATES = new Set(["done", "failed", "stopped"]);

const META = "meta.json";
const STATUS = "status.json";
const EVENTS = "events.jsonl";
const RESULT = "result.json";
const ERROR = "error.json";
const CONTROL = "control.json";
const LOG = "worker.log";

export interface CreateRunInput {
  script: string;
  args: unknown;
  configPath?: string | null;
  source: string;
  budgetTotal?: number | null;
}

export class RunStore {
  constructor(readonly root: string) {}

  // --- creation & paths ------------------------------------------------------

  create(input: CreateRunInput): string {
    const runId = newRunId();
    const dir = this.runDir(runId);
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, META), {
      runId,
      script: input.script,
      args: input.args ?? null,
      configPath: input.configPath ?? null,
      source: input.source,
      budgetTotal: input.budgetTotal ?? null,
      createdAt: now(),
    });
    writeJson(join(dir, STATUS), { runId, state: "pending", dispatched: 0, updatedAt: now() });
    return runId;
  }

  runDir(runId: string): string {
    return join(this.root, runId);
  }
  exists(runId: string): boolean {
    return existsSync(join(this.runDir(runId), META));
  }
  eventsPath(runId: string): string {
    return join(this.runDir(runId), EVENTS);
  }
  logPath(runId: string): string {
    return join(this.runDir(runId), LOG);
  }
  controlPath(runId: string): string {
    return join(this.runDir(runId), CONTROL);
  }

  // --- meta & status ---------------------------------------------------------

  readMeta(runId: string): Record<string, unknown> {
    return readJson(join(this.runDir(runId), META)) ?? {};
  }
  readStatus(runId: string): Record<string, unknown> {
    return readJson(join(this.runDir(runId), STATUS)) ?? {};
  }
  updateStatus(runId: string, fields: Record<string, unknown>): Record<string, unknown> {
    const status = { ...this.readStatus(runId), ...fields, updatedAt: now() };
    writeJson(join(this.runDir(runId), STATUS), status);
    return status;
  }

  // --- events ----------------------------------------------------------------

  readEvents(runId: string): WorkflowEvent[] {
    const path = this.eventsPath(runId);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as WorkflowEvent);
  }

  // --- result & error --------------------------------------------------------

  writeResult(runId: string, value: unknown): void {
    writeJson(join(this.runDir(runId), RESULT), { value: value ?? null });
  }
  readResult(runId: string): unknown {
    const payload = readJson(join(this.runDir(runId), RESULT));
    return payload === null ? null : payload.value;
  }
  hasResult(runId: string): boolean {
    return existsSync(join(this.runDir(runId), RESULT));
  }
  writeError(runId: string, error: Record<string, unknown>): void {
    writeJson(join(this.runDir(runId), ERROR), error);
  }
  readError(runId: string): Record<string, unknown> | null {
    return readJson(join(this.runDir(runId), ERROR));
  }

  // --- control ---------------------------------------------------------------

  writeControl(runId: string, action: string): void {
    writeJson(this.controlPath(runId), { action, at: now() });
  }
  readControl(runId: string): string | null {
    const payload = readJson(this.controlPath(runId));
    return payload === null ? null : ((payload.action as string) ?? null);
  }

  // --- listing ---------------------------------------------------------------

  listRuns(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(this.root, e.name, META)))
      .map((e) => e.name)
      .sort();
  }
}

/** An {@link EventSink} that appends each event to events.jsonl. */
export class JsonlSink implements EventSink {
  constructor(private readonly path: string) {}
  emit(ev: WorkflowEvent): void {
    appendFileSync(this.path, JSON.stringify(ev) + "\n");
  }
}

// --- module helpers ----------------------------------------------------------

function now(): number {
  return Date.now() / 1000;
}

function newRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = Math.floor(Math.random() * 0x1000000)
    .toString(16)
    .padStart(6, "0");
  return `${stamp}-${rand}`;
}

function writeJson(path: string, payload: unknown): void {
  const tmp = `${path}.${process.pid}.${Math.floor(Math.random() * 1e9).toString(36)}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  renameSync(tmp, path);
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}
