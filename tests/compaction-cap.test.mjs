import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginMod = await import(pathToFileURL(join(PKG_ROOT, "index.js")).href);

function resolveHostSchemastery() {
  const candidates = [
    join(PKG_ROOT, "package.json"),
    join(PKG_ROOT, "../../profiles/desktop/package.json"),
  ];
  for (const anchor of candidates) {
    if (!fs.existsSync(anchor)) continue;
    try {
      const req = createRequire(anchor);
      const Schema = req("@deepseek-ai/schemastery");
      const cosmokit = req("@deepseek-ai/cosmokit");
      if (Schema && cosmokit) return { Schema: Schema.default ?? Schema, cosmokit };
    } catch {
      // try next anchor
    }
  }
  return null;
}

const hostDeps = resolveHostSchemastery();

// 1. Test Config export & @deepseek-ai/schemastery volatile refs (when host deps are resolvable)
if (hostDeps) {
  console.log("Test 1: Schema Config & volatileForm rehydration (real DSH deps)...");
  const { Schema, cosmokit } = hostDeps;
  assert.equal(pluginMod.name, "dsh-compaction-cap");
  assert.ok(pluginMod.Config, "Config schema must be exported");
  assert.equal(typeof pluginMod.Config.toJSON, "function", "Config must support toJSON()");

  const json = pluginMod.Config.toJSON();
  const rehydrated = new Schema(json);
  const resolvedDefaults = rehydrated({});
  const volatileList = cosmokit.volatileEntries(resolvedDefaults);
  assert.equal(volatileList.length, 6, "All 6 Config fields must be volatile()");

  const hasAnyVolatile = (node) =>
    Boolean(node?.meta?.volatile) ||
    (node?.type === "object" && Object.values(node.dict ?? {}).some(hasAnyVolatile));
  assert.ok(hasAnyVolatile(pluginMod.Config), "Config must expose volatile fields to SettingsForms");
} else {
  console.log("Test 1: Export contract check (DSH host packages absent, skipping real schemastery rehydration)...");
  assert.equal(pluginMod.name, "dsh-compaction-cap");
  assert.ok(pluginMod.PRESETS?.compact && pluginMod.PRESETS?.balanced && pluginMod.PRESETS?.relaxed);
}

// 2. Test client.js factory & slot/locale registration contract
console.log("Test 2: client.js registration & package.json contract...");
const pkgJson = JSON.parse(fs.readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
assert.equal(pkgJson.exports["./client"], "./client.js");
assert.equal(pkgJson.dsh.client.platform, "web");
assert.equal(pkgJson.dsh.client.immediately, true);
assert.ok(Array.isArray(pkgJson.dsh.client.inject));

let loadedClientDef = null;
globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      loadedClientDef = def;
    },
  },
};
const clientSrc = fs.readFileSync(join(PKG_ROOT, "client.js"), "utf8");
new Function(clientSrc)();
delete globalThis.window;

assert.ok(loadedClientDef && loadedClientDef.id === "dsh-compaction-cap", "client.js must call __ModuleLoader__.load");
const mockReact = {
  createElement: (...args) => ({ $$el: args }),
  useState: (init) => [init, () => {}],
  useSyncExternalStore: (_sub, get) => get(),
};
const clientPlugin = loadedClientDef.factory((id) => {
  assert.equal(id, "react", `client.js must only require react, got ${id}`);
  return mockReact;
});
assert.deepEqual(clientPlugin.inject, ["slots", "locale", "configForms"]);

const registeredLocales = {};
const registeredSlots = [];
const mockFormSnapshot = {
  status: "ready",
  writable: true,
  value: {
    enabled: true,
    preset: "balanced",
    minContextWindow: 400000,
    maxThresholdTokens: 240000,
    retainTokens: 60000,
    debugLog: true,
  },
};
const fakeClientCtx = {
  locale: {
    register(ns, dicts) {
      registeredLocales[ns] = dicts;
      return () => {};
    },
    bind(ns) {
      return (key, params) => {
        let s = registeredLocales[ns]?.zh?.[key] ?? key;
        if (params) {
          for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v));
        }
        return s;
      };
    },
  },
  configForms: {
    get(id) {
      assert.equal(id, "dsh-compaction-cap");
      return {
        subscribe: () => () => {},
        getSnapshot: () => mockFormSnapshot,
        mutate: async () => true,
      };
    },
  },
  slots: {
    inject(_slotName, fn) {
      const dispose = fn();
      return () => dispose?.();
    },
    register(meta, component) {
      registeredSlots.push({ meta, component });
      return () => {};
    },
  },
  effect(fn) {
    fn();
  },
};
clientPlugin.apply(fakeClientCtx);
assert.equal(
  registeredSlots.some((s) => s.meta.name === "plugins.bundle.config" && s.meta.key === "dsh-compaction-cap"),
  true,
  "client.js must register plugins.bundle.config slot for dsh-compaction-cap"
);
const zhKeys = Object.keys(registeredLocales["dsh-compaction-cap"].zh).sort();
const enKeys = Object.keys(registeredLocales["dsh-compaction-cap"].en).sort();
assert.deepEqual(zhKeys, enKeys, "zh and en dictionaries must have identical key sets");
const BundleConfigCard = registeredSlots[0].component;
assert.equal(BundleConfigCard({ view: "summary" }), null);
const renderedTree = BundleConfigCard({ view: "page" });
assert.ok(renderedTree && Array.isArray(renderedTree.$$el), "BundleConfigCard must render element tree on view=page");

// 3. Test Option A + Option B host runtime cleanly (with Volatile refs when host deps exist, or fallback Volatile mock)
console.log("Test 3: Host runtime (Option A volatile updates + Option B /cap session/global isolation)...");

function makeSimpleVolatileConfig(initial) {
  const backing = structuredClone(initial);
  const out = {};
  for (const [k, v] of Object.entries(backing)) {
    let cur = v;
    out[k] = {
      get: () => cur,
      set: (nv) => {
        cur = nv;
      },
    };
  }
  return out;
}

function buildTestHost({
  contextWindow = 1_000_000,
  nativeThresholdRatio = 0.8,
  headroomTokens = 65536,
  rawYamlConfig = undefined,
} = {}) {
  const infoCalls = [];
  const consoleCalls = [];
  const origConsoleInfo = console.info;
  console.info = (...args) => {
    consoleCalls.push(args.join(" "));
  };

  class MockCompactionEngine {
    constructor(ctx, config) {
      this.ctx = ctx;
      this.config = config;
    }
    async compactPressure(_agent, header, _signal, _requireBelowThreshold) {
      const target = header?.config;
      const policies = Array.isArray(this.config.modelPolicies) ? this.config.modelPolicies : [];
      const matched = policies.find((p) => p.provider === target.provider && p.model === target.model);
      const ratio = matched?.thresholdRatio ?? this.config.thresholdRatio;
      const retainTokens = matched?.retainTokens ?? this.config.retainTokens ?? 32000;
      const threshold = Math.floor(
        Math.min(contextWindow * ratio, contextWindow - (target.maxTokens ?? 0) - this.config.headroomTokens)
      );
      return { threshold, retainTokens, ratio, modelPoliciesCount: policies.length };
    }
  }

  let preStepHandlers = [];
  const effectCleanups = [];
  let registeredCmd = null;
  let globalYamlState = rawYamlConfig
    ? structuredClone(rawYamlConfig)
    : {
        enabled: true,
        preset: "compact",
        minContextWindow: 400000,
        maxThresholdTokens: 180000,
        retainTokens: 32000,
        debugLog: false,
      };

  const effectiveConfig =
    hostDeps && pluginMod.Config
      ? pluginMod.Config(structuredClone(globalYamlState))
      : makeSimpleVolatileConfig(globalYamlState);

  const compactionInstance = new MockCompactionEngine(null, {
    thresholdRatio: nativeThresholdRatio,
    headroomTokens,
    modelPolicies: [],
  });

  const commandsService = {
    register(def) {
      registeredCmd = def;
      return () => {
        if (registeredCmd === def) registeredCmd = null;
      };
    },
  };

  const settingsService = {
    updateCalls: [],
    async update(ns, patch) {
      this.updateCalls.push({ ns, patch: structuredClone(patch) });
      globalYamlState = { ...globalYamlState, ...patch };
      ctx.fiber.rawConfig = globalYamlState;
      ctx.fiber.entry.options.config = globalYamlState;
      if (hostDeps && pluginMod.Config) {
        const nextCandidate = pluginMod.Config(structuredClone(globalYamlState));
        const oldRefs = hostDeps.cosmokit.volatileEntries(effectiveConfig);
        for (const { path, ref } of oldRefs) {
          const src = path.reduce((acc, k) => acc?.[k], nextCandidate);
          if (src && !hostDeps.cosmokit.deepEqual(ref.get(), src.get(), true)) {
            hostDeps.cosmokit.updateVolatile(ref, src);
          }
        }
      } else {
        for (const [k, v] of Object.entries(patch)) {
          effectiveConfig[k]?.set(v);
        }
      }
    },
  };

  const ctx = {
    logger: {
      info: (...args) => infoCalls.push(args.join(" ")),
      warn: (...args) => infoCalls.push("WARN:" + args.join(" ")),
    },
    llm: {
      async resolveModelInfo() {
        return {
          defaultMaxTokens: 16384,
          context: { contextWindow },
        };
      },
    },
    fiber: {
      effectiveConfig,
      rawConfig: globalYamlState,
      entry: { options: { id: "dsh-compaction-cap", config: globalYamlState } },
    },
    on(event, fn) {
      if (event === "agent/pre-step") {
        preStepHandlers.push(fn);
        return () => {
          preStepHandlers = preStepHandlers.filter((h) => h !== fn);
        };
      }
      return () => {};
    },
    get(key) {
      if (key === "compaction") return compactionInstance;
      if (key === "commands") return commandsService;
      if (key === "settings") return settingsService;
      return undefined;
    },
    inject(deps, cb) {
      if (deps.includes("commands")) {
        const scope = {
          get: (k) => (k === "commands" ? commandsService : ctx.get(k)),
          commands: commandsService,
          effect(fn) {
            const c = fn();
            if (typeof c === "function") effectCleanups.push(c);
          },
        };
        cb(scope);
      }
    },
    effect(fn) {
      const c = fn();
      if (typeof c === "function") effectCleanups.push(c);
    },
  };
  compactionInstance.ctx = ctx;

  return {
    MockCompactionEngine,
    compactionInstance,
    ctx,
    infoCalls,
    consoleCalls,
    settingsService,
    getCommand: () => registeredCmd,
    triggerPreStep: async (agent) => {
      for (const h of preStepHandlers) await h({ agent }, async () => {});
    },
    teardown: () => {
      console.info = origConsoleInfo;
      for (const fn of [...effectCleanups].reverse()) fn();
    },
  };
}

const host = buildTestHost({ contextWindow: 1_000_000 });
await pluginMod.apply(host.ctx, host.ctx.fiber.effectiveConfig);

const agentA = { session: { id: "sess-alpha" } };
const agentB = { session: { id: "sess-beta" } };
const header = { config: { provider: "mock-provider", model: "large-context-model", maxTokens: 16384 } };

await host.triggerPreStep(agentA);

// 3a. Default compact (180K / 32K)
let resA = await host.compactionInstance.compactPressure(agentA, header, new AbortController().signal, true);
assert.equal(resA.threshold, 180000);
assert.equal(resA.retainTokens, 32000);
assert.ok(
  host.infoCalls.some((l) =>
    l.includes("capped mock-provider/large-context-model (1000000 ctx) threshold 800000 -> 180000 (retain 32000)")
  )
);
assert.equal(host.consoleCalls.length, 0, "debugLog=false must not emit console.info");

// 3b. `/cap` status & `/cap off` isolates Session A from Session B
const capCmd = host.getCommand();
assert.ok(capCmd && capCmd.name === "cap");

let out = await capCmd.handler({ agent: agentA, rawInput: "" });
assert.equal(out.kind, "success");
assert.ok(out.text.includes("180,000") && out.text.includes("全局默认"));

out = await capCmd.handler({ agent: agentA, rawInput: "off" });
assert.equal(out.kind, "success");

resA = await host.compactionInstance.compactPressure(agentA, header, new AbortController().signal, true);
assert.equal(resA.threshold, 800000, "Session A must bypass cap when /cap off");
assert.equal(resA.modelPoliciesCount, 0);

let resB = await host.compactionInstance.compactPressure(agentB, header, new AbortController().signal, true);
assert.equal(resB.threshold, 180000, "Session B must stay capped at 180K");

// 3c. `/cap 240k` on Session A -> 240K / 60K
out = await capCmd.handler({ agent: agentA, rawInput: "240k" });
assert.equal(out.kind, "success");
resA = await host.compactionInstance.compactPressure(agentA, header, new AbortController().signal, true);
assert.equal(resA.threshold, 240000);
assert.equal(resA.retainTokens, 60000);

resB = await host.compactionInstance.compactPressure(agentB, header, new AbortController().signal, true);
assert.equal(resB.threshold, 180000);

// 3d. `/cap 300k 48k` custom session threshold + retain
out = await capCmd.handler({ agent: agentA, rawInput: "300k 48k" });
assert.equal(out.kind, "success");
resA = await host.compactionInstance.compactPressure(agentA, header, new AbortController().signal, true);
assert.equal(resA.threshold, 300000);
assert.equal(resA.retainTokens, 48000);

// 3e. Invalid tiny integer rejected cleanly
out = await capCmd.handler({ agent: agentA, rawInput: "50" });
assert.equal(out.kind, "error", "Tiny bare numbers like 50 must fail safely");

// 3f. Option A live volatile update + debugLog console emission
await host.settingsService.update("dsh-compaction-cap", {
  preset: "relaxed",
  maxThresholdTokens: 400000,
  retainTokens: 96000,
  debugLog: true,
});
resB = await host.compactionInstance.compactPressure(agentB, header, new AbortController().signal, true);
assert.equal(resB.threshold, 400000, "Volatile update must take effect immediately for global sessions");
assert.equal(resB.retainTokens, 96000);
assert.ok(host.consoleCalls.some((l) => l.includes("-> 400000 (retain 96000)")), "debugLog=true must emit console.info");

// Session A still holds 300K session override until `/cap reset`
resA = await host.compactionInstance.compactPressure(agentA, header, new AbortController().signal, true);
assert.equal(resA.threshold, 300000);

// `/cap reset` reverts Session A to live global (now 400K relaxed)
out = await capCmd.handler({ agent: agentA, rawInput: "reset" });
assert.equal(out.kind, "success");
resA = await host.compactionInstance.compactPressure(agentA, header, new AbortController().signal, true);
assert.equal(resA.threshold, 400000);

// 3g. `/cap global balanced` persists globally & clears current session override
await capCmd.handler({ agent: agentA, rawInput: "180k" });
out = await capCmd.handler({ agent: agentA, rawInput: "global balanced" });
assert.equal(out.kind, "success");
assert.equal(host.settingsService.updateCalls.at(-1).ns, "dsh-compaction-cap");
assert.equal(host.settingsService.updateCalls.at(-1).patch.preset, "balanced");
resA = await host.compactionInstance.compactPressure(agentA, header, new AbortController().signal, true);
resB = await host.compactionInstance.compactPressure(agentB, header, new AbortController().signal, true);
assert.equal(resA.threshold, 240000);
assert.equal(resB.threshold, 240000);

// 3h. `/cap global debug off` & `/cap global off`
await capCmd.handler({ agent: agentA, rawInput: "global debug off" });
const consoleCountBefore = host.consoleCalls.length;
await capCmd.handler({ agent: agentA, rawInput: "global off" });
resB = await host.compactionInstance.compactPressure(agentB, header, new AbortController().signal, true);
assert.equal(resB.threshold, 800000, "global off disables cap");
assert.equal(host.consoleCalls.length, consoleCountBefore, "debugLog=false stops console.info");

// 3i. Teardown restores original prototype & unregisters `/cap`
const origProtoDesc = host.MockCompactionEngine.prototype.compactPressure;
host.teardown();
assert.notEqual(host.MockCompactionEngine.prototype.compactPressure, origProtoDesc);
assert.equal(host.getCommand(), null, "/cap must unregister on teardown");

// 4. Test backwards compatibility: legacy v0.1.0 YAML config without `preset` field
console.log("Test 4: Legacy v0.1.0 YAML config compatibility (no `preset` field)...");
const legacyHost = buildTestHost({
  contextWindow: 1_000_000,
  rawYamlConfig: { enabled: true, minContextWindow: 400000, maxThresholdTokens: 250000, retainTokens: 45000 },
});
legacyHost.ctx.fiber.rawConfig = { enabled: true, minContextWindow: 400000, maxThresholdTokens: 250000, retainTokens: 45000 };
await pluginMod.apply(legacyHost.ctx, legacyHost.ctx.fiber.effectiveConfig);
await legacyHost.triggerPreStep(agentA);
const legRes = await legacyHost.compactionInstance.compactPressure(agentA, header, new AbortController().signal, true);
assert.equal(legRes.threshold, 250000, "Legacy config without `preset` key must keep custom 250000");
assert.equal(legRes.retainTokens, 45000);
legacyHost.teardown();

// 5. Test small context window (<= 200K) untouched
console.log("Test 5: Small context window (<= 200K) untouched...");
const smallHost = buildTestHost({ contextWindow: 128_000 });
await pluginMod.apply(smallHost.ctx, smallHost.ctx.fiber.effectiveConfig);
await smallHost.triggerPreStep(agentA);
const smallRes = await smallHost.compactionInstance.compactPressure(agentA, header, new AbortController().signal, true);
assert.equal(smallRes.modelPoliciesCount, 0, "Models below minContextWindow must pass straight to original engine");
smallHost.teardown();

console.log("\nALL TESTS PASSED!");
