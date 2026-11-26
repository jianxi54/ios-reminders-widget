# 发版流程

版本号规则：`V0.03`（小版本 +0.01）。版本唯一来源是 `lib/version.js`，`CHANGELOG.md` 记录明细，两者必须对得上。

## 一、定版

1. 改 `lib/version.js` 的 `VERSION`
2. 改 `host/widget-host.cs` 的 `APP_VERSION`
3. 在 `CHANGELOG.md` 顶部加一节：`## V0.04 — YYYY-MM-DD`，分类写「新增 / 修复 / 变更 / 移除 / 安全」，没有的分类不写
4. 同步 `SPEC.md` 里的定稿清单（如果有功能增删）

三处版本号不一致，CI 会失败。

## 二、自检

```bat
:: 语法检查（CI 跑的就是这一套）
node --check server.js
node --check public\app.js
node --check lib\cloudkit.js

:: 界面与主题回归
node tools\ui-check.js
node tools\ui-theme.js

:: 资源占用
powershell -ExecutionPolicy Bypass -File tools\perf.ps1
```

真机验证（CI 连不到 iCloud，这步只能手做）：

- 新建一条 → iPhone 上出现
- 改标题、勾完成、拖日期 → iPhone 上跟随
- 日期 + 提前提醒同时设 → iPhone 上提醒时间正确

## 三、打包

```bat
powershell -ExecutionPolicy Bypass -File packaging\build.ps1
```

脚本会依次：校验版本一致性 → 重编译宿主（`-p:DebugType=None --no-incremental`，避免 exe 里带本机 pdb 路径）→ 组装载荷 → 编译独立卸载器 → 压缩 → **隐私自检** → 编译安装器 → 算 SHA256。

产物：

- `dist\RemindersWidget-Setup-v0.04.exe`
- `dist\RemindersWidget-Setup-v0.04.exe.sha256`

隐私自检命中即中止。本机专属的检测值放 `packaging\privacy.local.txt`（不入库），**不要**把真实 Key 写进 `build.ps1`。

## 四、装机验证

1. 静默安装到临时目录，确认进程能起来、`mode=live`
2. 检查安装目录里没有 `node_modules`、`.pdb`、`obj`
3. 卸载，确认安装目录、注册表项、自启项、快捷方式、本地数据目录全部清干净

## 五、提交与打标

```bat
git add -A
git commit -m "V0.04: <一句话>"
git tag -a v0.04 -m "RemindersWidget v0.04"
git push origin master
git push origin v0.04
```

tag 必须打在**最终提交**上，且该提交的源码要能构建出同版本的安装包。

## 六、发 Release

仓库页 → Releases → **Draft a new release**：

- Tag：选刚推的 `v0.04`
- Title：`v0.04 — <一句话卖点>`
- 正文：直接粘 `CHANGELOG.md` 里对应那一节（`## V0.04` 到下一个 `---` 之间），顶部加一句「安装包在下方 Assets」
- Assets：上传 `RemindersWidget-Setup-v0.04.exe` 与 `.sha256`
- 不是正式版就勾 **Set as a pre-release**

已验证的 Release 不要删了重发——用户可能已经下载。发错了就补一个修订版，在正文里说明。

## 七、发布后

- 公众号 / 社媒的下载链接一律指向 **Releases 页面**，不要直链 exe（换版本会失效）
- 让用户核对 SHA256：
  ```powershell
  Get-FileHash .\RemindersWidget-Setup-v0.04.exe -Algorithm SHA256
  ```
- 有 Issue 反馈集中出现同一问题，先出 `V0.0x` 补丁，不要攒着

## 未做的事（如实说明）

- 安装包**没有代码签名**，首次运行会触发 SmartScreen「更多信息 → 仍要运行」
- 没有自动更新，新版本要用户自己下载覆盖
