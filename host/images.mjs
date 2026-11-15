/**
 * 素材补录：文稿和图片分开发时，图片从哪来、按什么顺序落地。
 *
 * 约束（与工具文案一致）：
 *   1. 只增不删：补进来的图一定会出现在正文里，且按给定顺序；
 *   2. 名字只留 basename，重名自动加 -2/-3，绝不覆盖已有素材；
 *   3. 位置可指定：默认插在结尾「END」之前，给了 after 就紧跟那个块。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.mjs';

export const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

export function isImageName(name) {
  return IMAGE_EXT.indexOf(path.extname(String(name || '')).toLowerCase()) >= 0;
}

/** 文件名里带 10 的排到带 9 的后面：自然的数字序，不是字典序。 */
function naturalCompare(a, b) {
  const ax = String(a).split(/(\d+)/);
  const bx = String(b).split(/(\d+)/);
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    const av = ax[i] === undefined ? '' : ax[i];
    const bv = bx[i] === undefined ? '' : bx[i];
    if (av === bv) continue;
    const an = /^\d+$/.test(av);
    const bn = /^\d+$/.test(bv);
    if (an && bn) return Number(av) - Number(bv);
    return av < bv ? -1 : 1;
  }
  return 0;
}

function walkDir(dir, out, ignored, depth) {
  if (depth > 3) return;
  let rows = [];
  try {
    rows = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  rows.sort((a, b) => naturalCompare(a.name, b.name));
  for (const row of rows) {
    const abs = path.join(dir, row.name);
    if (row.name.startsWith('.')) continue;
    if (row.isDirectory()) walkDir(abs, out, ignored, depth + 1);
    else if (row.isFile()) {
      if (isImageName(row.name)) out.push(abs);
      else ignored.push(row.name);
    }
  }
}

/**
 * 把「用户给的一串路径」展开成待插入的图片清单。
 * 目录会按文件名自然序遍历（图片分开发时最常见的形态：一个文件夹丢过来）。
 */
export function collectImages(inputs, cwd) {
  const files = [];
  const skipped = [];
  const seen = new Set();
  for (const raw of inputs || []) {
    const given = String(raw || '').trim();
    if (!given) continue;
    const abs = path.isAbsolute(given) ? given : path.resolve(cwd || process.cwd(), given);
    let stat = null;
    try {
      stat = fs.statSync(abs);
    } catch {
      skipped.push({ path: given, reason: '找不到这个文件或文件夹' });
      continue;
    }
    if (stat.isDirectory()) {
      const found = [];
      const ignored = [];
      walkDir(abs, found, ignored, 0);
      if (!found.length) skipped.push({ path: given, reason: '文件夹里没有 png / jpg / gif / webp' });
      // 文件夹里混着别的文件很正常，但「iPhone 的 .heic 被静默丢掉」会直接违反"图片必须全用上"，
      // 所以这里必须把不支持的格式报出来。
      if (ignored.length) {
        skipped.push({ path: given, reason: '文件夹里有 ' + ignored.length + ' 个不支持的文件，已跳过：' + ignored.slice(0, 5).join(', ') + (ignored.length > 5 ? ' …' : '') });
      }
      for (const f of found) {
        if (seen.has(f)) continue;
        seen.add(f);
        files.push(f);
      }
      continue;
    }
    if (!isImageName(abs)) {
      skipped.push({ path: given, reason: '不是支持的图片格式（png / jpg / gif / webp）' });
      continue;
    }
    if (seen.has(abs)) continue;
    seen.add(abs);
    files.push(abs);
  }
  return { files, skipped };
}

function safeName(name) {
  return String(name || 'image')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120) || 'image';
}

function uniqueName(name, used) {
  let candidate = safeName(name);
  if (!isImageName(candidate)) candidate += '.png';
  if (!used.has(candidate)) return candidate;
  const ext = path.extname(candidate);
  const stem = candidate.slice(0, candidate.length - ext.length);
  let n = 2;
  while (used.has(stem + '-' + n + ext)) n++;
  return stem + '-' + n + ext;
}

function newBlockId(blocks, extraTaken) {
  const taken = new Set((blocks || []).map((b) => b.id));
  if (extraTaken) for (const id of extraTaken) taken.add(id);
  let n = 0;
  while (true) {
    const id = 'b' + Date.now().toString(36) + (n === 0 ? '' : String(n));
    if (!taken.has(id)) return id;
    n++;
  }
}

function endIndex(blocks) {
  const i = (blocks || []).findIndex((b) => b.type === 'end');
  return i >= 0 ? i : (blocks || []).length;
}

/** 每个小节在块数组里的「收尾位置」：下一节小标题之前（最后一节是 END 之前）。 */
function sectionBounds(blocks) {
  const heads = [];
  (blocks || []).forEach((b, i) => { if (b.type === 'section') heads.push(i); });
  if (!heads.length) return [];
  const stop0 = endIndex(blocks);
  return heads.map((start, s) => ({ start, stop: s + 1 < heads.length ? heads[s + 1] : stop0 }));
}

/**
 * 图片该落在哪：按小节分（默认）还是全塞文末。
 * 返回 [{ at, from, to }]——插入点是块数组下标，按 at 从后往前执行就不会互相挪位。
 *
 * 「按小节分」的规矩（用户 2026-11-15 定）：图跟着文稿顺序走，一张不跳；
 * 图比小节少就铺开，图比小节多就每节摊平、余数给前面的小节。
 */
export function planImagePlacement(blocks, count, placement) {
  const total = Math.max(0, Number(count) || 0);
  if (!total) return [];
  const bounds = sectionBounds(blocks);
  if (placement === 'end' || !bounds.length) {
    return [{ at: endIndex(blocks), from: 0, to: total }];
  }
  const S = bounds.length;
  const buckets = new Array(S).fill(0);
  if (total <= S) {
    for (let i = 0; i < total; i++) {
      const pos = total === 1 ? 0 : Math.round((i * (S - 1)) / (total - 1));
      buckets[pos] += 1;
    }
  } else {
    const baseN = Math.floor(total / S);
    const rem = total % S;
    for (let s = 0; s < S; s++) buckets[s] = baseN + (s < rem ? 1 : 0);
  }
  const out = [];
  let k = 0;
  for (let s = 0; s < S; s++) {
    if (!buckets[s]) continue;
    out.push({ at: bounds[s].stop, from: k, to: k + buckets[s] });
    k += buckets[s];
  }
  return out;
}

/**
 * 把图片写进工程并落成 image 块。
 * items: [{ name, buffer, source? }]
 * opts:  { after?: blockId, captions?: string[], placement?: 'section' | 'end' }
 */
export function insertImages(cwd, projectId, items, opts = {}) {
  const list = (items || []).filter((it) => it && it.buffer && it.buffer.length);
  if (!list.length) throw new Error('没有可以插入的图片');
  const existing = store.readProject(cwd, projectId);
  if (!existing) throw new Error('找不到工程：' + projectId);

  const used = new Set((existing.assets || []).map((a) => a.name));
  const prepared = [];
  for (const it of list) {
    const name = uniqueName(it.name, used);
    used.add(name);
    prepared.push({ name, buffer: it.buffer, source: it.source || '', bytes: it.buffer.length });
  }

  const captions = Array.isArray(opts.captions) ? opts.captions : [];
  const anchor = String(opts.after || '');
  const placement = opts.placement === 'end' ? 'end' : 'section';
  // 先验锚点再落盘：否则 updateProject 抛错会留下没人引用的孤儿素材文件
  if (anchor && !(existing.blocks || []).some((b) => b.id === anchor)) {
    throw new Error('没有这个块：' + anchor);
  }

  const saved = [];
  let updated;
  try {
    for (const p of prepared) {
      store.saveAsset(cwd, projectId, p.name, p.buffer, 'image');
      saved.push(p.name);
    }
    updated = store.updateProject(cwd, projectId, (p) => {
    p.assets = (p.assets || []).concat(
      prepared.map((x) => ({ id: 'a' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), name: x.name, bytes: x.bytes, kind: 'image' }))
    );
    // 一次插多张时 newBlockId 看到的是同一份旧 blocks，得自己把新 id 记下来
    const freshIds = new Set();
    const makeRow = (x, caption) => {
      const id = newBlockId(p.blocks, freshIds);
      freshIds.add(id);
      return { id, type: 'image', asset: x.name, text: '', caption: caption ? String(caption) : '' };
    };

    if (anchor) {
      const i = p.blocks.findIndex((b) => b.id === anchor);
      if (i < 0) throw new Error('没有这个块：' + anchor);
      const rows = prepared.map((x, k) => makeRow(x, captions[k]));
      p.blocks.splice.apply(p.blocks, [i + 1, 0].concat(rows));
      return p;
    }

    const plan = planImagePlacement(p.blocks, prepared.length, placement);
    // 从后往前插，前面算好的下标才不会因为后面插入而失效
    plan.slice().sort((a, b) => b.at - a.at).forEach((slot) => {
      const rows = prepared.slice(slot.from, slot.to).map((x, k) => makeRow(x, captions[slot.from + k]));
      p.blocks.splice.apply(p.blocks, [slot.at, 0].concat(rows));
    });
    return p;
    });
  } catch (error) {
    // 落盘成功但写工程失败时把刚存的图删掉，别留孤儿素材
    for (const name of saved) {
      try { fs.unlinkSync(store.assetPath(cwd, projectId, name)); } catch { /* 删不掉也别盖住原错误 */ }
    }
    throw error;
  }

  return {
    project: updated,
    added: prepared.map((x, i) => ({ name: x.name, bytes: x.bytes, blockId: updated.blocks.find((b) => b.asset === x.name) ? updated.blocks.find((b) => b.asset === x.name).id : '', source: x.source })),
  };
}

/**
 * 把正文里已有的图片块按小标题重新分（顺序不变）。
 * 用于「图都挤在文末」的旧稿：不新增素材、不改文件，只挪块。
 */
export function distributeImages(cwd, projectId) {
  const project = store.readProject(cwd, projectId);
  if (!project) throw new Error('找不到工程：' + projectId);
  let moved = 0;
  const updated = store.updateProject(cwd, projectId, (p) => {
    const imgs = (p.blocks || []).filter((b) => b.type === 'image');
    if (!imgs.length) return p;
    p.blocks = (p.blocks || []).filter((b) => b.type !== 'image');
    const plan = planImagePlacement(p.blocks, imgs.length, 'section');
    plan.slice().sort((a, b) => b.at - a.at).forEach((slot) => {
      const rows = imgs.slice(slot.from, slot.to);
      p.blocks.splice.apply(p.blocks, [slot.at, 0].concat(rows));
    });
    moved = imgs.length;
    return p;
  });
  return { project: updated, moved };
}

/** 浏览器拖拽/选择上传走的是 data URL（也接受裸 base64）。 */
export function bufferFromUpload(payload, name) {
  const raw = String(payload || '');
  if (!raw) throw new Error('图片内容为空：' + name);
  const comma = raw.indexOf(',');
  let b64 = raw.indexOf('data:') === 0 && comma > 0 ? raw.slice(comma + 1) : raw;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw new Error('不是合法的 base64 图片：' + name);
  const buf = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
  if (!buf.length) throw new Error('图片内容为空：' + name);
  return buf;
}
