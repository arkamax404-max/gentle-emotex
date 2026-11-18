import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPanelModel,
  buildPanelRows,
  clockDeadline,
  cycleClockMode,
  type PanelSnapshot,
} from "../src/panel.ts";

const snapshot = (overrides: Partial<PanelSnapshot> = {}): PanelSnapshot => ({
  enabled: true,
  ownsDisplays: true,
  outputs: [
    { output: "internal", enabled: true, destinations: 0 },
    { output: "local", enabled: true, destinations: 1 },
    { output: "d200", enabled: false, destinations: 0, detail: "port 8003" },
    { output: "display", enabled: false, destinations: 1 },
  ],
  clocks: [
    { label: "local", mode: "receiver", session: true, remaining: 141_600, carrier: false },
    { label: "lan", mode: "silence", session: true, remaining: null, carrier: false },
  ],
  appearance: {
    avatar: "gentleman", avatarManual: false, title: null, folder: "gentle-emotex",
    size: 10, placement: "beside-editor", frame: true, accent: "auto",
  },
  status: {
    status: "idle", phase: "idle", activeSubagents: 0,
    workPhase: null, workPhaseSource: "none",
    png: { state: "grandma", frame: "grandma.png", set: "gentleman" },
  },
  ...overrides,
});

test("output rows state each output's switch and what it currently owns", () => {
  const rows = buildPanelRows(snapshot());
  assert.ok(rows.includes("OUTPUTS"), "the section is named");
  assert.ok(rows.includes(" [on ] terminal avatar"));
  assert.ok(rows.includes(" [on ] local simulators / desktop  (1 destination)"));
  assert.ok(rows.includes(" [off] d200 key  (port 8003)"), "the d200 row keeps its port detail");
  assert.ok(rows.includes(" [off] led / esp32  (1 destination)"), "a disabled output still reports its destinations");
});

test("clock rows carry the per-destination mode and a readable deadline", () => {
  const rows = buildPanelRows(snapshot());
  assert.ok(rows.includes("CLOCK"));
  assert.ok(rows.includes(" local  receiver  remaining 142s"), "141.6s rounds up to the second the deadline ends");
  assert.ok(rows.includes(" lan    silence   not-settled"));
  const elapsed = buildPanelRows(snapshot({ clocks: [{ label: "local", mode: "receiver", session: true, remaining: -1000, carrier: true }] }));
  assert.ok(elapsed.includes(" local  receiver  active"), "a passed deadline reads as active");
  assert.deepEqual(clockDeadline(null), "not-settled");
  assert.deepEqual(clockDeadline(0), "active", "zero is already elapsed");
  assert.deepEqual(clockDeadline(999), "remaining 1s");
});

test("status rows report activity, phase source and the selected PNG honestly", () => {
  const rows = buildPanelRows(snapshot());
  assert.ok(rows.includes("STATUS"));
  assert.ok(rows.includes(" activity idle/idle  subagents 0"));
  assert.ok(rows.includes(" phase none (source none)"), "an unpublished phase is never invented");
  assert.ok(rows.includes(" png grandma/grandma.png (gentleman)"));
  const working = buildPanelRows(snapshot({
    status: { ...snapshot().status, status: "busy", phase: "executing", activeSubagents: 2, workPhase: "planning", workPhaseSource: "native", png: null },
  }));
  assert.ok(working.includes(" activity busy/executing  subagents 2"));
  assert.ok(working.includes(" phase planning (source native)"));
  assert.ok(working.includes(" png none selected yet"));
});

test("appearance rows name the effective avatar, title and layout", () => {
  const rows = buildPanelRows(snapshot());
  assert.ok(rows.includes("APPEARANCE"));
  assert.ok(rows.includes(" avatar gentleman (auto)  title - (gentle-emotex)"));
  assert.ok(rows.includes(" size 10  placement beside-editor  frame on  accent auto"));
  const manual = buildPanelRows(snapshot({
    appearance: { ...snapshot().appearance, avatar: "gentleled", avatarManual: true, title: "matrix panel", frame: false },
  }));
  assert.ok(manual.includes(" avatar gentleled (manual)  title matrix panel (gentle-emotex)"));
  assert.ok(manual.includes(" size 10  placement beside-editor  frame off  accent auto"));
});

test("no destination, route or credential ever reaches the rows", () => {
  const rows = buildPanelRows(snapshot()).join("\n");
  for (const forbidden of ["http", "/emote", "127.0.0.1", "192.168", "8003/", "@"]) {
    assert.ok(!rows.includes(forbidden), `rows must not expose ${forbidden}`);
  }
});

test("a session without display ownership says so instead of pretending", () => {
  const rows = buildPanelRows(snapshot({
    ownsDisplays: false,
    clocks: [],
    outputs: [
      { output: "internal", enabled: true, destinations: 0 },
      { output: "local", enabled: true, destinations: 0 },
      { output: "d200", enabled: false, destinations: 0, detail: "port 8003" },
      { output: "display", enabled: false, destinations: 0 },
    ],
  }));
  assert.ok(rows.includes(" [on ] local simulators / desktop  (no destination)"), "the stored preference is reported, not rewritten");
  assert.ok(rows.includes(" display ownership: unavailable in this session"), "no ownership is stated");
  assert.ok(rows.includes(" clock: no destination"), "no clock line is invented");
  const disabled = buildPanelRows(snapshot({ enabled: false }));
  assert.ok(disabled.includes(" emote extension disabled in configuration"), "a disabled extension is stated");
});

test("clock mode cycles off to receiver to silence and back", () => {
  assert.equal(cycleClockMode("off"), "receiver");
  assert.equal(cycleClockMode("receiver"), "silence");
  assert.equal(cycleClockMode("silence"), "off");
  assert.equal(cycleClockMode("unknown" as never), "off", "an unknown value falls back to off");
});
test("only destinations the panel may switch carry a clock item", () => {
  const model = buildPanelModel(snapshot({ clocks: [
    { label: "local", mode: "off", session: true, remaining: null, carrier: false, actionable: true },
    { label: "d200", mode: "receiver", session: true, remaining: 5_000, carrier: false },
  ] }));
  const clockRows = model.filter(row => row.text.startsWith(" local  ") || row.text.startsWith(" d200"));
  assert.deepEqual(clockRows[0]!.item, { kind: "clock", index: 0, mode: "off" }, "a switchable destination carries its index and mode");
  assert.equal(clockRows[1]!.item, undefined, "the D200 key is reported but never switched from the panel");
});
