# ADR-0002：实现语言与调用方式——Node.js 单文件 + `type: "process"`

- 状态：Accepted（默认采用推荐方案，待用户复核）
- 日期：2026-09-15

## 背景

hook 脚本需要：读 stdin JSON、字符串/正则密集的规则匹配、跨 Windows/Git Bash 环境稳定运行。本机可用运行时：Node v22.22.2（fnm 管理）、Python 3.14.6、PowerShell。`type: "command"` 型 hook 走 shell（Windows 上 POSIX 语法会挂），`type: "process"` 型以 argv 直跑可执行文件、无 shell 参与。

## 决策

**Node.js 单文件脚本（`src/approve.mjs`，零第三方依赖），以 `type: "process"` 型 hook 调用**。安装器把 `process.execPath` 解析出的 node **绝对路径**写进注册项的 `command`，脚本绝对路径写进 `args`。

关键细节：本机 node 由 fnm 管理（`C:\Users\yx292\AppData\Roaming\fnm\node-versions\...`），fnm 的 PATH 注入通常发生在 shell profile 里；ZCode 是 GUI 应用，其派生的 hook 子进程 PATH 中未必有 `node`。因此**不能**只写 `"command": "node"`，必须在安装时固化绝对路径。

## 备选方案

- **Python 单文件**：JSON/正则能力相当（hookify 等插件即 Python）；但本机 Python 3.14 较新、第三方生态兼容性偶有坑，且与 ZCode 自身技术栈（Node）割裂。
- **PowerShell**：Windows 原生无运行时依赖，但 JSON 处理啰嗦、测试困难、跨平台为零。

## 后果

- 正面：`type: "process"` 完全绕开 shell，Windows 上最稳；零依赖意味着 `node --test` 之外不需要任何安装步骤。
- 负面：注册项里的 node 绝对路径在用户升级 node 版本（fnm 切换）后会失效——症状是 hook 报找不到命令，重跑 install 即修复；设计文档 §9 已注明。
