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
    assert.deepEqual(fresh.targets, [{ enabled: true, url: "http://127.0.0.1:8001/emote", transparentBackground: true, idleClock: "receiver" }]);
    assert.equal(fresh.transparentBackground, undefined, "USB/LAN do not inherit desktop transparency");
    assert.equal(fresh.idleClock, undefined, "USB/LAN do not inherit the desktop clock mode");
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

test("old and receiver desktop presets yield to legacy URLs, but customized presets do not", () => {
  const root = mkdtempSync(join(tmpdir(), "emote-preset-compat-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ext = join(root, "ext");
  const user = join(root, "agent", "extensions", "gentle-emote");
  const project = join(root, "project");
  const local = join(project, ".pi", "extensions", "gentle-emote");
  for (const dir of [ext, user, local]) mkdirSync(dir, { recursive: true });
  const desktop = { enabled: true, url: "http://127.0.0.1:8001/emote", transparentBackground: true };
  try {
    for (const layer of [user, local]) {
      for (const target of [desktop, { ...desktop, idleClock: "receiver" }]) {
        writeFileSync(join(ext, "config.json"), JSON.stringify({ externalDisplay: { enabled: true, targets: [target] } }));
        writeFileSync(join(user, "config.json"), "{}");
        writeFileSync(join(local, "config.json"), "{}");
        writeFileSync(join(layer, "config.json"), JSON.stringify({ externalDisplay: { url: "http://matrix/emote" } }));
        assert.deepEqual(loadLayeredConfig(ext, project).config.externalDisplay, {
          enabled: true, url: "http://matrix/emote", timeoutMs: 1000,
        }, `${layer}: ${JSON.stringify(target)}`);
      }
    }
    for (const target of [
      { ...desktop, idleClock: "off" },
      { ...desktop, idleClock: "silence" },
      { ...desktop, timeoutMs: 750 },
      { ...desktop, idleClock: "receiver", timeoutMs: 750 },
    ]) {
      writeFileSync(join(ext, "config.json"), JSON.stringify({ externalDisplay: { enabled: true, targets: [target] } }));
      assert.deepEqual(loadLayeredConfig(ext, project).config.externalDisplay.targets, [target], "customized targets keep precedence");
    }
    writeFileSync(join(ext, "config.json"), readFileSync(new URL("../config.json", import.meta.url)));
    for (const layer of [user, local]) {
      for (const idleClock of ["off", "silence"]) {
        writeFileSync(join(user, "config.json"), "{}");
        writeFileSync(join(local, "config.json"), "{}");
        const targets = [{ ...desktop, idleClock }];
        writeFileSync(join(layer, "config.json"), JSON.stringify({ externalDisplay: { targets } }));
        assert.deepEqual(loadLayeredConfig(ext, project).config.externalDisplay.targets, targets);
      }
    }
    writeFileSync(join(local, "config.json"), JSON.stringify({ externalDisplay: { enabled: false } }));
    assert.equal(loadLayeredConfig(ext, project).config.externalDisplay.enabled, false);
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

test("PNG appearance stays user-global while project clock settings remain layered", () => {
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
    const appearance = { transparentBackground: true, background: "#202020", backgroundCoverage: 0.5 };
    writeFileSync(join(user, "config.json"), JSON.stringify({ externalDisplay: { ...appearance, idleClock: "receiver" } }));
    writeFileSync(join(local, "config.json"), JSON.stringify({ externalDisplay: { background: "#404040", backgroundCoverage: 0 } }));
    assert.deepEqual(normalizeExternalDisplay(loadLayeredConfig(ext, project).config.externalDisplay), {
      ...target, timeoutMs: 1000, ...appearance, idleClock: "receiver",
    });
    writeFileSync(join(local, "config.json"), JSON.stringify({ externalDisplay: { transparentBackground: false, idleClock: "silence" } }));
    assert.deepEqual(normalizeExternalDisplay(loadLayeredConfig(ext, project).config.externalDisplay), {
      ...target, timeoutMs: 1000, ...appearance, idleClock: "silence",
    });
    writeFileSync(join(user, "config.json"), JSON.stringify({ externalDisplay: { ...appearance, transparentBackground: false } }));
    writeFileSync(join(local, "config.json"), JSON.stringify({ externalDisplay: { transparentBackground: true } }));
    const before = [join(user, "config.json"), join(local, "config.json")].map(path => readFileSync(path, "utf8"));
    assert.equal(loadLayeredConfig(ext, project).config.externalDisplay.transparentBackground, false,
      "a global false cannot be re-enabled by a project");
    assert.deepEqual([join(user, "config.json"), join(local, "config.json")].map(path => readFileSync(path, "utf8")), before,
      "loading preferences never rewrites either configuration layer");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});


test("per-target PNG appearance follows global URL identity without changing project routes", () => {
  const root = mkdtempSync(join(tmpdir(), "emote-global-targets-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const ext = join(root, "extension"), agent = join(root, "agent"), project = join(root, "project");
  const user = join(agent, "extensions", "gentle-emote");
  const local = join(project, ".pi", "extensions", "gentle-emote");
  for (const dir of [ext, user, local]) mkdirSync(dir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    writeFileSync(join(ext, "config.json"), JSON.stringify({ externalDisplay: { enabled: true } }));
    const global = { externalDisplay: { background: "#303030", backgroundCoverage: 0.75, transparentBackground: true,
      targets: [{ enabled: true, url: "http://localhost:8001/emote", background: "#202020", transparentBackground: false }] } };
    const routes = [
      { enabled: true, url: "http://LOCALHOST:8001/emote", timeoutMs: 321, idleClock: "silence", outline: "#00ff00",
        background: "gray", backgroundCoverage: 0, transparentBackground: true },
      { enabled: true, url: "http://matrix/emote", timeoutMs: 250, idleClock: "off", background: "#abcdef", transparentBackground: false },
    ];
    const projectConfig = { size: 14, externalDisplay: { timeoutMs: 777, background: "#404040", targets: routes } };
    writeFileSync(join(user, "config.json"), JSON.stringify(global));
    writeFileSync(join(local, "config.json"), JSON.stringify(projectConfig));
    const before = [join(user, "config.json"), join(local, "config.json")].map(path => readFileSync(path, "utf8"));
    const config = loadLayeredConfig(ext, project).config;
    assert.deepEqual(config.externalDisplay, {
      enabled: true, url: "", timeoutMs: 777, background: "#303030", backgroundCoverage: 0.75, transparentBackground: true,
      targets: [
        { enabled: true, url: routes[0]!.url, timeoutMs: 321, idleClock: "silence", outline: "#00ff00",
          background: "#202020", transparentBackground: false },
        { enabled: true, url: routes[1]!.url, timeoutMs: 250, idleClock: "off" },
      ],
    });
    assert.equal(config.size, 14, "internal terminal configuration remains project-scoped");
    assert.deepEqual([join(user, "config.json"), join(local, "config.json")].map(path => readFileSync(path, "utf8")), before);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid global PNG appearance stays fail-closed despite a valid project override", () => {
  const root = mkdtempSync(join(tmpdir(), "emote-global-invalid-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const ext = join(root, "extension"), agent = join(root, "agent"), project = join(root, "project");
  const user = join(agent, "extensions", "gentle-emote");
  const local = join(project, ".pi", "extensions", "gentle-emote");
  for (const dir of [ext, user, local]) mkdirSync(dir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    writeFileSync(join(ext, "config.json"), JSON.stringify({ externalDisplay: { enabled: true, url: "http://localhost/emote" } }));
    for (const [key, invalid, valid] of [
      ["background", "gray", "#000000"], ["background", null, "#000000"],
      ["backgroundCoverage", 1.1, 1], ["transparentBackground", "true", true],
    ] as const) {
      writeFileSync(join(user, "config.json"), JSON.stringify({ externalDisplay: { [key]: invalid } }));
      writeFileSync(join(local, "config.json"), JSON.stringify({ externalDisplay: { [key]: valid } }));
      const before = readFileSync(join(user, "config.json"), "utf8");
      assert.equal(normalizeExternalDisplay(loadLayeredConfig(ext, project).config.externalDisplay), null, key);
      assert.equal(readFileSync(join(user, "config.json"), "utf8"), before, "rejected configuration is not repaired");
    }
    writeFileSync(join(local, "config.json"), JSON.stringify({ externalDisplay: null }));
    assert.equal(normalizeExternalDisplay(loadLayeredConfig(ext, project).config.externalDisplay), null);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
