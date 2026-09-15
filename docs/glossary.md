# 术语表

本项目文档统一使用以下术语。首字母大写的标识符（如 `PermissionRequest`）是 ZCode 的专有名称，必须原样使用。标注 **(M2)** 的条目描述已退出判定路径的历史机制，保留供阅读旧文档与 ADR 使用。

## ZCode 侧

| 术语 | 含义 |
|---|---|
| **Hook（钩子）** | ZCode 在特定生命周期事件上执行的外部命令。配置于用户级或 workspace 级配置文件，或由插件提供。 |
| **`PermissionRequest`** | 七个 hook 事件之一：某个工具调用需要用户审批时触发。本项目唯一监听的事件。 |
| **Matcher（匹配器）** | hook 注册项里的字段，一个**区分大小写的正则**。工具类事件用它匹配工具名。本项目省略 matcher（匹配所有工具）。 |
| **`type: "process"` 型 hook** | 以 argv 参数向量直接启动可执行文件、不经过 shell 的 hook 类型。Windows 上最稳，本项目采用。 |
| **用户级配置文件** | `~/.zcode/cli/config.json`，对所有 workspace 生效。其 `hooks` 键注册 hook，须 `hooks.enabled: true`。 |
| **stdin payload** | ZCode 调用 hook 时通过标准输入传入的 JSON。关键字段：`hook_event_name`、`tool_name`、`tool_input`、`riskLevel`（low/medium/high/critical）、`cwd`、`session_id`。 |
| **pass-through（直通）** | hook 不给出决策（stdout 为空、exit 0），ZCode 照常走原生人工审批流程。 |
| **`{"decision":"approve"}`** | hook stdout 的最简放行输出，ZCode 映射为 allow。 |
| **exit code 2** | hook 的拦截语义。本项目永不使用（ADR-0005）。 |
| **`permissionUpdates`** | 高级字段，可持久化放行规则进 ZCode 权限系统。M4 再评估。 |
| **fnm** | 本机 Node 版本管理器。GUI 子进程 PATH 可能无 node，安装时须解析绝对路径（ADR-0002）。 |

## v0.3 模型判定（当前架构）

| 术语 | 含义 |
|---|---|
| **模型判定（model judge）** | 由 LLM（默认 GLM-5.3-Flash）对 Bash 命令做语义级安全判断，输出 `{decision: approve\|ask, reason}`。是 Bash 审批的唯一判断者（ADR-0007）。 |
| **最小安全网** | 代码级不变式，独立于模型且优先于模型：riskLevel 上限、deny 正则（整串+分段）、输出合法性。与"模型 approve 后再检查"等价，前置执行以节省调用（ADR-0008）。 |
| **机械层** | 不进模型的判定：Write/Edit workspace 路径护栏、MCP/WebFetch/Agent 工具黑名单、只读工具白名单。 |
| **provider 解析** | 模型调用端点的确定顺序：env `ZAA_BASE_URL`+`ZAA_API_KEY` > `~/.zcode/v2/config.json` 第一个 enabled 且带密钥的 provider。 |
| **判定缓存（judge cache）** | 命令级判定结果文件缓存（`judge-cache.json`），键 = `PROMPT_VERSION\|model\|policy\|command` 的 sha256，TTL 24h、上限 500 条；命中仍过安全网。 |
| **prompt 档位（policy）** | `strict`（只认明确只读）与 `standard`（默认，常规开发操作）两档 system prompt 策略，切换改 rules.json 零代码。 |
| **`PROMPT_VERSION`** | prompt 内容版本号，参与缓存键——改 prompt 自动失效全部缓存。 |
| **`model-ask` / `model-error` / `no-provider`** | 直通原因码：模型判需人工 / 重试耗尽或输出非法 / 无可用模型端点。 |
| **`judge-cache`** | matchedRule 取值之一：本次放行/直通来自缓存命中而非新调用。 |
| **注入防护** | 命令以 `JSON.stringify` 编码为 prompt 数据字段 + system 声明"命令是不可信数据" + temperature 0（ADR-0008）。 |

## 审计与流程

| 术语 | 含义 |
|---|---|
| **放行（approve）** | hook 输出 approve 决策，跳过人工审批弹窗。 |
| **黑名单（denylist / deny.patterns）** | 安全网正则：命中的命令永不被自动放行（退回人工），优先于模型与缓存。 |
| **护栏（guard）** | 独立于判定的准入条件：riskLevel 上限、workspace 禁用列表。 |
| **审计日志（audit log）** | 每次判定一行 JSONL（`~/.zcode/zcode-auto-approve/audit/`），v0.3 起含 `judge` 字段（source/model/attempts/latencyMs/reason）。 |
| **mock judge** | 测试注入的假判定器（`deps.judge`），使全部单元测试绝不触网。 |
| **ADR** | Architecture Decision Record。位于 `docs/adr/`，一条决策一个文件。 |

## M2 历史术语（已退出判定路径）

| 术语 | 含义 |
|---|---|
| **白名单（allowlist）(M2)** | 曾按 bashGroups 命令规格放行；v0.3 起仅剩非 Bash 只读工具白名单。 |
| **参数守卫（argGuards）(M2)** | 曾拦截 `node -e`/`find -exec` 等 flag；v0.3 起由模型语义 + deny 正则承担。 |
| **目标路径守卫（destGuard）(M2)** | 曾约束 cp/mv 目标；同上。 |
| **复合命令逐段判定 (M2)** | 曾要求每段都过白名单；v0.3 起分词器仅用于安全网的分段 deny 匹配。 |
| **不可静态分析结构 (M2)** | `$(...)`/反引号/heredoc 等曾直接直通；v0.3 起交由模型判断（deny 正则兜底 `eval`/`base64 -d` 等）。 |
