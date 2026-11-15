# 第二轮需求计划（R2）— 真模板 / 真预览 / 可点链接 / 桌面 exe

> 来源：用户 m03822（六条）。本文件是本轮唯一事实源；每条都要能指到「怎么验」。
> 写着「已验证」的，都有实测输出；写着「待验」的，别当成做完了。

## 0. 用户要什么（原话要点，不许走样）

| # | 要求 | 判定标准（我方的验收） |
|---|------|------------------------|
| R2-1 | **模板必须真正用上**：不接受「照气质配色」。做不到直接写入，「哪怕是操控电脑把模板另存到账号，再把文字图片一步步换进去」 | 成品里有模板自带的背景/装饰/组件/动效；换的只是文字与图片槽；有干跑与真跑两条路 |
| R2-2 | **Q4 点一下就发 = 交付精美成品** | 点「发布」后 我的图文 里那篇是带模板组件的，不是纯文字配图 |
| R2-3 | **预览必须看到图片** | 工作台手机预览里每张图都真实显示；看不到就是没做完 |
| R2-4 | **不占用用户的浏览器** | 自动化一律走 DSH 浏览器（wincu browser lane）或无窗口 Edge；不碰 360 极速浏览器X |
| R2-5 | **Electron 桌面 exe**：与插件并存；装插件时可问要不要桌面快捷方式；只装 exe 也能编辑并连秀米 | 双击 exe 能起工作台、能导入 Word、能预览、能连秀米/发布 |
| R2-6 | **提示里的蓝字必须可点且有反馈** | 「完整展开工作台」「连接秀米」等，点下去有动作有反馈；点不动算 bug |
| R2-7 | 完成后**代码审查**（总论 + 正确性/安全/可维护/性能，每项带示例代码）+ **红队对抗审查**（5 个最强假设如何失效 / 3 个反例 / 认知偏差 / 失败排序 / 什么证据能改变立场） | 产出 `docs/REVIEW-R2.md`，蓝队写实现、红队挑错打回 |

## 1. 已验证的事实（别重复验证，直接用）

- **模板能编程填充**：`copy_show` 复制账号内作品 → `update_show_from_plan` 按槽换文字/图片，未绑定槽逐字节保留。
  - 实测作品 738890287（冬天快乐/卡通模板）→ 复制为 **738939797** → dry_run 27 槽 `{"valid":true}` → 正式提交 `updated_slots` 27 个。
  - 复核 `get_show_edit_spec(738939797)`：body_1/body_2 已是通稿正文，work_title 已是通稿标题。**模板组件没动。**
- **spec 里图片槽是区间记法**：`S image_1..13 IMG` = image_1…image_13 共 13 个独立槽（官方图例原话）。试验脚本 `_inspect/fill-template-test.mjs` 只取了区间首号，生产代码必须展开。
- **未发布作品的 public preview 打不开**：`v.xiumius.cn/...?in_preview=true&stage_ticket=…` 返回 403 `Camus:Failed_ShowRelease … 需要制作者登录秀米，点击预览后申请审核`。所以视觉验收不能靠这个 URL。
- **MCP 没有「新建图文」「发布」工具**（12 个工具已盘点）：只能读作品、改槽、管图库、复制、删/恢复。要新建/发布必须走浏览器编辑器。
- **无窗口验证通道**：`bash _inspect/edge-headless.sh`（headless Edge + CDP 9333），`node _inspect/cdp-full.mjs <url> <out> [w] [h]` 整页截图。

## 2. 架构决定（AD）

- **AD-1 模板路径 = 复制 + 填槽**。分两步：①把模板「另存为我的作品」（需要登录态浏览器点「使用模板」）；②MCP 填槽。②已通，①是本轮攻坚点。
- **AD-2 取模板只走 DSH 浏览器 / 无窗口**。用户的 360 浏览器不碰（R2-4）。若 DSH 浏览器里没有秀米登录态，就让用户**一次性**登录，之后所有模板都自动。
- **AD-3 预览自渲染，不依赖秀米阅读页**。工作台预览用本地渲染 + 图床真图（R2-3）；秀米侧渲染只作为发布后复核。
- **AD-4 桌面端与插件共用一套 client + host**。desktop 只是外壳（Electron 主进程 + 本地 http 服务），不复制业务代码，避免分叉。
- **AD-5 蓝字一律 <a href> + 复制兜底 + toast 反馈**；Electron 里 `shell.openExternal`。禁止出现「只显示文字不响应点击」的链接。

## 3. 任务分解

| 任务 | 归属 | 写作用域 | 验收 |
|------|------|----------|------|
| T1 预览真图 | ui | `client/**` | 手机预览每张图都显示（截图 + 断网也能看到本地图） |
| T2 蓝字可点 + 反馈 | ui | `client/**` | 所有提示链接可点、有 toast、被拦时有兜底 |
| T3 模板选型（按主题从 216 库里挑，可解释） | lead | `host/templates.mjs` | 给一篇通稿能说出「为什么是这个模板」 |
| T4 模板取用（另存到账号） | lead | `host/**` | 能对一个模板 code 生成「我的图文」新作品 |
| T5 填槽引擎（区间展开 + 干跑 + 真跑） | lead | `host/template-fill.mjs` | 单测覆盖区间展开；真作品干跑通过 |
| T6 Electron exe | desk | `desktop/**`、`tools/**` | 双击起工作台；能导入 Word；能预览；能连秀米 |
| T7 代码审查 + 红队 | red | `docs/REVIEW-R2.md` | 逐条按 R2-7 格式 |

## 4. 已知风险

1. 模板「使用模板」按钮背后的接口未摸清；可能必须靠 UI 点击（→ 需要登录态）。**应对**：先用 DSH 浏览器跑一次，抓请求；抓不到就退化为「用户点一次、程序接管后续」。
2. Electron 依赖下载可能被墙（本机有过网络受限）。**应对**：优先复用本机已有 Electron 运行时（`D:/DSH 工作区/DeepSeek Harness.exe` 同目录的 dll/pak），失败再走 npm。
3. 多智能体同仓写代码会撞车。**应对**：写作用域严格切分（client / host / desktop / docs），Lead 统一跑回归。
4. 未过审作品无法公开预览 → 视觉验收只能在工作台自渲染或登录态编辑器里做。
## 5. 进展快照（2026-11-15 13:5x，过期就看 git 或代码）

| 任务 | 状态 | 证据 |
| --- | --- | --- |
| T1 预览真图 | ui-builder 进行中 | — |
| T2 蓝字可点 | ui-builder 进行中 | — |
| T3 模板选型 | **改判**：目录只做参考（216 条可匿名拉到），选型逻辑不进关键路径 | §1 与 2.5.1 |
| T4 模板取用 | **一半**：账号内模板可用（copy_show 成功）；目录内模板拿不到（Failed_DataNotMatch）→ 需登录态点一次「使用模板」 | 738890287→738939797 |
| T5 填槽引擎 | **已完成** | `host/template-fill.mjs`；35 条离线断言；真跑 738943717（53 槽：2 元信息 + 36 文字 + 15 图） |
| T6 Electron exe | cover-designer 进行中 | desktop/ |
| T7 代码审查 + 红队 | **已完成**（audit-reviewer，docs/REVIEW-R2.md）；C1–C5 已改，C6/C7 是真跑踩出来的新约束 | REVIEW-R2 |
| 新增 T8 模板 UI | 已派给 ui-builder（task-12） | `GET /xiumi/api/template/shows`、`POST /xiumi/api/template/apply` |

### 5.1 本轮新增的接口（已 --check 通过，未接 UI）

- `GET  /xiumi/api/template/shows[?refresh=1]` → `{ok,total,templates[],others[]}`；每项含 `showId,title,cover,editUrl,textSlots,imageSlots,isTemplate`。
- `POST /xiumi/api/template/apply` body `{projectId,showId,dryRun(默认 true),titlePostfix,blankUnused(默认 true)}` → 复制模板再灌内容。
  - 干跑零副作用：不 copy_show、不上传透明图（用进程内缓存地址）；真跑先补传本地图，失败会 delete_show 掉复制出来的空稿（返回 cleanedShowId、showId:null）。
  - titlePostfix **最多 8 字**（秀米 copy_show 硬限制，超了 400）；宿主 clampPostfix() 兜底。
  - 返回 warnings 含：本地图未上传（C1）、超大标题槽吞长段落（C7）、空图片槽、文字/图片槽溢出、标题超 60 字与摘要只取前 120 字（C6，截断必须说出来）。
  - spec 解析出的问题（C4/C8）直接让 apply/fill 返回 `{ok:false,error:'套模板失败：模板 spec 有问题：…'}`，不再静默出一篇空稿。
- `POST /xiumi/api/template/fill` 同上但**不复制**，灌进已复制好的那一篇；先过 assertFillTarget（只认本插件复制并登记在 `<cwd>/.dsh-xiumi/template-copies.json` 的副本，跨工程/已发布都拒）。
- 模型侧对应工具：xiumi_template_shows / xiumi_template_apply / xiumi_template_fill（工具总数 16）。

### 5.2 回归基线（每次改完都要跑）

`bash _inspect/_all.sh` → 18 个脚本、**656 条断言全绿、OVERALL_FAIL=0**（test-template-fill 40 条、test-template-rank 63 条、test-layout 37 条、test-route-order 19 条、test-review-fixes 41 条都接进去了）。

真跑验收（2026-11-15）：作品 **738943717** 由 736180850 复制并灌槽，updated_slots 覆盖 work_title/work_desc/body_1..36/image_1..15；预览页渲染后 DOM 里 //img.xiumi.us/…/5NZEw 共 15 条 = 10 张真图 + 5 张 …-sz_70.png 透明占位，没有模板自带的 statics 照片。

### 5.3 仍然卡着的两件事（要人）

1. **DSH 浏览器里秀米未登录** → 任意免费模板取不到手；也看不到真实渲染（未过审作品预览恒 403）。需要用户**一次性**登录。
2. 桌面 exe 的 Electron 运行时来源（复用 `D:/DSH 工作区/` 还是 npm 装）由 cover-designer 用实测决定。
