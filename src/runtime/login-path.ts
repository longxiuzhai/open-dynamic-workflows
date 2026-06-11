/**
 * Login-shell PATH recovery for GUI launches (cross-cutting).
 *
 * A macOS `.app` launched from Finder/Dock inherits launchd's minimal PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), NOT the user's interactive-shell PATH.
 * Coding-agent CLIs almost always live in directories that minimal PATH omits —
 * `~/.local/bin`, `/opt/homebrew/bin`, nvm/conda version dirs — so adapter
 * detection (`isOnPath`) reports every adapter "not installed", and worse, the
 * worker's `spawn("claude", …)` fails with ENOENT when a run actually starts.
 *
 * The fix mirrors what editors like VS Code do: ask the user's login shell for
 * its real PATH and merge it in. To keep a terminal `odw serve` byte-for-byte
 * unchanged, recovery only runs when the desktop shell asks for it via the
 * {@link RESOLVE_LOGIN_PATH_ENV} flag — the GUI launcher is the one component
 * that knows it inherited a stripped environment.
 */

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter } from "node:path";

/** Env flag the desktop shell sets on the sidecar so it recovers PATH. */
export const RESOLVE_LOGIN_PATH_ENV = "ODW_RESOLVE_LOGIN_PATH";

/** Sentinels framing the PATH in the shell's stdout so rc-file chatter can't corrupt it. */
const BEGIN = "__ODW_PATH_BEGIN__";
const END = "__ODW_PATH_END__";

/** What a recovery attempt did — `outcome` drives the one-line startup breadcrumb. */
export interface PathRecovery {
  /**
   * - `skipped`   — the GUI flag was not set (a terminal launch); nothing tried.
   * - `failed`    — the flag was set but no usable PATH came back (no shell
   *                 output, a timeout, or only entries that aren't real dirs).
   * - `unchanged` — a PATH came back but it added nothing new (already complete).
   * - `recovered` — new directories were merged into `env.PATH`.
   */
  outcome: "skipped" | "failed" | "unchanged" | "recovered";
  /** Directories newly added to PATH (only non-empty for `recovered`). */
  added: string[];
}

/**
 * Merge `extra` PATH entries into `base`: keep `base`'s order, then append only
 * the entries `base` does not already contain. Empty segments are dropped. The
 * user's existing PATH always wins on order — recovery only ever *adds* dirs.
 */
export function mergePath(base: string, extra: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of [...base.split(delimiter), ...extra.split(delimiter)]) {
    if (!part || seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out.join(delimiter);
}

/**
 * Ask the user's login shell for its PATH.
 *
 * Runs `<shell> -ilc <printf>` so both login (`.zprofile`/`.bash_profile`) and
 * interactive (`.zshrc`/`.bashrc`) files — wherever PATH is set — are sourced,
 * under a hard timeout so a slow or input-blocking rc file can't hang startup.
 * The PATH is framed in sentinels and stderr is discarded, so a noisy rc file
 * (warnings, motd) cannot corrupt the captured value.
 *
 * The captured value is read from stdout **regardless of the shell's exit code**:
 * an rc file's EXIT-trap teardown hook (common with iTerm2/VS Code shell
 * integration, conda, direnv, atuin) can make the shell exit non-zero *after*
 * the printf already emitted PATH, and `execFileSync` throws in that case even
 * though the value is sitting in `err.stdout`. Returns `null` only when no shell
 * ran at all (spawn error / timeout with no output) or no sentinels were emitted.
 */
export function loginShellPath(
  opts: { shell?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): string | null {
  // On a GUI launch SHELL is usually still set; fall back to the macOS default.
  const shell = opts.shell ?? opts.env?.SHELL ?? process.env.SHELL ?? "/bin/zsh";
  let out: string;
  try {
    out = execFileSync(shell, ["-ilc", `printf '%s%s%s' '${BEGIN}' "$PATH" '${END}'`], {
      encoding: "utf8",
      timeout: opts.timeoutMs ?? 3000,
      stdio: ["ignore", "pipe", "ignore"],
      env: opts.env ?? process.env,
      // A misbehaving login shell that floods stdout shouldn't blow up memory.
      maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    // Non-zero exit (e.g. an EXIT-trap firing after $PATH was printed) still
    // leaves the framed value in stdout; a spawn failure / timeout leaves it
    // empty. Parse whatever was emitted either way.
    const captured = (err as { stdout?: unknown })?.stdout;
    out = typeof captured === "string" ? captured : "";
  }
  const begin = out.indexOf(BEGIN);
  const end = out.indexOf(END, begin + BEGIN.length);
  if (begin === -1 || end === -1) return null;
  const path = out.slice(begin + BEGIN.length, end).trim();
  return path ? path : null;
}

/**
 * When the GUI-launch flag is set, recover the login shell's PATH and merge it
 * into `env.PATH` *in place*. Idempotent and fail-safe: an absent flag, missing
 * shell, timeout, or already-complete PATH all leave `env` untouched.
 *
 * Only recovered entries that are **real directories not already on PATH** are
 * merged. That sanitization is what makes the result trustworthy across shells:
 * a shell whose `$PATH` isn't colon-joined (fish space-joins it) yields one
 * bogus non-directory segment, which is dropped — so recovery reports `failed`
 * honestly instead of appending garbage and claiming success.
 *
 * Mutating `process.env.PATH` (the default target) is deliberate: the detached
 * worker the launcher spawns inherits `process.env`, so a single fix here repairs
 * both adapter detection *and* the adapter CLI the worker later executes.
 */
export function recoverLoginPath(env: NodeJS.ProcessEnv = process.env): PathRecovery {
  if (!env[RESOLVE_LOGIN_PATH_ENV]) return { outcome: "skipped", added: [] };
  const recovered = loginShellPath({ env });
  if (recovered === null) return { outcome: "failed", added: [] };

  const before = env.PATH ?? "";
  const present = new Set(before.split(delimiter).filter(Boolean));
  const added: string[] = [];
  const seen = new Set<string>();
  for (const dir of recovered.split(delimiter)) {
    if (!dir || present.has(dir) || seen.has(dir)) continue;
    seen.add(dir);
    if (isDir(dir)) added.push(dir);
  }
  // A non-null recovery that contributes no real new directory (e.g. fish's
  // space-joined blob, or a PATH already complete) is not a success — but only
  // "already complete" is benign. Distinguish them so the breadcrumb is useful.
  if (added.length === 0) {
    const recoveredDirs = recovered.split(delimiter).some((d) => d && isDir(d));
    return { outcome: recoveredDirs ? "unchanged" : "failed", added: [] };
  }
  env.PATH = before ? `${before}${delimiter}${added.join(delimiter)}` : added.join(delimiter);
  return { outcome: "recovered", added };
}

/** True if `path` is (or resolves to) an existing directory. */
function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
