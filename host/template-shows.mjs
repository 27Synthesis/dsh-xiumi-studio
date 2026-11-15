/**
 * 「我的图文里哪些是可以拿来套的模板」+ 复制 + 套用。
 *
 * 秀米不给「列出模板」的接口：模板只是别人账号里的作品，MCP 的 copy_show 只认自己的作品
 * （对外部 show_id 实测返回 Common:Failed_DataNotMatch）。所以能拿来套的模板 = 自己账号里
 * 那些「使用模板」另存下来的作品。这里负责把它们找出来、认清形状、复制一份新的再灌内容。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as mcp from './mcp.mjs';
import * as store from './store.mjs';
import { parseSpec, planFill, applyFill, fetchSpec, blankImageUrl, cachedBlankImageUrl } from './template-fill.mjs';
import { classifySlot, planLayout } from './layout.mjs';
import { uploadProjectAssets } from './xiumi.mjs';

/** 判据：图片槽多、文字槽多，且标题里常带「模板/拷贝/｜分类｜」这类痕迹 */
export const TEMPLATE_MIN_IMAGE_SLOTS = 12;
export const TEMPLATE_MIN_TEXT_SLOTS = 8;

function cacheFile(cwd) {
  return path.join(cwd, '.dsh-xiumi', 'template-specs.json');
}

function readCache(cwd) {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(cwd), 'utf8'));
  } catch {
    return { version: 1, items: {} };
  }
}

function writeCache(cwd, data) {
  const file = cacheFile(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 1));
}

/** 列出账号里的作品（分页拉全） */
export async function listShows(opts = {}) {
  // get_shows 的 limit 上限是 20（传 50 会被 MCP 以 Input validation error 拒掉）
  const limit = Math.min(20, Math.max(1, Number(opts.limit || 20)));
  const out = [];
  for (let offset = 0; offset < 500; offset += limit) {
    const res = await mcp.callTool('get_shows', { offset, limit, sort_by: 'saved' }, { timeoutMs: 60000 });
    const text = (res.content || []).map((c) => c.text || '').join('\n');
    const first = text.slice(text.indexOf('{'));
    let payload = null;
    try {
      payload = JSON.parse(first.slice(0, first.lastIndexOf('}') + 1));
    } catch {
      payload = null;
    }
    const shows = (payload && payload.shows) || [];
    out.push(...shows);
    if (shows.length < limit) break;
  }
  return out;
}

/**
 * 给账号里的作品逐个读 spec，判它是不是模板，并把形状记进缓存。
 * @returns {Promise<Array<{showId,title,cover,editUrl,showUrl,savedAt,released,textSlots,imageSlots,isTemplate,summary}>>}
 */
export async function inspectAccountShows(cwd, opts = {}) {
  const shows = await listShows(opts);
  const cache = readCache(cwd);
  const fresh = Number(opts.refreshAfterMs || 24 * 60 * 60 * 1000);
  const now = Date.now();
  const out = [];

  for (const show of shows) {
    const id = String(show.show_id);
    const hit = cache.items[id];
    let specText = null;
    if (hit && now - hit.at < fresh && !opts.refresh) {
      specText = hit.spec;
    } else {
      try {
        specText = await fetchSpec(show.show_id);
        cache.items[id] = { at: now, spec: specText };
      } catch (error) {
        specText = null;
      }
    }
    const spec = specText ? parseSpec(specText) : null;
    const textSlots = spec ? spec.textSlots.length : 0;
    const imageSlots = spec ? spec.imageSlots.length : 0;
    // 超大标题槽（fs≥1.45）：长段落进去会显示成一屏大字。挑模板时要看得见，不能挑完才警告
    const bigTextSlots = spec ? spec.textSlots.filter((s) => Number(s.fs) >= 1.45).length : 0;
    // 槽位的角色形状：模板有几个大标题槽 / 小节标题槽 / 正文槽。挑模板时结构要对得上稿子，
    // 否则正文只能挤进标题槽（用户抱怨的「长段落塞进标题页」就是这么来的）。
    const roleCounts = { title: 0, section: 0, body: 0, number: 0, deco: 0 };
    if (spec) {
      for (const s of spec.textSlots) {
        const role = classifySlot(s);
        roleCounts[role] = (roleCounts[role] || 0) + 1;
      }
    }
    // 我们自己的成品（套过模板的那篇）槽位形状和模板一模一样：先认标题，再认正文——
    // 套过模板的作品，槽里就是本地工程的原文，逐段比对能认出来（标题被改过也能认）
    const matched = specText ? matchProject(cwd, show.title) || matchProjectByText(cwd, spec) : null;
    const isTemplate =
      Boolean(spec) &&
      imageSlots >= TEMPLATE_MIN_IMAGE_SLOTS &&
      textSlots >= TEMPLATE_MIN_TEXT_SLOTS &&
      !matched;
    out.push({
      likelyFilled: Boolean(matched),
      projectId: matched ? matched.id : null,
      showId: show.show_id,
      title: show.title,
      cover: show.cover,
      editUrl: show.edit_url,
      showUrl: show.show_url,
      savedAt: show.saved_at,
      released: Boolean(show.release_at),
      textSlots,
      imageSlots,
      bigTextSlots,
      roleCounts,
      // 打分要真的排一遍才知道「几段被并进最后一个槽」「几个标题框会空着」——解析结果挂在这里，rankTemplates 用
      _spec: spec,
      isTemplate,
      summary: spec ? spec.summary : '',
    });
  }
  writeCache(cwd, cache);
  return out;
}

/** 这篇是不是我们自己的成品（标题能对上某个工程） */
function matchProject(cwd, title) {
  if (!title) return null;
  const norm = (s) => String(s || '').replace(/\s+/g, '').slice(0, 18);
  const key = norm(title);
  if (key.length < 6) return null;
  let projects = [];
  try {
    projects = store.listProjects(cwd) || [];
  } catch {
    return null;
  }
  for (const p of projects) {
    const t = norm(p.title);
    if (t && key.startsWith(t.slice(0, 12))) return p;
  }
  return null;
}

/**
 * 正文认亲：这篇的槽里是不是灌着本地某个工程的原文。
 * 套过模板的成品，槽位形状和模板完全一样，光看形状分不出来；但槽里的字是本地文稿的原文。
 */
function matchProjectByText(cwd, spec) {
  if (!spec || !spec.textSlots || !spec.textSlots.length) return null;
  let projects = [];
  try {
    projects = store.listProjects(cwd) || [];
  } catch {
    return null;
  }
  const norm = (s) => String(s || '').replace(/\s+/g, '');
  const samples = spec.textSlots
    .map((s) => norm(s.ex))
    .filter((t) => t.length >= 14)
    .slice(0, 40);
  if (samples.length < 2) return null;
  for (const item of projects) {
    let project = null;
    try {
      project = store.readProject(cwd, item.id);
    } catch {
      continue;
    }
    const body = norm((project.blocks || []).map((b) => b.text || '').join(''));
    if (body.length < 60) continue;
    let hits = 0;
    for (const t of samples) if (body.includes(t)) hits += 1;
    if (hits >= 2) return project;
  }
  return null;
}

/** 秀米 copy_show 的 title_postfix 上限是 8 个字，超了整次复制都会 400，所以入口统一裁 */
export function clampPostfix(titlePostfix) {
  const s = String(titlePostfix == null || titlePostfix === '' ? '·新作品' : titlePostfix).trim();
  return Array.from(s).slice(0, 8).join('') || '·新作品';
}

/** 复制一篇作品，得到可随意改的新作品 */
export async function copyAsNew(showId, titlePostfix) {
  const res = await mcp.callTool(
    'copy_show',
    { show_id: Number(showId), title_postfix: clampPostfix(titlePostfix) },
    { timeoutMs: 120000 }
  );
  const text = (res.content || []).map((c) => c.text || '').join('\n');
  const payload = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let parsed = null;
  try {
    parsed = JSON.parse(payload);
  } catch {
    parsed = null;
  }
  const newShow = (parsed && (parsed.show || parsed)) || {};
  const newId = newShow.show_id || newShow.showId || null;
  return { text, showId: newId, show: newShow };
}

/** 本插件在这个工作目录里复制出来的副本：showId → {projectId, templateShowId, at}（重启后仍然认得出） */
function copiesFile(cwd) {
  return path.join(cwd, '.dsh-xiumi', 'template-copies.json');
}
export function readCopies(cwd) {
  try {
    return JSON.parse(fs.readFileSync(copiesFile(cwd), 'utf8')) || {};
  } catch {
    return {};
  }
}
export function registerCopy(cwd, info) {
  const file = copiesFile(cwd);
  const all = readCopies(cwd);
  all[String(info.showId)] = { ...info, at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
  return all[String(info.showId)];
}

/**
 * 归属校验（审查 C5）：只允许改「本插件刚复制出来、还没发布」的那一篇。
 * 秀米的 update_show_from_plan 只要拿到 show_id 就能改任何作品，不校验就能覆盖别人/已发布的稿子。
 */
export async function assertFillTarget(cwd, showId, project) {
  const id = String(showId);
  const copies = readCopies(cwd);
  const entry = copies[id];
  if (!entry) {
    throw new Error('作品 ' + id + ' 不是本插件复制出来的副本，不能直接灌内容：请先用「套模板」新建一篇（只会改自动生成的副本）');
  }
  if (project && entry.projectId && entry.projectId !== project.id) {
    throw new Error('作品 ' + id + ' 属于另一个工程（' + entry.projectId + '），不能灌「' + project.title + '」的内容');
  }
  try {
    const shows = await listShows({ limit: 20 });
    const hit = shows.find((s) => String(s.show_id) === id);
    if (hit && hit.release_at) throw new Error('作品 ' + id + ' 已经发布（' + hit.release_at + '），插件不会改已发布的稿子；请新建副本再改');
  } catch (error) {
    if (/已经发布/.test(error.message)) throw error;
    // 列表拿不到（网络/token）时以副本登记为准，不因读不到列表就拒绝干活
  }
  return entry;
}

/** 把复制出来但没用上的副本删进回收站；返回秀米回的 deleted_show_id 或 null */
async function discardCopy(_cwd, showId) {
  try {
    const res = await mcp.callTool('delete_show', { show_id: Number(showId), confirm: true }, { timeoutMs: 60000 });
    const text = (res.content || []).map((c) => c.text || '').join('\n');
    const hit = /"deleted_show_id"\s*:\s*(\d+)/.exec(text);
    return hit ? hit[1] : 'ok';
  } catch (error) {
    return null;
  }
}

/**
 * 一步到位：复制模板 → 灌内容（可选先干跑）。
 * @returns {Promise<{showId, dryRun, text, warnings, report}>}
 */
export async function fillTemplate({ project, cwd, templateShowId, dryRun = true, titlePostfix, blankUnused = true, readAsset }) {
  // 干跑绝不许有副作用：不复制、不上传新图、不新建透明图（审查 C1/C4）。只有本进程已经传过的透明图才拿来用。
  const blank = blankUnused ? (dryRun ? cachedBlankImageUrl() : await blankImageUrl()) : '';
  // 干跑不能复制：copy_show 一调，账号里就多一篇垃圾稿。干跑直接对着模板本身的 spec 预检。
  if (dryRun) {
    const spec = parseSpec(await fetchSpec(templateShowId));
    const plan = planFill({ spec, project, blankImageUrl: blank, expectUpload: true });
    const result = await applyFill(templateShowId, plan, { dryRun: true });
    return {
      showId: null,
      dryRun: true,
      editUrl: null,
      ok: result.ok,
      text: result.text,
      warnings: plan.warnings,
      bindings: plan.bindings.length,
      report: {
        templateShowId,
        textSlots: spec.textSlots.length,
        imageSlots: spec.imageSlots.length,
        boundText: plan.material.content_items.filter((i) => i.type === 'text').length,
        boundImage: plan.material.content_items.filter((i) => i.type === 'image').length,
      },
    };
  }
  // 真跑：先把本地图传进秀米图床（否则模板的图片槽只会被透明占位图顶掉——审查 C1 的根因）
  const upload = { uploaded: [], skipped: [], failed: [] };
  if (typeof readAsset === 'function') {
    const up = await uploadProjectAssets(project, { readAsset });
    upload.uploaded = up.uploaded;
    upload.skipped = up.skipped;
    upload.failed = up.failed;
  }
  const copy = await copyAsNew(templateShowId, titlePostfix);
  if (!copy.showId) throw new Error('复制模板没有拿到新作品 id：' + copy.text.slice(0, 200));
  registerCopy(cwd || project.cwd || '', { showId: copy.showId, projectId: project.id, templateShowId, title: copy.show && copy.show.title });
  const spec = parseSpec(await fetchSpec(copy.showId));
  const plan = planFill({ spec, project, blankImageUrl: blank });
  if (upload.failed.length) {
    plan.warnings.unshift(
      '有 ' + upload.failed.length + ' 张图没传进秀米图床（' + upload.failed.map((f) => f.name + '：' + f.error).join('；') + '）'
    );
  }
  let result;
  try {
    result = await applyFill(copy.showId, plan, { dryRun: false });
  } catch (error) {
    await discardCopy(cwd, copy.showId);
    throw error;
  }
  // 灌失败就把复制出来的空稿删掉（审查 C4）：否则账号里会堆一篇篇跟正文无关的垃圾稿
  let cleaned = null;
  if (!result.ok) {
    cleaned = await discardCopy(cwd, copy.showId);
    plan.warnings.push('灌内容没成功，已把复制出来的那篇空稿删进回收站（' + (cleaned || '删除未确认') + '）');
  }
  return {
    cleanedShowId: cleaned,
    uploaded: upload.uploaded.length,
    failedUploads: upload.failed,
    showId: cleaned ? null : copy.showId,
    dryRun,
    // 前端别自己拼地址：编辑页地址从这里来，秀米换版本时只改一处
    editUrl: cleaned ? null : 'https://xiumi.us/studio/v5#/paper/for/' + copy.showId,
    title: (copy.show && (copy.show.title || copy.show.work_title)) || null,
    ok: result.ok,
    text: result.text,
    warnings: plan.warnings,
    bindings: plan.bindings.length,
    report: {
      templateShowId,
      showId: copy.showId,
      textSlots: spec.textSlots.length,
      imageSlots: spec.imageSlots.length,
      boundText: plan.material.content_items.filter((i) => i.type === 'text').length,
      boundImage: plan.material.content_items.filter((i) => i.type === 'image').length,
    },
  };
}
/** 中文里对「题材」有用的词：命中越多，模板越贴题 */
const TOPIC_LEXICON = [
  '会议', '大会', '部署', '总结', '报告', '换届', '选举', '任命', '表彰', '喜报', '获奖', '竞赛', '大赛',
  '讲座', '论坛', '研讨', '培训', '教研', '学术', '课题',
  '党建', '党支部', '团日', '团学', '思政', '红色', '志愿', '实践', '支教', '三下乡',
  '招新', '社团', '文艺', '晚会', '音乐会', '演出', '比赛', '运动', '体育', '草坪',
  '通知', '公告', '公示', '招聘', '报名', '招生',
  '散文', '诗歌', '随笔', '旅行', '游记', '假期', '节日', '新年', '春天', '秋天', '夏天', '冬天',
  '商务', '科技', '创新', '企业', '蓝色', '简约', '杂志', '文艺', '设计', '高级',
];

function topics(text) {
  const s = String(text || '');
  return TOPIC_LEXICON.filter((w) => s.includes(w));
}

/** 项目的题材词：标题 + 各小节标题 + 主题名 */
export function projectTopics(project) {
  const parts = [project.title || ''];
  for (const b of project.blocks || []) {
    if (b.type === 'section' || b.type === 'kicker' || b.type === 'lead') parts.push(b.text || '');
  }
  return [...new Set(topics(parts.join(' ')))];
}

/**
 * 给一篇稿子挑模板，并说清为什么。
 * 打分：题材命中 ×3 + 槽位够用 + 图片槽贴合度 - 槽位不足的硬伤
 * @returns {{picked: object|null, ranked: Array}}
 */
export function rankTemplates({ project, items, needText, needImage }) {
  const want = projectTopics(project);
  const nText = needText || countTextUnits(project);
  const nImage = needImage || countImages(project);
  const need = structureNeed(project);
  const ranked = [];

  for (const item of items) {
    if (!item || !item.isTemplate) continue;
    // 已经灌过内容的成品（本地工程的原文就在槽里）不能当模板再套一遍
    if (item.likelyFilled) continue;
    const tplTopics = topics(item.title);
    const hit = tplTopics.filter((w) => want.includes(w));
    let score = hit.length * 3;
    const reasons = [];
    if (hit.length) reasons.push('题材对得上：' + hit.slice(0, 4).join('、'));
    else if (want.length && String(item.title || '').trim()) {
      // 题材完全不沾边的模板（比如给喜报配一个旅行模板），结构再合适也难看
      score -= 2;
      reasons.push('题材对不上（模板标题里没有「' + want.slice(0, 3).join('」「') + '」这类词）');
    }
    // 标题和这篇几乎一样 = 同一篇的成品（自己或插件之前跑的那版），不能当模板再套一遍
    if (nearSameTitle(project.title, item.title)) {
      score -= 10;
      reasons.push('这篇的标题和你要做的几乎一样，多半是同一篇的成品，不适合当模板');
    }

    const textOk = item.textSlots >= nText;
    const imageOk = item.imageSlots >= nImage;
    if (textOk && imageOk) {
      score += 2;
      reasons.push('槽位够用（文字 ' + item.textSlots + '≥' + nText + '，图片 ' + item.imageSlots + '≥' + nImage + '）');
    } else {
      score -= 6;
      reasons.push(
        '槽位偏少（' + (textOk ? '' : '文字 ' + item.textSlots + '<' + nText + ' ') + (imageOk ? '' : '图片 ' + item.imageSlots + '<' + nImage) + '）'
      );
    }
    // 槽位大量富余说明模板是「大版面」的，给同样内容会显得空；小幅富余最舒服
    const slack = (item.textSlots - nText) + (item.imageSlots - nImage);
    if (slack >= 0 && slack <= 40) score += 1;
    if (slack > 120) score -= 1;
    // 结构匹配：正文段要落进「正文槽」，小节标题要落进「小节标题槽」。
    // 槽位总数够、但角色不对的模板，一样会把长段塞进标题框——所以单看总数不够。
    const role = item.roleCounts;
    if (role && typeof role === 'object') {
      const bodySlots = Number(role.body || 0);
      const sectionSlots = Number(role.section || 0);
      const titleSlots = Number(role.title || 0);
      if (bodySlots >= need.body) {
        score += 2;
        reasons.push('正文槽够放（正文 ' + bodySlots + ' ≥ ' + need.body + ' 段）');
      } else {
        const shortOf = need.body - bodySlots;
        score -= Math.min(8, shortOf);
        reasons.push('正文槽不够（正文 ' + bodySlots + ' < ' + need.body + ' 段）：多出来的 ' + shortOf + ' 段只能接在最后一个正文槽里');
      }
      if (need.sections > 0 && sectionSlots === 0) {
        score -= 3;
        reasons.push('模板没有小节标题槽，小节标题只能挤进正文槽');
      } else if (need.sections > 0 && sectionSlots >= need.sections) {
        score += 1;
        reasons.push('小节标题槽够用（' + sectionSlots + ' ≥ ' + need.sections + '）');
      }
      // 多出来的小节标题槽会在成品里露成「没字的带边框空面板」（真跑截图确认过），比槽位不够还难看
      const surplusSec = need.sections > 0 ? Math.max(0, sectionSlots - need.sections) : 0;
      if (surplusSec > 0) {
        reasons.push('模板的小节标题槽多出 ' + surplusSec + ' 个（' + sectionSlots + ' > ' + need.sections + '）：成品里会露出 ' + surplusSec + ' 个没字的标题框');
      }
      if (titleSlots === 0) {
        score -= 2;
        reasons.push('模板没有大标题槽，标题只能放进小节或正文槽');
      }
    }
    // 真排一遍：只有排一次才知道「几段被并进最后一个正文槽」「几个标题框会露空」「几张图没处放」。
    // 槽位总数对得上、真排起来却塞不下的模板，就是用户说的「长段生硬插入」来源。
    if (item._spec && project) {
      try {
        const plan = planLayout({ spec: item._spec, project, expectUpload: true });
        const st = plan.stats || {};
        const overflow = Number(st.overflow || 0);
        if (overflow > 0) {
          score -= Math.min(8, overflow * 2);
          reasons.push('真排一遍：有 ' + overflow + ' 段内容塞不下，会被并进最后一个正文槽');
        }
        // 空着的小节标题槽在成品里是「带边框的空面板」，最难看的就这个 → 扣分最重（上限 10 分）
        const emptyHeading = Number(st.emptyHeading || 0);
        if (emptyHeading > 0) {
          score -= Math.min(10, emptyHeading * 2);
          reasons.push('真排一遍：会留下 ' + emptyHeading + ' 个没字的标题框（成品里是空面板）');
        }
        const blankImage = Number(st.blankImage || 0);
        if (blankImage > 0) {
          score -= Math.min(6, blankImage);
          reasons.push('真排一遍：' + blankImage + ' 个图片槽没有对应的照片，会用透明细线顶掉（不重复用图）');
        }
      } catch (error) {
        reasons.push('真排一遍失败，跳过细算（' + String(error.message || error).slice(0, 60) + '）');
      }
    }
    // 超大标题槽是排版陷阱：正文段落按顺序落进去就会被放大成标题（C7 的警告来得太晚，这里先扣分）
    const big = Number(item.bigTextSlots || 0);
    if (big > 0) {
      score -= Math.min(4, big);
      reasons.push('有 ' + big + ' 个超大标题槽（字号 ≥1.45），长段落会被放大成大字');
    }
    if (item.released) score -= 1; // 已发布的多半是成品，不是给人套的模板

    ranked.push({ ...item, score, hit, reasons, enough: textOk && imageOk });
  }
  ranked.sort((a, b) => b.score - a.score || b.imageSlots - a.imageSlots);
  return { picked: ranked[0] || null, ranked, want, needText: nText, needImage: nImage, need };
}

/** 标题归一化后前 12 个字相同 = 同一个稿子（标题里常带「喜报！」这类前缀，拼音/空格的差别也去掉） */
function nearSameTitle(a, b) {
  const norm = (s) => String(s || '').replace(/[\s\u3000·・|｜—\-–!！?？,，.。:：;；"'“”‘’()（）【】\[\]]/g, '');
  const x = norm(a);
  const y = norm(b);
  if (x.length < 10 || y.length < 10) return false;
  return x.slice(0, 12) === y.slice(0, 12);
}

/** 稿子需要的结构形状：几个小节标题、几段正文（正文类的都算） */
export function structureNeed(project) {
  let sections = 0;
  let body = 0;
  for (const b of project.blocks || []) {
    if (b.type === 'section') sections += 1;
    else if (['lead', 'paragraph', 'quote', 'list', 'signature', 'note', 'table'].includes(b.type)) body += 1;
  }
  return { sections, body };
}

function countTextUnits(project) {
  let n = 0;
  for (const b of project.blocks || []) {
    if (['kicker', 'section', 'lead', 'paragraph', 'quote'].includes(b.type)) n += 1;
  }
  return n;
}

function countImages(project) {
  return (project.blocks || []).filter((b) => b.type === 'image').length;
}
