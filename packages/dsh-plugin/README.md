# dsh-memcore（DSH 插件）

把 memcore 装进 DeepSeek Harness：每轮自动注入线索 / 档案索引 / 开场卡，并注册 8 个工具。

**你不需要**：侧栏面板、策展流水线、MCP/HTTP 服务。这个包只在 DSH 里有意义。

## 它做什么

1. **证据层**：把会话的 user/assistant 原话追加到 `episodes.jsonl`（不经过模型）
2. **注入**：每轮把最近几段压成几行线索（≤1KB）、档案索引三行、开场记忆卡
3. **工具**：`recall` / `trace` / `remember` / `decide` / `fact_write` / `self_read` / `self_write` / `handoff_write`
4. **在场/回来信号**：读 `presence.json` / `returned.json`（可选，没有就跳过）

## 安装

### 不想自己动手：把这段粘给你的 AI

> 前提三条，缺一条就会卡住：agent 能改 profile 目录（完全权限）、机器上有 `git` 和 `pnpm`、装完**必须重启客户端**。

```text
把 GitHub 上的 memcore 装上，每一步结果都告我：
1) git clone --depth 1 https://github.com/yoooice/memcore 到临时目录；
2) 找到我的 DSH profile 目录（一般 ~/.dsh/profiles/desktop），在其中执行
   pnpm add file:<刚 clone 的目录>/packages/dsh-plugin
3) 把 "dsh-memcore" 加进该 profile 的 package.json 里 dsh.profile.bundles，再 pnpm install；
4) 重启 DSH，跑 node cli.mjs doctor，输出原样贴给我。
哪一步失败就说清是权限、网络还是版本问题，不要自己猜着改别的东西。
```

最常漏的是第 4 步的重启：`bundles` 改完不重启，插件不会加载，`doctor` 会把它标成「半装」。

### 手动

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
