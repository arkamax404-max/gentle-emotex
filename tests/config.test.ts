import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLayeredConfig } from "../src/config.ts";
import { normalizeExternalDisplay } from "../src/external_display.ts";

test("shipped desktop preset preserves explicit legacy destinations and hardware opacity", () => {
  const root = mkdtempSync(join(tmpdir(), "emote-desktop-default-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ext = join(root, "ext"), project = join(root, "project");
  const user = join(root, "agent", "extensions", "gentle-emote");
  for (const dir of [ext, project, user]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(ext, "config.json"), readFileSync(new URL("../config.json", import.meta.url)));
  try {
    const fresh = loadLayeredConfig(ext, project).config.externalDisplay;
    assert.equal(fresh.enabled, true);
    assert.deepEqual(fresh.targets, [{ enabled: true, url: "http://127.0.0.1:8001/emote", transparentBackground: true }]);
    assert.equal(fresh.transparentBackground, undefined, "USB/LAN do not inherit desktop transparency");
    writeFileSync(join(user, "config.json"), JSON.stringify({ externalDisplay: { enabled: true, url: "http://matrix/emote" } }));
    const legacy = loadLayeredConfig(ext, project).config.externalDisplay;
    assert.equal(legacy.targets, undefined, "shipped targets must not shadow a saved legacy URL");
    assert.deepEqual(normalizeExternalDisplay(legacy), { enabled: true, url: "http://matrix/emote", timeoutMs: 1000 });
    const targets = [{ enabled: true, url: "http://localhost:8001/emote", transparentBackground: false }];
    writeFileSync(join(user, "config.json"), JSON.stringify({ externalDisplay: { targets } }));
    assert.deepEqual(loadLayeredConfig(ext, project).config.externalDisplay.targets, targets);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("custom extension targets keep their precedence over higher legacy URLs", () => {
  const root = mkdtempSync(join(tmpdir(), "emote-custom-target-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ext = join(root, "ext"), project = join(root, "project");
  const user = join(root, "agent", "extensions", "gentle-emote");
  for (const dir of [ext, project, user]) mkdirSync(dir, { recursive: true });
  const targets = [{ enabled: true, url: "http://localhost:9030/emote", transparentBackground: false }];
  try {
    writeFileSync(join(ext, "config.json"), JSON.stringify({ externalDisplay: { enabled: true, targets } }));
    writeFileSync(join(user, "config.json"), JSON.stringify({ externalDisplay: { url: "http://localhost:9040/emote" } }));
    assert.deepEqual(loadLayeredConfig(ext, project).config.externalDisplay.targets, targets);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("external display defaults off, layered fields merge, existing size and terminal behavior preserved", () => {
  const root = mkdtempSync(join(tmpdir(), "emote-config-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const ext = join(root, "extension"), agent = join(root, "agent"), project = join(root, "project");
  const userConfig = join(agent, "extensions", "gentle-emote");
  const localConfig = join(project, ".pi", "extensions", "gentle-emote");
  for (const dir of [ext, userConfig, localConfig]) mkdirSync(dir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    assert.deepEqual(loadLayeredConfig(ext, project).config.externalDisplay, { enabled: false, url: "", timeoutMs: 1000 });
    writeFileSync(join(ext, "config.json"), JSON.stringify({ externalDisplay: { enabled: true, url: "http://127.0.0.1:8000/emote" }, size: 12 }));
    writeFileSync(join(userConfig, "config.json"), JSON.stringify({ externalDisplay: { timeoutMs: 500 }, terminals: [{ match: "tmux", render: "ascii" }] }));
    writeFileSync(join(localConfig, "config.json"), JSON.stringify({ externalDisplay: { url: "https://localhost/emote" }, size: 14 }));
    const { config, userConfiguredTerminals } = loadLayeredConfig(ext, project);
    assert.deepEqual(normalizeExternalDisplay(config.externalDisplay), { enabled: true, url: "https://localhost/emote", timeoutMs: 500 });
    assert.equal(config.size, 14);
    assert.equal(config.terminals.find(entry => entry.match === "tmux")?.render, "ascii");
    assert.ok(userConfiguredTerminals.has("tmux"));
    const simulator = { enabled: true, url: "http://127.0.0.1:8000/emote" };
    const device = { enabled: true, url: "http://gentle-matrix.local/emote", timeoutMs: 750 };
    writeFileSync(join(userConfig, "config.json"), JSON.stringify({ externalDisplay: { targets: [simulator, device] } }));
    writeFileSync(join(localConfig, "config.json"), JSON.stringify({ externalDisplay: { targets: [device] } }));
    assert.deepEqual(loadLayeredConfig(ext, project).config.externalDisplay.targets, [device], "project array replaces user destinations");
    writeFileSync(join(localConfig, "config.json"), JSON.stringify({ externalDisplay: null }));
    const invalid = loadLayeredConfig(ext, project).config;
    assert.equal(normalizeExternalDisplay(invalid.externalDisplay), null);
    assert.equal(invalid.size, 12);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("transparentBackground merges across config layers and preserves an explicit false", () => {
  const root = mkdtempSync(join(tmpdir(), "emote-transparent-config-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const ext = join(root, "extension"), agent = join(root, "agent"), project = join(root, "project");
  const user = join(agent, "extensions", "gentle-emote");
  const local = join(project, ".pi", "extensions", "gentle-emote");
  for (const dir of [ext, user, local]) mkdirSync(dir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    const target = { enabled: true, url: "http://localhost/emote" };
    writeFileSync(join(ext, "config.json"), JSON.stringify({ externalDisplay: { ...target, idleClock: "off" } }));
    writeFileSync(join(user, "config.json"), JSON.stringify({ externalDisplay: { transparentBackground: true, idleClock: "receiver" } }));
    writeFileSync(join(local, "config.json"), JSON.stringify({ externalDisplay: { background: "#404040" } }));
    assert.deepEqual(normalizeExternalDisplay(loadLayeredConfig(ext, project).config.externalDisplay), {
      ...target, timeoutMs: 1000, background: "#404040", transparentBackground: true, idleClock: "receiver",
    });
    writeFileSync(join(local, "config.json"), JSON.stringify({ externalDisplay: { transparentBackground: false, idleClock: "silence" } }));
    assert.deepEqual(normalizeExternalDisplay(loadLayeredConfig(ext, project).config.externalDisplay), {
      ...target, timeoutMs: 1000, transparentBackground: false, idleClock: "silence",
    });
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
