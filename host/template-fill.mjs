/**
 * 模板填充引擎：把「我的图文」里一篇模板作品，按槽位换成我们这篇通稿的文字与图片。
 *
 * 为什么要有这个文件：
 *   秀米的免费模板不是 CSS，是一棵带背景/装饰/组件/动效的 JIANPU 内容树。MCP 只给了两把钥匙——
 *   get_show_edit_spec（把树摊平成带名字的槽）和 update_show_from_plan（按槽名替换，未绑定的槽逐字节保留）。
 *   所以「用模板」= 复制模板作品 + 把我们的内容灌进槽里，模板组件原样留着。
 *
 * 三条实测出来的硬规则（改之前先看 _inspect/probe-slot-rules*.mjs 的输出）：
 *   1. 文字槽不能绑空串/空格/换行（MATERIAL_EMPTY_TEXT）。想清空一个槽，绑零宽空格 U+200B。
 *   2. 图片槽能绑图床 URL；模板自带的照片要顶掉，否则成品里会夹着别人的图。顶掉用 1×1 透明 PNG。
 *   3. spec 里 image_1..13 是 13 个独立槽，不是叫 image_1..13 的一个槽；不展开就会漏绑。
 */
import * as mcp from './mcp.mjs';
import { BLANK_TEXT, BLANK_PNG_BASE64 } from './template-fill-const.mjs';
import { planLayout, collectUnits, classifySlot, tableToLines } from './layout.mjs';

// 常量搬到了 template-fill-const.mjs（layout.mjs 也要用，单放一个文件避免循环引用）
export { BLANK_TEXT, BLANK_PNG_BASE64 };
export { planLayout, collectUnits, classifySlot, tableToLines };

/** 解析 spec 文本里「role:xxx」「fs:1.25」「opt」「max60」这类旗标 */
function flagsOf(tokens) {
  const out = { role: '', fs: 1, opt: false, min: 1, repeat: null, max: 0, url: false };
  for (const t of tokens) {
    if (t === 'opt') out.opt = true;
    else if (t === 'URL') out.url = true;
    else if (t.startsWith('role:')) out.role = t.slice(5);
    else if (t.startsWith('fs:')) out.fs = Number(t.slice(3)) || 1;
    else if (t.startsWith('max')) out.max = Number(t.slice(3)) || 0;
    else if (t.startsWith('min')) out.min = Number(t.slice(3)) || 0;
    else if (t.startsWith('REP')) out.repeat = t.slice(3);
  }
  return out;
}

/** 从一行里取载荷：note: / ex: 都可能出现，ex 里的「 ex\:」是转义，别当成载荷起点 */
function payloadOf(line) {
  const m = /(^|\s)ex:/.exec(line);
  if (!m) return '';
  return line.slice(m.index + m[0].length);
}

/**
 * 把 get_show_edit_spec 的文本解析成可绑定的槽表。
 * @returns {{specVersion:string, meta:Array, textSlots:Array, imageSlots:Array, slots:Map, summary:string}}
 */
export function parseSpec(text) {
  const raw = String(text || '');
  const lines = raw.split(/\r?\n/);
  const versionLine = lines.find((l) => /^JIANPU\s/i.test(l)) || '';
  const specVersion = /spec_version=([0-9a-f]+)/i.exec(versionLine)?.[1] || '';
  const summary = (lines.find((l) => /^#\s*摘要/.test(l)) || '').replace(/^#\s*/, '').trim();

  const meta = [];
  const textSlots = [];
  const imageSlots = [];
  const slots = new Map();
  // 解析时发现的硬问题（审查 C4/C8）：说出来，别让调用方以为「解析成功、只是没槽」
  const problems = [];
  if (!versionLine) problems.push('这不是秀米的 JIANPU 编辑规格（没有 JIANPU 行）');
  if (versionLine && !specVersion) problems.push('编辑规格第一行没有 spec_version');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const metaMatch = /^META\s+(\S+)(.*)$/.exec(trimmed);
    if (metaMatch) {
      const name = metaMatch[1];
      const rest = metaMatch[2] || '';
      const ex = payloadOf(rest);
      const flags = flagsOf(rest.replace(/ex:.*$/, '').split(/\s+/).filter(Boolean));
      const slot = { kind: 'meta', name, max: flags.max, url: flags.url, ex };
      meta.push(slot);
      slots.set(name, slot);
      continue;
    }

    if (/^(LAYER|FRAG)\b/.test(trimmed)) continue;

    const slotMatch = /^S\s+(\S+)\s+(TXT|IMG)\b(.*)$/.exec(trimmed);
    if (!slotMatch) continue;
    const [, rawName, type, rest] = slotMatch;
    const ex = payloadOf(rest);
    const flags = flagsOf(rest.replace(/ex:.*$/, '').split(/\s+/).filter(Boolean));

    if (type === 'IMG') {
      // 区间记法：image_1..13 = 13 个独立槽（官方图例原话）
      const range = /^(\D*?)(\d+)\.\.(\d+)$/.exec(rawName);
      let names = [rawName];
      if (range) {
        const from = Number(range[2]);
        const to = Number(range[3]);
        // 倒序区间（image_13..1）以前会静默算出 0 个槽；超大区间（image_1..200000）会造出二十万条绑定
        if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
          problems.push('图片槽区间不合法：' + rawName + '（起止反了）');
          continue;
        }
        if (to - from + 1 > 999) {
          problems.push('图片槽区间太大：' + rawName + '（' + (to - from + 1) + ' 个，最多 999）');
          continue;
        }
        names = Array.from({ length: to - from + 1 }, (_, i) => range[1] + (from + i));
      }
      for (const name of names) {
        const slot = { kind: 'image', name, role: flags.role, opt: flags.opt, exclusiveRange: Boolean(range) };
        imageSlots.push(slot);
        slots.set(name, slot);
      }
      continue;
    }

    const slot = { kind: 'text', name: rawName, role: flags.role, fs: flags.fs, opt: flags.opt, ex };
    textSlots.push(slot);
    slots.set(rawName, slot);
  }

  return { specVersion, summary, meta, textSlots, imageSlots, slots, raw, problems };
}

/**
 * 这篇文章要灌进模板的「文字单元」和「图片单元」，按正文顺序。
 * 角色判断交给了 layout.mjs（那里会看模板槽的 fs / ex / 顺序）。
 */
export function contentOf(project) {
  const { units, images, localOnly } = collectUnits(project);
  const texts = units
    .filter((u) => u.kind !== 'number')
    .map((u) => ({ text: u.text, role: u.kind, fs: u.kind === 'section' ? 1.25 : 1.0 }));
  return { texts, images, localOnly };
}

/**
 * 产出填槽计划（不碰网络）。
 *
 * 排版不再「按序号摊平」，而是先让 layout.mjs 认出每个槽是标题/小节/正文/编号/装饰，
 * 再把稿子的标题、小节、段落、表格、署名按角色放进去；放不下的接在最后一个正文槽后面，一个字都不丢。
 * @param {{spec:object, project:object, blankImageUrl:string}} args
 */
export function planFill({ spec, project, blankImageUrl, expectUpload = false }) {
  // C4：空/坏 spec 以前会「成功」，实际一个槽都没填（真跑出来是一篇空稿）
  if (!spec || !spec.specVersion) {
    throw new Error('模板 spec 解析失败：没有 spec_version，拿到的可能不是编辑规格——先 get_show_edit_spec 重新取一次，别硬灌');
  }
  if (spec.problems && spec.problems.length) {
    throw new Error('模板 spec 有问题：' + spec.problems.join('；'));
  }
  if (!spec.slots || spec.slots.size === 0) {
    throw new Error('模板 spec 里一个槽都没有（文字 0、图片 0），灌进去只会得到一篇空稿——换一个模板或重新取 spec');
  }

  const { images, localOnly } = collectUnits(project);
  const layout = planLayout({ spec, project, expectUpload });
  const warnings = layout.warnings.slice();
  const bindings = [];
  const items = [];
  let index = 0;

  const push = (slot, material) => {
    bindings.push({ slot, material: { index } });
    items.push({ index, ...material });
    index += 1;
  };

  // 标题：模板的 work_title 槽 = 文章标题
  const titleText = String(project.title || '');
  if (spec.slots.has('work_title')) {
    if (titleText.length > 60) warnings.push('标题有 ' + titleText.length + ' 字，超过 work_title 槽的 60 字上限，后 ' + (titleText.length - 60) + ' 字放不进去（正文里不受影响）');
    push('work_title', { type: 'text', text: titleText.slice(0, 60) });
  } else {
    warnings.push('这个模板没有 work_title 槽，标题只能留在正文里');
  }
  // 摘要槽：公众号的摘要和正文本来就是两处，导语进摘要后**正文里仍然保留全文**（文稿一字不删）。
  if (spec.slots.has('work_desc')) {
    const source = (project.blocks || []).find((b) => b.type === 'lead') || (project.blocks || []).find((b) => b.text) || { text: '' };
    const flatDesc = String(source.text || '').replace(/\s+/g, ' ');
    if (flatDesc.length > 120) warnings.push('摘要槽只放前 120 字（这段共 ' + flatDesc.length + ' 字），其余没进摘要；正文里仍是全文');
    push('work_desc', { type: 'text', text: flatDesc.slice(0, 120) });
  }

  // 文字槽：每个槽一行（有内容，或者零宽空格把模板占位文案清掉）
  for (const row of layout.textRows) push(row.slot.name, { type: 'text', text: row.text });

  // 万一长段落还是落进了超大标题槽（模板标题槽特别多），提前说清，别让用户以为是我们排坏了
  const squeezed = layout.textRows.filter((row) => classifySlot(row.slot) === 'title' && Number(row.slot.fs) >= 1.45 && String(row.text || '').length > 60);
  if (squeezed.length) {
    warnings.push(
      '模板有 ' + squeezed.length + ' 个超大标题槽（' + squeezed.slice(0, 3).map((r) => r.slot.name).join('、') +
        '）被正文占用了，显示出来会是大字——想更规整就换一个字号均匀的模板'
    );
  }

  if (localOnly > 0 && expectUpload) {
    warnings.push('有 ' + localOnly + ' 张图还在本地：干跑不上传，所以预览里这些槽是空的；真跑会先传进秀米图床再灌，成品里是原图');
  } else if (localOnly > 0) {
    warnings.push(
      '有 ' + localOnly + ' 张图还只在本地、没进秀米图床（成品只有 ' + images.length + ' 张能显示）——先点「图片进秀米图床」或发布一次' +
        (images.length === 0 ? '；现在一张能显示的图都没有，模板图片槽会被透明占位图顶掉' : '')
    );
  }

  // 图片：按 layout 的分配，一张图只用一次；没用上的槽用透明细线顶掉模板照片
  for (const row of layout.imageRows) push(row.slot.name, { type: 'image', url: row.url });
  const filledImage = new Set(layout.imageRows.map((r) => r.slot.name));
  const emptyImageSlots = spec.imageSlots.filter((slot) => !filledImage.has(slot.name));
  if (emptyImageSlots.length && blankImageUrl) {
    for (const slot of emptyImageSlots) push(slot.name, { type: 'image', url: blankImageUrl });
  } else if (emptyImageSlots.length) {
    // 一条就够：以前写在循环里，5 个空槽会印 5 遍同样的警告
    warnings.push(
      expectUpload
        ? '模板还有 ' + emptyImageSlots.length + ' 个图片槽空着：干跑没有透明图地址，真跑会生成一张透明占位图把它们顶掉（模板自带照片不会露出来）'
        : '模板还有 ' + emptyImageSlots.length + ' 个空图片槽，没给透明图地址，模板自带照片会留在成品里'
    );
  }

  const userIntent = ('按槽位把《' + String(project.title || '').slice(0, 24) + '》的文字与图片换进模板，保留模板组件').slice(0, 255);

  return { specVersion: spec.specVersion, bindings, material: { content_items: items }, userIntent, warnings, stats: layout.stats };
}

/** 在任意深度的 JSON 里找这些键（秀米把结果包在 content[0].text 里，层级不固定） */
function deepFind(value, keys, depth = 0) {
  if (depth > 5 || value == null) return undefined;
  // 秀米 MCP 常把结果再序列化一层塞进 content[0].text："{\"valid\":true,...}"
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s.startsWith('{') && !s.startsWith('[')) return undefined;
    try {
      return deepFind(JSON.parse(s), keys, depth + 1);
    } catch {
      return undefined;
    }
  }
  if (typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = deepFind(v, keys, depth + 1);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(value, k)) return value[k];
  for (const v of Object.values(value)) {
    const hit = deepFind(v, keys, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * 把计划提交给秀米（dryRun=true 时零副作用预检）。
 * 成功判定看接口语义，不看文案（审查 C3）：valid === true 且 updated_slots ≥ bindings 数。
 */
export async function applyFill(showId, plan, opts = {}) {
  const res = await mcp.callTool(
    'update_show_from_plan',
    {
      show_id: Number(showId),
      spec_version: plan.specVersion,
      bindings: plan.bindings,
      material: plan.material,
      user_intent: plan.userIntent,
      ...(opts.dryRun ? { dry_run: true } : {}),
    },
    { timeoutMs: opts.timeoutMs || 180000 }
  );
  const text = (res.content || []).map((c) => c.text || '').join('\n');
  return judgeFillResult(text, plan);
}

/** 解析 update_show_from_plan 的返回：{ok, valid, updatedSlots, expected, errors, note, text} */
export function judgeFillResult(text, plan = {}) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  let payload = null;
  if (start >= 0 && end > start) {
    try {
      payload = JSON.parse(raw.slice(start, end + 1));
    } catch {
      payload = null;
    }
  }
  const valid = payload ? deepFind(payload, ['valid']) : undefined;
  const slotsRaw = payload ? deepFind(payload, ['updated_slots', 'updatedSlots']) : undefined;
  const errorsRaw = payload ? deepFind(payload, ['errors']) : undefined;
  const expected = Array.isArray(plan.bindings) ? plan.bindings.length : null;
  const updatedSlots = slotsRaw == null ? null : Number(slotsRaw);
  const errors = Array.isArray(errorsRaw) ? errorsRaw : errorsRaw ? [errorsRaw] : [];
  const notes = [];
  let ok;
  if (valid === true) {
    ok = expected == null || updatedSlots == null ? true : updatedSlots >= expected;
    if (!ok) notes.push('接口说 valid，但只更新了 ' + updatedSlots + ' / ' + expected + ' 个槽');
  } else if (valid === false) {
    ok = false;
    notes.push('接口判定不合法');
  } else {
    // 解析不出 JSON：只能退回文案判断，并且必须说清楚这是退路
    ok = /更新成功/.test(raw) && !/"valid"\s*:\s*false/.test(raw);
    notes.push('返回里没有可解析的结果对象，按文案判定（' + (ok ? '成功' : '失败') + '）');
  }
  return {
    text: raw,
    ok,
    valid: valid === undefined ? null : Boolean(valid),
    updatedSlots,
    expected,
    errors,
    notes,
    payload,
  };
}
/** 拿一个作品的 spec（文本） */
export async function fetchSpec(showId, opts = {}) {
  const res = await mcp.callTool('get_show_edit_spec', { show_id: Number(showId) }, { timeoutMs: opts.timeoutMs || 90000 });
  return (res.content || []).map((c) => c.text || '').join('\n');
}

/** 干跑用：只在本次进程已经传过透明图时才有值（干跑不许有副作用，不触发 create_image） */
export function cachedBlankImageUrl() {
  return blankCache || '';
}

/** 1×1 透明图地址（每次进程内只传一次，秀米图床保留） */
let blankCache = null;
export async function blankImageUrl() {
  if (blankCache) return blankCache;
  const res = await mcp.callTool('create_image', { image_base64: BLANK_PNG_BASE64 }, { timeoutMs: 90000 });
  const text = (res.content || []).map((c) => c.text || '').join('\n');
  const uri = /"target_uri"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  if (!uri) throw new Error('上传透明占位图失败：' + text.slice(0, 200));
  blankCache = uri.startsWith('//') ? 'https:' + uri : uri;
  return blankCache;
}
