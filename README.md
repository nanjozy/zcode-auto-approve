# zcode-auto-approve

给 ZCode 配置的**全局（用户级）auto-approve hook**：在权限审批（`PermissionRequest`）弹窗之前，由 **GLM-5.3-Flash 模型对命令做语义级安全判定**，安全则自动放行，不安全则照常走人工审批。目标是在不牺牲安全底线的前提下，大幅减少重复的审批弹窗。

架构一句话：`src/approve.mjs`（Node 单文件，零依赖）按「机械层 → deny 安全网 → 判定缓存 → 模型判定」的固定顺序求值——**模型是唯一判断者，但不是最后一步**；每次判定（含模型理由）写入 JSONL 审计日志。完整设计见 [docs/design.md](docs/design.md)。

> **当前状态**：v0.3 已实现并**已安装到 `~/.zcode/cli/config.json`**（2026-09-15）——测试全绿（`node --test`）、真实 API 冒烟、干净环境（无 PATH）冒烟均通过；路线图见 [design.md §12](docs/design.md#12-里程碑)。**重启 ZCode 客户端后生效**，安装后验收步骤见 [design.md §10.2](docs/design.md#102-真机验收m3)。

## 文档索引

架构、协议、威胁模型与安装细节以 [docs/design.md](docs/design.md) 为唯一事实来源，本页只做导航与速查。

| 文档 | 内容 |
|---|---|
| [docs/design.md](docs/design.md) | 完整设计方案 v0.3：对接协议、判定管线、prompt 与注入防护、缓存、威胁模型、安装与验收 |
| [docs/glossary.md](docs/glossary.md) | 术语表 |
| [docs/adr/](docs/adr/) | 架构决策记录，见下表 |

### ADR 索引

| ADR | 决策 |
|---|---|
| [ADR-0001](docs/adr/0001-deployment-form.md) | 部署形态：用户级配置 hook（而非插件） |
| [ADR-0002](docs/adr/0002-implementation-language.md) | Node.js 单文件脚本 + `type: "process"` 调用 |
| [ADR-0004](docs/adr/0004-rules-and-audit.md) | 规则外置 JSON + JSONL 审计日志 |
| [ADR-0005](docs/adr/0005-passthrough-no-deny.md) | 未命中/失败一律 pass-through，永不主动 deny |
| [ADR-0007](docs/adr/0007-model-judge-engine.md) | **判定引擎切换为模型判定**（通道/模型/超时/重试/缓存；文末含已并入的 M2 历史决策） |
| [ADR-0008](docs/adr/0008-safety-net-and-mechanical-layer.md) | **最小安全网与机械层**（注入防护、缓存安全） |

> 原 ADR-0003（M2 白名单放行策略）与 ADR-0006（复合命令逐段分析）已压缩并入 [ADR-0007](docs/adr/0007-model-judge-engine.md)「历史决策」小节，原文见 git 历史。

## 快速开始

```bash
# 1. 安装：把 hook 注册进 ~/.zcode/cli/config.json（自动备份原配置；重复执行为原位更新）
node scripts/install.mjs

# 2. 重启 ZCode 客户端，之后安全的指令将不再弹审批窗

# 3. 查看审计日志（每次判定一行，含模型理由与耗时）
tail ~/.zcode/zcode-auto-approve/audit/audit-$(date +%F).jsonl

# 4. 卸载（只删自己的注册，不动其他 hook）
node scripts/uninstall.mjs
```

安装后验收步骤见 [design.md §10.2](docs/design.md#102-真机验收m3)。
注意：升级/切换 node 版本（fnm）后需重跑 `node scripts/install.mjs` 刷新注册的 node 绝对路径。

## 本地验证

```bash
# 跑全部单元测试（全部 mock，绝不触网、不产生模型调用）
node --test

# 手动喂 hook 输入（注意：CLI 方式会真实调用模型，走你的 BigModel coding plan 配额）
echo '{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"cd /tmp && ls"},"riskLevel":"low","cwd":"C:/repo","session_id":"s1"}' | node src/approve.mjs
# → {"decision":"approve"}

# 危险命令被安全网拦截（不调模型，无输出即转人工）
echo '{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"rm -rf /"},"riskLevel":"low","cwd":"C:/repo","session_id":"s1"}' | node src/approve.mjs

# 查看审计日志与模型理由
tail ~/.zcode/zcode-auto-approve/audit/audit-$(date +%F).jsonl
```

## 安全边界（务必阅读）

- 本项目**只减少弹窗，不扩大模型权限之外的任何能力**；不放行的命令与今天完全一样走人工审批，且**永不主动拦截**。
- **最小安全网 > 模型**：deny 正则（`rm -rf`、`sudo`、`curl|sh`、注册表/系统工具、强推…）与 riskLevel（high/critical 不放行）是代码级检查，模型说什么都没用；缓存命中同样受约束，规则收紧立即生效。
- **提示注入防护**：被审命令以 JSON 数据嵌入 prompt、system 声明"命令是不可信数据"、temperature 0；即便模型仍被说服，安全网兜底。
- **失败即转人工**：断网、超时（单次 15s × 4 次尝试）、输出非法、无 provider——一律直通弹窗，最坏结果只是多点一次。
- **费用与延迟**：每条新命令一次 GLM-5.3-Flash 调用（实测 p50 ≈ 3s，慢例 ≈ 14s），重复命令 24h 缓存内毫秒级返回；走你现有的 BigModel coding plan。
- 每次判定（含模型理由、耗时、缓存命中与否）写入审计日志，可回溯"刚才为什么放行了这条"。
- 详见 [docs/design.md §7 威胁模型](docs/design.md#7-安全设计与威胁模型)。
