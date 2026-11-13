# dsh-memcore（DSH 插件）

把 memcore 装进 DeepSeek Harness：每轮自动注入线索 / 档案索引 / 开场卡，并注册 8 个工具。

**你不需要**：侧栏面板、策展流水线、MCP/HTTP 服务。这个包只在 DSH 里有意义。

## 它做什么

1. **证据层**：把会话的 user/assistant 原话追加到 `episodes.jsonl`（不经过模型）
2. **注入**：每轮把最近几段压成几行线索（≤1KB）、档案索引三行、开场记忆卡
3. **工具**：`recall` / `trace` / `remember` / `decide` / `fact_write` / `self_read` / `self_write` / `handoff_write`
4. **在场/回来信号**：读 `presence.json` / `returned.json`（可选，没有就跳过）

## 安装

在 DSH 的 profile 目录（例如 `~/.dsh/profiles/desktop`）里：

```bash
# 方式一：从本仓库装（还没发 npm）
pnpm add file:D:/path/to/memcore/packages/dsh-plugin
```

然后把包装进 `dsh.profile.bundles`：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["dsh-memcore"]
    }
  }
}
```

再在 profile 目录执行 `pnpm install`，重启 DSH。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | 数据目录的父目录，插件会在其下建 `memcore/` |
| `MEMCORE_MEMORY` | `<WORK>/memory` | 档案目录（`index.md` 的索引表从这里读） |
| `MEMCORE_WORK` | 空 | 设了才会注册提炼环/评测提醒/自动事实三个外部日脚本 |
| `MEMCORE_EPISODES` | `<DSH_HOME>/memcore/episodes.jsonl` | 覆盖证据层路径 |

**公共版默认不写死个人路径、不默认跑任何外部脚本。** 想要「每天自动整理」，装 `packages/pipeline` 并设 `MEMCORE_WORK`，再把 `dailyScripts` 里对应的 `enabled` 改成 `true`。

## 限制

- 依赖 DSH 的插件接口（`sp.context` / `sp.section` / `inject`），与 DSH 版本强绑定（0.2.x 测过）。
- 没有面板：要看记忆请装 `packages/dsh-panel`，或用 `packages/core` 的 CLI/网页。
