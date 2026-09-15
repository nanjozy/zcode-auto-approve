# zcode-auto-approve

给 ZCode 配置的**全局（用户级）auto-approve hook**：在权限审批（`PermissionRequest`）弹窗之前，用一个本地脚本静态判定指令是否安全，安全则自动放行，不安全则照常走人工审批。目标是在不牺牲安全底线的前提下，大幅减少重复的审批弹窗。

> **当前状态**：阶段 M1（项目初始化 + 设计方案）。实现尚未开始，见[路线图](#路线图)。

## 工作原理（一图流）

```
模型发起工具调用（如 Bash: npm test）
        │
        ▼
ZCode 判定需要审批 → 触发 PermissionRequest hook
        │  stdin: { tool_name, tool_input, riskLevel, cwd, ... }
        ▼
src/approve.mjs（本项目，Node.js 单文件）
        │  1. 黑名单优先：命中危险模式 → 不放行
        │  2. riskLevel 护栏：high/critical → 不放行
        │  3. 白名单判定：工具/命令逐段匹配 rules.json
        ▼
安全 ── stdout: {"decision":"approve"} ──► 自动通过，无弹窗
不安全/不确定 ── stdout 为空，exit 0 ────► 照常弹人工审批窗
```

核心原则：**只做自动放行，永不自动拦截**。脚本对任何不确定的情况（解析不了、超时、报错）都退回人工审批，因此最坏结果只是"多弹一次窗"，而不是"放过了危险命令"。

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/design.md](docs/design.md) | 完整设计方案：hook 协议、规则引擎、安全设计、安装方案、测试方案 |
| [docs/glossary.md](docs/glossary.md) | 术语表 |
| [docs/adr/](docs/adr/) | 架构决策记录（ADR），见下表 |

### ADR 索引

| ADR | 决策 |
|---|---|
| [ADR-0001](docs/adr/0001-deployment-form.md) | 部署形态：用户级配置 hook（而非插件） |
| [ADR-0002](docs/adr/0002-implementation-language.md) | Node.js 单文件脚本 + `type: "process"` 调用 |
| [ADR-0003](docs/adr/0003-approval-policy.md) | 放行策略：分级白名单 + 黑名单优先 + riskLevel 护栏 |
| [ADR-0004](docs/adr/0004-rules-and-audit.md) | 规则外置 JSON 文件 + JSONL 审计日志 |
| [ADR-0005](docs/adr/0005-passthrough-no-deny.md) | 未命中/失败一律 pass-through，v1 不主动 deny |
| [ADR-0006](docs/adr/0006-compound-command-parsing.md) | 复合命令逐段全安全才放行，不可静态分析则不放行 |

> 注：以上决策在设计访谈未获得用户答复的情况下，按推荐方案默认采用并在 ADR 中记录了备选项，**待用户复核**。如需调整，改动对应 ADR 与 `docs/design.md` 即可。

## 目录结构（规划）

```
zcode-auto-approve/
├── README.md               # 本文件
├── .gitignore
├── docs/
│   ├── design.md           # 完整设计方案
│   ├── glossary.md         # 术语表
│   └── adr/                # 架构决策记录
├── rules.json              # 放行规则（M2 实现，schema 见设计文档 §5）
├── src/
│   └── approve.mjs         # hook 脚本入口（M2 实现）
├── scripts/
│   ├── install.mjs         # 安装：写入 ~/.zcode/cli/config.json（M3）
│   └── uninstall.mjs       # 卸载（M3）
└── test/                   # 规则引擎单元测试（M2）
```

## 快速开始（M3 完成后可用）

```bash
# 1. 安装：把 hook 注册进 ~/.zcode/cli/config.json（自动备份原配置）
node scripts/install.mjs

# 2. 重启 ZCode，之后安全的指令将不再弹审批窗

# 3. 查看审计日志（每次自动放行都有记录）
tail ~/.zcode/zcode-auto-approve/audit/audit-$(date +%F).jsonl

# 4. 卸载
node scripts/uninstall.mjs
```

## 路线图

- [x] **M1** 项目初始化、README、设计方案、ADR、术语表（本阶段）
- [ ] **M2** 规则引擎 + `src/approve.mjs` + 单元测试
- [ ] **M3** 安装/卸载脚本 + 真机验证（各类 riskLevel、复合命令）
- [ ] **M4**（远期）`permissionUpdates` 规则注入、按 workspace 覆盖、可选 deny 模式

## 安全边界（务必阅读）

- 本项目**只减少弹窗，不扩大模型权限之外的任何能力**；不放行的命令与今天完全一样走人工审批。
- 黑名单永远优先于白名单；`riskLevel` 为 `high`/`critical` 一律不放行。
- 含命令替换 `$(...)`、反引号、`eval` 等无法静态分析的命令一律不放行。
- 每次放行都写入 JSONL 审计日志，可回溯"刚才为什么自动放行了这条"。
- 详见 [docs/design.md §7 威胁模型](docs/design.md#7-安全设计与威胁模型)。
