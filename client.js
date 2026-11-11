// client.js — DSH Plugin Settings card for dsh-compaction-cap
// Mounted on the `plugins.bundle.config` slot so users can toggle & tune compaction cap
// in Settings -> Plugins -> dsh-compaction-cap without restarting DSH.

window.__ModuleLoader__.load({
  id: "dsh-compaction-cap",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useState, useSyncExternalStore } = React;

    const PACKAGE = "dsh-compaction-cap";
    const ROW_ID = "dsh-compaction-cap";

    const PRESETS = {
      compact: { threshold: 180000, retain: 32000 },
      balanced: { threshold: 240000, retain: 60000 },
      relaxed: { threshold: 400000, retain: 96000 },
    };

    const DICT_ZH = {
      card_title: "长上下文压缩上限设置",
      card_hint: "控制大上下文窗口模型（如 >= 400K）的自动压缩触发点，修改后实时生效，无需重启 DSH。",
      field_enabled: "启用压缩阈值上限",
      field_enabled_hint: "关闭后，所有模型恢复原生的 80% 窗口压缩预算（对话中也可随时用 /cap off 临时关闭单会话）。",
      field_preset: "阈值档位",
      preset_compact_title: "紧凑省额度 (180K)",
      preset_compact_desc: "180K 触发 / 32K 保留 · 默认",
      preset_balanced_title: "均衡体验 (240K)",
      preset_balanced_desc: "240K 触发 / 60K 保留",
      preset_relaxed_title: "高保真长上下文 (400K)",
      preset_relaxed_desc: "400K 触发 / 96K 保留",
      preset_custom_title: "自定义",
      preset_custom_desc: "使用下方手动数值",
      field_threshold: "触发自动压缩上限 (Tokens)",
      field_threshold_hint: "超过该估计上下文 token 时触发压缩；建议 120,000 ~ 400,000（最低 4,096）。",
      field_retain: "压缩后保留上限 (Tokens)",
      field_retain_hint: "压缩保留近期精确对话体的目标上限，内部会自动限制不超过触发上限的 25%。",
      field_min_window: "生效最小模型窗口 (Tokens)",
      field_min_window_hint: "仅对上下文窗口 >= 该值的模型生效（默认 400,000；<= 200K 小窗口模型不会被截断）。",
      field_debug_log: "打印 Host 诊断控制台日志",
      field_debug_log_hint: "开启后，每次命中或旁路截断会在 NodeJS 诊断 -> Console (Host) 输出 console.info 便于现场核验。",
      slash_tip: "对话内快捷指令：/cap status · /cap off · /cap 240k · /cap reset · /cap global 240k",
      save: "保存",
      reset: "重置修改",
      restore_default: "恢复默认 (180K)",
      saved: "已保存 {at}（热生效）",
      save_rejected: "Host 拒绝了此次配置写入。",
      form_loading: "正在读取插件配置…",
      form_unavailable: "当前插件配置表单暂不可用。",
      unwritable: "当前 profile 不允许写入配置。",
      err_threshold: "触发上限必须是 4,096 ~ 2,000,000 之间的整数。",
      err_retain: "保留上限必须是 0 ~ 2,000,000 之间的整数。",
      err_min_window: "最小模型窗口必须是 >= 1,000 的整数。",
    };

    const DICT_EN = {
      card_title: "Compaction Cap Settings",
      card_hint: "Control automatic pressure-compaction threshold for large-window models (>= 400K). Changes hot-apply immediately without restarting DSH.",
      field_enabled: "Enable compaction threshold cap",
      field_enabled_hint: "When disabled, models fall back to their native 80% compaction budget (or use /cap off per session).",
      field_preset: "Threshold preset",
      preset_compact_title: "Compact (180K)",
      preset_compact_desc: "180K trigger / 32K retain · Default",
      preset_balanced_title: "Balanced (240K)",
      preset_balanced_desc: "240K trigger / 60K retain",
      preset_relaxed_title: "Relaxed (400K)",
      preset_relaxed_desc: "400K trigger / 96K retain",
      preset_custom_title: "Custom",
      preset_custom_desc: "Use manual numbers below",
      field_threshold: "Max trigger threshold (Tokens)",
      field_threshold_hint: "Trigger pressure compaction at or below this token count (minimum 4,096).",
      field_retain: "Retain budget after compaction (Tokens)",
      field_retain_hint: "Recent exact history retained after compaction; clamped internally to at most 25% of threshold.",
      field_min_window: "Minimum model context window (Tokens)",
      field_min_window_hint: "Only cap models whose context window is >= this value (default 400,000).",
      field_debug_log: "Emit console.info to Host Diagnostics Console",
      field_debug_log_hint: "Also print live cap decisions via console.info so they show up directly in NodeJS Diagnostics -> Console (Host).",
      slash_tip: "In-chat commands: /cap status · /cap off · /cap 240k · /cap reset · /cap global 240k",
      save: "Save",
      reset: "Reset edits",
      restore_default: "Restore defaults (180K)",
      saved: "Saved {at} (live)",
      save_rejected: "The Host rejected the write.",
      form_loading: "Loading configuration…",
      form_unavailable: "Configuration is not available right now.",
      unwritable: "The Host is not accepting writes for this profile.",
      err_threshold: "Threshold must be an integer between 4,096 and 2,000,000.",
      err_retain: "Retain tokens must be an integer between 0 and 2,000,000.",
      err_min_window: "Minimum context window must be an integer >= 1,000.",
    };

    const CSS = `
.dcc-form{display:flex;flex-direction:column;gap:12px;min-width:0;color:var(--dsw-alias-label-primary);font:inherit;}
.dcc-card{display:flex;flex-direction:column;gap:10px;padding:14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);min-width:0;}
.dcc-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;}
.dcc-title{margin:0 0 2px;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary);}
.dcc-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;}
.dcc-body{display:flex;flex-direction:column;padding:12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover);gap:0;min-width:0;}
.dcc-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:10px 0;min-width:0;}
.dcc-row:first-child{padding-top:0;}
.dcc-row:last-child{padding-bottom:0;}
.dcc-row + .dcc-row{border-top:.5px solid var(--dsw-alias-border-l2);}
.dcc-col{display:flex;flex-direction:column;gap:8px;padding:10px 0;min-width:0;}
.dcc-col + .dcc-row,.dcc-row + .dcc-col,.dcc-col + .dcc-col{border-top:.5px solid var(--dsw-alias-border-l2);}
.dcc-label-wrap{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1 1 auto;}
.dcc-label{font-size:13px;font-weight:500;line-height:1.45;color:var(--dsw-alias-label-primary);}
.dcc-presets{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:8px;}
.dcc-preset{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;font:inherit;}
.dcc-preset[data-active=true]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-bg-layer-3));box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary);}
.dcc-preset:disabled{opacity:.5;cursor:default;}
.dcc-preset-title{font-size:12px;font-weight:600;line-height:1.4;}
.dcc-preset-desc{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-tertiary);}
.dcc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;}
.dcc-input-group{display:flex;flex-direction:column;gap:4px;min-width:0;}
.dcc-input{box-sizing:border-box;width:100%;height:34px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;}
.dcc-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary);}
.dcc-input:disabled{color:var(--dsw-alias-label-tertiary);opacity:.65;}
.dcc-switch{position:relative;flex:none;width:36px;height:20px;padding:0;border:none;border-radius:999px;background:var(--dsw-alias-border-l4);cursor:pointer;transition:background .15s ease;margin-top:2px;}
.dcc-switch[aria-checked=true]{background:var(--dsw-alias-state-business-primary);}
.dcc-switch:disabled{opacity:.45;cursor:default;}
.dcc-thumb{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s ease;}
.dcc-switch[aria-checked=true] .dcc-thumb{transform:translateX(16px);}
.dcc-tip{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);}
.dcc-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-top:2px;}
.dcc-save{appearance:none;border:1px solid transparent;border-radius:var(--dsw-radius-md);padding:5px 14px;font:inherit;font-size:13px;cursor:pointer;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);}
.dcc-save:disabled{opacity:.4;cursor:default;}
.dcc-btn-link{border:none;background:none;padding:0;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;}
.dcc-btn-link:disabled{opacity:.4;cursor:default;}
.dcc-ok{font-size:12px;color:var(--dsw-alias-state-success-primary);}
.dcc-err{font-size:12px;color:var(--dsw-alias-state-error-primary);}
`;

    function asIntString(val, fallback) {
      return typeof val === "number" && Number.isFinite(val) ? String(Math.floor(val)) : String(fallback);
    }

    function readServed(value) {
      const preset = typeof value?.preset === "string" && (value.preset === "custom" || Object.hasOwn(PRESETS, value.preset))
        ? value.preset
        : "compact";
      return {
        enabled: typeof value?.enabled === "boolean" ? value.enabled : true,
        preset,
        minContextWindow: asIntString(value?.minContextWindow, 400000),
        maxThresholdTokens: asIntString(value?.maxThresholdTokens, 180000),
        retainTokens: asIntString(value?.retainTokens, 32000),
        debugLog: typeof value?.debugLog === "boolean" ? value.debugLog : false,
      };
    }

    function Switch({ checked, disabled, label, onToggle }) {
      return h(
        "button",
        {
          type: "button",
          role: "switch",
          "aria-checked": String(Boolean(checked)),
          "aria-label": label,
          className: "dcc-switch",
          disabled,
          onClick: onToggle,
        },
        h("span", { className: "dcc-thumb" })
      );
    }

    return {
      inject: ["slots", "locale", "configForms"],
      apply(ctx) {
        const disposeLocale = ctx.locale.register(PACKAGE, {
          zh: DICT_ZH,
          en: DICT_EN,
        });
        const t = ctx.locale.bind(PACKAGE);
        const form = ctx.configForms.get(ROW_ID);

        const ABSENT_SUB = () => () => {};
        const ABSENT_SNAP = { status: "unavailable", value: undefined, writable: false };
        const subscribe = form === undefined ? ABSENT_SUB : (listener) => form.subscribe(listener);
        const getSnapshot = form === undefined ? () => ABSENT_SNAP : () => form.getSnapshot();

        function BundleConfigCard(props) {
          const snap = useSyncExternalStore(subscribe, getSnapshot);
          const [draft, setDraft] = useState(null);
          const [busy, setBusy] = useState(false);
          const [savedAt, setSavedAt] = useState(null);
          const [note, setNote] = useState(null);

          if (props?.view === "summary") return null;

          const loading = snap.status === "loading";
          const unavailable = snap.status === "unavailable";
          const served = readServed(snap.value);
          const values = draft ?? served;

          const dirty =
            draft !== null &&
            (values.enabled !== served.enabled ||
              values.preset !== served.preset ||
              values.minContextWindow !== served.minContextWindow ||
              values.maxThresholdTokens !== served.maxThresholdTokens ||
              values.retainTokens !== served.retainTokens ||
              values.debugLog !== served.debugLog);

          const editable = !loading && !unavailable && snap.writable !== false && !busy;

          function updateDraft(patch) {
            setDraft({ ...values, ...patch });
            setNote(null);
            setSavedAt(null);
          }

          function selectPreset(presetId) {
            if (Object.hasOwn(PRESETS, presetId)) {
              const p = PRESETS[presetId];
              updateDraft({
                preset: presetId,
                maxThresholdTokens: String(p.threshold),
                retainTokens: String(p.retain),
              });
            } else {
              updateDraft({ preset: "custom" });
            }
          }

          async function save(targetValues = values) {
            const threshold = Number(targetValues.maxThresholdTokens);
            const retain = Number(targetValues.retainTokens);
            const minWin = Number(targetValues.minContextWindow);
            if (!Number.isInteger(threshold) || threshold < 4096 || threshold > 2000000) {
              setNote(t("err_threshold"));
              return;
            }
            if (!Number.isInteger(retain) || retain < 0 || retain > 2000000) {
              setNote(t("err_retain"));
              return;
            }
            if (!Number.isInteger(minWin) || minWin < 1000) {
              setNote(t("err_min_window"));
              return;
            }

            setBusy(true);
            setNote(null);
            try {
              const ops = [
                { op: "set", path: ["enabled"], value: Boolean(targetValues.enabled) },
                { op: "set", path: ["preset"], value: targetValues.preset },
                { op: "set", path: ["minContextWindow"], value: minWin },
                { op: "set", path: ["maxThresholdTokens"], value: threshold },
                { op: "set", path: ["retainTokens"], value: retain },
                { op: "set", path: ["debugLog"], value: Boolean(targetValues.debugLog) },
              ];
              const ok = await form.mutate(ops);
              if (ok) {
                setDraft(null);
                setSavedAt(new Date().toLocaleTimeString());
              } else {
                setNote(t("save_rejected"));
              }
            } catch (err) {
              setNote(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }

          const presetItems = [
            ["compact", t("preset_compact_title"), t("preset_compact_desc")],
            ["balanced", t("preset_balanced_title"), t("preset_balanced_desc")],
            ["relaxed", t("preset_relaxed_title"), t("preset_relaxed_desc")],
            ["custom", t("preset_custom_title"), t("preset_custom_desc")],
          ];

          return h(
            "form",
            {
              className: "dcc-form",
              noValidate: true,
              onSubmit: (e) => {
                e.preventDefault();
                void save();
              },
            },
            h("style", null, CSS),
            loading || unavailable
              ? h("p", { className: "dcc-hint" }, loading ? t("form_loading") : t("form_unavailable"))
              : [
                  h(
                    "section",
                    { className: "dcc-card", key: "main" },
                    h(
                      "div",
                      { className: "dcc-head" },
                      h(
                        "div",
                        { className: "dcc-label-wrap" },
                        h("h4", { className: "dcc-title" }, t("card_title")),
                        h("p", { className: "dcc-hint" }, t("card_hint"))
                      )
                    ),
                    h(
                      "div",
                      { className: "dcc-body" },
                      h(
                        "div",
                        { className: "dcc-row" },
                        h(
                          "div",
                          { className: "dcc-label-wrap" },
                          h("span", { className: "dcc-label" }, t("field_enabled")),
                          h("p", { className: "dcc-hint" }, t("field_enabled_hint"))
                        ),
                        h(Switch, {
                          checked: values.enabled,
                          disabled: !editable,
                          label: t("field_enabled"),
                          onToggle: () => updateDraft({ enabled: !values.enabled }),
                        })
                      ),
                      h(
                        "div",
                        { className: "dcc-col" },
                        h("span", { className: "dcc-label" }, t("field_preset")),
                        h(
                          "div",
                          { className: "dcc-presets" },
                          presetItems.map(([id, title, desc]) =>
                            h(
                              "button",
                              {
                                key: id,
                                type: "button",
                                className: "dcc-preset",
                                "data-active": String(values.preset === id),
                                disabled: !editable || !values.enabled,
                                onClick: () => selectPreset(id),
                              },
                              h("span", { className: "dcc-preset-title" }, title),
                              h("span", { className: "dcc-preset-desc" }, desc)
                            )
                          )
                        )
                      ),
                      h(
                        "div",
                        { className: "dcc-col" },
                        h(
                          "div",
                          { className: "dcc-grid" },
                          h(
                            "div",
                            { className: "dcc-input-group" },
                            h("label", { className: "dcc-label", htmlFor: "dcc-threshold" }, t("field_threshold")),
                            h("input", {
                              id: "dcc-threshold",
                              className: "dcc-input",
                              type: "number",
                              min: 4096,
                              step: 10000,
                              disabled: !editable || !values.enabled,
                              value: values.maxThresholdTokens,
                              onChange: (e) =>
                                updateDraft({
                                  preset: "custom",
                                  maxThresholdTokens: e.target.value,
                                }),
                            }),
                            h("p", { className: "dcc-hint" }, t("field_threshold_hint"))
                          ),
                          h(
                            "div",
                            { className: "dcc-input-group" },
                            h("label", { className: "dcc-label", htmlFor: "dcc-retain" }, t("field_retain")),
                            h("input", {
                              id: "dcc-retain",
                              className: "dcc-input",
                              type: "number",
                              min: 0,
                              step: 1000,
                              disabled: !editable || !values.enabled,
                              value: values.retainTokens,
                              onChange: (e) =>
                                updateDraft({
                                  preset: "custom",
                                  retainTokens: e.target.value,
                                }),
                            }),
                            h("p", { className: "dcc-hint" }, t("field_retain_hint"))
                          ),
                          h(
                            "div",
                            { className: "dcc-input-group" },
                            h("label", { className: "dcc-label", htmlFor: "dcc-min-win" }, t("field_min_window")),
                            h("input", {
                              id: "dcc-min-win",
                              className: "dcc-input",
                              type: "number",
                              min: 1000,
                              step: 10000,
                              disabled: !editable,
                              value: values.minContextWindow,
                              onChange: (e) => updateDraft({ minContextWindow: e.target.value }),
                            }),
                            h("p", { className: "dcc-hint" }, t("field_min_window_hint"))
                          )
                        )
                      ),
                      h(
                        "div",
                        { className: "dcc-row" },
                        h(
                          "div",
                          { className: "dcc-label-wrap" },
                          h("span", { className: "dcc-label" }, t("field_debug_log")),
                          h("p", { className: "dcc-hint" }, t("field_debug_log_hint"))
                        ),
                        h(Switch, {
                          checked: values.debugLog,
                          disabled: !editable,
                          label: t("field_debug_log"),
                          onToggle: () => updateDraft({ debugLog: !values.debugLog }),
                        })
                      )
                    ),
                    h("p", { className: "dcc-tip" }, t("slash_tip"))
                  ),
                  h(
                    "div",
                    { className: "dcc-actions", key: "actions" },
                    h(
                      "button",
                      {
                        type: "submit",
                        className: "dcc-save",
                        disabled: !editable || (!dirty && note === null),
                      },
                      t("save")
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        className: "dcc-btn-link",
                        disabled: !editable || (!dirty && note === null),
                        onClick: () => {
                          setDraft(null);
                          setNote(null);
                          setSavedAt(null);
                        },
                      },
                      t("reset")
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        className: "dcc-btn-link",
                        disabled: !editable,
                        onClick: () => {
                          const def = {
                            enabled: true,
                            preset: "compact",
                            minContextWindow: "400000",
                            maxThresholdTokens: "180000",
                            retainTokens: "32000",
                            debugLog: false,
                          };
                          setDraft(def);
                          void save(def);
                        },
                      },
                      t("restore_default")
                    ),
                    snap.writable === false ? h("span", { className: "dcc-err" }, t("unwritable")) : null,
                    savedAt ? h("span", { className: "dcc-ok" }, t("saved", { at: savedAt })) : null,
                    note ? h("span", { className: "dcc-err" }, note) : null
                  ),
                ]
          );
        }

        ctx.effect(() => disposeLocale, "dsh-compaction-cap: client locale");
        ctx.effect(() => {
          return ctx.slots.inject("plugins.bundle.config", () =>
            ctx.slots.register(
              {
                name: "plugins.bundle.config",
                key: PACKAGE,
                locale: PACKAGE,
              },
              BundleConfigCard
            )
          );
        }, "dsh-compaction-cap: bundle config card");
      },
    };
  },
});
