# dsh-compaction-cap

> DeepSeek Harness (DSH) 插件：为超大上下文窗口模型（默认 `>= 400K`）提供可控的自动上下文压缩阈值上限与即时切换开关，兼顾长对话费用控制与复杂重构场景的高保真长上下文需求。

## 核心特性

- **按上下文窗口安全分流**：默认仅覆盖 `contextWindow >= 400,000` 的模型（如 1M 上下文模型原生 80% = 800K 才会自动压缩），将其收敛至更省额度的触发阈值；`<= 200K` 小窗口模型自动原样放行，不受影响。
- **跨 Provider / Preset 全覆盖**：通过拦截 `BasicCompactionEngine.prototype.compactPressure` 与订阅 `agent/pre-step`（prepend），同时对 `standard`、`ops-ptc` 等所有 Agent 预设与上游 Provider 生效。
- **A · 可视化设置面板（热生效）**：内置 DSH 浏览器端设置卡片（**设置 → 插件 → `dsh-compaction-cap`**），基于 `@deepseek-ai/schemastery` 全字段 `.volatile()`，保存后立即热生效，无需重启 DSH。
- **B · 对话内 `/cap` 快捷开关（零 Token 损耗）**：支持单会话临时切换或全局持久化，命令输出直接由 DSH `commands` 服务响应，不消耗模型额度，不破坏 KV Cache。
- **向后兼容与 Fail-Open**：显式传入自定义数字但未写 `preset` 的旧版配置会自动识别为 `custom`；未命中或解析异常时安全回退至原生压缩引擎。

---

## 预设档位与开关用法

### 预设档位

| 档位 (`preset`) | 触发上限 (`maxThresholdTokens`) | 保留预算 (`retainTokens`) | 适用场景 |
| --- | --- | --- | --- |
| `compact`（默认） | `180,000` | `32,000` | 日常开发，控制长对话单轮计费与延迟 |
| `balanced` | `240,000` | `60,000` | 较长链路调试，兼顾历史记忆与成本 |
| `relaxed` | `400,000` | `96,000` | 大规模重构 / 跨文件深挖，减少早期摘要损失 |
| `custom` | 自定义（`4,096 ~ 2,000,000`） | 自定义（实际受触发上限 `25%` 封顶） | 精细调优 |

> 总开关关闭（`enabled: false` 或 `/cap off`）后，恢复模型原生的 `80%` 上下文窗口触发预算。

### 对话内 `/cap` 指令（Scheme B）

| 指令 | 作用域 | 说明 |
| --- | --- | --- |
| `/cap` 或 `/cap status` | 查看 | 查看当前会话实际阈值、全局默认设置与当前作用域 |
| `/cap off` / `/cap on` | 当前会话 | 仅在当前会话临时关闭或开启上限覆盖，不影响其他并发会话 |
| `/cap 180k` / `/cap compact` | 当前会话 | 临时切换至 `180K / 32K` |
| `/cap 240k` / `/cap balanced` | 当前会话 | 临时切换至 `240K / 60K` |
| `/cap 400k` / `/cap relaxed` | 当前会话 | 临时切换至 `400K / 96K` |
| `/cap <阈值> [保留]` | 当前会话 | 如 `/cap 300k` 或 `/cap 300k 48k` |
| `/cap reset` | 当前会话 | 清除当前会话覆盖，恢复跟随全局配置 |
| `/cap global <参数>` | 全局（热持久化） | 写入全局设置并同步更新，支持 `/cap global 240k`、`/cap global off`、`/cap global debug on`、`/cap global reset` |

---

## 安装与配置

### 作为本地插件链接到 DSH Profile

在你的 DSH profile `package.json` 中以本地路径或包方式引入，并加入 `dsh.profile.bundles`：

```json
{
  "dependencies": {
    "dsh-compaction-cap": "link:/path/to/dsh-compaction-cap"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-compaction-cap"]
    }
  }
}
```

插件自带 [`cordis.patch.yml`](cordis.patch.yml) 默认配置：

```yaml
- insert:
    - id: dsh-compaction-cap
      name: dsh-compaction-cap
      config:
        enabled: true
        preset: compact
        minContextWindow: 400000
        maxThresholdTokens: 180000
        retainTokens: 32000
        debugLog: false
```

---

## 本地测试与打包

```bash
npm test
mkdir -p dist && npm pack --pack-destination dist
```

- `tests/compaction-cap.test.mjs` 会校验插件配置导出、`client.js` 槽位与中英词典一致性、单会话 `/cap` 隔离、全局热更新、旧版配置兼容及 `<= 200K` 模型旁路；若检测到宿主 DSH profile 依赖存在，会同时运行真实的 `@deepseek-ai/schemastery` / `@deepseek-ai/cosmokit` volatile 重水合验证。

---

## License

[MIT](LICENSE)
