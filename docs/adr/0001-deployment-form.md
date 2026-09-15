# ADR-0001：部署形态——用户级配置 hook

- 状态：Accepted（默认采用推荐方案，待用户复核）
- 日期：2026-09-15

## 背景

ZCode 注册 hook 有两条路：① 用户级配置文件 `~/.zcode/cli/config.json` 的 `hooks.events.PermissionRequest`（需 `hooks.enabled: true`）；② 打包成本地插件经 marketplace 安装（插件 hook 自动激活 runner）。需求明确要"全局"生效，即用户级范围，两条路都能达到。

## 决策

采用**用户级配置 hook**：脚本在本仓库维护，安装器把指向它的注册项写进 `~/.zcode/cli/config.json`，并置 `hooks.enabled: true`。

## 备选方案

- **本地插件**：优点是插件 hook 自动激活 runner、不碰全局 `enabled` 开关、天然可分发；缺点是要走 marketplace 安装流程，改规则/脚本后需重装或依赖插件目录副本，日常迭代摩擦大。本项目是个人全局工具、脚本路径固定，插件化的收益用不上。
- **两者兼备**：仓库同时维护插件清单。维护两份注册结构，v1 无此需求。

## 后果

- 正面：改 `rules.json`/脚本即时生效，无需任何重装动作；结构最少。
- 负面：`hooks.enabled: true` 会激活**所有**配置型 hook——本机当前没有其他配置型 hook，无实际副作用；安装器检测到已有其他 hook 时会打印提示。
- 本机 `~/.zcode/cli/config.json` 尚不存在，安装器负责创建（provider 配置在 `~/.zcode/v2/config.json`，互不干扰）。
