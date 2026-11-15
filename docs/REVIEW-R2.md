# R2 代码审查 + 红队对抗审查

审查者：audit-reviewer（独立于 R2 实现方）· 日期：2026-11-15 · 任务：task-12 / PLAN-R2.md R2-7

对象：本轮新增的「套账号内模板」链路 —— `host/template-fill.mjs`、`host/template-shows.mjs`、`host/routes.mjs` 三个新接口、`host/mcp.mjs` 的认证与错误路径，以及它们在 SKILL / 面板 / 工具层的接线。

方法：只读代码 + 离线断言 + `node --check`。**没有调用任何会写数据的秀米接口，没有复制作品，没有重载插件**，没有改源码（本次只写这个文件）。快照 sha256、可复现的离线实验见 §6。

---

## 0. 总论：现在是什么，哪些真跑通，哪些只是「写得像」

一句话：**引擎是真的，链路是断的，断口后面还藏着两个会静默出错的坑。**

| 能力 | 真实证据 | 判定 |
|---|---|---|
| 导入 docx → 主题 → 预览 → 发布自绘版 | `host/docx.mjs`、`host/render.mjs`、`host/xiumi.mjs:179 publishProject`；R1 与 PLAN-R2 有真作品 | 跑通（R1 已核） |
| 读 spec 生成填槽计划 | `host/template-fill.mjs:151-211`；`_inspect/test-template-fill.mjs` 33 条断言 | 跑通（纯函数层） |
| 把 plan 提交给秀米 | `host/template-fill.mjs:214-229`；PLAN-R2:21 记 738890287→738939797，dry_run 27 槽 `valid:true`，正式 `updated_slots 27` | **半通**：只证明 MCP 接受了 plan，没有视觉/样式/图片验收 |
| 浏览器入口 | `client/studio.js:1116` 仍取 `/templates`（商店目录）；`:1074` 注释明说「只做参考，不到模板本体里塞内容」 | 没接 |
| 模型入口 | `host/tools.mjs` 只有 `xiumi_templates`（目录）；13 个工具里没有 apply/fill；`:565`/`:594` 仍写「还没做」 | 没接 |
| HTTP 接口 | `host/routes.mjs:670-730`；`_inspect/test-template-rank.mjs:136-137` 只断言源码里有这个字符串 | 只在 curl 下存在 |
| 自动选模板 | `host/template-shows.mjs:231-266` | 逻辑在，判据脆弱（M5/M6） |

「写得像」清单（每条都能对着代码/文档核）：

1. `skills/xiumi-studio/SKILL.md:110/119/121` 直接叫模型 `POST /xiumi/api/template/apply`，但模型侧没有这个工具、面板也没有调用方 —— 流程写了，入口没写。模型照做只能自己在 bash 里拼端口和 session，SKILL 没教怎么拿。
2. `host/template-fill.mjs:228` 用正则判成功 —— 「成功」是文本巧合，不是接口语义。
3. `host/template-fill.mjs:213` docstring「dryRun=true 时零副作用预检」+ `SKILL.md:120`「干跑不会复制」—— 干跑仍会 `create_image` 上传一张透明图（`host/template-shows.mjs:157`）。
4. `SKILL.md:106`「未绑的槽保持原样」—— `planFill` 把所有文字槽都绑成内容或 ZWSP（`template-fill.mjs:176-186`），未用图片槽全绑透明图（`:192-206`）。
5. `docs/PLAN-R2.md:75`「14 个脚本、493 条断言」—— `_inspect/_all.sh` 实际 15 个脚本（多一个 test-template-rank），断言数未复核。
6. `_inspect/test-template-rank.mjs:136-137` 用 `routesSrc.includes(p)` 当接口契约测试 —— 证明的是字符串存在，不是接口能跑。

验收意见：R2-1/R2-2 的「用户可以套模板」不成立（没有入口）；R2-3 的「图片槽绑图床地址」在**未发布工程上必然全空**（C1）。这两个不修，本轮的对外价值接近 0，只剩一个能被 curl 调用的引擎。

---

## 1. 正确性

### C1【严重】未发布工程的图片在模板填充里全部静默消失，成品无图却报成功

```js
// host/template-fill.mjs:110-113
    if (block.type === 'image') {
      if (block.remoteUrl) images.push({ name: block.name || '', url: block.remoteUrl, caption: block.caption || '' });
      continue;
    }
```

`block.remoteUrl` 全仓库只有一个写入点，在发布链路里：

```js
// host/xiumi.mjs:252-253（uploadProjectAssets 末尾，tools.mjs:496 发布前才调）
  for (const b of project.blocks || []) {
    if (b && b.type === 'image' && b.asset && known.has(b.asset)) b.remoteUrl = known.get(b.asset);
```

`/xiumi/api/template/apply`、`/xiumi/api/template/fill` **都不调用** `uploadProjectAssets`，也不检查 `remoteUrl`。刚导入、还没发布过的工程，图片块只有本机 `asset`，于是 `contentOf` 返回 `images: []`，`planFill` 用透明图（`blankImageUrl`）把模板的每个图片槽都顶掉，`warnings` 为空。离线实验 C 实证：两个图片块（一个带 remoteUrl、一个不带）进去，plan 里只剩带 remoteUrl 的那一张，且 `warnings = []`。

对照：发布链路自己是有这个防备的 —— `host/xiumi.mjs:163` 有 `const localOnly = imgs.filter((b) => !b.remoteUrl).length;` 专门在 preflight 里提醒。模板链路照抄这段就行，但没照抄。

改法：`fillTemplate` 里先 `await xiumi.uploadProjectAssets(project, { readAsset })`（或把 `deps` 的读素材函数传进来），把 `failed/localOnly` 放进 `warnings`；`contentOf` 同时返回 `localOnlyCount`，`planFill` 在有本机图却无 remoteUrl 时给出明确警告（而不是静默当没有图）。验收：一条「新导入未发布工程 → dryRun」的测试，必须回「N 张图还没传图床」。

### C2【高】`work_desc` 与正文首段重复，成品开头同一段出现两次

```js
// host/template-fill.mjs:170-172
  if (spec.slots.has('work_desc')) {
    const desc = (texts.find((t) => t.role === 'lead') || texts[0] || { text: '' }).text;
    push('work_desc', { type: 'text', text: desc.replace(/\s+/g, ' ').slice(0, 120) });
```

`texts` 是全部文字单元，之后 `distribute(texts, slotsForText)`（`:177`）仍把它原样摊进正文槽。稿子没有 `lead` 块时（`docx` 导入默认不产 lead），`desc = texts[0]`，同一段既进 `work_desc` 又进 `body_1`。离线实验 C 的实测绑定：`["冬天快乐：校园讲座侧记", "第一段是导语…", "第一段是导语…", "第二段正文。"]`。

改法：取 desc 时记住它的来源下标，摊正文时 `texts.filter((t) => t !== descUnit)`；或者干脆只在有 `lead` 时才填 `work_desc`。

### C3【高】成功判定靠正则，真跑「成功但文本不含关键词」会被判失败，并诱发重复复制

```js
// host/template-fill.mjs:228
  return { text, ok: /"valid"\s*:\s*true/.test(text) || /更新成功/.test(text) };
```

PLAN-R2:21 记录的真跑响应里给的是 `updated_slots 27`，并没有 `valid` 字样 —— 也就是说这次真跑能报 ok，靠的是响应文本里恰好还有「更新成功」或 `valid`。上游换个措辞、或返回 SSE 分段、或 `valid` 出现在错误上下文里，判定就翻。同时 `ok` 是二元的：部分槽失败、`updated_slots` 少于 bindings 数，也照样 `ok:true`。

改法：解析响应 JSON，返回三态 `{ ok, valid, updatedSlots, errors }`；`ok` 定义为 `valid === true && updatedSlots === bindings.length`，解析不出来时 `ok:false` 且把原文带出去。路由改用 `out.updatedSlots` 记事件。

### C4【中高】空/坏 spec 静默通过：解析失败也能报 ok，实际一个槽都没填

```js
// host/template-fill.mjs:51-52
  const versionLine = lines.find((l) => /^JIANPU\s/i.test(l)) || '';
  const specVersion = /spec_version=([0-9a-f]+)/i.exec(versionLine)?.[1] || '';
```

`parseSpec` 对任何文本都不抛错：没有 `JIANPU` 行 → `specVersion=''`；槽行格式变了 → `textSlots=[]`。`/template/fill`（`routes.mjs:719-726`）拿到这种 spec 后照旧 `planFill` + `applyFill`，把 `spec_version: ''`、`bindings: []` 发给 MCP。上游若宽容，就回一个 `{"valid":true}` —— 用户看到「填槽成功」，模板一个字没变。`spec_version` 的正则只认 `[0-9a-f]`，万一上游改成大写或带别的字符，同样静默降级为空串。

改法：`parseSpec` 后立刻校验 `specVersion` 非空且 `slots.size > 0`，否则抛「这篇作品的 spec 解析失败（可能不是图文/格式变了）」；`applyFill` 前再断言 `bindings.length > 0`。

### C5【中】「干跑零副作用」不成立：干跑也会往图库传一张透明图

```js
// host/template-shows.mjs:157（dryRun 分支之前就执行）
  const blank = blankUnused ? await blankImageUrl() : '';
// host/template-fill.mjs:213
/** 把计划提交给秀米（dryRun=true 时零副作用预检） */
```

`blankImageUrl()` 会 `create_image` 上传 1×1 PNG（`template-fill.mjs:239-247`）。第一次干跑就会在账号图库里留一张透明图；`SKILL.md:120` 却向模型保证「干跑不会复制」、docstring 写「零副作用」。用户对「干跑」的预期是「什么都不留下」。

改法：二选一 ——（a）干跑不取 blank，未绑图片槽不生成 binding，在 `report` 里注明「干跑不覆盖图片清空的效果」；（b）保留现状但把 docstring/SKILL 改成「干跑不复制作品，但会在图库存一张占位透明图」。

### C6【中】标题与摘要静默截断，用户不知道被砍了

```js
// host/template-fill.mjs:166 / 172 / 208
    push('work_title', { type: 'text', text: String(project.title || '').slice(0, 60) });
    push('work_desc', { type: 'text', text: desc.replace(/\s+/g, ' ').slice(0, 120) });
  const userIntent = ('按槽位把《' + String(project.title || '').slice(0, 24) + '》的文字与图片换进模板，保留模板组件').slice(0, 255);
```

60 字标题、120 字摘要都是硬切，没有省略号、没有 warning。离线实验 D：80 字标题 → 绑定文本 60 字，`warnings` 里只有一条图片槽的提示。摘要还有更糟的一种：切在第 120 个字符上，句子断在半句。

改法：超过上限时 `slice(0, N - 1) + '…'` 并 `warnings.push('标题超过模板上限 60 字，已截断')`；摘要优先在句号/逗号处断（`lastIndexOf('。')`）。

### C7【中】真跑失败留下垃圾稿，重试再复制一份

```js
// host/template-shows.mjs:179-183
  const copy = await copyAsNew(templateShowId, titlePostfix);
  if (!copy.showId) throw new Error('复制模板没有拿到新作品 id：' + copy.text.slice(0, 200));
  const spec = parseSpec(await fetchSpec(copy.showId));
  const plan = planFill({ spec, project, blankImageUrl: blank });
  const result = await applyFill(copy.showId, plan, { dryRun: false });
```

复制成功之后的任何一步（`fetchSpec` 超时 90s、`planFill` 抛错、`applyFill` 180s 超时）都会让整个函数抛出，但已经复制出来的那篇作品不会删。`routes.mjs:711-713` 只回 error，`addEvent` 也不记。用户看到失败 → 再点一次 → 账号里两篇「模板原名·日期」的垃圾稿。秀米 MCP 有 `delete_show`/`restore_show`（`_inspect/tools.json`），够用来收拾。

改法：`try { ...applyFill } catch (e) { try { await mcp.callTool('delete_show', { show_id: copy.showId }) } catch {} ; e.showId = copy.showId; throw e }`；或在响应里带 `orphanShowId` 让调用方决定。

### C8【中】区间记法没有上下界：倒序静默 0 槽，超大区间直接造 20 万 bindings

```js
// host/template-fill.mjs:86-89
      const range = /^(\D*?)(\d+)\.\.(\d+)$/.exec(rawName);
      const names = range
        ? Array.from({ length: Number(range[3]) - Number(range[2]) + 1 }, (_, i) => range[1] + (Number(range[2]) + i))
        : [rawName];
```

离线实验：`S image_9..1 IMG` → 图片槽 0 个，不报错不警告，图片全部进不去；`S image_1..200000 IMG` → 200000 个槽、200001 条 bindings，用时 108ms（内存没事，但请求体会是几十 MB，交给 MCP 基本必被拒或超时）。这不是我们写的 spec，是上游/用户改过的 spec 的真实可能形态。

改法：`const [a, b] = [Number(range[2]), Number(range[3])]; if (a > b || b - a > 199) throw new Error('spec 区间不合法：' + rawName)`。

### C9【低】两条 warning 文案不实/重复

```js
// host/template-fill.mjs:187-189
  if (texts.length > slotsForText.length) {
    warnings.push('文字段落比模板槽位多（' + texts.length + ' > ' + slotsForText.length + '），多出来的段合并进了最后一个槽');
  }
```

`distribute`（`:128-145`）是**均匀摊到每个槽**，不是「合并进最后一个槽」，warning 说错了做法；`:202` 的「模板还有 N 个空图片槽」在循环里对每个空槽各 push 一次（42 个空槽 = 42 条一模一样的警告）。改法：文案改成「已均匀分到 N 个槽」，空槽警告循环外聚合一次。

---

## 2. 安全

### S1【中高】`/template/fill` 不校验 showId 归属：能直接覆盖模板本体或已发布作品

```js
// host/routes.mjs:717-724
      if (req.method === 'POST' && route === '/xiumi/api/template/fill') {
        const project = loadProject(cwd, url, body);
        const showId = Number(body && body.showId);
        if (!showId) return fail(res, 400, '缺少 showId（要填哪一篇）');
        try {
          const spec = parseSpec(await templateFill.fetchSpec(showId));
```

`showId` 来自请求体，`fetchSpec` + `applyFill` 直接作用在这篇作品上。没有任何「这篇是不是本次复制出来的 / 是不是我们自己的」判断，也没有 `released` 检查。`apply` 的自动挑模板路径（`:692-699`）只从 `isTemplate` 里挑，但手动传 `showId` 时连这个都不走。配合 `sameOrigin`（`routes.mjs:133-147`）对**没有 Origin 的请求一律放行**：本机任何进程（脚本、另一个插件、Electron 渲染进程里的任意页面走 fetch 会带 Origin，但 curl/本地程序不带）都能把任意作品（包括已发布的正式推文）覆盖成当前稿子。这是「本机信任边界」内的设计选择，但 fill 的破坏力比 apply 大一个量级（apply 只会新增副本），至少该有二次确认。

改法：内存里记一份「本次会话 copyAsNew 产出的 showId」（`fillTemplate` 真跑成功后登记），`/template/fill` 只接受登记过的 id；对 `released` 作品要求 `body.confirmReleased === true`；两者都不满足回 403。

### S2【中】OAuth 回调的 state 可以缺省，pending 没有过期时间

```js
// host/mcp.mjs:250-253
export async function finishAuthorization({ code, state }, opts = {}) {
  const pending = readJson(pendingFile(), null);
  if (!pending) throw new Error('没有待处理的授权（可能已过期，请重新点「连接秀米」）');
  if (state && pending.state && state !== pending.state) throw new Error('state 不匹配，拒绝这次回调');
```

回调不带 `state` 就跳过校验（条件短路），带空 `pending.state` 也跳过。这正是 PKCE/state 要防的「把受害者的账号绑到攻击者的授权码上」那一类。`pending.at` 在 `startAuthorization` 里写了（`host/mcp.mjs:236`），但没有任何地方读它，pending 永不过期。

改法：`if (!pending.state || !state || state !== pending.state) throw ...`；`if (Date.now() - pending.at > 10 * 60 * 1000) throw new Error('授权已过期，请重新连接')`；授权成功或失败都删 pending（成功已经删，失败路径没删）。

### S3【中】`authorizationStatus().connected` 谎报；401 之后 token 不清理

```js
// host/mcp.mjs:341-345
export function authorizationStatus() {
  const creds = storedCreds();
  const token = creds.token || {};
  return {
    connected: !!token.accessToken,
// host/mcp.mjs:405-409
  if (res.status === 401) {
    const error = new Error('秀米授权已失效，请重新连接');
    error.code = 'XIUMI_UNAUTHORIZED';
    error.status = 401;
    throw error;
  }
```

401 只是抛错，存储里的 accessToken/refreshToken 原样保留，`authorizationStatus` 仍然回 `connected: true`。面板因此显示「已连接」，直到下一次调用再失败。用户看到的是「明明连着，怎么又失败了」。

改法：401 时把 `token.errorAt/errorCode` 落盘（或删 token），`authorizationStatus` 返回 `connected: false, reason: '授权已失效'`；面板据此变色并提示重新连接。

### S4【中】上游原始响应被原样回吐给浏览器

```js
// host/routes.mjs:710
        return json(res, 200, { ok: Boolean(out.ok), ...out, picked: picked ? {
```

`...out` 里带 `text`（MCP 响应原文，含账号里的作品标题、内部 id、可能的错误详情），`/template/fill`（`:726`）同理。这些是本地环路接口，泄露面有限，但面板是浏览器上下文，任何 XSS/第三方脚本都能读到。

改法：响应只回白名单字段（`ok / showId / dryRun / bindings / warnings / report / picked / updatedSlots`），`text` 只进 `log`。

### S5【低】凭证文件把 accessToken 平铺展开写盘

```js
// host/mcp.mjs:115-124
function saveStored(creds) {
  const out = { version: 2, clients: creds.clients || {}, token: creds.token || null };
  // 兼容字段：面板、日志、老代码按平铺字段读，写盘时一并带上
  const t = out.token || {};
  out.clientId = t.clientId || null;
  out.accessToken = t.accessToken || null;
  out.refreshToken = t.refreshToken || null;
```

文件权限是 0o600（`writeJson` 走 tmp + chmod，R1 的 P13 已修），所以这是「同一份密钥在文件里存了两遍」，风险等级低，但违背最小暴露。

改法：写入只保留 `version/clients/token`；读取侧保留平铺兼容（`normalizeCreds` 里兼容一年再删）。

### S6【低】失败一律回 HTTP 200

```js
// host/routes.mjs:680-682
  } catch (error) {
    return json(res, 200, { ok: false, error: '读账号作品失败：' + error.message });
```

三个新接口的所有失败路径都是 200 + `ok:false`（`:680-682`、`:711-713`、`:727-729`）。调用方（脚本、将来的工具）只能解析 body；监控/日志也看不出这是错误。改法：校验失败 400、上游失败 502，body 仍带 `ok:false` 与 `error`。

### PAT 专项结论（回应子任务的担心）

**仓库里没有任何 PAT 实现**（全仓 grep 无 `pat`/`personal access token` 相关代码，唯一出现在秀米自己的 `tools.json` 描述里：「列出当前授权用户（PAT 属主）…」）。token 只出现在 `host/mcp.mjs:392` 的 `authorization` 请求头与凭证文件，不进 `log`、不进 `Error`。所以「PAT 会不会进日志或异常信息」这条**不成立**；真正的泄露面是 S4（上游响应原文回吐）。

---

## 3. 可维护性

### M1【高】新链路没有任何入口：面板不调、模型没有工具，只有 curl 能到

```js
// client/studio.js:1116-1117（模板面板取的是商店目录）
      var path = '/templates?limit=6' + (q ? '&q=' + encodeURIComponent(q) : '');
      var first = refresh ? api('/templates/refresh', {}) : Promise.resolve(null);
```

全仓库引用 `/template/shows|apply|fill` 的文件只有 docs（PLAN/PLAN-R2/README/SKILL）、`host/routes.mjs` 和 `_inspect/` 里的探针与源码字符串断言 —— 没有产品代码调用。模型侧 `host/tools.mjs` 的 13 个工具里没有对应工具，`:565`/`:594` 的描述还停在「把成品直接塞进别人的模板还没做」。而 `SKILL.md:110/119/121` 已经写成「调 POST …」的既成事实。三方（代码/面板/文档）状态不一致，用户和模型都点不到这个能力。

改法（按性价比排序）：① 加第 14 个工具 `xiumi_apply_template({ projectId?, showId?, dryRun=true })`，`dryRun` 默认 true、返回 `picked.reasons + warnings`，成功真跑写 `p.xiumi.show_id`；② 面板「参考模板」下面加一行「套这篇」按钮（`dryRun:true` 先弹 bindings/warnings 确认）；③ SKILL 改成调工具，删掉裸 HTTP 用法。

### M2【中】文档与代码互相矛盾，误差都指向「比实际更强」

| 文档 | 说法 | 代码事实 |
|---|---|---|
| `SKILL.md:106` | 未绑的槽保持原样 | 所有文字槽绑内容或 ZWSP，未用图片槽绑透明图（`template-fill.mjs:176-206`） |
| `SKILL.md:120`、`template-fill.mjs:213` | 干跑不会复制/零副作用 | 干跑会 `create_image` 上传透明图（`template-shows.mjs:157`） |
| `docs/PLAN-R2.md:75` | 14 个脚本 | `_inspect/_all.sh:7` 起 15 个 |
| `host/tools.mjs:565/594` | 把成品塞进模板还没做 | 引擎与接口已存在（只是没入口） |
| `host/template-fill.mjs:187-189` | 多出的段合并进最后一个槽 | 均匀摊到所有槽（`:128-145`） |

改法：以代码为准改文档；把「干跑会传占位图」「未绑槽会被清空」写成显式注意事项，而不是乐观描述。

### M3【中】测试脆弱且有恒真空断言，路由层零覆盖

```js
// _inspect/test-template-fill.mjs:10 / :32 / :46
const cwd = '<工作区>';
  const project = store.readProject(cwd, 'p_202611150044_f3f35e');
  ok(plan.material.content_items.filter((it) => it.type === 'text' && it.text === BLANK_TEXT).length === Math.max(0, 21 - 22), ...);
```

测试硬编码了这台机器的绝对路径和一篇真实工程 id：换机器、删工程、换工作区就红。`:46` 的 `Math.max(0, 21 - 22)` 恒为 0 —— 即使 `planFill` 完全不用 ZWSP、或者 ZWSP 逻辑写反，这条也照样过（ZWSP 分支从未被真正断言过）。33 条断言全在「21 文字 / 42 图槽 + 恰好 10 张有图床地址的图」这个顺利样本上，没有一条覆盖失败路径、缺图、异常 spec、`applyFill`、路由。路由的「契约测试」在 `test-template-rank.mjs:136-137`，是 `routesSrc.includes(p)`。

改法：fixture 工程（`_inspect/fixtures/project.json`）+ 相对 cwd；补「槽比段落多」（真正走到 ZWSP）、「图无 remoteUrl」、「倒序区间」、「applyFill 返回坏文本」四类用例；给 `applyFill` 注入假 `mcp.callTool`，把 ok 判定也纳入断言。

### M4【中】解析了 7 个 spec 语义字段，planFill 一个都不用

```js
// host/template-fill.mjs:98（解析）
    const slot = { kind: 'text', name: rawName, role: flags.role, fs: flags.fs, opt: flags.opt, ex };
// :184（使用）
    const text = group.map((g) => g.text).join('\n');
```

`role/fs/opt/min/max/url/ex` 都解析出来挂在槽上，`planFill` 只用了 `slot.name` 和槽的类别/顺序。结果是：字号对不上模板（`contentOf` 里辛苦算的 `fs: 1.25` 也没进 material）、`opt` 可选槽被强行清空、`max` 截断不生效（只能靠 C6 的硬切）、`ex` 完全没进 payload。看起来支持 spec 语义，其实只支持槽名。

改法：要么用起来（`opt && !text` 时不生成 binding；`max` 用于截断并警告；`fs` 带进 material），要么把不用的字段从解析里删掉，别让下一个人以为它们生效。

### M5【低】「自家成品」靠标题前 12 字认人

```js
// host/template-shows.mjs:125-127
  for (const p of projects) {
    const t = norm(p.title);
    if (t && key.startsWith(t.slice(0, 12))) return p;
  }
```

同一标题的 V1/V2 会互相认错（`likelyFilled` 指向第一篇），改过标题的成品认不出（会被当模板）。而发布时其实已经记了 `p.xiumi.show_id`（`host/tools.mjs:531-536`），完全可以按 show_id 认。改法：`matchProject` 先按 `p.xiumi.show_id === show.show_id` 精确匹配，标题前缀只作兜底。

### M6【低】`isTemplate` 只看两个槽数阈值

```js
// host/template-shows.mjs:88-92
    const isTemplate =
      Boolean(spec) &&
      imageSlots >= TEMPLATE_MIN_IMAGE_SLOTS &&
      textSlots >= TEMPLATE_MIN_TEXT_SLOTS &&
      !matched;
```

账号里任何一篇 12 图 + 8 段的旧文章（不是我们做的、标题对不上工程）都会被判成模板，进「可套」列表，还可能被自动挑中 —— 结构上它确实能套，但用户预期是「秀米模板商店那种模板」。改法：加结构特征（槽名是连续 `image_N`/`body_N` 区间、spec 里有 `role:image` 的 opt 标记）或让用户手动勾选「这是我的模板」。

### M7【低】fill 成功不写事件，apply 写了

```js
// host/routes.mjs:707-709（apply 记了）
        if (!dryRun && out.ok) store.addEvent(cwd, project.id, 'template', '已套用模板（秀米作品 ' + out.showId + '）');
```

`/template/fill` 直接改作品，却不记事件（`:717-730` 全段没有 `addEvent`）。事后从工程事件流看不出这篇被谁改过。改法：fill 成功/失败都记，带 `showId` 与 `bindings` 数。

---

## 4. 性能

### P1【中】账号作品逐个串行读 spec，最坏能挂半小时

```js
// host/template-shows.mjs:69-77
  for (const show of shows) {
    const id = String(show.show_id);
    const hit = cache.items[id];
    let specText = null;
    if (hit && now - hit.at < fresh && !opts.refresh) {
      specText = hit.spec;
    } else {
      try {
        specText = await fetchSpec(show.show_id);
```

`fetchSpec` 的超时是 90s（`template-fill.mjs:233`），`shows` 最多 20 篇，串行 → 最坏 30 分钟。`GET /xiumi/api/template/shows?refresh=1` 会一直挂着；没有整体 deadline，也没有把客户端的 `req` 关闭映射成取消。24h 缓存能挡住日常，但第一次用/手动刷新就是最坏情况。

改法：3–4 路并发 + 整体 60s deadline（`AbortSignal.any`），超时的作品标 `unknown` 而不是当「不是模板」；`refresh=1` 只刷新前 N 篇或后台分批。

### P2【中】自动挑模板会再跑一轮账号扫描

```js
// host/routes.mjs:692-693
        if (!showId) {
          const items = await templateShows.inspectAccountShows(cwd, {});
```

面板/工具通常是先 `GET /template/shows` 看列表，再 `POST /template/apply` 自动挑；第二次调用又走一遍 `listShows` + 逐篇 spec（命中 24h 缓存时只省 spec，不省 `get_shows`）。改法：`apply` 接受调用方传回的 `candidates`（或让 `/shows` 返回一个短期 token），或把 `inspectAccountShows` 的结果按 cwd 做 60s 进程内缓存。

### P3【低】缓存写入非原子

```js
// host/template-shows.mjs:30-34（writeCache）
  fs.writeFileSync(file, JSON.stringify(data, null, 1));
```

两个请求并发结束时可能互相截断，`readCache` 解析失败会静默回到空缓存，下一轮全量重取（又把 P1 的最坏情况走一遍）。`host/mcp.mjs:59-78` 已经有 tmp+rename+chmod 的写法，照抄即可。

### P4【低】作品列表硬顶 500 篇，超了静默截断

```js
// host/template-shows.mjs:41-53
  for (let offset = 0; offset < 500; offset += limit) {
    const res = await mcp.callTool('get_shows', { offset, limit, sort_by: 'saved' }, { timeoutMs: 60000 });
```

`limit` 已被夹到 ≤20，所以最多 25 次请求、每次 60s。账号超过 500 篇后，更早的作品不会被看到，且响应里没有 `truncated` 标记。改法：回 `{ items, truncated: true, scanned: 500 }`，让面板显示「只看了最近 500 篇」。

### P5【低】透明图地址是模块级缓存，换账号不失效

```js
// host/template-fill.mjs:238-240
let blankCache = null;
export async function blankImageUrl() {
  if (blankCache) return blankCache;
```

同一进程里重新授权到另一个秀米账号后，仍然用旧账号图床的地址。改法：缓存 key 用 `creds.token.clientId`（或干脆每次会话缓存一次），授权变更时清空。

---

## 5. 红队对抗审查

前面的每一节都在问「代码写得对不对」；这一节只问一件事：**如果我们要把这轮宣布为「用户能套模板了」，它会怎么被打脸。**

### 5.1 五个最强假设，各自怎么失效

**A1「槽位填进去 = 模板被用上了」**
失效方式：`planFill` 只发槽名 + 文字/图片 URL，`fs`/`role` 不进 material（M4），字号层级对不上；未绑文字槽填 ZWSP 会清掉模板自己的装饰性文案；未用图片槽填 1×1 透明图，模板照片被顶成空白；模板的动效/组合组件是否保留，唯一证据是 `updated_slots` 计数（PLAN-R2:21），不是视觉。

**A2「干跑 = 真跑的预演」**
失效方式：干跑对的是**模板本体**的 spec（`template-shows.mjs:160`），真跑对的是**复制出来的那篇**的 spec（`:181`）。复制过程可能改 `spec_version`、槽序或数量；干跑也完全不覆盖 copy 这一步的失败、applyFill 超时后的垃圾稿（C7）。所以「干跑 valid:true」不能推「真跑会成」。

**A3「`isTemplate` 认得出模板」**
失效方式：判据只有 `imageSlots >= 12 && textSlots >= 8 && !matchProject(title)`（M6）。账号里任何一篇 12 图 + 8 段的旧文章都会被当模板；反过来，我们自己的成品改过标题就认不出（M5），会被当模板再复制一遍自己。

**A4「ok/valid 可信」**
失效方式：ok 是正则匹配响应文本（C3），失败也回 HTTP 200（S6），部分槽失败也算 ok。用户看到的「成功」不代表成品对。

**A5「用户/模型能用到这条路」**
失效方式：面板走的是商店目录（`studio.js:1116`），模型没有工具（M1），SKILL 却已经写成「调 POST …」。用户找不到按钮，模型没有可调用的工具，只有读过源码的人会 curl。

### 5.2 三个能构造出错误结果的反例（都是离线实测，不需要秀米账号）

**反例 1：新导入、还没发布的工程去套模板 → 图片全丢，且报告「一切正常」**

```text
内容：title + 2 段正文 + image(p1.png 无 remoteUrl) + image(p2.png 有 remoteUrl)
spec：work_title / work_desc / body_1 / body_2 / image_1..2
实测 contentOf = {"texts":[…2 段…],"images":[{"name":"","url":"https://img.example/p2.png"}]}
实测 image bindings = [p2 的图床地址, https://example.com/blank.png]
实测 warnings = []
```

p1.png 无声消失，模板第 1 个图片槽被透明图顶掉，`warnings` 空。任意一次「新导入 → 直接套模板」都会复现。

**反例 2：稿子没有 lead 块 → 开头同一段出现两次**

```text
实测文字绑定 = ["冬天快乐：校园讲座侧记", "第一段是导语，讲这次讲座的时间地点与主办方。", "第一段是导语，讲这次讲座的时间地点与主办方。", "第二段正文。"]
```

`docx` 导入默认不产 `lead`，所以这是**默认路径**，不是边角。

**反例 3：spec 区间记法越界/倒序 → 静默 0 槽或 20 万槽**

```text
[A] S image_9..1 IMG        → 图片槽 0 个，不报错
[B] S image_1..200000 IMG   → 图片槽 200000 个，bindings 200001 条，108ms
[D] 80 字标题               → 绑定文本 60 字，无截断警告
```

### 5.3 认知偏差自查：我们是不是只验证了顺利路径

是。具体表现：

1. **顺利样本偏差**：33 条断言全建在「21 文字 / 42 图槽 / 恰好 10 张有图床地址」的样本上（`test-template-fill.mjs:15/32/35`）。异常 spec、缺 remoteUrl、空 spec、失败清理，一条都没有。
2. **恒真断言**：`:46` 的 `Math.max(0, 21 - 22)` 恒为 0，ZWSP 分支从未被真正验证 —— 即使删掉整个 ZWSP 逻辑，这条仍绿。
3. **同义反复的成功**：`ok` 由正则定义，测试却只测 plan、不测 `applyFill`；「真跑 65 槽」验证的是 `updated_slots`，不是成品。
4. **契约测试幻觉**：路由的「测试」是 `routesSrc.includes(endpoint)`（`test-template-rank.mjs:136-137`），证明字符串存在，不证明能跑。
5. **探针当证据**：`_inspect/probe-routes-stub.mjs` 手工跑通过，但不在 `_all.sh` 里、没有断言、依赖本机真实工程 —— 它不是回归证据。
6. **文档先行**：SKILL 与 PLAN-R2 的描述已经超出了代码实际能力（M2），后续读者会以为都做完了。

没做的对抗：没在**空账号**上跑过 `/template/shows`（0 篇作品 → `rank.picked = null` 时 apply 的行为没验）；没验证 500+ 篇账号的分页；没验证秀米改版后 spec 格式变化。

### 5.4 失败排序（按「多可能发生 × 多严重」）

| # | 失败 | 发生概率 | 严重度 | 理由 |
|---|---|---|---|---|
| 1 | 用户/模型根本找不到入口，本轮功能等于没上 | 必然 | 高 | 面板与工具都没接（M1） |
| 2 | 未发布工程套模板 → 成品一张图都没有，还报成功 | 高 | 高 | 默认路径 + warnings 空（C1） |
| 3 | 摘要与首段重复、长标题被砍 | 高 | 中 | 默认 docx 路径就命中（C2/C6） |
| 4 | 真跑中途失败 → 账号里留下垃圾稿，重试再复制一份 | 中 | 中高 | 90s+180s 超时窗口不小（C7） |
| 5 | `/template/fill` 传错 showId → 覆盖已发布推文 | 低 | 高 | 无归属校验（S1） |

### 5.5 什么证据能改变我们的立场

- **一次真跑的编辑器复核**（截图或逐项对照）：模板装饰、字号层级、图片位置都还在 → 削弱 A1；若发现字号/装饰丢失 → A1 升级为事实。
- **「新导入未发布工程 → apply dryRun」的产物检查**：直接证实/证伪 C1（我这边是纯函数实测，没走 MCP）。
- **`/template/*` 的自动化行为测试 + 面板/工具接线 PR**：削弱 A5/M1；哪怕只有一个按钮，也改变「等于没上」的结论。
- **账号作品的人工标注 vs `isTemplate` 判定**（比如 20 篇标一遍）：量化 M6 的误判率。
- **401 之后 `authorizationStatus()` 的实测输出**：确认 S3（代码面确定，UI 表现未验）。
- **500+ 篇作品账号的 `/template/shows` 结果**：确认 P4 截断是否真实发生。

反过来，能让立场**更强硬**的证据：把上面任一坑修掉后，回归基线里出现对应的失败用例 —— 现在的 `_all.sh` 里一条都没有。

---

## 6. 方法与不可验证项

**快照**（`<系统临时目录>/xiumi-snap-r2/`，sha256 前 12 位 / 行数）：`routes.mjs` 1b17374f2bc6/744、`template-fill.mjs` e05b8cba0e44/248、`template-shows.mjs` 135b10b96f32/279、`mcp.mjs` 9d1fc20a01b4/481、`xiumi.mjs` bf6957b899aa/313、`tools.mjs` 9188a84ffe23/627、`studio.js` f8328b8be672/1192、`SKILL.md` 27e5eb14f32a/214、`PLAN-R2.md` af829dc77fa0/81。

**语法检查**：`node --check host/template-fill.mjs`、`host/template-shows.mjs`、`host/routes.mjs` 三个全过（Node 20+）。

**离线实验**：用 `node --input-type=module` 直接 import 仓库里的 `host/template-fill.mjs`，构造合成 spec/工程对象调用 `parseSpec` / `contentOf` / `planFill`。全部在内存里，不读写工程、不联网。上面的 [A]/[B]/[C]/[D] 都是这次跑出来的原始输出。

**没做的**：

- 没调任何秀米 MCP 工具（不写数据、不复制、不上传占位图），所以 C3/C4/C5/C7 与 S1~S3 是代码面判定，缺一次真账号复核。
- 没重载插件、没跑 `_inspect/_all.sh`（其中 `test-templates.mjs` 会联网抓商店目录，且部分脚本会写 `.dsh-xiumi` 缓存）。
- 没评 `desktop/**`（本轮 T6 归 cover-designer），也没评 `host/cover.mjs` 的改动。

**按要求不当 bug 报的已知事实**：秀米 MCP 没有「新建图文/发布」工具；外部模板 `copy_show` 必失败（Failed_DataNotMatch）；spec 里的图片槽没有 `ex:` 载荷。这三条在报告里只作为背景，没有算缺陷。

---

## 7. 整改顺序建议（给 lead）

| 优先级 | 事项 | 对应 |
|---|---|---|
| P0 | 接入口：模型工具 `xiumi_apply_template(dryRun 默认 true)` + 面板「套这篇」按钮；SKILL 改调工具 | M1/A5 |
| P0 | 填槽前把本机图传图床（或明确报「N 张图还没传图床」并拒绝出成品） | C1 |
| P0 | 成功判定改成结构化 `{valid, updated_slots}`，不再靠正则；失败别回 200 | C3/S6 |
| P1 | 摘要不与首段重复；截断给省略号 + warning | C2/C6 |
| P1 | spec 校验（version 非空、槽 > 0、区间合法） | C4/C8 |
| P1 | 真跑失败收拾垃圾稿（delete_show）或回 orphanShowId | C7 |
| P2 | fill 的 showId 归属校验 / 已发布二次确认 | S1 |
| P2 | state 必填 + pending TTL；401 清 token 状态 | S2/S3 |
| P2 | 补路由行为测试与失败路径用例，替掉源码字符串断言与恒真断言 | M3 |

（本文件只写这一份，未改任何源码。）

