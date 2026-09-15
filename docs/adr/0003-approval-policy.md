# ADR-0003：放行策略——分级白名单 + 黑名单优先 + riskLevel 护栏

- 状态：**Superseded（判定机制部分）**——v0.3 起 Bash 判定改为模型判定，本 ADR 的白名单/argGuards/目标守卫机制退出判定路径；deny 正则与 riskLevel 护栏以"最小安全网"形式保留（见 [ADR-0007](0007-model-judge-engine.md)/[0008](0008-safety-net-and-mechanical-layer.md)）。以下原文记录 M2 阶段决策。
- 日期：2026-09-15；修订：2026-09-15（M2）；取代：2026-09-15（v0.3）

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

## 修订（2026-09-15，M2 实施阶段）

实现与测试过程中发现 M1 草案的白名单存在**超出 T4 边界的任意代码执行通道**，收紧如下（规则层面的差异见 design.md §5.2"M2 实施修订"）：

1. **新增 `argGuards` 参数守卫**：草案语义"命令字匹配则任意参数放行"使 `node -e "代码"`、`python -c`、`find -exec rm`、`rg --pre cmd` 可直接执行任意代码——这不是"repo 内代码"（T4），是即席代码注入，必须挡。守卫命中的规格失效，落回人工审批。
2. **`npx`、`npm exec`、`pnpm exec` 移出 safework**：拉取并执行任意远端包，同样超出 T4。
3. **`npm run` 从 readonly 移到 safework**：它执行 package.json scripts，本就不是只读。
4. **`cp`/`mv` 内置目标路径守卫**：白名单命令的参数指向 workspace 外路径（绝对路径、`~`、`..`）时直通，与 fileEdits 的 workspace-only 哲学对齐。
5. **deny 正则修正**：`eval` 锚定命令位置（原 `\beval\b` 误伤 `node --eval=code`/`grep eval`）；`git push --force` 补充 ` -f` 短旗标；`dd of=` 修正为 `dd\b.*of=/dev/`。

修订后的残余风险仍为 T4 一类（repo 内代码执行：npm scripts、Makefile、pytest 收集钩子等），维持"moderate 档显式接受、conservative 档可完全规避"的立场。
