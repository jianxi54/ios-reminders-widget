# 参与贡献

感谢你愿意帮忙。这个项目很小，维护者只有一个人，所以下面这些约定能省掉很多来回。

## 先看这两件事

1. **这是非官方客户端。** 它走 iCloud 网页版背后的 CloudKit 私有接口，接口没有公开文档，所有格式都是抓包和试错得出的。改动这部分请务必做真机验证（改一条，去 iPhone 上看）。
2. **不要提交本机数据。** `icloud-session.json`、`settings.json`、`pushed.json`、`browser-profile/`、`node/`、`dist/` 都已在 `.gitignore` 里。开 PR 前请确认 `git status` 里没有这些东西，也没有你自己的 Bark Key。

## 报告问题

- 功能异常、崩溃、同步不对 → 用 [Bug 报告](.github/ISSUE_TEMPLATE/bug_report.yml)
- 想要新功能 → 用 [功能建议](.github/ISSUE_TEMPLATE/feature_request.yml)
- 安全漏洞 → **不要开 Issue**，按 [SECURITY.md](SECURITY.md) 走私密通道

提 Bug 时把「设置 → 关于 → 诊断信息」那一段贴上来，里面版本号、同步模式、错误原文都有，能省掉一半的往返。

## 本地开发

### 环境

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | 18+ | 本地服务（`127.0.0.1:8642`） |
| .NET SDK | 8.0+ | 编译原生宿主与安装器 |
| WebView2 Runtime | 任意 | Windows 11 自带 |

### 跑起来

```bat
:: 1. 编译宿主（首次、或改了 host\widget-host.cs 之后）
build-host.bat

:: 2. 开发模式启动（用系统 Node，不打包）
start-widget.bat

:: 3. 打安装包（可选，产物在 dist\）
powershell -ExecutionPolicy Bypass -File packaging\build.ps1
```

开发目录必须在项目根下存在 `node\node.exe`（宿主优先找它），否则宿主会退到系统 PATH 里的 Node。没有的话把它链接或复制过去，该目录已被 gitignore。

### 登录 iCloud

首次运行点设置里的「打开浏览器登录」，或直接跑 `login-icloud.bat`。登录必须由真实浏览器完成——Node 直接 POST `idmsa.apple.com` 会被 Apple WAF 拦成 503（TLS 指纹识别），加什么请求头都没用。

## 改代码时请注意

- **版本号只有一个来源**：`lib/version.js` 的 `VERSION`。改版本时同步改 `CHANGELOG.md`、`host/widget-host.cs` 里的 `APP_VERSION`，三处必须一致。
- **写入是原子的**。日期和提醒必须放进同一个 CloudKit `modify` 批次，拆成两次提交会被服务端静默丢弃。相关坑都写在 README 的「技术说明」里，动 `lib/cloudkit.js` 之前先读一遍。
- **同一个状态只能有一条写路径**。前端改内存的同时必须有对应的接口调用，否则刷新就回退；反过来写了库但页面不刷新也是 Bug。
- **不要加滚动条**，也不要把原生 `<select>` 放回来（暗色下会白底白字）。下拉是自绘的。
- **不要在日志里打令牌、Cookie、Bark Key。** 日志会进用户的问题反馈里。

### 代码风格

不用格式化工具，跟着周围代码走即可：2 空格缩进、单引号、分号不省；C# 部分用 4 空格缩进、`_camelCase` 私有字段。

### 提交信息

```
<范围>: <做了什么>

<为什么，可选>
```

范围用 `ui` / `cloudkit` / `host` / `packaging` / `docs` 之一。例：`cloudkit: 日期与提醒合并到同一批次`。

## 提交 PR

1. 从 `master` 拉分支：`git switch -c fix/alarm-batch`
2. 只做一件事。一个 PR 里混三件不相关的改动，审查会卡住。
3. 自测写进 PR 描述：改了什么、怎么验证的、影响哪些已有功能。
4. 涉及界面改动的，附一张改前改后的截图。
5. CI 必须绿（语法检查、版本一致性、宿主编译）。

CI 只跑基础检查，**同步相关改动请自己上真机验证**，CI 连不到 iCloud。

## 行为准则

参与本项目即表示同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## 许可

提交的代码按 [MIT](LICENSE) 授权。你保留著作权，但同意以同样的许可分发。
