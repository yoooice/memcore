# 更新日志

## 0.2.0 — 2026-11-09

- 新增 `node cli.mjs doctor`（`lib/doctor.mjs`）：只读体检，覆盖「装了但没生效」的常见现场——数据目录接错、插件没进 `dsh.profile.bundles`、`billion-context` 版本不在测试矩阵、profile `package.json` 带 BOM、目录不可写、开场卡太久没注入。每项失败给一条可复制的修复命令，不写任何文件。支持 `--json`。
- 新增英文 README（`README.en.md`），中文 README 顶部加语言切换。
- README 新增「搭配上下文压缩」一节：为什么推荐 billion-context、什么时候不需要、测试矩阵、责任边界。
- `package.json` 补 `repository` / `homepage` / `bugs` 字段。

## 0.1.1 及更早

见 git 历史。
