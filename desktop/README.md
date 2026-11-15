# 桌面版 · 秀米工作台

双击一个 exe，直接在窗口里排公众号图文，不用先开 DSH、不用在浏览器里找地址。

它不是另一个版本：里面跑的**就是插件那一份 `host/` 与 `client/`**，
桌面壳只负责「起本地 http 服务 + 开窗口 + 补浏览器做不到的事（系统对话框、菜单、外部链接交给系统浏览器）」（PLAN-R2 AD-4）。

## 怎么构建

不用 npm、不下载 Electron——直接复用本机已有的 Electron 运行时（风险 2 的绕法）：

```powershell
$NODE=node   # Node 20+
& $NODE tools/build-desktop.mjs            # 首次：拷运行时 + 装壳
& $NODE tools/build-desktop.mjs --app-only # 之后只改壳：只刷 shell/ host/ client/
```

产物 `desktop/dist/`：

```
秀米工作台.exe           ← 双击这个（启动器：带图标、自动补 --no-sandbox，原因见下）
dsh-xiumi.exe            ← 运行时主程序（直接双击在本机会闪退，见下）
备用启动.cmd             ← 启动器编不出来时的兜底（csc 不在的机器）
*.dll *.pak locales/ …   ← 运行时（不含 DSH 自己的 resources/app.asar，我们从不碰它）
resources/app/
    package.json         ← main: shell/main.js
    shell/               ← desktop/app/*（主进程 main.js / http 服务 server.mjs / 导入 importer.mjs / 配置 config.mjs）
    host/  client/       ← 插件仓库里的那一份
```

运行时的来源默认是 `D:/DSH 工作区`，用 `--runtime <dir>` 换。
装桌面 + 开始菜单快捷方式：`powershell -ExecutionPolicy Bypass -File tools/install-shortcuts.ps1`（可重复执行，
建完用 `tools/verify-shortcuts.ps1` 读回来核对；拆掉用 `tools/uninstall-shortcuts.ps1`）。
打发行包：`node tools/package-release.mjs`（详见 `docs/RELEASE.md`）。

## 怎么用

1. 双击 `秀米工作台.exe`（或桌面/开始菜单里的快捷方式）：窗口里直接是完整三栏工作台。
2. **文件 → 导入 Word 文稿…**（Ctrl+O）选 .docx：自动拆标题/小节/正文/图片，落素材，按标题配主题，顺手画封面。
3. 右侧换主题、看封面、补图、发布；**连接秀米**会打开**系统浏览器**登录（Electron 里登录态不共享，所以老老实实用浏览器）。
4. 工程位置：`工作目录/.xiumi/projects/<id>/`。换工作目录：**文件 → 换工作目录…**

## 一篇稿子能一路走到哪一步

| 步骤 | 桌面版 | 说明 |
| --- | --- | --- |
| 导入 Word（Ctrl+O / 文件菜单） | ✅ | 桌面壳自带 `POST /xiumi/api/desktop/import-docx`（上游只有模型工具，没有 http 路由） |
| 预览、换主题、重绘封面、补图、导出 HTML | ✅ | 和插件同一份渲染与配色 |
| **连接秀米** | ⚠️ 要在系统浏览器里点一次授权 | Electron 窗口里的登录态和系统浏览器不共享，所以老老实实开系统浏览器；授权回来后凭证写 `~/.dsh/xiumi/oauth.json`，**与插件共用**同一份 |
| 套用模板（真跑） | ✅ 需要①上面的授权②能连 xiumi.us | 桌面进程自己直连 `https://xiumi.us/mcp`（OAuth + JSON-RPC），不依赖 DSH 在跑；账号里没有可套的模板时，先在秀米模板库点「使用模板」存一篇再刷新 |
| 发布到「我的图文」 | ❌ 一步到底做不到（上游限制） | 秀米 MCP **没有「新建图文」接口**。程序会把图传进图床、生成可粘贴版，然后要人做三下：点「复制到秀米」→ 在「我的图文」新建一篇空白图文 → 正文区 Ctrl+V、右上「保存」、填标题 |

也就是说：**除了"最后新建那篇图文"和"秀米登录"，其它都能在窗口里做完**。
这两步不是壳的问题，是秀米接口与登录态的边界，换浏览器版也一样。

## 为什么启动要带 --no-sandbox

这台机器上，Chromium 沙箱一开，Electron 在引导阶段就死：进程直接退出，码 `-2147483645`（0x80000003 STATUS_BREAKPOINT），
连 `main.js` 第一行都不会执行，所以**什么日志都不会留下**——看起来就是"双击了没反应/闪一下没了"。
同一个 exe 带 `--no-sandbox` 立刻正常，`ELECTRON_DISABLE_SANDBOX=1` 等效。

已排除的原因：asar/fuse、路径里有中文（软链到 `C:\xiumi-ascii` 仍崩）、管理员权限、SmartScreen/ADS、
显式 `--user-data-dir`、`--disable-gpu` 一类开关。**只跟"沙箱开关"有关**，且只影响这套拷出来的运行时
（DSH 自己那个 exe 不崩，见 PLAN-R2 风险）。所以：

- 启动器 `秀米工作台.exe`（`tools/launcher/Launcher.cs`，用系统 csc 编出来）**自己补** `--no-sandbox`，并清掉
  `ELECTRON_RUN_AS_NODE`；快捷方式只指向这个启动器，所以参数留在代码里、不靠人记；
- `备用启动.cmd` 是同一件事的 cmd 版（没有 .NET Framework 的机器用）；
- 直接从 DSH 的 shell 里拉起来时还要 `env -u ELECTRON_RUN_AS_NODE`（DSH 会注入这个变量，有它 exe 会被当成 node 跑）。

## 数据写在哪

Electron 的默认 `userData` 跟着 productName 走，会变成 `%APPDATA%\秀米工作台` 这种中文目录，
在 ready 之前就要用它推路径，容易炸。所以主进程第一步（还没读配置文件时）就把 userData 定到：
`%LOCALAPPDATA%\dsh-xiumi-desktop`，写不进去时退到 `<壳目录>/.profile`；也可用 `XIUMI_DESKTOP_DATA` 环境变量指定。
工作目录、端口、配置仍按下面这张表。

窗口开不出来时（工作目录不可写、端口被占死等），不会再是"静默卡死"：
主进程会开一扇 900×620 的**错误窗口**，把错误原文和日志路径写在页面上。

## 端口、凭证、工作目录

| 项 | 默认 | 改法 |
| --- | --- | --- |
| 工作目录 | `文档/秀米工作台` | 菜单「换工作目录…」，或 `desktop.json` 里的 `workspace` |
| 端口 | `50577` | `desktop.json` 里的 `port`，或启动参数 `--port 50577` |
| 配置 | `%APPDATA%/秀米工作台/desktop.json` | 同上 |
| 秀米凭证 | `~/.dsh/xiumi/oauth.json` | 与插件**共用**同一份；在插件里连过秀米，桌面端直接用 |

端口为什么固定：秀米 OAuth 的 redirectUri 带端口，换了端口就要重新注册一个客户端。
端口被占会自动往后顺延（日志里会说），这时需要重连一次秀米。

工作目录和插件共用同一个概念（`<cwd>/.xiumi/`），所以在桌面里建好的稿子，
把插件的会话 cwd 指到同一个目录就能接着改——**但别两边同时写同一篇**，工程是整文件覆盖的。

## 自测（不开 Electron）

```powershell
& $NODE tools/smoke-desktop.mjs --docx <随便一个 .docx>
```

它会起 `server.mjs`，把工作台真正会打的接口要一遍（页面/资源/state/themes/render/封面/导入），
报「N 通过 / M 失败」。带 `--docx` 时连导入 Word 一起验。

要证实"窗口真的能起来"，用截图开关（跑完自动退出，适合脚本里验）：

```bash
XIUMI_DESKTOP_LOG=./desktop.log XIUMI_DESKTOP_DATA=./desktop/.profile \
timeout 30 ./desktop/dist/dsh-xiumi.exe --no-sandbox \
  --workspace ./desktop/.smoke/workspace --shot=./desktop/_shots/window.png
```

`--shot=<png>`：页面加载完后截图再退出；起不来时截的是错误窗口。

## 现在到哪一步了

- ✅ 窗口能起来、直接是工作台、`/xiumi/api/*` 全部有响应（和插件同一份处理器）
- ✅ 导入 Word（菜单/对话框）、预览、换主题、重绘封面、导出 HTML
- ✅ 秀米授权走系统浏览器回环回调，凭证与插件共用
- ✅ 双击即开：`秀米工作台.exe` 拉起后窗口正常（`_inspect/shots/t19-window-final.png` 是最后一次重建后抓的真实窗口，PrintWindow，1280×680）
- ✅ 工作目录建不出来也不卡死：`main.js` 启动时先试配置里的目录，失败（只读盘、受控文件夹、沙箱）就退到
  userData 下的 `workspace/` 并把原因写进 desktop.log，界面照常打开（退回的目录不写回配置）
- ✅ 实测证据：`_shots/window.png`（带一篇稿子的三栏工作台）、`_inspect/shots/t19-launcher.png`（经启动器启动后的空状态）
- ⚠️ 发布到「我的图文」仍然要人按三下（秀米 MCP 没有"新建图文"，上游限制）
- ✅ 图标：`tools/make-icon.py` 画的朱砂方章「米」（256…16 全尺寸），csc `/win32icon` 打进启动器，
  同时放进 `resources/app/icon.ico` 给窗口/任务栏；桌面与开始菜单的快捷方式也用它（`IconLocation=<exe>,0`）

## 已知没做的

- 没有自动更新、没有真正的安装程序（发行包就是一份目录 + `安装.cmd` 建快捷方式；卸载 = 删目录）
- 多窗口/多工作目录同时开：单实例，只有第一个窗口
- 导入是桌面壳自己补的端点（`POST /xiumi/api/desktop/import-docx`）：上游目前只有模型工具、没有 http 路由；
  上游补了之后这里可以退化成转发
