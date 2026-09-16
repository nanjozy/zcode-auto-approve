# ADR-0009：hook 运行时来源——ZCode.exe（ELECTRON_RUN_AS_NODE）优先，fnm node 兜底

- 状态：Accepted（用户访谈确认，2026-09-16；**env 透传待真机验收确认**——若 hook 注册忽略 per-hook `env` 字段，本 ADR 回退为"维持 ADR-0002 现行注册"并修订）
- 日期：2026-09-16
- 演进：ADR-0002 的"注册项固化解释器绝对路径"原则不变，但解释器来源从 fnm node 演进为 ZCode.exe（本 ADR）；fnm node 降级为安装时兜底

## 背景

ADR-0002 把 node 绝对路径固化进注册项，规避了 fnm PATH 缺失问题，但残余风险仍在：**fnm 升级/切换 node 版本后注册路径失效**（症状：hook 报找不到命令，全部退回人工），需重跑 install。

事实考察（2026-09-16，本机实证）：

- ZCode 桌面端是 Electron 41.0.3 应用，**不附带独立 node.exe**；其 CLI 核心 `zcode.cjs` 由 Electron 内嵌 node 运行（`resources/glm/.node-bundle-meta.json`：`"runtime": "electron-node"`）。
- `ELECTRON_RUN_AS_NODE=1 ZCode.exe` 可把该 exe 当纯 node 用：实测内嵌 **node 24.14.0**（内置 fetch，满足 approve.mjs 要求），fuse 未关闭。
- ZCode 自身在 `app.asar` 内部就以 `env: {ELECTRON_RUN_AS_NODE: "1"}` 派生进程（5 处出现），该模式是应用的一等实践。
- 启动延迟：run-as-node ≈132ms/次 vs fnm node ≈83ms/次（+50ms，对 30s hook 预算可忽略）。
- deny-path 冒烟：经 run-as-node 跑 `approve.mjs`，`rm -rf /` 正确命中 deny-pattern、空输出 exit 0、审计落盘。
- `ZCode.exe` 经 electron-updater **原位更新，安装路径不变**——比"fnm 版本目录"稳定得多。

## 决策

安装器按以下顺序选择 hook 运行时，并把结果（含所选路径与原因）打印给用户：

1. 显式回退开关：env `ZAA_NODE_SOURCE=node` → 直接用 fnm node（`process.execPath` 绝对路径），不尝试 ZCode.exe——这是 ZCode 更新破坏本通道后的文档化逃生门；
2. `ZCode.exe` 定位：env `ZAA_ELECTRON` 覆盖 > 默认安装路径 `%LOCALAPPDATA%\Programs\ZCode\ZCode.exe` 存在性探测；
3. 运行时验证（两者都过才采用）：run-as-node 版本探针（exit 0 且输出 node 版本）+ deny-path 冒烟（经 `approve.mjs` 喂 `rm -rf /`，期望空输出 exit 0）；
4. 验证通过 → 注册 `command: <ZCode.exe>`、`env: {ELECTRON_RUN_AS_NODE: "1"}`、`args: [approve.mjs]`；任一步失败 → 回退 fnm node 绝对路径（现行形态），打印回退原因。

卸载匹配逻辑不变（按 args 含 `approve.mjs`），两种注册形态通吃。

## 备选方案（含被否决理由）

- **维持现状（仅 fnm node）**：零新风险，但 fnm 版本切换断路径的痛点长存，且与"去除用户 node 依赖"的目标相悖。
- **cmd.exe wrapper**（`command: cmd.exe`，args 里 set 环境变量后链式调用）：不依赖 env 字段支持，但把 shell 重新引进调用链——违背 ADR-0002 选 `type: "process"` 的初衷，引号拼接脆弱、可审计性差。
- **ELECTRON_RUN_AS_NODE 独占（无兜底）**：ZCode 更新换机器/卸载 ZCode 时无退路，验证失败只能拒绝安装。

## 风险与已接受的残余风险

- **非承诺通道**：`ELECTRON_RUN_AS_NODE` 是 Electron 官方环境变量，但 ZCode 可通过 Electron fuse 关闭它或更改内部实现。某次 ZCode 更新后 hook 可能静默失效——后果是 fail-safe 的（全部退回人工审批，安全性不降），重跑 install 会自动验证并回退；验证通过但仍异常时用 `ZAA_NODE_SOURCE=node` 强制回退。
- **env 透传未证实**：per-hook `env` 字段是否被 ZCode 的 hook 派生器透传，无法离线验证。若被静默忽略，症状是每次审批弹出一个异常窗口（Electron 单实例锁使其短暂无害），此时按上一条回退。真机验收（design.md §10.2）包含此项观察。
- 费用/延迟/判定语义与运行时来源无关，不受本决策影响。
