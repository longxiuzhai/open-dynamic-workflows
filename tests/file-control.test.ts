import { test } from "node:test";
import assert from "node:assert/strict";

import { RunStopped } from "../src/errors.js";
import { FileControl } from "../src/runtime/file-control.js";

test("checkpoint returns immediately when running", async () => {
  const fc = new FileControl({ readAction: () => null });
  await fc.checkpoint();
  assert.equal(fc.state(), "running");
});

test("checkpoint throws RunStopped on a stop request", async () => {
  const fc = new FileControl({ readAction: () => "stop" });
  await assert.rejects(() => fc.checkpoint(), RunStopped);
  assert.equal(fc.state(), "stopped");
});

test("checkpoint blocks while paused, then resumes when cleared", async () => {
  let action: string | null = "pause";
  const states: string[] = [];
  const fc = new FileControl({
    readAction: () => action,
    onState: (s) => states.push(s),
    pollIntervalMs: 5,
  });
  const pending = fc.checkpoint();
  setTimeout(() => {
    action = null;
  }, 25);
  await pending;
  assert.ok(states.includes("paused"), "should have reported paused");
  assert.equal(states[states.length - 1], "running");
});
