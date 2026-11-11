import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const name = "dsh-compaction-cap";

const PATCH_MARK = Symbol.for("dsh-compaction-cap.patched");
const PATCH_STATE = Symbol.for("dsh-compaction-cap.state");

export const PRESETS = Object.freeze({
  compact: Object.freeze({ threshold: 180000, retain: 32000, label: "compact (省额度 180K / 32K)" }),
  balanced: Object.freeze({ threshold: 240000, retain: 60000, label: "balanced (均衡 240K / 60K)" }),
  relaxed: Object.freeze({ threshold: 400000, retain: 96000, label: "relaxed (长上下文 400K / 96K)" }),
});

function loadDshSchema() {
  const selfDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    import.meta.url,
    join(process.cwd(), "package.json"),
    join(selfDir, "../../profiles/desktop/package.json"),
  ];
  try {
    const profilesDir = join(selfDir, "../../profiles");
    if (existsSync(profilesDir)) {
      for (const ent of readdirSync(profilesDir, { withFileTypes: true })) {
        if (ent.isDirectory()) {
          candidates.push(join(profilesDir, ent.name, "package.json"));
        }
      }
    }
  } catch {
    // ignore profile scan failures
  }

  for (const anchor of new Set(candidates)) {
    try {
      const req = createRequire(anchor);
      const mod = req("@deepseek-ai/schemastery");
      const Schema = mod?.default ?? mod;
      if (typeof Schema === "function" && typeof Schema.object === "function") {
        return Schema;
      }
    } catch {
      // try next anchor
    }
  }
  return undefined;
}

const Schema = loadDshSchema();

export const Config = Schema
  ? Schema.object({
      enabled: Schema.boolean()
        .default(true)
        .volatile()
        .description("启用大上下文模型 (>= minContextWindow) 的自动压缩上限覆盖"),
      preset: Schema.union([
        Schema.const("compact").description("compact (180K 触发 / 32K 保留，默认)"),
        Schema.const("balanced").description("balanced (240K 触发 / 60K 保留)"),
        Schema.const("relaxed").description("relaxed (400K 触发 / 96K 保留)"),
        Schema.const("custom").description("custom (使用下方自定义阈值)"),
      ])
        .default("compact")
        .volatile()
        .description("压缩阈值预设档位"),
      minContextWindow: Schema.number()
        .min(1000)
        .step(1)
        .default(400000)
        .volatile()
        .description("仅覆盖上下文窗口 >= 该值的模型"),
      maxThresholdTokens: Schema.number()
        .min(4096)
        .max(2000000)
        .step(1)
        .default(180000)
        .volatile()
        .description("触发自动压缩上限 (preset = custom 时生效)"),
      retainTokens: Schema.number()
        .min(0)
        .max(2000000)
        .step(1)
        .default(32000)
        .volatile()
        .description("压缩后保留上下文上限 (preset = custom 时生效)"),
      debugLog: Schema.boolean()
        .default(false)
        .volatile()
        .description("额外输出 console.info 到 Host 诊断控制台"),
    })
  : undefined;

function unwrap(val) {
  return val !== null && typeof val === "object" && typeof val.get === "function" ? val.get() : val;
}

function clampInt(v, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

function resolveThresholdAndRetain(presetName, rawThreshold, rawRetain) {
  if (presetName && Object.hasOwn(PRESETS, presetName)) {
    const p = PRESETS[presetName];
    return {
      preset: presetName,
      maxThresholdTokens: p.threshold,
      retainTokens: p.retain,
    };
  }
  return {
    preset: "custom",
    maxThresholdTokens: clampInt(rawThreshold, 180000, 4096, 2000000),
    retainTokens: clampInt(rawRetain, 32000, 0, 2000000),
  };
}

function normalizeGlobalConfig(rawConfig, ctx) {
  // Always read live Volatile refs first; fallback cleanly if a caller passes plain config or entry options.
  const cfgObj = ctx?.fiber?.effectiveConfig ?? rawConfig ?? {};
  let rawYamlObj;
  try {
    rawYamlObj = ctx?.fiber?.rawConfig ?? ctx?.fiber?.entry?.options?.config;
  } catch {
    rawYamlObj = undefined;
  }

  const enabled = typeof unwrap(cfgObj?.enabled) === "boolean" ? unwrap(cfgObj.enabled) : true;
  const minContextWindow = clampInt(unwrap(cfgObj?.minContextWindow), 400000, 1000);
  const rawThreshold = clampInt(unwrap(cfgObj?.maxThresholdTokens), 180000, 4096, 2000000);
  const rawRetain = clampInt(unwrap(cfgObj?.retainTokens), 32000, 0, 2000000);
  const debugLog = typeof unwrap(cfgObj?.debugLog) === "boolean" ? unwrap(cfgObj.debugLog) : false;

  let rawPreset = unwrap(cfgObj?.preset);
  // Backwards compatibility: if caller/YAML set custom numeric values without specifying `preset`, treat as `custom`.
  const explicitPreset = rawYamlObj?.preset;
  if (
    explicitPreset === undefined &&
    (rawThreshold !== 180000 || rawRetain !== 32000) &&
    (rawPreset === undefined || rawPreset === "compact")
  ) {
    rawPreset = "custom";
  }
  if (rawPreset === undefined) rawPreset = "compact";
  if (rawPreset !== "custom" && !Object.hasOwn(PRESETS, rawPreset)) {
    rawPreset = "compact";
  }

  const resolved = resolveThresholdAndRetain(rawPreset, rawThreshold, rawRetain);
  return {
    enabled,
    preset: resolved.preset,
    minContextWindow,
    maxThresholdTokens: resolved.maxThresholdTokens,
    retainTokens: resolved.retainTokens,
    debugLog,
  };
}

function createSessionStore() {
  const byId = new Map();
  const byObj = new WeakMap();

  function keyInfo(agent) {
    const session = agent?.session;
    const id = typeof session?.id === "string" && session.id.length > 0 ? session.id : undefined;
    return { session, id };
  }

  return {
    get(agent) {
      const { session, id } = keyInfo(agent);
      if (id !== undefined) return byId.get(id);
      if (session !== null && typeof session === "object") return byObj.get(session);
      return byId.get("__default__");
    },
    set(agent, override) {
      const { session, id } = keyInfo(agent);
      if (id !== undefined) {
        if (byId.size > 500 && !byId.has(id)) {
          const oldest = byId.keys().next().value;
          if (oldest !== undefined) byId.delete(oldest);
        }
        byId.set(id, override);
        return;
      }
      if (session !== null && typeof session === "object") {
        byObj.set(session, override);
        return;
      }
      byId.set("__default__", override);
    },
    delete(agent) {
      const { session, id } = keyInfo(agent);
      if (id !== undefined) return byId.delete(id);
      if (session !== null && typeof session === "object") return byObj.delete(session);
      return byId.delete("__default__");
    },
    idOf(agent) {
      const { session, id } = keyInfo(agent);
      if (id !== undefined) return id;
      if (session !== null && typeof session === "object") return "session-obj";
      return "default";
    },
    clear() {
      byId.clear();
    },
  };
}

function patchPrototype(proto, ownerToken, runtime) {
  if (!proto || typeof proto.compactPressure !== "function") return false;
  const existing = proto[PATCH_STATE];
  if (proto.compactPressure[PATCH_MARK] === true && existing) {
    existing.owner = ownerToken;
    existing.runtime = runtime;
    existing.active = true;
    existing.loggedKeys.clear();
    return true;
  }

  const orig = proto.compactPressure;
  proto[PATCH_STATE] = { active: true, owner: ownerToken, runtime, orig, loggedKeys: new Set() };

  async function cappedCompactPressure(agent, header, signal, requireBelowThreshold) {
    const st = proto[PATCH_STATE];
    const target = header?.config;
    const baseCfg = this?.config;
    const rt = st?.runtime;
    if (
      !st?.active ||
      !rt ||
      !baseCfg ||
      !target ||
      typeof target.provider !== "string" ||
      typeof target.model !== "string"
    ) {
      return orig.call(this, agent, header, signal, requireBelowThreshold);
    }

    const eff = rt.resolveEffective(agent);
    if (!eff.enabled) {
      if (eff.debugLog) {
        const sid = rt.sessionIdOf(agent);
        const key = `${sid}:disabled:${target.provider}/${target.model}`;
        if (!st.loggedKeys.has(key)) {
          if (st.loggedKeys.size > 2000) st.loggedKeys.clear();
          st.loggedKeys.add(key);
          const msg = `dsh-compaction-cap: bypass (${eff.source}) for ${target.provider}/${target.model}`;
          rt.logger?.info?.(msg);
          console.info(msg);
        }
      }
      return orig.call(this, agent, header, signal, requireBelowThreshold);
    }

    const policies = Array.isArray(baseCfg.modelPolicies) ? baseCfg.modelPolicies : [];
    if (policies.some((p) => p && p.provider === target.provider && p.model === target.model)) {
      return orig.call(this, agent, header, signal, requireBelowThreshold);
    }

    let info;
    try {
      info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
    } catch {
      return orig.call(this, agent, header, signal, requireBelowThreshold);
    }

    const contextWindow = info?.context?.contextWindow;
    if (!Number.isInteger(contextWindow) || contextWindow < eff.minContextWindow) {
      return orig.call(this, agent, header, signal, requireBelowThreshold);
    }

    const baseRatio = typeof baseCfg.thresholdRatio === "number" ? baseCfg.thresholdRatio : 0.8;
    const headroom = typeof baseCfg.headroomTokens === "number" ? baseCfg.headroomTokens : 65536;
    const reserved = target.maxTokens ?? info.defaultMaxTokens ?? 0;
    const pressureBudget =
      Number.isInteger(reserved) && reserved >= 0 ? contextWindow - reserved - headroom : 0;
    if (pressureBudget <= 0) {
      return orig.call(this, agent, header, signal, requireBelowThreshold);
    }

    const nativeThreshold = Math.floor(Math.min(contextWindow * baseRatio, pressureBudget));
    const cappedThreshold = Math.min(eff.maxThresholdTokens, pressureBudget);
    if (nativeThreshold <= cappedThreshold) {
      return orig.call(this, agent, header, signal, requireBelowThreshold);
    }

    const targetThreshold = Math.max(2048, cappedThreshold);
    const ratio = Math.min(
      baseRatio,
      Math.max(1 / contextWindow, (targetThreshold + 0.1) / contextWindow)
    );
    const actualThreshold = Math.floor(Math.min(contextWindow * ratio, pressureBudget));
    if (actualThreshold < 2) {
      return orig.call(this, agent, header, signal, requireBelowThreshold);
    }

    const safeRetain = Math.min(eff.retainTokens, Math.max(0, Math.floor(actualThreshold * 0.25)));
    const sid = rt.sessionIdOf(agent);
    const key = `${sid}:${target.provider}/${target.model}:${contextWindow}:${actualThreshold}:${safeRetain}`;
    if (!st.loggedKeys.has(key)) {
      if (st.loggedKeys.size > 2000) st.loggedKeys.clear();
      st.loggedKeys.add(key);
      const msg = `dsh-compaction-cap: capped ${target.provider}/${target.model} (${contextWindow} ctx) threshold ${nativeThreshold} -> ${actualThreshold} (retain ${safeRetain})`;
      rt.logger?.info?.(msg);
      if (eff.debugLog) console.info(msg);
    }

    const scoped = Object.create(this);
    scoped.config = {
      ...baseCfg,
      modelPolicies: [
        ...policies,
        {
          provider: target.provider,
          model: target.model,
          thresholdRatio: ratio,
          retainTokens: safeRetain,
        },
      ],
    };
    return orig.call(scoped, agent, header, signal, requireBelowThreshold);
  }

  Object.defineProperty(cappedCompactPressure, PATCH_MARK, { value: true });
  proto.compactPressure = cappedCompactPressure;
  return true;
}

async function loadPrototypes(ctx) {
  const protos = new Set();
  const urls = [];
  try {
    const anchor = ctx.get("profileContext")?.installAnchor;
    if (typeof anchor === "string" && anchor.length > 0) {
      urls.push(pathToFileURL(createRequire(anchor).resolve("@deepseek-ai/dsh-compaction-basic")).href);
    }
  } catch {
    // ignore and try fallback below
  }
  try {
    urls.push(import.meta.resolve("@deepseek-ai/dsh-compaction-basic"));
  } catch {
    // ignore if unresolvable directly
  }
  for (const url of new Set(urls)) {
    try {
      const mod = await import(url);
      const proto = mod?.BasicCompactionEngine?.prototype;
      if (proto && typeof proto.compactPressure === "function") protos.add(proto);
    } catch {
      // ignore
    }
  }
  return protos;
}

function parseTokenCount(raw, { min, max }) {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().toLowerCase().replaceAll(",", "").replaceAll("_", "");
  const m = /^(\d+(?:\.\d+)?)([km])?$/u.exec(s);
  if (!m) return undefined;
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return undefined;
  const mult = m[2] === "m" ? 1_000_000 : m[2] === "k" ? 1_000 : 1;
  // Disallow bare tiny integers like `180` without `k` suffix to avoid setting 180 tokens by typo
  if (m[2] === undefined && base < min) return undefined;
  const n = Math.round(base * mult);
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  return n;
}

function parseCapTarget(args, currentCfg) {
  const first = args[0].toLowerCase();
  if (first === "off" || first === "disable") {
    return { ok: true, kind: "off" };
  }
  if (first === "on" || first === "enable") {
    return { ok: true, kind: "on" };
  }
  if (first === "reset" || first === "default") {
    return { ok: true, kind: "reset" };
  }
  if (first === "compact" || first === "180k") {
    return { ok: true, kind: "preset", preset: "compact", ...PRESETS.compact };
  }
  if (first === "balanced" || first === "240k") {
    return { ok: true, kind: "preset", preset: "balanced", ...PRESETS.balanced };
  }
  if (first === "relaxed" || first === "400k") {
    return { ok: true, kind: "preset", preset: "relaxed", ...PRESETS.relaxed };
  }

  const threshold = parseTokenCount(first, { min: 4096, max: 2_000_000 });
  if (threshold === undefined) {
    return { ok: false, error: `无效参数 "${args[0]}"` };
  }

  let retain;
  if (args.length >= 2) {
    retain = parseTokenCount(args[1], { min: 0, max: 2_000_000 });
    if (retain === undefined) {
      return { ok: false, error: `无效保留 token 参数 "${args[1]}"` };
    }
  } else {
    retain = Math.min(currentCfg.retainTokens, Math.max(0, Math.floor(threshold * 0.25)));
    if (retain === 0 && currentCfg.retainTokens === 0) retain = 0;
  }

  return {
    ok: true,
    kind: "custom",
    preset: "custom",
    threshold,
    retain,
  };
}

function formatTokens(n) {
  return typeof n === "number" ? n.toLocaleString("en-US") : String(n);
}

function helpText() {
  return [
    "dsh-compaction-cap 用法（默认仅对 >= 400K 窗口模型生效）：",
    "- `/cap` 或 `/cap status`：查看当前生效配置与作用域",
    "- `/cap off` / `/cap on`：仅在当前会话临时关闭或恢复上限覆盖（重启自动还原全局设置）",
    "- `/cap compact` (或 `/cap 180k`)：当前会话设为 180K 触发 / 32K 保留（省额度）",
    "- `/cap balanced` (或 `/cap 240k`)：当前会话设为 240K 触发 / 60K 保留（均衡）",
    "- `/cap relaxed` (或 `/cap 400k`)：当前会话设为 400K 触发 / 96K 保留（高保真长上下文）",
    "- `/cap <阈值> [保留]`：自定义当前会话阈值，如 `/cap 300k` 或 `/cap 300k 48k`",
    "- `/cap reset`：清除当前会话覆盖，恢复使用全局配置",
    "- `/cap global <off|on|compact|180k|balanced|240k|relaxed|400k|<阈值>|reset|debug on|debug off>`：写入全局持久化配置（热生效）",
  ].join("\n");
}

function formatStatus(eff, globalCfg, hasSessionOverride) {
  const scopeLabel = hasSessionOverride ? "当前会话临时覆盖 (session)" : "全局默认 (global)";
  const stateLabel = eff.enabled ? `开启 [${eff.preset}]` : "已关闭 (按模型原生 80% 预算)";
  const effectiveRetainCap = Math.min(eff.retainTokens, Math.floor(eff.maxThresholdTokens * 0.25));
  const lines = [
    `dsh-compaction-cap 状态：${stateLabel}`,
    `- 作用域：${scopeLabel}`,
    `- 触发上限：${formatTokens(eff.maxThresholdTokens)} tokens（保留 ${formatTokens(effectiveRetainCap)} tokens，仅作用于 >= ${formatTokens(eff.minContextWindow)} 窗口模型）`,
    `- 全局默认：${globalCfg.enabled ? `开启 [${globalCfg.preset}]` : "已关闭"} · ${formatTokens(globalCfg.maxThresholdTokens)} / ${formatTokens(globalCfg.retainTokens)} · 调试日志 ${globalCfg.debugLog ? "开" : "关"}`,
    `- 快捷操作：/cap off | /cap 180k | /cap 240k | /cap 400k | /cap reset | /cap global ... | /cap help`,
  ];
  return lines.join("\n");
}

export async function apply(ctx, rawConfig = {}) {
  const owner = Symbol("dsh-compaction-cap.owner");
  const patched = new Set();
  const logger = ctx.logger;
  const sessionOverrides = createSessionStore();

  const resolveGlobal = () => normalizeGlobalConfig(rawConfig, ctx);
  const resolveEffective = (agent) => {
    const globalCfg = resolveGlobal();
    const override = sessionOverrides.get(agent);
    if (!override) {
      return { ...globalCfg, source: "global" };
    }
    const preset = override.preset ?? globalCfg.preset;
    const maxThresholdTokens = override.maxThresholdTokens ?? globalCfg.maxThresholdTokens;
    const retainTokens = override.retainTokens ?? globalCfg.retainTokens;
    return {
      enabled: override.enabled ?? globalCfg.enabled,
      preset,
      minContextWindow: globalCfg.minContextWindow,
      maxThresholdTokens,
      retainTokens,
      debugLog: globalCfg.debugLog,
      source: "session",
    };
  };

  const runtime = {
    owner,
    logger,
    resolveGlobal,
    resolveEffective,
    sessionIdOf: (agent) => sessionOverrides.idOf(agent),
  };

  for (const proto of await loadPrototypes(ctx)) {
    if (patchPrototype(proto, owner, runtime)) patched.add(proto);
  }

  const offPreStep = ctx.on(
    "agent/pre-step",
    ({ agent }, next) => {
      try {
        const engine = ctx.get("agentPresets")?.serviceFor(agent, "compaction") ?? ctx.get("compaction");
        const proto = engine ? Object.getPrototypeOf(engine) : undefined;
        if (proto && (!proto.compactPressure?.[PATCH_MARK] || proto[PATCH_STATE]?.owner !== owner)) {
          if (patchPrototype(proto, owner, runtime)) patched.add(proto);
        }
      } catch {
        // fail-open: never interrupt agent loop
      }
      return next();
    },
    { prepend: true }
  );

  // Register `/cap` slash command when Commands service is available.
  ctx.inject(["commands"], (scope) => {
    const commands = scope.get("commands") ?? scope.commands;
    if (!commands || typeof commands.register !== "function") return;
    scope.effect(() => {
      try {
        return commands.register({
          name: "cap",
          description: "查看或调整长上下文自动压缩阈值上限（单会话临时覆盖 / 全局配置）",
          input: {
            hint: "[status | on | off | 180k | 240k | 400k | <N>k [retain] | reset | global <...> | help]",
          },
          handler: async ({ agent, rawInput }) => {
            const tokens = typeof rawInput === "string" ? rawInput.trim().split(/\s+/u).filter(Boolean) : [];
            const globalCfg = resolveGlobal();
            const currentEff = resolveEffective(agent);

            if (tokens.length === 0 || tokens[0].toLowerCase() === "status") {
              return {
                kind: "success",
                text: formatStatus(currentEff, globalCfg, sessionOverrides.get(agent) !== undefined),
              };
            }

            const cmd = tokens[0].toLowerCase();
            if (cmd === "help" || cmd === "-h" || cmd === "--help" || cmd === "?") {
              return { kind: "success", text: helpText() };
            }

            if (cmd === "global" || cmd === "save") {
              const subArgs = tokens.slice(1);
              if (subArgs.length === 0 || subArgs[0].toLowerCase() === "status") {
                return {
                  kind: "success",
                  text: formatStatus(currentEff, globalCfg, sessionOverrides.get(agent) !== undefined),
                };
              }

              const settings = ctx.get("settings");
              if (!settings || typeof settings.update !== "function") {
                return {
                  kind: "error",
                  text: "当前运行环境不支持全局配置持久化写入（settings 服务不可用）；仍可使用 /cap 调整当前会话。",
                };
              }

              const ns = ctx.fiber?.entry?.options?.id ?? name;
              const sub0 = subArgs[0].toLowerCase();
              let patch;
              let summary;

              if (sub0 === "debug") {
                const sub1 = subArgs[1]?.toLowerCase();
                if (sub1 !== "on" && sub1 !== "off") {
                  return { kind: "error", text: "用法：/cap global debug on 或 /cap global debug off" };
                }
                patch = { debugLog: sub1 === "on" };
                summary = `已将全局调试日志（console.info）设为 ${sub1 === "on" ? "开启" : "关闭"}`;
              } else {
                const parsed = parseCapTarget(subArgs, globalCfg);
                if (!parsed.ok) {
                  return { kind: "error", text: `${parsed.error}\n\n${helpText()}` };
                }
                if (parsed.kind === "off") {
                  patch = { enabled: false };
                  summary = "已全局关闭长上下文阈值上限覆盖（热生效并已持久化）";
                } else if (parsed.kind === "on") {
                  patch = { enabled: true };
                  summary = `已全局启用长上下文阈值上限覆盖（${globalCfg.preset}：${formatTokens(globalCfg.maxThresholdTokens)} / ${formatTokens(globalCfg.retainTokens)}）`;
                } else if (parsed.kind === "reset") {
                  patch = {
                    enabled: true,
                    preset: "compact",
                    minContextWindow: 400000,
                    maxThresholdTokens: PRESETS.compact.threshold,
                    retainTokens: PRESETS.compact.retain,
                    debugLog: false,
                  };
                  summary = "已将全局配置恢复为默认 compact（180,000 触发 / 32,000 保留）";
                } else {
                  patch = {
                    enabled: true,
                    preset: parsed.preset,
                    maxThresholdTokens: parsed.threshold,
                    retainTokens: parsed.retain,
                  };
                  const effRetain = Math.min(parsed.retain, Math.floor(parsed.threshold * 0.25));
                  const clampNote =
                    effRetain < parsed.retain
                      ? `（retain 受上限 25% 约束实际生效 ${formatTokens(effRetain)}）`
                      : "";
                  summary = `已将全局配置设为 ${parsed.preset}：${formatTokens(parsed.threshold)} 触发 / ${formatTokens(parsed.retain)} 保留${clampNote}`;
                }
              }

              try {
                await settings.update(ns, patch);
                // Clear current session override so the newly applied global setting is active here immediately
                sessionOverrides.delete(agent);
              } catch (err) {
                return {
                  kind: "error",
                  text: `全局配置写入失败：${err instanceof Error ? err.message : String(err)}`,
                };
              }

              return { kind: "success", text: summary };
            }

            // Session-scoped command
            const parsed = parseCapTarget(tokens, currentEff);
            if (!parsed.ok) {
              return { kind: "error", text: `${parsed.error}\n\n${helpText()}` };
            }

            if (parsed.kind === "reset") {
              const had = sessionOverrides.delete(agent);
              const nextEff = resolveEffective(agent);
              return {
                kind: "success",
                text: had
                  ? `已清除当前会话临时覆盖，恢复全局配置：${nextEff.enabled ? `${nextEff.preset} (${formatTokens(nextEff.maxThresholdTokens)} / ${formatTokens(nextEff.retainTokens)})` : "已关闭"}`
                  : `当前会话本来即使用全局配置：${nextEff.enabled ? `${nextEff.preset} (${formatTokens(nextEff.maxThresholdTokens)} / ${formatTokens(nextEff.retainTokens)})` : "已关闭"}`,
              };
            }

            const prev = sessionOverrides.get(agent);
            if (parsed.kind === "off") {
              sessionOverrides.set(agent, {
                ...(prev ?? {
                  preset: currentEff.preset,
                  maxThresholdTokens: currentEff.maxThresholdTokens,
                  retainTokens: currentEff.retainTokens,
                }),
                enabled: false,
              });
              return {
                kind: "success",
                text: "已在当前会话临时关闭压缩上限覆盖（将使用模型原生 80% 预算；重启或 /cap reset 恢复全局设置）",
              };
            }

            if (parsed.kind === "on") {
              sessionOverrides.set(agent, {
                ...(prev ?? {
                  preset: globalCfg.preset,
                  maxThresholdTokens: globalCfg.maxThresholdTokens,
                  retainTokens: globalCfg.retainTokens,
                }),
                enabled: true,
              });
              const nextEff = resolveEffective(agent);
              return {
                kind: "success",
                text: `已在当前会话启用压缩上限：${nextEff.preset} (${formatTokens(nextEff.maxThresholdTokens)} 触发 / ${formatTokens(nextEff.retainTokens)} 保留)`,
              };
            }

            sessionOverrides.set(agent, {
              enabled: true,
              preset: parsed.preset,
              maxThresholdTokens: parsed.threshold,
              retainTokens: parsed.retain,
            });
            const effRetain = Math.min(parsed.retain, Math.floor(parsed.threshold * 0.25));
            const clampNote =
              effRetain < parsed.retain
                ? `（注：保留 token 受触发上限 25% 约束，实际生效 ${formatTokens(effRetain)}）`
                : "";
            return {
              kind: "success",
              text: `已在当前会话临时切换为 ${parsed.preset}：${formatTokens(parsed.threshold)} 触发 / ${formatTokens(parsed.retain)} 保留${clampNote}`,
            };
          },
        });
      } catch (err) {
        logger?.warn?.("dsh-compaction-cap: failed to register /cap command: %s", err?.message ?? err);
        return undefined;
      }
    }, "dsh-compaction-cap: /cap command");
  });

  ctx.effect(() => () => {
    if (typeof offPreStep === "function") offPreStep();
    sessionOverrides.clear();
    for (const proto of patched) {
      const st = proto[PATCH_STATE];
      if (st?.owner === owner) {
        proto.compactPressure = st.orig;
        delete proto[PATCH_STATE];
      }
    }
  }, "dsh-compaction-cap");
}
