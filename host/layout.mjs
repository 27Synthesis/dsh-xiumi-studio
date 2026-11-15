/**
 * 语义排版引擎：把稿子的「段落/小标题/导语/名单/署名/图片」对到模板槽位的「角色」上。
 *
 * 之前是「按顺序摊平」：不管槽是 1.875 倍的大标题还是 0.938 的正文，一律按序号塞。
 * 结果就是长段落进了大标题槽（一屏蓝字）、正文进了标题框、图片全堆在末尾——用户说的「乱七八糟」。
 *
 * 这里的办法不猜模板，只用 spec 已经写出来的线索：
 *   - fs：字号相对刊面基准的比值（省略 = 1.0）。1.875 是主标题，0.938 是正文，1.5 的「01」是编号。
 *   - ex：模板自带的示例文案。「01」是编号槽、纯英文是全大写装饰字、几十字长句是正文槽、
 *         十来个字的中文短句是小节标题槽。
 *   - 顺序：spec 里槽的出现顺序就是模板的视觉顺序，图片槽本来就捏在文字之间。
 * 于是「角色对角色」地放：标题→标题槽、小节→小节槽、正文→正文槽、编号→编号槽，图片按图片槽走。
 */
import { BLANK_TEXT } from './template-fill-const.mjs';

const CJK = /[\u3400-\u9fff]/;

/** 文本槽的用途：title / section / body / number / deco（装饰字，留空最好看） */
export function classifySlot(slot) {
  const fs = Number(slot && slot.fs) || 1;
  const ex = String((slot && slot.ex) || '').trim();
  const exLen = ex.length;
  if (!ex) return fs >= 1.25 ? 'title' : fs >= 0.99 ? 'section' : 'body';
  // 「01」「02」这类纯编号槽：可以放我们自己的小节序号
  if (/^[0-9]{1,2}$/.test(ex)) return 'number';
  // 纯数字的年份（2026）是装饰，不放内容
  if (/^[0-9]{3,4}$/.test(ex)) return 'deco';
  // 全大写英文/符号的装饰字（FUTURE TECHNOLOGY / TECHNOLOGICAL INNOVATION）
  if (!CJK.test(ex) && /^[A-Za-z0-9\s&'’\-·.,!?/]+$/.test(ex)) return 'deco';
  if (fs >= 1.25) return 'title';
  if (exLen >= 40) return 'body';
  if (fs >= 1.08) return 'section';
  if (fs >= 0.99) return exLen <= 20 ? 'section' : 'body';
  return 'body';
}

/** 一个单元的「身份」→ 它能去的槽角色（按优先级） */
function rolesFor(kind) {
  switch (kind) {
    case 'title': return ['title', 'section', 'body'];
    case 'subtitle': return ['section', 'title', 'body'];
    case 'number': return ['number'];
    case 'section': return ['section', 'body'];
    case 'signature': return ['body', 'section'];
    default: return ['body', 'section'];
  }
}

/** 表格转成一行行「表头：值」，既不丢字，也能塞进一个正文槽 */
export function tableToLines(rows, header) {
  if (!Array.isArray(rows) || !rows.length) return '';
  const head = Array.isArray(header) ? header : null;
  if (!head || rows.length < 2) return rows.map((r) => r.join(' ')).join('\n');
  // store 读回来的 header 和 rows[0] 是两个不同数组，内容一样但 === 不成立 → 按值比
  const sameHead = (r) => head.every((h, i) => String(h || '').trim() === String(r[i] || '').trim());
  const body = rows.length > 1 && sameHead(rows[0]) ? rows.slice(1) : rows;
  // 只有一行数据、列数不多（获奖名单这类）：转成一列一行的「表头：值」，
  // 比把 5 个格子用全角空格拼成一条长龙好看得多，也不会在窄槽里溢出到画外。
  if (body.length === 1 && head.length <= 6) {
    return head
      .map((h, i) => {
        const v = String(body[0][i] || '').trim();
        if (!v) return '';
        return h ? h + '：' + v : v;
      })
      .filter(Boolean)
      .join('\n');
  }
  return body
    .map((r) => head.map((h, i) => {
      const v = String(r[i] || '').trim();
      if (!v) return '';
      return h ? h + '：' + v : v;
    }).filter(Boolean).join('　'))
    .filter(Boolean)
    .join('\n');
}

/**
 * 稿子 → 有序的单元流。
 * 图片单独成表（带 block 序号），这样图片槽能按「文字走到哪了」来分配。
 */
export function collectUnits(project) {
  const units = [];
  const images = [];
  let localOnly = 0;
  (project.blocks || []).forEach((block, i) => {
    if (block.type === 'image') {
      if (block.remoteUrl) images.push({ order: i, url: block.remoteUrl, caption: block.caption || '', name: block.name || '' });
      else if (block.asset) localOnly += 1;
      return;
    }
    if (block.type === 'kicker') return; // 刊头小标交给模板自己的设计
    if (block.type === 'end') return; // 版尾 END 交给模板自己的版尾
    if (block.type === 'title') { units.push({ order: i, kind: 'title', text: String(block.text || '').trim() }); return; }
    if (block.type === 'subtitle') { units.push({ order: i, kind: 'subtitle', text: String(block.text || '').trim() }); return; }
    if (block.type === 'section') {
      units.push({ order: i, kind: 'section', text: String(block.text || '').trim(), number: block.number || '' });
      return;
    }
    if (block.type === 'table') {
      const text = tableToLines(block.rows, block.header);
      if (text) units.push({ order: i, kind: 'table', text });
      return;
    }
    const text = String(block.text || '').trim();
    if (!text) return;
    if (block.type === 'lead') { units.push({ order: i, kind: 'lead', text }); return; }
    if (block.type === 'list') { units.push({ order: i, kind: 'list', text }); return; }
    if (block.type === 'quote') { units.push({ order: i, kind: 'quote', text }); return; }
    if (block.type === 'signature') { units.push({ order: i, kind: 'signature', text }); return; }
    if (block.type === 'note') { units.push({ order: i, kind: 'note', text }); return; }
    units.push({ order: i, kind: 'paragraph', text });
  });
  return { units: units.filter((u) => u.text), images, localOnly };
}

/** 在 textSlots 里为单元找槽：从 from 往后，按角色优先级找第一个没被占的 */
function findSlot(textSlots, roles, from, used, ok) {
  for (const role of roles) {
    for (let i = from; i < textSlots.length; i += 1) {
      if (used.has(i)) continue;
      if (classifySlot(textSlots[i]) !== role) continue;
      if (ok && !ok(textSlots[i])) continue;
      return i;
    }
  }
  return -1;
}

/**
 * 产出排版方案（纯函数，不碰网络）。
 * @returns {{textRows:Array<{slot:object, text:string, kind:string}>, imageRows:Array<{slot:object, url:string}>, warnings:string[], stats:object}}
 */
export function planLayout({ spec, project, expectUpload = false }) {
  const textSlots = (spec && spec.textSlots) || [];
  const imageSlots = (spec && spec.imageSlots) || [];
  const { units, images, localOnly } = collectUnits(project);
  const warnings = [];

  const roles = textSlots.map((s) => classifySlot(s));
  const used = new Set();
  const rows = [];
  let cursor = 0;
  let overflow = [];

  // 编号槽：有小节序号就按顺序放（「01 领导勉励」的 01）
  const numberSlots = textSlots.map((s, i) => ({ s, i, role: roles[i] })).filter((x) => x.role === 'number');
  const sectionNumbers = units.filter((u) => u.kind === 'section' && u.number).map((u) => u.number);
  if (numberSlots.length && sectionNumbers.length) {
    numberSlots.slice(0, sectionNumbers.length).forEach((x, k) => {
      used.add(x.i);
      rows.push({ slot: x.s, text: sectionNumbers[k], kind: 'number' });
    });
  } else if (numberSlots.length) {
    // 没有小节序号就把编号槽留空，别把正文塞进大数字里
    for (const x of numberSlots) used.add(x.i);
  }

  const ordered = units.slice().sort((a, b) => a.order - b.order);
  for (const u of ordered) {
    let idx = -1;
    if (u.kind === 'title' && u.text.length > 22) {
      // 二十多字的长标题放进 1.875 倍的大标题槽会排成好几行巨字（用户抱怨过的「一屏大字」）。
      // 分层找：① 标题感最正的字号（1.0–1.6 倍）② 同样字号的小节/正文槽 ③ ≤1.6 的任意标题槽
      // ④ ≤1.6 的小节/正文槽 ⑤ 实在没有才用大标题槽，并在下面警告。
      const headline = (s) => { const f = Number(s.fs) || 1; return f >= 0.99 && f <= 1.6; };
      const small = (s) => (Number(s.fs) || 1) <= 1.6;
      idx = findSlot(textSlots, ['title'], cursor, used, headline);
      if (idx < 0) idx = findSlot(textSlots, ['section', 'body'], cursor, used, headline);
      if (idx < 0) idx = findSlot(textSlots, ['title'], cursor, used, small);
      if (idx < 0) idx = findSlot(textSlots, ['section', 'body'], cursor, used, small);
    }
    if (idx < 0) idx = findSlot(textSlots, rolesFor(u.kind), cursor, used);
    if (idx < 0) { overflow.push(u); continue; }
    used.add(idx);
    rows.push({ slot: textSlots[idx], text: u.text, kind: u.kind });
    cursor = idx + 1;
  }
  const titleRow = rows.find((r) => r.kind === 'title');
  if (titleRow && titleRow.text.length > 22 && (Number(titleRow.slot.fs) || 1) > 1.6) {
    warnings.push('标题有 ' + titleRow.text.length + ' 字，落进了「' + titleRow.slot.name + '」这个 ' + titleRow.slot.fs + ' 倍字号的大标题槽，正文区会排成好几行巨字——换一个标题槽小一点的模板，或把长标题拆成主标题 + 副标题');
  }

  // 放不下的：回填到「上一个正文槽」，用换行接上，一个字都不许丢
  if (overflow.length) {
    const tail = rows.filter((r) => r.kind !== 'number');
    const bodyish = tail.length ? tail[tail.length - 1] : null;
    if (bodyish) {
      bodyish.text += '\n' + overflow.map((u) => u.text).join('\n');
      warnings.push('模板的槽位不够（' + units.length + ' 段内容 / ' + textSlots.length + ' 个文字槽），有 ' + overflow.length + ' 段接在了「' + bodyish.slot.name + '」后面');
    } else {
      warnings.push('模板一个可用的文字槽都没有，' + overflow.length + ' 段内容没地方放——换一个模板');
    }
  }

  // 空槽：文字槽给零宽空格（模板占位文案必须清掉），装饰槽本来就是空的
  const filled = new Map(rows.map((r) => [r.slot.name, r]));
  for (let i = 0; i < textSlots.length; i += 1) {
    if (used.has(i)) continue;
    const slot = textSlots[i];
    // 装饰字（全大写英文/年份）和小节标题框都清成零宽空格：模板的占位文案不能留
    filled.set(slot.name, { slot, text: BLANK_TEXT, kind: 'blank' });
  }

  const blankRows = [...filled.values()].filter((r) => r.kind === 'blank');
  const emptyText = blankRows.length;
  if (emptyText > 0 && emptyText >= Math.ceil(textSlots.length * 0.4)) {
    warnings.push('模板有 ' + textSlots.length + ' 个文字槽，你的稿子只填了 ' + (textSlots.length - emptyText) + ' 个：剩下的是空的（模板装饰可能露出空框），想更饱满就换一个槽数接近的模板');
  }
  // 空着的是小节标题框：模板的小节组比稿子多时，成品里会露出没字的标题框（不是排版坏了，是槽对不上）
  // 只有「小节标题」槽空着会露出带边框的空面板；大标题槽空着在成品里是隐形的（真跑截图确认过），不吓人
  const emptyHeading = blankRows.filter((r) => {
    const role = roles[textSlots.indexOf(r.slot)];
    return role === 'section';
  });
  if (emptyHeading.length) {
    warnings.push('模板还有 ' + emptyHeading.length + ' 个空的小节标题框（' + emptyHeading.slice(0, 3).map((r) => r.slot.name).join('、') + '）：模板的小节组比你的稿子多，成品里会露出没字的标题框——换一个槽数接近的模板，或把小节拆细一点');
  }

  // 图片：稿子里有几张就放几张，**一张只用一次**（用户明确要求：不要为了填满模板来回重复用图）。
  // 槽比图多时，把这几张图均匀摊到整篇的图片槽上（保持原顺序），避免全挤在开头；
  // 多出来的槽用「透明细线图」顶掉——既不重复用图，也不会露出模板自带的照片。
  const imageRows = [];
  const blankSlots = [];
  if (!images.length) {
    blankSlots.push(...imageSlots);
  } else if (images.length >= imageSlots.length) {
    images.forEach((img, i) => {
      if (i < imageSlots.length) imageRows.push({ slot: imageSlots[i], url: img.url });
    });
    // 图比槽多：多出来的图没地方放——这是硬约束（提供的图必须全部用上），一定要说出来
    if (images.length > imageSlots.length) {
      warnings.push('图片比模板图片槽多（' + images.length + ' > ' + imageSlots.length + '），有 ' + (images.length - imageSlots.length) + ' 张放不进去——换一个图片槽更多的模板，或把几张图并成一张再传');
    }
  } else {
    // 均匀取槽：第 k 张图落在第 round((k + 0.5) * 槽数 / 图数 - 0.5) 个槽上，序号严格递增
    const picks = [];
    for (let k = 0; k < images.length; k += 1) {
      let idx = Math.round(((k + 0.5) * imageSlots.length) / images.length - 0.5);
      idx = Math.max(0, Math.min(imageSlots.length - 1, idx));
      while (picks.includes(idx)) idx = Math.min(imageSlots.length - 1, idx + 1);
      picks.push(idx);
    }
    picks.sort((a, b) => a - b);
    picks.forEach((slotIdx, k) => imageRows.push({ slot: imageSlots[slotIdx], url: images[k].url }));
    imageSlots.forEach((slot, i) => { if (!picks.includes(i)) blankSlots.push(slot); });
  }
  const blankImageCount = blankSlots.length;
  if (blankImageCount) {
    if (!images.length && expectUpload) {
      // 干跑不传图，所以这里 images 必然是空的；别吓人，说清真跑会怎样
      warnings.push('干跑不传图，所以 ' + imageSlots.length + ' 个图片槽现在是空的；真跑时会先把 ' + localOnly + ' 张本地图传进秀米图床，再灌进这些槽');
    } else if (images.length) {
      warnings.push('模板有 ' + imageSlots.length + ' 个图片槽，稿子里只有 ' + images.length + ' 张图：每张图只用一次，剩下的 ' + blankImageCount + ' 个槽会用透明细线占位（不重复用图，也不留模板自带的照片）');
    } else {
      warnings.push('稿子里一张能显示的图都没有：' + imageSlots.length + ' 个图片槽都会用透明细线占位');
    }
  }

  const stats = {
    units: units.length,
    images: images.length,
    textSlots: textSlots.length,
    imageSlots: imageSlots.length,
    filledText: textSlots.length - emptyText,
    filledImage: imageRows.length,
    blankImage: blankImageCount,
    repeatedImages: 0,
    overflow: overflow.length,
    emptyHeading: emptyHeading.length,
    emptySection: emptyHeading.length,
    localOnly,
    roles: roles.reduce((m, r) => { m[r] = (m[r] || 0) + 1; return m; }, {}),
  };

  return {
    textRows: [...filled.values()].sort((a, b) => textSlots.indexOf(a.slot) - textSlots.indexOf(b.slot)),
    imageRows,
    warnings,
    stats,
  };
}
