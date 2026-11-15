# 计划与验收 · 秀米图文台

> 这份文件是需求的唯一追踪表。每完成一项就在「验收证据」里补一条**能点开看的东西**（截图 / 测试输出 / 文件），
> 不写「已完成」三个字了事。做完一轮回头看一遍需求，是本文档存在的理由。

## 0. 一句话目标

宣传部干事把前辈给的 Word（有时图文分开发）交给 DSH，在右侧栏看着成品诞生的过程，最后这篇图文出现在秀米「我的图文」里。

**做完的判定**：拿一份真实通稿走完全程，文字一段没少、图片一张没漏、成品在秀米账号里能打开。

## 1. 硬约束（违反即返工，不参与取舍）

| 编号 | 约束 | 现在的落地方式 |
| --- | --- | --- |
| C1 | 文稿文字不删改 | 导入只分类不改字；改块工具只允许修排版；改文案必须人来提 |
| C2 | 提供的图片全部用上 | 导入按原序落块；补图只增不减；面板与 xiumi_preview 点名「未用上的素材」 |
| C3 | 成品进秀米「我的图文」 | 走官方 MCP 投递；接口做不到时给「复制到秀米」的等价比路 |
| C4 | 工作流从真实任务总结，不许凭空写 | SKILL.md 先写第一版，跑完第一篇真实推文后据实修订 |

## 2. 需求清单（对照 m00005 原话）

| 编号 | 需求 | 实现位置 | 验收证据 | 状态 |
| --- | --- | --- | --- | --- |
| R1 | 接收材料：Word（文本+图片） | host/docx.mjs、host/tools.mjs `xiumi_import_docx` | `_inspect/test-headings.mjs` 18/18；真实通稿 25 块 / 28 块导入成功 | ✅ |
| R2 | 材料：图文分开发 | host/images.mjs、`xiumi_add_images`、面板「素材」拖拽区 | `_inspect/test-images.mjs` 37/37；`test-tool-addimages.mjs` 34/34；真实文件夹 10 张补齐 | ✅ |
| R3 | 按主题挑免费模板 / 或自创版式 | 三条：①host/themes.mjs（五套配色 + 按标题自动匹配）②host/templates.mjs（秀米免费模板目录，216 条，作参考）③**host/template-shows.mjs + template-fill.mjs（把账号里的真模板复制一份再填槽）** | ①`test-templates.mjs` 72/72 ②③见 R19 | ✅ **两条都通**：自创版 + 真模板版都能进「我的图文」 |
| R4 | 自创时要自己设计封面/背景/动效 | host/cover.mjs（900×383 + 500×500）、render.mjs（分隔线/色条/引号卡） | `_inspect/preview/v5-deploy.png` 封面随主题重绘；`v5-article-full.png`（425×7617 整页长图） | 🔶 封面与版式有；动效受公众号限制只做了静态层次 |
| R5 | 文字只能调排版、不能删改 | docx 分类不改字；xiumi_set_block 文案约束 | `_inspect/verify-text.mjs` 15 段全在、10 图全在 | ✅ |
| R6 | 图片必须全部用上 | 同上 + 未用素材检查 | xiumi_preview「未用上的素材」为空；面板 10/10 用上 | ✅ |
| R7 | 要有优秀前端：能看创作页面与过程 | client/studio.*（三栏工作台）、右侧栏 embed 版 | `_inspect/preview/v2-studio.png`、`v3-embed-430.png`、`v3-embed-300.png` | ✅ |
| R8 | 参考 dsh-fishpai 的实现方式 | 路由/工具/技能注册沿用同一套 cordis 插件形态 | 右侧栏面板注册成功，`/xiumi/studio` 200 | ✅ |
| R9 | Skill 工作流内置于插件 | skills/xiumi-studio/SKILL.md + references/checklist.md | 已按**两次真跑**修订：§6 发布链路（作品 738932963）、§2.5 套真模板全节（四条填槽硬规则 + 选型打分 + 图片槽 spec 看不见的坑）、§6.4 模板版落地；`_inspect/test-host.mjs` 断言正文与 SKILL.md 一致 | ✅ |
| R10 | 成品直接进秀米「我的图文」 | host/xiumi.mjs（OAuth PKCE + create_image 图床 + pickImageUrl 规范化）+ client/studio.js copyToXiumi | **已实证**：作品 738932963，`https://xiumi.us/studio/v5#/paper/for/738932963`，`https://v.xiumius.cn/board/v6/3gtx9y/LuhNq`；`get_show_edit_spec` 报「图片槽 10」；账号作品数 15 | ✅ 链路通；程序投递无「新建图文」工具，落地靠剪贴板（见 R15） |
| R11 | 长期项目七原则写进插件底层 | docs/PRINCIPLES.md + 代码约束 | 样式单一来源 grep 自检；无写死视口；文档随代码改 | ✅ |
| R12 | 需求做成可追踪任务，每完成一项回看 | 本文件 | 你正在看 | ✅ |
| R13 | 图片按小节自动落位（Q1，2026-11-15 拍板） | host/images.mjs `planImagePlacement` / `insertImages(placement:'section')`；工具 `xiumi_add_images`；素材区「图片按小节分」`xiumi_layout_images` | `_inspect/test-images.mjs` 6.5) 按小节分配 5 条断言全过；34/34 里 Q1b 旧稿重排 5 条 | ✅ |
| R14 | 工程复制 / 多版本（Q3，2026-11-15 拍板） | host/store.mjs `duplicateProject`；工具 `xiumi_duplicate_project`；顶栏「另存一版」 | `test-tool-addimages.mjs` Q3 段：深拷贝、素材文件真复制、新工程是草稿、切到新工程 | ✅ |
| R15 | 一键发布、不二次确认（Q4，2026-11-15 拍板） | client/studio.js `publish()` → 已连接则直接 `copyToXiumi(true)`：写剪贴板 + 开「我的图文」+ 黄条三步 | `_inspect/preview/v13-publish.png`；`_inspect/publish-real.mjs` **9/9**（10 图全部图床地址、整页无 127.0.0.1、publishProject 必抛无创建工具并转 ready） | ✅ 程序能做的都做了；新建+粘贴+Ctrl+S 是人手的最后三下（跨页注入粘贴浏览器不接受） |
| R17 | 发布前体检：有本地图/未用素材/没封面时先拦 | host/xiumi.mjs `preflightPublish` + `dumpTools`；路由 409；`xiumi_publish(allow_local_images)` | `test-publish.mjs` 11/11；真机 POST /xiumi/api/publish 返回 409 并列出 11 张本机图；schema 落盘 `~/.dsh/xiumi/mcp-tools.json` | ✅ |
| R18 | 顶栏授权入口在「已连接」时也要说人话（用户找不到「连接秀米」） | client/studio.js chip 文案 | 已连接：窄版 `秀米 ✓` / 宽版 `秀米 · 已连接`；未连接：`连接秀米` / `连接秀米账号`。截图 `_inspect/preview/v14-embed-380.png` | ✅ |
| R19 | **真模板套用**（模板骨架/装饰/动效留住，只换文字与图片） | host/template-fill.mjs（parseSpec 区间展开 / planFill 摊分 / ZWSP 空白 / 1×1 透明图占位）、host/template-shows.mjs（列作品判模板 / 打分选型 / 复制 / 填槽）、routes 三个接口、client 抽屉（task-14 进行中） | `test-template-fill.mjs` 33/33；真跑 **738941427**（模板「商务\|科技\|创新\|行业峰会\|年度总结\|企业会议\|蓝色模板」，126→53 绑定、dry_run `{"valid":true}`、`updated_slots` 含 image_1…image_15）；过程稿 738939797 / 738941335 已进回收站 | ✅ 引擎通；视觉验收要人在登录态编辑器看一眼（未过审作品公开预览恒 403） |
| R20 | 模板选型要可解释 | host/template-shows.mjs `rankTemplates`（题材词 ×3 + 槽位够用 + 富余适度 - 已发布）；`POST /xiumi/api/template/apply` 不给 showId 时自动挑并回 `picked.reasons` | 真项目打分：736180850(9) > 736183256(9) > 736183604(8)，理由「题材对得上：会议、总结；槽位够用 36≥23 / 15≥10」 | ✅ |
| R16 | 误拖素材可连块删除 | store.removeAsset；工具 `xiumi_remove_image`；素材行 ✕ | `test-tool-addimages.mjs`：素材删掉、引用块没了、文件删了、原工程不受影响 | ✅ |

## 3. 里程碑

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| M1 骨架 | 插件入口、路由、工作台三栏、手机预览 | 完成（`_inspect/preview/live-studio.png`） |
| M2 导入 | docx → 块结构 → 主题 → 封面 | 完成 |
| M3 编辑 | 换主题、挪块、图注、补图、重绘封面 | 完成（14 个接口用例 + 浏览器上传实测） |
| M4 自检 | 字数/图数/落位/未用素材 | 完成 |
| M5 发布 | OAuth → 图床 → 建图文 | 完成（作品 738932963）：授权已通、图床 10/10、剪贴板+粘贴+Ctrl+S 已实证；无「新建图文」工具是平台限制，已用剪贴板等价实现 |
| M6 沉淀 | 真实任务复盘 → 修订 SKILL.md → 补 checklist | 完成：§6 按真链路重写；§2.5 套真模板全节从两次真跑里总结（含四条硬规则与三个坑） |

## 4. 风险与应对

| 风险 | 影响 | 现在怎么办 |
| --- | --- | --- |
| 秀米 MCP 没有「新建图文」的工具 | R10 直接失败 | 运行时读 tools/list 再决定；没有就明确报错 + 给「复制到秀米」的可用路径 |
| 秀米服务器取不到 127.0.0.1 的图片 | 发布出去的图裂 | 发布前把图传进秀米图床换成 CDN 地址；做不到时提示改用剪贴板粘贴（图片由秀米自己上传） |
| iPhone 的 HEIC 照片 | 静默漏图，违反 C2 | 明确点名跳过，要求转 png/jpg |
| docx 版式千奇百怪（表格、文本框、艺术字） | 结构错乱 | 只承诺段落 + 内嵌图；异常结构在预览里一眼看出来，允许人工调块 |
| 插件热更新失败导致宿主不可用 | 整个 GUI 起不来 | 每个 effect 包 guarded()，单点失败只记日志 |
| 凭据泄露 | 账号风险 | token 只落 `~/.dsh/xiumi/oauth.json`，不进工作区、不进日志 |

## 5. 拍板结果（2026-11-15）

- **Q1 图片默认落位 → 按小节自动分**，保持 Word 里的原顺序（已实现，R13）。
- **Q3 多版本 → 支持另存一版**（已实现，R14）；并排比较还没做。
- **Q4 发布 → 面板上点一下就发**，不加二次确认（已实现，R15）；未授权时点发布会先走授权，连上后自动发。
- **Q2 模板 → 做「参考 + 预览」，不塞模板本体**：秀米匿名接口只能枚举前约 216 条免费模板（第 18 页起 401，搜索需登录），模板本体是 Angular 串、不开放写入。面板右栏「参考模板」与工具 `xiumi_templates` 都能看标题/作者/复制量/预览链接；`xiumi_set_theme` 仍按内容气质自己配色。调研报告 `_inspect/research-templates.md`。
- **Q5 授权入口**：右侧栏 embed 态整条右栏（含授权按钮）是隐藏的，所以顶栏最左放了「连接秀米」胶囊按钮。

## 6. 已知未做

- **程序自动新建图文**：没有 `create_show` 这类工具（`create_show_from_plan`/`create_show` 均 -32602），但**有 `copy_show`**——
  复制一篇已有作品就得到一篇新作品。所以：**套模板那条路是真正零手工的**（复制 + 填槽，作品直接落进「我的图文」）；
  自绘版没有模板可复制，才需要人手按「新建 / Ctrl+V / Ctrl+S」三下。
- **套任意免费模板要人点一次**：目录里的模板只能看不能用（`copy_show` 跨账号必失败 `Failed_DataNotMatch`）。
  想套新模板 = 在登录态浏览器里点一次「使用模板」把它存进自己账号，之后程序接管。
- **真正无人值守**：需要一个「已登录秀米 + 开着 CDP 调试端口」的浏览器。现状：360 极速浏览器X 有登录态但无调试端口；Edge（9333）有调试端口但未登录秀米。一次在 Edge 登录即可换来全自动粘贴，需要用户决定。
- 宿主代码改动要**重启 DSH** 才生效（ESM 启动即载入）；客户端 JS/CSS 每次请求读盘，改完刷新即可。
- `.doc` / PDF 材料。
- 图片拖动排序、多工程并排比较（另存已可复制多版）。
- 真实推文跑通后回填 SKILL.md 的第 4/5 步细节（现在写的是通用流程，不是从一篇成功稿子里总结的）。
- 已建好的旧工程（部署会那篇 11 张图全在文末）需要人在面板上点一次「图片按小节分」；导入/补图的新工程已默认按小节落位。
- 面板大纲是**只读**的：能看块清单，不能在面板里直接拖块/改图注（要改就说一句，由 AI 调 `xiumi_set_block`，结果实时反映在面板上并记进「创作过程」）。做面板内编辑 UI 是下一步的活，不是承诺过的东西。
- 授权回跳的 `state` 是弱校验（不带 state 也能完成）；收紧可能打断已跑通的授权链，等真机再验一轮后改。
- 窄屏（右侧栏 300–430px）验收只能走 `_inspect/cdp.mjs`：Windows 显示缩放会让 Edge 的 `--window-size` 截图骗人（页面实际按更宽布局渲染，看起来像溢出）。

## 7. 独立审查的 15 项整改（audit-reviewer，40 项里挑出的必修）

审查报告：`_inspect/review-round1.md`。逐项结果：

| # | 问题 | 处理 | 证据 |
| --- | --- | --- | --- |
| P1 | 「复制到秀米」没内嵌图片（路由只认 `embed=1`，客户端传 `mode=embed`） | 路由 `const embed = embed===1 \|\| mode==='embed' \|\| mode==='export'`；粘贴失败面直接报错不假装成功 | `test-shell.mjs` 9/9（导出与复制片段逐字节相同、无 127.0.0.1） |
| P2 | 汉字小节号「十一、」被悄悄吞成 01 | docx.mjs 加 cnNumber()，认得出才摘前缀、两位补零；认不出原文一字不动 | `test-headings-cn.mjs` 78/78；真实两份 docx 逐块核对 0 处不一致 |
| P3 | 改块/删块没有留痕；能通过 `text:''` 把正文清空 | 五种 action 都生成 note 记进「创作过程」；正文清空必须显式 allowEmpty/allow_clear | `test-shell.mjs`：清空被拦且正文没变、改图注/删块/挪块事件里都有 diff 文本 |
| P4 | 面板/封面色值散落各处，换主题不同步 | 颜色全部收进 themes.mjs（含新增 wash/shellBg/onAccent/shadow），`/xiumi/api/themes` 是唯一来源；client 走 `--xm-*` CSS 变量 | grep 6 位色值：host/ + client/ 除 themes.mjs 零命中；test-host 81/81；截图 p4-studio-molan.png、p4b-studio-molan.png |
| P5 | 导出 HTML 与复制片段两套外壳 | renderStandalone() 是唯一外壳，路由 mode=export 直接用 | `test-shell.mjs`：导出以 DOCTYPE 开头、与复制片段逐字节一致 |
| P6 | 发布时图 URL 缺 session → 对面 400 | assetUrl 拼 `?session=` | test-publish 11/11 |
| P7 | 补图先落盘后校验锚点，锚点不存在会留孤儿素材 | 先验锚点再落盘；失败回滚已落盘的文件 | test-images 37/37 |
| P8 | `xiumi_preview` 只报统计，缺图不吭声 | 重写：未用素材 / 指向不存在的素材 / 素材文件不在盘上 / 导出体积 四类都点名 | test-shell 缺图框断言 |
| P9 | 三个测试脚本只打印不判失败 | verify-text 20、test-render 45、test-host 81 全改真断言 + `_harness.mjs`（失败 exit 1） | 全套 13 脚本 449 条断言全绿；失败注入实测 exit 1 |
| P10 | README 声称面板能挪块改图注（实际没有） | 改成「大纲只读、改块由 AI 做、改动记进创作过程」 | 本文件 §6 |
| P11 | 重载脚本会默默改宿主全局配置 | 默认 dry-run（exit 2），`--yes` 才动；改前备份、失败还原；README 写明这是调试工具 | 三种场景自测通过 |
| P12 | 缺图块渲染不出来，也不说原因 | imageBlock 渲染虚线框 + 「这里缺一张图：<素材名>」 | test-shell 9/9 |
| P13 | 网络无超时、凭证 0644 | fetchText 统一 15s 超时 + 三类人话错误；oauth.json/pending.json 0600、目录 0700 | `test-net-timeout.mjs` 13/13 |
| P14 | 死代码（blocksToPlan 导出、mimeOfName 等） | 删干净 | grep 零引用 |
| P15 | `_inspect` 里 20MB 垃圾（临时工作区、测试图） | 临时目录改 os.tmpdir；删 testws/tmpimg/tiles 等；35MB/248 文件 → 12MB/104 文件 | `_inspect/README.md` 清理记录 |

合计：18 个测试脚本、656 条断言，全绿（含 test-layout 37 条：槽位分类 / 表格转行按值去重与单行转置 / 长标题优先落 0.99–1.6 倍槽 / emptySection 与 overflow 统计；test-route-order：GET 路由必须早于 POST 守卫，防 405 事故复现；test-review-fixes 41 条：C1 本地图警告与干跑文案 / C2 导语进摘要但正文保留全文 / C3 回执判定 / C5 副本归属 / C6 标题摘要截断要说 / C7 超大标题槽警告 / C8 区间上下界 / C4 空坏 spec 拒绝出计划；test-template-rank 63 条含结构打分、「真排一遍」空标题框/溢出段扣分、likelyFilled 成品跳过；test-template-fill 40 条含 42 槽图片分配（一张图只用一次、均匀摊开、透明细线补空槽）与干跑文案）；真宿主 127.0.0.1:51673 重载后 ping 200、template/shows 与 health 都回「缺少 session」（= 路由已挂上）。

## 8. v2 反馈（2026-11-15 晚，m05802）

| # | 用户原话 | 状态 | 证据 / 落点 |
| --- | --- | --- | --- |
| V1 | 图片「每张只用一次」不要重复 | ✅ 做完 | `host/layout.mjs` 图少于槽时均匀取槽（首图不堆开头、末图不只在结尾），空槽用 1200×2 透明细线顶；DOM 实测 4 张照片各 1 次 + 10 条透明线；`test-template-fill` 40/40 |
| V2 | 没用上的槽位「斧正」删掉 | ⚠️ 接口不支持 | `update_show_from_plan` 的 `content_items` 只有 text/image 两种，无删块能力；E2E-R3 §5.5 写清两条替代路径（打分避开空小节槽 / 人在编辑器里删一下） |
| V3 | 别为填满模板舍本逐末 | ✅ 做完 | 不再为填满而重复用图；空图槽本身缩成细线，露出来的是空小节标题槽（见 V2） |
| V4 | 改完跑一遍、再作为 v1 发 GitHub | 🔄 半程 | 真跑 **738982013** 待用户确认；两份对比副本已删（回收站 531708304 / 531708306）；桌面 dist 已重建（`--app-only`，smoke 17/17） |