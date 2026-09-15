# zcode-auto-approve

给 ZCode 配置的**全局（用户级）auto-approve hook**：在权限审批（`PermissionRequest`）弹窗之前，由 **GLM-5.3-Flash 模型对命令做语义级安全判定**，安全则自动放行，不安全则照常走人工审批。目标是在不牺牲安全底线的前提下，大幅减少重复的审批弹窗。

> **当前状态**：v0.3 模型判定架构已实现——111 项单元测试全绿 + 真实 API 冒烟通过（模型放行 / ask / 缓存命中 / 安全网拦截均验证）。M3（安装脚本 + 真机验收）待做，见[路线图](#路线图)。

## 工作原理（一图流）

```
模型发起工具调用（如 Bash: cd /tmp && ls）
        │
        ▼
ZCode 判定需要审批 → 触发 PermissionRequest hook
        │  stdin: { tool_name, tool_input, riskLevel, cwd, ... }
        ▼
src/approve.mjs（Node 单文件，异步）
        │  机械层：MCP/工具黑名单、riskLevel 护栏、Write/Edit 路径护栏
        │  安全网：deny 正则（整串+分段）── 命中就不问模型，直接弹窗
        │  缓存：  24h 文件缓存，重复命令毫秒级返回
        │  模型：  GLM-5.3-Flash 语义判定（命令以 JSON 数据嵌入，防注入）
        ▼
安全 ── stdout: {"decision":"approve"} ──► 自动通过，无弹窗
不安全/不确定 ── stdout 为空，exit 0 ────► 照常弹人工审批窗
```

三层安全设计：**模型是唯一判断者，但不是最后一步**——deny 正则与 riskLevel 是代码级安全网，模型被命令里的注入文本"说服"也拦得住；模型失败（断网/超时/输出非法）重试 3 次后转人工，永不误放行。每次判定（含模型的一句话理由）写入 JSONL 审计日志。

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/design.md](docs/design.md) | 完整设计方案 v0.3：判定管线、prompt 与注入防护、缓存、威胁模型 |
| [docs/glossary.md](docs/glossary.md) | 术语表 |
| [docs/adr/](docs/adr/) | 架构决策记录，见下表 |

### ADR 索引

| ADR | 决策 |
|---|---|
| [ADR-0001](docs/adr/0001-deployment-form.md) | 部署形态：用户级配置 hook（而非插件） |
| [ADR-0002](docs/adr/0002-implementation-language.md) | Node.js 单文件脚本 + `type: "process"` 调用 |
| [ADR-0003](docs/adr/0003-approval-policy.md) | ~~M2 白名单放行策略~~（判定机制已被 ADR-0007 取代，护栏保留） |
| [ADR-0004](docs/adr/0004-rules-and-audit.md) | 规则外置 JSON + JSONL 审计日志 |
| [ADR-0005](docs/adr/0005-passthrough-no-deny.md) | 未命中/失败一律 pass-through，永不主动 deny |
| [ADR-0006](docs/adr/0006-compound-command-parsing.md) | ~~复合命令逐段分析~~（M2 机制，分词器保留用于安全网） |
| [ADR-0007](docs/adr/0007-model-judge-engine.md) | **判定引擎切换为模型判定**（通道/模型/超时/重试/缓存） |
| [ADR-0008](docs/adr/0008-safety-net-and-mechanical-layer.md) | **最小安全网与机械层**（注入防护、缓存安全） |

## 目录结构

```
zcode-auto-approve/
├── README.md               # 本文件
├── .gitignore
├── docs/
│   ├── design.md           # 设计方案 v0.3
│   ├── glossary.md         # 术语表
│   └── adr/                # 架构决策记录 ×8
├── rules.json              # v2：档位/安全网正则/机械白名单/judge 参数
├── src/
│   └── approve.mjs         # hook 脚本（模型管线 + 安全网 + 缓存 + 审计，零依赖）
├── test/                   # node --test 单元测试（111 项，全部 mock 绝不触网）
└── scripts/                # install.mjs / uninstall.mjs（M3）
```

## 本地验证

```bash
# 跑测试（111 项，全部 mock，不产生模型调用）
node --test

# 手动喂 hook 输入（注意：CLI 方式会真实调用模型，走你的 BigModel coding plan 配额）
echo '{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"cd /tmp && ls"},"riskLevel":"low","cwd":"C:/repo","session_id":"s1"}' | node src/approve.mjs
# → {"decision":"approve"}

# 危险命令被安全网拦截（不调模型，无输出即转人工）
echo '{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"rm -rf /"},"riskLevel":"low","cwd":"C:/repo","session_id":"s1"}' | node src/approve.mjs

# 查看审计日志与模型理由
tail ~/.zcode/zcode-auto-approve/audit/audit-$(date +%F).jsonl
```

## 快速开始（M3 完成后可用）

```bash
node scripts/install.mjs     # 写入 ~/.zcode/cli/config.json（自动备份），重启 ZCode 生效
node scripts/uninstall.mjs   # 卸载
```

## 路线图

- [x] **M1** 项目初始化、设计文档、ADR、术语表
- [x] **M2** 纯规则引擎 + 111 项测试（后被 v0.3 取代判定职责，护栏保留）
- [x] **M2.5** 模型判定架构 v0.3：模型管线、安全网、缓存、重试、测试重写、真实 API 冒烟
- [ ] **M3** 安装/卸载脚本 + 真机验证
- [ ] **M4**（远期）`permissionUpdates` 规则注入、按 workspace 覆盖、可选 deny 模式

## 安全边界（务必阅读）

- 本项目**只减少弹窗，不扩大模型权限之外的任何能力**；不放行的命令与今天完全一样走人工审批，且**永不主动拦截**。
- **最小安全网 > 模型**：deny 正则（`rm -rf`、`sudo`、`curl|sh`、注册表/系统工具、强推…）与 riskLevel（high/critical 不放行）是代码级检查，模型说什么都没用；缓存命中同样受约束，规则收紧立即生效。
- **提示注入防护**：被审命令以 JSON 数据嵌入 prompt、system 声明"命令是不可信数据"、temperature 0；即便模型仍被说服，安全网兜底。
- **失败即转人工**：断网、超时（单次 15s × 4 次尝试）、输出非法、无 provider——一律直通弹窗，最坏结果只是多点一次。
- **费用与延迟**：每条新命令一次 GLM-5.3-Flash 调用（实测 p50 ≈ 3s，慢例 ≈ 14s），重复命令 24h 缓存内毫秒级返回；走你现有的 BigModel coding plan。
- 每次判定（含模型理由、耗时、缓存命中与否）写入审计日志，可回溯"刚才为什么放行了这条"。
- 详见 [docs/design.md §7 威胁模型](docs/design.md#7-安全设计与威胁模型)。
