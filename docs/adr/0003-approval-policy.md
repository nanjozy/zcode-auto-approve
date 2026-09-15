# ADR-0003：放行策略——分级白名单 + 黑名单优先 + riskLevel 护栏

- 状态：Accepted（默认采用推荐方案"中等档"，待用户复核）
- 日期：2026-09-15

## 背景

"安全指令"的判定是本项目核心安全决策。stdin payload 提供 ZCode 自算的 `riskLevel`（low/medium/high/critical）。谱线上的四档：仅只读（保守）、白名单+黑名单（中等）、完全信任 riskLevel、仅黑名单（激进）。

## 决策

采用**中等档**作为默认，并以 profile 机制保留档位切换：

1. **黑名单永远优先**：危险模式（`rm -rf`、`sudo`、`curl|sh`、注册表/计划任务、`git push --force`…）与高危工具（全部 MCP 工具、`WebFetch`/`WebSearch`、`Agent`）命中即不放行；
2. **riskLevel 护栏**：moderate 档上限 `medium`——`high`/`critical` 一律不放行，作为独立于自家规则之外的兜底；
3. **白名单按组管理**：`readonly`（ls/cat/git status…）与 `safework`（mkdir/git commit/npm install/npm test/node/python/cargo…）两组，moderate 全开，conservative 只开 readonly；
4. **文件写操作**：moderate 档放行 `Write`/`Edit`，但目标路径必须在 workspace（stdin 的 `cwd`）内；conservative 不放行；
5. 复合命令逐段判定的细则独立记录于 [ADR-0006](0006-compound-command-parsing.md)。

## 备选方案

- **保守（仅只读）**：最安全但弹窗依然频繁，收益打折，作为 profile 保留而非默认。
- **完全信任 riskLevel（low 即放行）**：实现最简，但把安全判断整体外包给 ZCode 内部分类器，口径不可控、不可审计、随版本漂移；自家规则 + riskLevel 作上限护栏的组合严格更稳。
- **激进（仅黑名单）**：体验最顺滑，但白名单之外的大量中危命令（任意可执行文件、任意网络写）都会被放行，违背"安全底线不降级"的项目目标。

## 后果

- 正面：判定的每一行规则都在本仓库版本控制下，可审计、可回滚；riskLevel 漂移只影响护栏松紧、不影响规则本体。
- 已接受的残余风险（T4）：`npm install` 的 postinstall 供应链风险、`git commit` 提交敏感文件——moderate 档显式接受，文档与 README 均有披露；不接受时切 conservative。
