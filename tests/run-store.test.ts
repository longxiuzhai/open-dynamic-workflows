import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonlSink, RunStore } from "../src/runtime/run-store.js";

const tempRoot = () => mkdtempSync(join(tmpdir(), "odw-runs-"));

test("create writes meta + status; reads round-trip", () => {
  const root = tempRoot();
  try {
    const store = new RunStore(root);
    const id = store.create({ script: "/x/wf.js", args: { n: 1 }, source: "/src" });
    assert.ok(store.exists(id));
    assert.equal(store.readMeta(id).script, "/x/wf.js");
    assert.deepEqual(store.readMeta(id).args, { n: 1 });
    assert.equal(store.readStatus(id).state, "pending");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updateStatus merges; result/control round-trip; listRuns", () => {
  const root = tempRoot();
  try {
    const store = new RunStore(root);
    const id = store.create({ script: "wf.js", args: null, source: "/src" });
    store.updateStatus(id, { state: "running", dispatched: 2 });
    assert.equal(store.readStatus(id).state, "running");
    assert.equal(store.readStatus(id).dispatched, 2);
    store.writeResult(id, { ok: true });
    assert.deepEqual(store.readResult(id), { ok: true });
    store.writeControl(id, "stop");
    assert.equal(store.readControl(id), "stop");
    assert.deepEqual(store.listRuns(), [id]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JsonlSink appends and readEvents parses each line", () => {
  const root = tempRoot();
  try {
    const store = new RunStore(root);
    const id = store.create({ script: "wf.js", args: null, source: "/src" });
    const sink = new JsonlSink(store.eventsPath(id));
    sink.emit({ ts: 1, type: "log", message: "a" });
    sink.emit({ ts: 2, type: "log", message: "b" });
    const events = store.readEvents(id);
    assert.equal(events.length, 2);
    assert.equal(events[1]!.message, "b");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
