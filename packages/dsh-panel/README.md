# DSH 面板适配器（记忆核心）

把 memcore 内核挂进 DSH（DeepSeek Harness）客户端的左侧栏，入口名「记忆核心」。
面板与 MCP/HTTP/CLI 共用同一份数据，不另起端口。

## 结构

```
index.js         宿主半：同进程加载 lib/core.mjs，注册 /api/memcore/* 路由
client.js        浏览器半：sidebar.panellist 入口 + main 面板（检索/事实/决策/档案四页）
cordis.patch.yml 插件的 patch（insert 一条）
lib/             内核快照（与 packages/core/lib 同步；发布时一起更新）
```

## 安装

1. 复制到客户端 profile：

   ```bash
   cp -r packages/dsh-panel/. "C:/Users/you/.dsh/profiles/desktop/node_modules/dsh-memcore-panel/"
   ```

2. profile 的 `package.json` 里加依赖与 bundle：

   ```json
   "dependencies": { "dsh-memcore-panel": "file:D:/path/to/memcore/packages/dsh-panel" },
   "dsh": { "profile": { "bundles": ["...", "dsh-memcore-panel"] } }
   ```

3. 让客户端重新加载 patch（重启或 `utimesSync` 触发）：

   ```bash
   node -e "const f='C:/Users/you/.dsh/profiles/desktop/cordis.patch.yml';const t=Date.now()/1000;require('fs').utimesSync(f,t,t)"
   ```

4. 新增 bundle **必须重启客户端**（不是热重载），重启后左栏出现「记忆核心」。

## 数据位置

宿主半默认读 `MEMCORE_DIR`（缺省 `~/.dsh/memcore`）、档案目录 `MEMCORE_DOCS`（缺省 `D:/Deepseek-Core/Work/memory`）。
换机器时用环境变量指定，别改代码。

## 限制

- 面板只做「看和搜 + 写事实/决策」，不做批量导入。
- DSH 的 UI 槽位 API 随版本可能变；升级客户端后若面板空白，先看控制台里 `[memcore-panel]` 的报错。
