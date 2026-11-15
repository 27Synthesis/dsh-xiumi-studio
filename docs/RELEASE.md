# 发行说明 · v0.1.0（2026-11-15）

Windows 桌面版第一版。目标只有一条：**解压、双击、就能用**——不用装 Node，不用配 DSH，
不用在命令行里记参数。

## 下载

| 文件 | 说明 |
| --- | --- |
| `dsh-xiumi-studio-0.1.0-win-x64.zip` | 免安装包（内含 Electron 运行时，约 250 MB 解压后更大），解压即用 |
| `SHA256SUMS.txt` | 上面那个 zip 的校验和 |

> 仓库里**不会**提交这个 zip（`desktop/dist/` 有整套 Electron 运行时，已写进 `.gitignore`）。
> 发行包由 `node tools/package-release.mjs` 现场打出来，再挂到 GitHub Releases。

## 这一版做了什么

1. **启动了就能开窗口**：之前双击没反应的根因是 `app.getPath('userData')`——
   产品名是中文「秀米工作台」，Electron 推默认 userData 目录时在 `ready` 之前就崩。
   现在 userData 固定到 `%LOCALAPPDATA%\dsh-xiumi-desktop`（兜底 <程序目录>/.profile，
   可用 `XIUMI_DESKTOP_DATA` 覆盖），起不来会开一个 900×620 的错误窗口把日志路径写清楚，
   不再是一声不响地闪一下。
2. **自带启动器 `秀米工作台.exe`**：系统自带的 csc 编出来的 WinExe，带图标、无控制台、
   自动补 `--no-sandbox`（本机这套 Electron 运行时不带它会 0x80000003 直接死），
   并清掉 DSH 注入的 `ELECTRON_RUN_AS_NODE`。双击即开。
3. **自己的图标**：`tools/make-icon.py` 用 Pillow 逐尺寸画（256/128/64/48/40/32/24/16），
   朱砂竖渐变方章 + 细金线 + 白「米」字；同一份 `.ico` 既打进 exe，也给窗口标题栏/任务栏用。
4. **桌面 + 开始菜单快捷方式**：`tools/install-shortcuts.ps1` 一条命令建两处，可重复执行；
   `tools/uninstall-shortcuts.ps1` 拆掉。快捷方式只指向我们的 `秀米工作台.exe`。
5. **发行包可直接发**：`tools/package-release.mjs` 负责打包、算 SHA256、写 `使用说明.txt`。

## 安装

1. 解压到手边任意目录（**不要**放 `C:\Program Files`：更新时目录会被占用）。
2. 双击 `安装.cmd` → 桌面和开始菜单「程序」里各出现一个「秀米工作台」。
3. 双击桌面图标开始用。第一次启动会起本地服务并打开工作台窗口。
4. 也可以不解压到固定位置、直接双击 `秀米工作台.exe`（不进开始菜单）。

## 卸载

1. 双击 `卸载.cmd`（只删两个快捷方式，用户数据留着）。
   想连数据一起删：`powershell -ExecutionPolicy Bypass -File uninstall-shortcuts.ps1 -RemoveData`。
2. 删掉解压出来的目录。

## 已知限制（这一版不装的）

- 只支持 64 位 Windows；`--no-sandbox` 是本机 Electron 运行时的硬要求，不是我们的选择。
- 发布到秀米「我的图文」最后一跳要人点三下（新建 → Ctrl+V → 保存）：秀米 MCP 没有"新建图文"接口。
- 只吃 `.docx`；PDF / `.doc` 先另存。
- 首次运行可能被 SmartScreen/杀软拦一下（未签名 exe），选「仍要运行」即可。

## 校验

```
certutil -hashfile dsh-xiumi-studio-0.1.0-win-x64.zip SHA256
```

与 `SHA256SUMS.txt` 里那一行对照。

## 从源码打这个包

```bash
NODE=node      # Node 20+
PY=python      # Python 3，画封面/图标要 Pillow

"$PY"   tools/make-icon.py                      # 图标（改了设计才需要重画）
"$NODE" tools/build-desktop.mjs                 # 组装 desktop/dist（含启动器 exe）
"$NODE" tools/package-release.mjs --skip-build  # 打 release/*.zip + SHA256SUMS.txt
```

## 许可

MIT（见 `LICENSE`）。随包分发的 Electron / Chromium 按其各自许可，文本在
`desktop/dist/LICENSE.electron.txt` 与 `desktop/dist/LICENSES.chromium.html`。
