# SPEC — 最终形态（当前实现即最终版）

> 本文件是**唯一权威功能清单**。早期方案（毛玻璃背景、＋ 新建按钮、原生 select、8px 系统圆角、列表分组、可见滚动条）已废弃，不再实现、不再讨论。
> 详细技术踩坑见 `README.md`，此处只留"留下来的功能"。
> 当前版本 **V0.04**，每次迭代 +0.01，明细记在 `CHANGELOG.md`。

## 1. 定位

iPhone「提醒事项」↔ Windows 11 桌面**原生小组件**。数据走 iCloud 私有 CloudKit（`com.apple.reminders`），读写双向同步回 iPhone。

## 2. 最终功能清单

### 窗口与宿主
| # | 行为 |
|---|---|
| 1 | 窗口 420×400，无边框，**20px 圆角**（`SetWindowRgn` + `CreateRoundRectRgn`） |
| 2 | **固定到桌面层**：不遮挡其他窗口、不受 Win+D 影响、任务栏不显示；资源管理器重启后自动挂回 |
| 3 | **固定 = 锁定位置**：固定后拖不动（宿主不响应拖动、页面也无拖动手柄）；取消固定才能拖；位置记忆 |
| 4 | **固定状态会记住**：写进 `settings.json` 的 `ui.pinned`，下次启动自动恢复固定 + 锁定，不用重新点图钉 |
| 5 | 托盘常驻：显示/隐藏、固定/取消固定、开机自启（HKCU Run）、退出；标题栏 ✕ 收进托盘（收进后 WebView2 自动挂起省内存） |
| 6 | 启动无黑框控制台；无边框窗口用自定义标题栏按钮 |
| 7 | 版本号 V0.04 显示在设置抽屉底部，托盘提示带版本 |
| 8 | **会话自愈**：重新登录后服务按会话文件修改时间自动重载，最多 20 秒接上，不用重启；421 `Invalid global session` 视为会话失效并给出明确提示 |
| 9 | **自带 Node 运行时**：优先用程序目录 `node\node.exe`，其次系统 Node；分发不要求用户装 Node.js |
| 10 | **单实例**：连点快捷方式只保留一个窗口。第二个进程用命名互斥量判定、用命名事件唤醒已有实例后退出；唤醒时不重复拉起 Node 服务 |
| 11 | **程序图标**：exe / 桌面与开始菜单快捷方式 / 安装器 / 卸载器统一用 `assets\app.ico`（16–256 共 10 个尺寸），托盘图标同一套视觉 |

### 版式（对齐 Apple 截图）
- 顶部：**大号计数 36px/700** + **列表名 15px/600**（用列表色）+ 细分隔线
- **无 ＋ 按钮**、无列表分组/分类标签、底部无任何文字
- 行高 42px，行距紧凑（标题 1.24 / 备注 1.28，body gap 1px）
- **全界面无滚动条**（列表、详情、设置三处），滚轮自然滚动
- 右上角圆形按钮进「已完成」视图，同位置变返回箭头

### 交互
| 操作 | 方式 |
|---|---|
| 新建 | 点**列表末尾空白行**直接输入，回车建；空行默认不显示圆圈，进入输入才出现 |
| 改名 | 点**标题文字**就地编辑，回车保存 / Esc 取消；编辑框无边框无底色，字落在原位 |
| 查看/编辑详情 | 点条目**其余位置**打开详情面板 |
| 完成 / 取消 | 点左侧圆圈，条目像 iOS 一样收起消失；已完成进独立视图（日期仍灰色显示） |
| 删除 | 详情内「删除提醒」，二次点击确认 |
| 同步 | 每 20 秒自动 + 窗口聚焦刷新 + 头部 ↻ 手动刷新 |

### 字段
- **标题**、**备注**（行内两行摘要，详情看全文并可编辑；多行富文本取全部文字节点）
- **日期 / 时间 / 全天**；已完成条目也显示日期
- **提前提醒**：按 iOS 标准 —— 准时 / 提前 5、15、30 分钟 / 1、2 小时 / 1、2 天 / 1 周 / 自定义分钟
- **旗标**（橙色旗子）
- **优先级**：标题文字前 `!!!`（高·红）/ `!!`（中·橙）/ `!`（低·灰），无优先级不显示任何标记

### 主题
- 设置 → 外观：**明亮 / 暗色**，整套 CSS 变量（列表、详情、设置、自绘下拉、Toast）一起切，**窗口底色同步**，重启保持
- 流程：宿主启动读 `settings.json` 的 `ui.theme` 定底色 + 首帧前注入 `data-theme`，亮色不闪深色
- 原生 `<select>` 一律隐藏，改用**自绘下拉**（`position: fixed`，自动上下翻转），解决深色下白底白字

### Bark 推送
- 设置内配置：启用、服务器地址、设备 Key、分组、铃声、级别、到期是否推
- 触发时刻 = **到期时间 − 提前提醒**；60s 巡检，命中 `[at, at+10min]` 且未推过才发
- 去重键 `uid|at` 存 `pushed.json`（保留 400 条），重启不重复推

## 3. 分发与安装

| 项 | 定稿方案 |
|---|---|
| 产物 | `dist\RemindersWidget-Setup-v0.04.exe`，单文件约 32 MB，内置 Node 运行时 |
| 安装位置 | `%LOCALAPPDATA%\Programs\RemindersWidget`，**不需要管理员权限** |
| 向导选项 | 安装路径、桌面快捷方式、开机自启、安装后立即运行 |
| 卸载 | 安装目录内 `Uninstall.exe`（36 KB，不含载荷）+ 注册表标准卸载项（Windows 设置→应用可见） |
| 卸载清理 | 停进程 → 删快捷方式 → 删注册表（卸载项 + Run）→ 删安装目录 → 删 `%LOCALAPPDATA%\RemindersWidget` 本地数据 |
| 依赖检测 | 检测 WebView2 Runtime，缺失时在向导里提示 |
| 环境 | .NET Framework 4.8（Win10 1809+/Win11 自带）、x64 |
| 打包 | `powershell -ExecutionPolicy Bypass -File packaging\build.ps1` |
| 打包自检 | 压缩前扫描载荷（文本 + 二进制）里的 Bark Key、服务器地址、会话字段、本机用户名路径；命中即中止 |
| 代码签名 | 未签名，首次运行 SmartScreen 可能提示「更多信息 → 仍要运行」 |

开源文件：`LICENSE`（MIT）、`THIRD-PARTY-NOTICES.txt`、`.gitignore`、`README.md`（面向使用者）。

## 4. 仍生效的技术要点

- **备注写回会压平富文本为纯文本**（文字不丢）；段落用 `U+2028` 分隔
- **日期 + 提醒原子提交**：`create Alarm` + `create AlarmTrigger` + `update Reminder(DueDate, AllDay, TimeZone, AlarmIDs)` 同一 `modify` 批次；`Alarm` 不带 `parent`，`AlarmIDs` 传数组
- **列表成员关系**手动维护 `Lists.ReminderIDs`：先挂 UUID 再 create Reminder；更新 Lists 只提交 `ReminderIDs`
- **限流兜底**：请求间隔 ≥260ms + 指数退避；Alarm/Trigger 按 id 缓存；服务端 10s 快照复用、`stale:true` 先返回旧数据、`inflight` 合并、写后强制真实数据
- 服务只监听 `127.0.0.1:8642`

## 5. 运行与文件

```
login-icloud.bat      浏览器登录取会话（密码不落盘，只存 cookie+dsid）
start-widget.bat / host/RemindersWidget.exe   （exe 由 build-host.bat 生成，不入库）
server.js             本地服务 + Bark 调度
lib/cloudkit.js        CloudKit 读写、protobuf 编解码、日期/提醒
lib/settings.js        本地设置（ui.theme、bark）
lib/bark.js            推送
public/                index.html / app.js / style.css
host/widget-host.cs    WinForms + WebView2 宿主
packaging/build.ps1    一键打包（编译宿主 → 组装载荷 → 编译卸载器 → 压缩 → 编译安装器）
packaging/setup/       安装向导（内嵌 payload.zip）
packaging/uninstall/   独立卸载器（同源码，UNINSTALLER 条件编译，无载荷）
tools/                 ui-check / ui-layout / ui-theme / shots / doc-shots / test-due / test-alarm / test-bark / audit-titles
```

- 会话 `%LOCALAPPDATA%\RemindersWidget\icloud-session.json`
- 设置 `%LOCALAPPDATA%\RemindersWidget\settings.json`
- 去重 `%LOCALAPPDATA%\RemindersWidget\pushed.json`
