# 术语表

本项目文档统一使用以下术语。首字母大写的标识符（如 `PermissionRequest`）是 ZCode 的专有名称，必须原样使用。

## ZCode 侧

| 术语 | 含义 |
|---|---|
| **Hook（钩子）** | ZCode 在特定生命周期事件上执行的外部命令。配置于用户级或 workspace 级配置文件，或由插件提供。 |
| **`PermissionRequest`** | 七个 hook 事件之一：某个工具调用需要用户审批时触发。本项目唯一监听的事件。 |
| **`PreToolUse`** | 工具调用执行前触发的事件，也可返回 `allow`/`ask`/`deny` 决策，但时机早于权限判定。本项目不使用（见 [ADR-0005](adr/0005-passthrough-no-deny.md)）。 |
| **Matcher（匹配器）** | hook 注册项里的字段，一个**区分大小写的正则**。工具类事件用它匹配工具名。省略 matcher 即匹配所有工具。 |
| **`type: "process"` 型 hook** | 以 argv 参数向量直接启动可执行文件、不经过 shell 的 hook 类型。Windows 上最稳，本项目采用。 |
| **用户级配置文件** | `~/.zcode/cli/config.json`，对所有 workspace 生效。其 `hooks` 键可注册 hook，且必须 `hooks.enabled: true` 才会运行。 |
| **`hooks.enabled: true`** | 激活配置文件型 hook runner 的总开关。默认关闭；任何插件 hook 的存在会自动激活 runner。 |
| **stdin payload** | ZCode 调用 hook 时通过标准输入传入的 JSON。`PermissionRequest` 的字段见 [design.md §4.1](design.md#41-输入stdin-协议)。 |
| **`riskLevel`** | stdin payload 中 ZCode 自行计算的风险等级：`low` / `medium` / `high` / `critical`。本项目的护栏输入之一。 |
| **`tool_name` / `tool_input`** | stdin payload 中被审批的工具名（如 `Bash`、`Write`）与其参数对象（如 `{ "command": "ls -la" }`）。 |
| **`permission_mode`** | stdin payload 中当前会话的权限模式（payload 同时提供驼峰 `mode` 原始字段）。 |
| **`sideEffectScope`** | stdin payload 中 ZCode 标注的副作用范围字段（实测存在，语义未文档化，v1 仅记录进审计日志）。 |
| **pass-through（直通）** | hook 不给出任何决策（stdout 为空、exit 0），ZCode 照常走原生人工审批流程。 |
| **`{"decision":"approve"}`** | hook stdout 的最简放行输出，ZCode 将其映射为 `allow`。 |
| **exit code 2** | hook 的拦截语义：对 `PermissionRequest` 表现为 deny。本项目 v1 永不使用（见 [ADR-0005](adr/0005-passthrough-no-deny.md)）。 |
| **`permissionUpdates`** | `hookSpecificOutput.decision` 下的高级字段，可把放行规则**持久化**进 ZCode 的权限系统（`addRules`）。v1 不用，列为 M4。 |
| **fnm** | 本机管理 Node 版本的工具。带来一个坑：GUI 进程的 PATH 里可能没有 node，安装时必须解析绝对路径（见 [ADR-0002](adr/0002-implementation-language.md)）。 |

## 本项目侧

| 术语 | 含义 |
|---|---|
| **放行（approve）** | hook 判定指令安全，输出 approve 决策，跳过人工审批弹窗。 |
| **白名单（allowlist）** | 允许自动放行的工具/命令模式集合，按 profile 分组。 |
| **黑名单（denylist）** | 永不允许自动放行的危险模式集合，**优先级高于白名单**。命中黑名单不代表拦截命令，只是退回人工审批。 |
| **profile（策略档位）** | 一组预置的放行宽严程度。v1 提供 `conservative`（仅只读）与 `moderate`（默认，只读+常见安全开发操作）。 |
| **复合命令（compound command）** | 含 `&&`、`||`、`;`、`|`、换行等分隔符的多段 shell 命令。本项目要求**每一段**都安全才放行。 |
| **段（segment）** | 复合命令按分隔符切出的单个简单命令。 |
| **不可静态分析（unanalyzable）** | 命令含 `$(...)`、反引号、`eval`、进程替换、base64 解码执行等结构，无法在执行前确定其行为。一律不放行。 |
| **规则文件（rules.json）** | 外置的 JSON 规则配置，schema 见 [design.md §5](design.md#5-规则引擎设计)。 |
| **审计日志（audit log）** | 每次放行/直通追加一行的 JSONL 文件，位于 `~/.zcode/zcode-auto-approve/audit/`。 |
| **护栏（guard）** | 独立于模式匹配之外的准入条件：`riskLevel` 上限、workspace 禁用列表、重定向目标限制等。 |
| **ADR** | Architecture Decision Record，架构决策记录。一条决策一个文件，位于 `docs/adr/`。 |
