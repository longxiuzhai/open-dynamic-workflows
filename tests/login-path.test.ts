import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  RESOLVE_LOGIN_PATH_ENV,
  loginShellPath,
  mergePath,
  recoverLoginPath,
} from "../src/runtime/login-path.js";

// Regression for the desktop-app failure: a GUI launch inherits launchd's
// stripped PATH, so every adapter reads "not installed" and `spawn("claude")`
// ENOENTs. recoverLoginPath() merges the login shell's real PATH back in.

// --- mergePath: pure union, base order wins, dedup, drop empties -------------

test("mergePath keeps base order and appends only new entries", () => {
  const base = ["/usr/bin", "/bin"].join(delimiter);
  const extra = ["/opt/homebrew/bin", "/usr/bin", "/Users/x/.local/bin"].join(delimiter);
  assert.equal(
    mergePath(base, extra),
    ["/usr/bin", "/bin", "/opt/homebrew/bin", "/Users/x/.local/bin"].join(delimiter),
  );
});

test("mergePath dedups within and drops empty segments", () => {
  const base = ["/a", "", "/a", "/b"].join(delimiter);
  const extra = ["/b", "", "/c"].join(delimiter);
  assert.equal(mergePath(base, extra), ["/a", "/b", "/c"].join(delimiter));
});

test("mergePath is a no-op when extra is fully contained in base", () => {
  const base = ["/a", "/b", "/c"].join(delimiter);
  assert.equal(mergePath(base, "/b"), base);
});

// --- a fake login shell that ignores -ilc and prints a sentinel-wrapped PATH --

/** Write an executable stand-in for $SHELL. `body` is the script after the shebang. */
function fakeShell(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A shell whose stdout frames `pathValue` in the sentinels; `tail` runs after. */
function shellEmitting(dir: string, name: string, pathValue: string, tail = ""): string {
  return fakeShell(
    dir,
    name,
    `printf '%s%s%s' '__ODW_PATH_BEGIN__' '${pathValue}' '__ODW_PATH_END__'\n${tail}`,
  );
}

test("loginShellPath extracts PATH framed by sentinels, ignoring rc-file noise on stderr", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-shell-"));
  try {
    const shell = fakeShell(
      dir,
      "noisyshell",
      `echo "corrupt go version" 1>&2\nprintf '%s%s%s' '__ODW_PATH_BEGIN__' '/opt/homebrew/bin:/Users/x/.local/bin' '__ODW_PATH_END__'`,
    );
    assert.equal(loginShellPath({ shell }), "/opt/homebrew/bin:/Users/x/.local/bin");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loginShellPath recovers the PATH even when the shell exits non-zero AFTER printing it", () => {
  // The real-world trigger: an EXIT-trap teardown hook (iTerm2/VS Code shell
  // integration, conda, direnv) makes the shell exit non-zero after $PATH was
  // already emitted. execFileSync throws, but the value is in err.stdout.
  const dir = mkdtempSync(join(tmpdir(), "odw-shell-"));
  try {
    const shell = shellEmitting(dir, "trapshell", "/opt/homebrew/bin:/Users/x/.local/bin", "exit 7");
    assert.equal(loginShellPath({ shell }), "/opt/homebrew/bin:/Users/x/.local/bin");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loginShellPath returns null when the shell prints no sentinels", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-shell-"));
  try {
    const shell = fakeShell(dir, "blankshell", `printf 'hello world'`);
    assert.equal(loginShellPath({ shell }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loginShellPath returns null when the shell binary does not exist", () => {
  assert.equal(loginShellPath({ shell: "/no/such/shell-binary" }), null);
});

test("loginShellPath gives up (null) on a shell that hangs past the timeout", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-shell-"));
  try {
    const shell = fakeShell(dir, "hangshell", `sleep 10`);
    const started = Date.now();
    assert.equal(loginShellPath({ shell, timeoutMs: 300 }), null);
    assert.ok(Date.now() - started < 5000, "returned promptly via the timeout, not after sleep 10");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- recoverLoginPath: gated by the flag, merges only REAL new dirs ----------

test("recoverLoginPath is a no-op without the flag (terminal launch is untouched)", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-shell-"));
  try {
    const shell = shellEmitting(dir, "sh1", dir); // dir exists, but no flag
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", SHELL: shell };
    assert.deepEqual(recoverLoginPath(env), { outcome: "skipped", added: [] });
    assert.equal(env.PATH, "/usr/bin");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recoverLoginPath merges real, new login-PATH dirs in place when the flag is set", () => {
  const root = mkdtempSync(join(tmpdir(), "odw-recover-"));
  const a = mkdtempSync(join(root, "bin-a-"));
  const b = mkdtempSync(join(root, "bin-b-"));
  const dir = mkdtempSync(join(tmpdir(), "odw-shell-"));
  try {
    // /usr/bin is already present; a and b are the new login-shell dirs.
    const shell = shellEmitting(dir, "sh2", ["/usr/bin", a, b].join(delimiter));
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", SHELL: shell, [RESOLVE_LOGIN_PATH_ENV]: "1" };
    const result = recoverLoginPath(env);
    assert.equal(result.outcome, "recovered");
    assert.deepEqual(result.added, [a, b]);
    assert.equal(env.PATH, ["/usr/bin", "/bin", a, b].join(delimiter));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recoverLoginPath reports 'unchanged' when recovery adds no new dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-shell-"));
  try {
    const shell = shellEmitting(dir, "sh3", "/usr/bin"); // a real dir, already present
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", SHELL: shell, [RESOLVE_LOGIN_PATH_ENV]: "1" };
    assert.deepEqual(recoverLoginPath(env), { outcome: "unchanged", added: [] });
    assert.equal(env.PATH, "/usr/bin:/bin");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recoverLoginPath fails safe (no masking) on a fish-style space-joined PATH", () => {
  // fish interpolates "$PATH" space-joined, not colon-joined, so the whole value
  // is one bogus non-directory segment. It must be dropped — recovery reports
  // 'failed' and leaves PATH untouched, not 'recovered' with a useless entry.
  const root = mkdtempSync(join(tmpdir(), "odw-recover-"));
  const a = mkdtempSync(join(root, "bin-a-"));
  const b = mkdtempSync(join(root, "bin-b-"));
  const dir = mkdtempSync(join(tmpdir(), "odw-shell-"));
  try {
    const shell = shellEmitting(dir, "fishlike", `${a} ${b}`); // space-joined: one fake path
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", SHELL: shell, [RESOLVE_LOGIN_PATH_ENV]: "1" };
    assert.deepEqual(recoverLoginPath(env), { outcome: "failed", added: [] });
    assert.equal(env.PATH, "/usr/bin:/bin");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recoverLoginPath reports 'failed' when the shell yields no PATH at all", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-shell-"));
  try {
    const shell = fakeShell(dir, "emptyshell", `printf 'no sentinels here'`);
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", SHELL: shell, [RESOLVE_LOGIN_PATH_ENV]: "1" };
    assert.deepEqual(recoverLoginPath(env), { outcome: "failed", added: [] });
    assert.equal(env.PATH, "/usr/bin");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
