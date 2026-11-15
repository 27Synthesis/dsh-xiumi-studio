/**
 * 模型侧工具。工具文案本身就是工作纪律：
 *   - 先 open 看现场，再改；改完回到面板让人看见
 *   - 文稿一个字都不删改：只能调块结构、顺序、图片说明
 *   - 素材必须全部用上：导入时就把 docx 里的图逐张落到 blocks
 */
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.mjs';
import { parseDocxBuffer, buildDraft } from './docx.mjs';
import { makeCover } from './cover.mjs';
import { renderPage, renderFragment, renderStandalone, countStats } from './render.mjs';
import { THEMES, getTheme, pickThemeFor } from './themes.mjs';
import { describeRemote, publishProject, preflightPublish, uploadProjectAssets } from './xiumi.mjs';
import { collectImages, insertImages, distributeImages } from './images.mjs';
import * as templates from './templates.mjs';
import * as templateShows from './template-shows.mjs';
import * as templateFill from './template-fill.mjs';
import * as presence from './presence.mjs';

const OUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { text: { type: 'string' }, isError: { type: 'boolean' } },
  required: ['text'],
};

const renderText = (_args, value) => [{ type: 'text', text: String(value.text || '') }];
const ok = (text) => ({ text, isError: false });
const bad = (text) => ({ text, isError: true });
/** 事件/回执里记 diff 用：压掉换行，截断到 n 个字符 */
const clip = (text, n) => {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
};

function sessionOf(deps, exec) {
  const sessionId = exec && exec.agent && exec.agent.session ? exec.agent.session.id : null;
  if (!sessionId) throw new Error('拿不到调用方会话');
  const cwd = deps.resolveCwd(sessionId);
  if (!cwd) throw new Error('这个会话没有工作目录');
  return { sessionId, cwd };
}

function currentProject(cwd, sessionId, args) {
  const id = (args && args.project_id) || store.activeProjectId(cwd, sessionId);
  if (!id) throw new Error('还没有图文工程：先用 xiumi_import_docx 从 Word 建一篇');
  const project = store.readProject(cwd, id);
  if (!project) throw new Error('工程不存在：' + id);
  return project;
}

function outlineText(project) {
  const lines = (project.blocks || []).map((b, i) => {
    const idx = String(i + 1).padStart(2, '0');
    if (b.type === 'image') return '  ' + idx + ' [图] ' + b.asset + (b.caption ? ' · ' + b.caption : '');
    const num = b.number ? b.number + ' ' : '';
    return '  ' + idx + ' [' + b.type + '] ' + num + String(b.text || '').slice(0, 42);
  });
  return lines.join('\n');
}

/** 导入 Word：解析 → 建工程 → 落素材 → 生成封面。导出给测试与脚本复用。 */
export async function importDocx(deps, exec, args) {
  const { sessionId, cwd } = sessionOf(deps, exec);
  const file = String(args.path || '');
  if (!file) throw new Error('需要 path（.docx 文件路径）');
  const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
  if (!fs.existsSync(abs)) throw new Error('找不到这个文件：' + abs);
  const buf = fs.readFileSync(abs);
  const parsed = parseDocxBuffer(buf);
  const draft = buildDraft(parsed, { kicker: args.kicker || '' });

  const theme = args.theme && THEMES.some((t) => t.id === args.theme) ? args.theme : pickThemeFor(draft.title + ' ' + (draft.subtitle || ''));

  // 素材落盘：文件名沿用 docx 里的 media 名，重名加序号
  const nameById = new Map();
  const assets = [];
  const used = new Set();
  for (const a of draft.assets) {
    let name = path.basename(a.file);
    let n = 1;
    while (used.has(name)) {
      const dot = name.lastIndexOf('.');
      name = (dot > 0 ? name.slice(0, dot) : name) + '-' + n++ + a.ext;
    }
    used.add(name);
    nameById.set(a.id, name);
    assets.push({ id: a.id, name, bytes: a.data.length, kind: 'image' });
  }

  const blocks = draft.blocks.map((b) => (b.type === 'image' ? { ...b, asset: nameById.get(b.asset) || b.asset } : b));
  if (!blocks.some((b) => b.type === 'end')) blocks.push({ id: 'b' + (blocks.length + 1), type: 'end', text: 'END' });

  const project = store.createProject(cwd, {
    title: draft.title,
    subtitle: draft.subtitle,
    kicker: args.kicker || '',
    date: args.date || '',
    theme,
    blocks,
    assets,
    source: { file: abs, media: parsed.media.size, paragraphs: parsed.paragraphs.filter((p) => p.text).length },
  });

  for (const a of draft.assets) {
    store.saveAsset(cwd, project.id, nameById.get(a.id), a.data, 'image');
  }
  store.setActive(cwd, sessionId, project.id);
  store.addEvent(cwd, project.id, 'import', '从 Word 拆出 ' + assets.length + ' 张图 · ' + blocks.length + ' 个块');
  // 建好就把面板推到人眼前——他应该"直接看到成品"，而不是回来问面板在哪。
  presence.requestOpen(cwd, 'import');

  // 封面顺手画好：人一打开面板就该看到成品感，而不是"还没有封面"。
  // 画失败不阻断导入（缺 Python 是环境问题，不是材料问题），但要把原因带回给模型。
  let coverError = null;
  try {
    await makeCover({ project, dir: store.projectDir(cwd, project.id), log: deps.log });
    store.updateProject(cwd, project.id, (p) => {
      p.cover = { cover: 'cover.png', square: 'square.png', at: new Date().toISOString() };
      return p;
    });
    store.addEvent(cwd, project.id, 'cover', '按「' + getTheme(theme).name + '」生成封面');
  } catch (error) {
    coverError = (error && error.message) || String(error);
    deps.log('[xiumi] 封面生成失败：' + coverError);
  }

  return { project: store.readProject(cwd, project.id), cwd, sessionId, assets, parsed, abs, coverError };
}

function toolDefs(deps) {
  return [
    {
      name: 'xiumi_open',
      description: '打开「秀米工作台」：返回当前工程、工程列表、面板地址，以及这篇图文的完整块清单。开始任何排版工作前先调它看现场。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { project_id: { type: 'string', description: '可选：指定工程 id，默认取当前活跃工程' } },
      },
      execute: (_args, exec) => {
        const { sessionId, cwd } = sessionOf(deps, exec);
        presence.requestOpen(cwd, 'open');
        const id = store.activeProjectId(cwd, sessionId);
        const project = id ? store.readProject(cwd, id) : null;
        const lines = [];
        lines.push('秀米工作台：' + deps.studioUrl(sessionId));
        lines.push('工作目录：' + cwd);
        if (!project) {
          lines.push('当前还没有图文工程。把 Word 路径给我，我用 xiumi_import_docx 建一篇。');
          const recent = store.listProjects(cwd);
          if (recent.length) lines.push('历史工程：\n' + recent.map((p) => '  ' + p.id + ' ' + p.title + '（' + p.status + '）').join('\n'));
          return ok(lines.join('\n'));
        }
        const stats = countStats(project);
        lines.push('工程：' + project.id + ' · ' + project.title);
        lines.push('主题：' + getTheme(project.theme).name + '（' + project.theme + '）  块：' + stats.blocks + '  图：' + stats.images + '  字：' + stats.chars);
        if (project.subtitle) lines.push('副题：' + project.subtitle);
        lines.push('封面：' + (project.cover ? '已生成' : '未生成'));
        lines.push('块清单：\n' + outlineText(project));
        return ok(lines.join('\n'));
      },
    },
    {
      name: 'xiumi_import_docx',
      description: '把一篇 Word（.docx）导入成排版工程：解析段落与内嵌图片，按「标题/导语/小标题/正文」拆块，图片按原文顺序落位，并自动按主题选配色与生成封面。文稿文字不做任何删改，图片全部保留。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'docx 绝对路径（或相对工作目录）' },
          theme: { type: 'string', description: '可选：zhusha / qingci / molan / yingfen / subai，不传则按标题自动挑' },
          kicker: { type: 'string', description: '可选：标题上方的小标眉（如「校园讲座」）；不确定就留空，不要编造' },
          date: { type: 'string', description: '可选：封面日期行，如 2026.11.02' },
        },
      },
      execute: async (args, exec) => {
        const result = await importDocx(deps, exec, args);
        const { project } = result;
        const stats = countStats(project);
        const lines = [
          '已建工程：' + project.id,
          '标题：' + project.title,
          project.subtitle ? '副题：' + project.subtitle : '',
          '主题：' + getTheme(project.theme).name + '（自动匹配，可换）',
          '块 ' + stats.blocks + ' · 图 ' + stats.images + ' · 字 ' + stats.chars,
          '素材：' + result.assets.map((a) => a.name).join(', '),
          '块清单：',
          outlineText(project),
          '',
          result.coverError ? '⚠ 封面没画出来：' + result.coverError + '（修好后调 xiumi_make_cover）' : '封面已生成（900×383 + 500×500）',
          '下一步：需要的话用 xiumi_set_block 调结构（只能调排版，不能删改文稿）。面板：' + deps.studioUrl(result.sessionId),
        ];
        return ok(lines.filter(Boolean).join('\n'));
      },
    },
    {
      name: 'xiumi_add_images',
      description: '把分开发的图片补进当前工程（文稿与图片分开发时用这个）。paths 可以是图片文件，也可以是整个文件夹：文件夹会按文件名自然序（1,2,…,10）展开。默认按文稿小节自动分：图片按给的顺序，均匀落进每个小节末尾，图比小节多就每节摊平、图比小节少就铺开，不会挤在一起。要全塞到文末传 placement:"end"；要精确放到某个块后面用 after 指定块 id（先 xiumi_open 看块清单）。图片只增不减、不覆盖已有素材；补完调 xiumi_preview 确认「未用上的素材」为空。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['paths'],
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: '图片文件或文件夹的路径（绝对路径，或相对工作目录），按数组顺序插入；文件夹内部按文件名自然序',
          },
          placement: { type: 'string', enum: ['section', 'end'], description: '可选：section（默认）按小标题自动分到各节末尾；end 全部放在结尾「END」之前' },
          after: { type: 'string', description: '可选：插在这个块 id 之后（如 b10）；传了它就不按小节分' },
          captions: { type: 'array', items: { type: 'string' }, description: '可选：与图片一一对应的图注；图注只写客观信息（时间、地点、人物、事件），不确定就留空' },
          project_id: { type: 'string' },
        },
      },
      execute: (args, exec) => {
        const { sessionId, cwd } = sessionOf(deps, exec);
        const project = currentProject(cwd, sessionId, args);
        const collected = collectImages(args.paths, cwd);
        const items = [];
        const notes = collected.skipped.map((s) => s.path + '：' + s.reason);
        for (const abs of collected.files) {
          try {
            items.push({ name: path.basename(abs), buffer: fs.readFileSync(abs), source: abs });
          } catch (error) {
            notes.push(path.basename(abs) + '：读不出来（' + error.message + '）');
          }
        }
        if (!items.length) {
          throw new Error('没有可插入的图片' + (notes.length ? '：' + notes.join('；') : ''));
        }
        const placement = args.after ? '' : args.placement === 'end' ? 'end' : 'section';
        const result = insertImages(cwd, project.id, items, { after: args.after, captions: args.captions, placement: placement || 'section' });
        const where = args.after ? '接在 ' + args.after + ' 之后' : placement === 'end' ? '全部放在文末' : '按小节分好了';
        store.addEvent(cwd, project.id, 'images', '补进 ' + result.added.length + ' 张图（' + where + '）');
        presence.requestOpen(cwd, 'images');
        const stats = countStats(result.project);
        const lines = [
          '已补进 ' + result.added.length + ' 张图：' + result.added.map((a) => a.name).join(', '),
          '落位：' + where,
          '工程：' + result.project.id + ' · 块 ' + stats.blocks + ' · 图 ' + stats.images,
        ];
        if (notes.length) lines.push('⚠ 没进去的：' + notes.join('；'));
        lines.push('块清单：\n' + outlineText(result.project));
        lines.push('下一步：xiumi_preview 确认「未用上的素材」为空，再检查落位对不对。面板：' + deps.studioUrl(sessionId));
        return ok(lines.join('\n'));
      },
    },
    {
      name: 'xiumi_remove_image',
      description: '去掉一张素材，连带删掉引用它的图片块。只在素材是误拖/错图、或用户明确说要删时用；用户提供的图原则上要全部用上，不要拿它当"图太多"的清理工具。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: { type: 'string', description: '素材文件名（xiumi_open 或 xiumi_preview 里看到的那个名字）' },
          project_id: { type: 'string' },
        },
      },
      execute: (args, exec) => {
        const { sessionId, cwd } = sessionOf(deps, exec);
        const project = currentProject(cwd, sessionId, args);
        const out = store.removeAsset(cwd, project.id, String(args.name || ''));
        const stats = countStats(out.project);
        return ok(
          '已去掉素材「' + args.name + '」' + (out.removedBlocks ? '，连带删掉 ' + out.removedBlocks + ' 个图片块' : '（正文里没有引用它）') + '。\n' +
            '工程：' + project.id + ' · 块 ' + stats.blocks + ' · 图 ' + stats.images + '\n' +
            '面板：' + deps.studioUrl(sessionId)
        );
      },
    },
    {
      name: 'xiumi_layout_images',
      description: '把正文里现有的图片按小标题重新分：原来挤在文末的图会回到各小节末尾，顺序不变，不新增/删除任何素材。旧稿（补图默认堆在文末的时代做的）想变成「图跟着小节走」时用它。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { project_id: { type: 'string' } },
      },
      execute: (args, exec) => {
        const { sessionId, cwd } = sessionOf(deps, exec);
        const project = currentProject(cwd, sessionId, args);
        const out = distributeImages(cwd, project.id);
        store.addEvent(cwd, project.id, 'images', '把 ' + out.moved + ' 张图按小节重新分');
        const stats = countStats(out.project);
        return ok(
          '已按小节重新分好：' + out.moved + ' 张图（顺序没动）。\n' +
            '工程：' + project.id + ' · 块 ' + stats.blocks + ' · 图 ' + stats.images + '\n' +
            '面板看一眼落位：' + deps.studioUrl(sessionId)
        );
      },
    },
    {
      name: 'xiumi_duplicate_project',
      description: '另存一版：把当前工程的块、素材、封面全部复制成一个新工程，发布状态清空。改版式前先存一版，改坏了能回来对照；多版本之间用 xiumi_open 切换。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: '可选：新工程的标题，不传就是「原标题（副本）」' },
          project_id: { type: 'string' },
        },
      },
      execute: (args, exec) => {
        const { sessionId, cwd } = sessionOf(deps, exec);
        const project = currentProject(cwd, sessionId, args);
        const copy = store.duplicateProject(cwd, project.id, { title: typeof args.title === 'string' && args.title ? args.title : '' });
        store.setActive(cwd, sessionId, copy.id);
        const stats = countStats(copy);
        return ok(
          '已另存一版：' + copy.title + '（' + copy.id + '）\n' +
            '块 ' + stats.blocks + ' · 图 ' + stats.images + ' · 字 ' + stats.chars + '（发布状态已清空）\n' +
            '现在切到了新工程；要回原来那版用 xiumi_open 传 project_id=' + project.id + '\n' +
            '面板：' + deps.studioUrl(sessionId)
        );
      },
    },
    {
      name: 'xiumi_make_cover',
      description: '按当前主题配色生成公众号封面（900×383）与分享方图（500×500）。换主题后要重绘。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { project_id: { type: 'string' } },
      },
      execute: async (args, exec) => {
        const { sessionId, cwd } = sessionOf(deps, exec);
        const project = currentProject(cwd, sessionId, args);
        const dir = store.projectDir(cwd, project.id);
        const made = await makeCover({ project, dir, log: deps.log });
        store.updateProject(cwd, project.id, (p) => {
          p.cover = { cover: 'cover.png', square: 'square.png', at: new Date().toISOString() };
          return p;
        });
        store.addEvent(cwd, project.id, 'cover', '封面重绘（' + getTheme(project.theme).name + '）');
        return ok('封面已生成：cover.png（900×383）与 square.png（500×500）。\n预览：' + deps.studioUrl(sessionId) + '\n文件：' + made.cover);
      },
    },
    {
      name: 'xiumi_set_theme',
      description: '换配色主题。五套：zhusha 朱砂（庄重/红色主题）、qingci 青瓷（学术/清爽）、molan 墨蓝（严谨/团学）、yingfen 樱粉（活动/轻盈）、subai 素白（极简）。换完记得重绘封面。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['theme'],
        properties: {
          theme: { type: 'string', enum: THEMES.map((t) => t.id) },
          project_id: { type: 'string' },
        },
      },
      execute: (args, exec) => {
        const { sessionId, cwd } = sessionOf(deps, exec);
        const project = currentProject(cwd, sessionId, args);
        const next = store.updateProject(cwd, project.id, (p) => {
          p.theme = args.theme;
          return p;
        });
        store.addEvent(cwd, project.id, 'theme', '换成「' + getTheme(args.theme).name + '」主题');
        return ok('已换成「' + getTheme(next.theme).name + '」。封面还是旧配色的话，调 xiumi_make_cover 重绘。');
      },
    },
    {
      name: 'xiumi_set_block',
      description: '调整块结构与排版（不动文稿内容）：update 改图片说明或小标文字、move 上下移动、delete 删除一个块、insert 在指定块后插入新块（type: paragraph/section/quote/list/divider/end）。改正文文字只允许用于修排版（如断句、去多余空格），删改原意一律不允许。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['update', 'move', 'delete', 'insert'] },
          block_id: { type: 'string', description: '目标块 id（block 清单里的 b1/b2…）' },
          direction: { type: 'string', enum: ['up', 'down'], description: 'move 用' },
          type: { type: 'string', description: 'insert 用：新块类型' },
          text: { type: 'string', description: 'update/insert 用：文字内容' },
          caption: { type: 'string', description: 'update 图片时用：图注' },
          allow_clear: { type: 'boolean', description: '仅排障用：明知要清空正文才传 true（默认拒绝清空）' },
          project_id: { type: 'string' },
        },
      },
      execute: (args, exec) => {
        const { sessionId, cwd } = sessionOf(deps, exec);
        const project = currentProject(cwd, sessionId, args);
        const rid = String(args.block_id || '');
        let note = '';
        const updated = store.updateProject(cwd, project.id, (p) => {
          const i = p.blocks.findIndex((b) => b.id === rid);
          if (i < 0) throw new Error('没有这个块：' + rid);
          const cur = p.blocks[i];
          const before = String(cur.text || '');
          if (args.action === 'update') {
            if (typeof args.text === 'string') {
              // 硬约束：文稿不删改。清空正文必须显式 allow_clear，免得手滑把整段抹掉。
              if (!args.text.trim() && before.trim() && args.allow_clear !== true) {
                throw new Error('不能把正文清空（文稿不允许删改）：确实要清空请带 allow_clear: true');
              }
              p.blocks[i].text = args.text;
              note = '改正文 ' + rid + '：「' + clip(before, 24) + '」→「' + clip(args.text, 24) + '」';
            }
            if (typeof args.caption === 'string') {
              p.blocks[i].caption = args.caption;
              note += (note ? '；' : '') + '改图注 ' + rid + '：「' + clip(cur.caption, 20) + '」→「' + clip(args.caption, 20) + '」';
            }
            if (p.blocks[i].type === 'section' && typeof args.text === 'string' && !p.blocks[i].number) {
              const count = p.blocks.filter((b) => b.type === 'section').indexOf(p.blocks[i]) + 1;
              p.blocks[i].number = String(count).padStart(2, '0');
            }
          } else if (args.action === 'move') {
            const to = args.direction === 'up' ? i - 1 : i + 1;
            if (to < 0 || to >= p.blocks.length) throw new Error('已经到头了');
            const [b] = p.blocks.splice(i, 1);
            p.blocks.splice(to, 0, b);
            note = '把块 ' + rid + '（' + clip(before || b.caption || b.asset, 20) + '）' + (args.direction === 'up' ? '上移一位' : '下移一位');
          } else if (args.action === 'delete') {
            p.blocks.splice(i, 1);
            note = '删掉块 ' + rid + '（' + cur.type + '：' + clip(before || cur.caption || cur.asset, 20) + '）';
          } else if (args.action === 'insert') {
            const type = String(args.type || 'paragraph');
            const seq = p.blocks.length + 1;
            p.blocks.splice(i + 1, 0, { id: 'b' + Date.now().toString(36) + seq, type, text: String(args.text || '') });
            note = '在 ' + rid + ' 后插入一个 ' + type + '（' + clip(args.text, 20) + '）';
          } else {
            throw new Error('未知 action：' + args.action);
          }
          return p;
        });
        store.addEvent(cwd, project.id, 'edit', note || ('调整块：' + args.action + ' ' + rid));
        return ok('已更新（' + (note || args.action + ' ' + rid) + '）。当前 ' + updated.blocks.length + ' 个块。\n' + outlineText(updated));
      },
    },
    {
      name: 'xiumi_preview',
      description: '取当前图文的渲染结果与统计：字数、图片数、小节数、HTML 字节数，以及面板与预览地址。检查「图片是不是全用上了」用它。',
      parameters: { type: 'object', additionalProperties: false, properties: { project_id: { type: 'string' } } },
      execute: (args, exec) => {
        const { sessionId, cwd } = sessionOf(deps, exec);
        const project = currentProject(cwd, sessionId, args);
        const stats = countStats(project);
        const assetUrl = (n) => deps.origin() + '/xiumi/api/asset/' + project.id + '/' + encodeURIComponent(n) + '?session=' + encodeURIComponent(sessionId || '');
        const byName = {};
        for (const a of project.assets || []) byName[a.name] = a;
        const used = (project.blocks || []).filter((b) => b.type === 'image').map((b) => b.asset);
        const unused = (project.assets || []).filter((a) => used.indexOf(a.name) < 0).map((a) => a.name);
        // 两个方向都要查：素材没用上、图片块指向了不存在的素材/文件
        const dangling = used.filter((n) => !byName[n]);
        const missingFiles = used.filter((n) => byName[n] && !fs.existsSync(store.assetPath(cwd, project.id, n)));
        const html = renderStandalone(project, { assetUrl, heroAsset: used[0] });
        let inlined = 0;
        for (const n of used) {
          try { inlined += Math.round(fs.statSync(store.assetPath(cwd, project.id, n)).size * 1.37); } catch { /* 缺文件的上面已经报过 */ }
        }
        const lines = [
          '统计：块 ' + stats.blocks + ' · 图 ' + stats.images + ' · 小节 ' + stats.sections + ' · 字 ' + stats.chars,
          '主题：' + getTheme(project.theme).name + ' · 封面：' + (project.cover ? '有' : '无'),
          '导出体积：正文约 ' + Math.round((html.length + inlined) / 1024) + ' KB（图片已内嵌）',
          '图片落位：' + used.join(', '),
        ];
        if (unused.length) lines.push('⚠ 未用上的素材：' + unused.join(', ') + '（要求：提供的图必须全部用上）');
        if (dangling.length) lines.push('⚠ 图片块指向了不存在的素材：' + dangling.join(', ') + '（渲染出来是缺图框）');
        if (missingFiles.length) lines.push('⚠ 素材文件不在盘上：' + missingFiles.join(', '));
        lines.push('面板：' + deps.studioUrl(sessionId));
        return ok(lines.join('\n'));
      },
    },
    {
      name: 'xiumi_xiumi_tools',
      description: '列出秀米侧（MCP）当前可用的工具及其参数：授权后用它确认发布接口的真实 schema，不要凭想象调用。同时返回授权状态。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      execute: async () => {
        const status = deps.xiumiStatus();
        if (!status.connected) {
          return ok('秀米账号还没连接。请在人面前说清楚：面板顶栏最左边有个带小圆点的「连接秀米」胶囊按钮（全宽视图里写「连接秀米账号」），点它登录并同意授权（一次即可），之后就能直接把图文投进「我的图文」。\n面板：' + deps.studioUrl(null));
        }
        const tools = await describeRemote();
        return ok('秀米已连接。可用工具：\n' + tools.map((t) => '- ' + t.name + (t.required.length ? '（必填：' + t.required.join(', ') + '）' : '') + '：' + t.description.slice(0, 120)).join('\n'));
      },
    },
    {
      name: 'xiumi_publish',
      description: '把当前图文发布到秀米「我的图文」。需要先完成一次秀米授权；接口 schema 在运行时读取，不做猜测。发布前会先体检（图片是不是还只有本机地址、有没有素材没用上、封面有没有），会在秀米那边出丑的情况提前拦住。发布失败会带出真实报错与可用工具清单。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          project_id: { type: 'string' },
          prefer: { type: 'string', enum: ['html', 'markdown'] },
          allow_local_images: { type: 'boolean', description: '仅排障用：明知图片只有本机地址仍要投递（发出去可能裂图）' },
        },
      },
      execute: async (args, exec) => {
        const { sessionId, cwd } = sessionOf(deps, exec);
        const project = currentProject(cwd, sessionId, args);
        // ① 先把图传进秀米图床：秀米服务器取不到 127.0.0.1 的图，不换地址投过去就是裂图。
        let up = { uploaded: [], skipped: [], failed: [] };
        try {
          up = await uploadProjectAssets(project, {
            readAsset: (name) => {
              const file = store.assetPath(cwd, project.id, name);
              return fs.existsSync(file) ? fs.readFileSync(file) : null;
            },
          });
        } catch (error) {
          up.failed.push({ name: '（全部）', error: error.message });
        }
        if (up.uploaded.length) {
          store.updateProject(cwd, project.id, (p) => {
            p.blocks = project.blocks;
            return p;
          });
          store.addEvent(cwd, project.id, 'publish', '传了 ' + up.uploaded.length + ' 张图进秀米图床');
        }
        const uploaded = up.uploaded.length + up.skipped.length;
        const total = uploaded + up.failed.length;
        const upNote = total ? '图片：' + uploaded + '/' + total + ' 已经在秀米图床' + (up.failed.length ? '（没传上：' + up.failed.map((f) => f.name).join('、') + '）' : '') : '';

        // 体检放在传图之后：图已经有图床地址，就不该再因为「只有本机地址」被拦。
        const pre = preflightPublish(project, { origin: deps.origin(), allowLocalImages: true });
        if (!pre.ok) {
          const blocking = pre.issues.filter((i) => i.level === 'block').map((i) => '· ' + i.msg).join('\n');
          return bad('先别发，发出去会出丑：\n' + blocking + '\n面板：' + deps.studioUrl(sessionId));
        }

        // ② 秀米 MCP 没有「新建图文」的工具（12 个工具里只有 create_image，其余都是读作品 / 改已有作品 / 管图库）。
        //    先按名字找一次创建工具：万一秀米以后开了，这条路自动生效；没有就走粘贴这条路。
        const remoteHtml = renderFragment(project, {
          preferRemote: true,
          assetUrl: (n) => deps.origin() + '/xiumi/api/asset/' + project.id + '/' + encodeURIComponent(n) + '?session=' + encodeURIComponent(sessionId || ''),
        });
        try {
          const result = await publishProject(project, { html: remoteHtml, prefer: args.prefer });
          store.updateProject(cwd, project.id, (p) => {
            p.xiumi = { tool: result.tool, text: result.text, at: new Date().toISOString(), structured: result.structured || null };
            p.status = 'published';
            return p;
          });
          store.addEvent(cwd, project.id, 'publish', '已投递到秀米（' + result.tool + '）');
          const warns = pre.issues.filter((i) => i.level === 'warn').map((i) => '· ' + i.msg).join('\n');
          return ok('已发布（工具 ' + result.tool + '，用了字段：' + result.used.join(', ') + '）\n' + (result.text || '').slice(0, 800) + '\n' + upNote + '\n去这里看：https://xiumi.us/#/studio/papers' + (warns ? '\n\n还有几处能更好：\n' + warns : ''));
        } catch (error) {
          if (error.code === 'XIUMI_UNAUTHORIZED') {
            return bad('还没授权秀米：需要人点一次面板顶栏最左边那个「连接秀米」胶囊按钮（右侧栏窄版里也在顶栏第一个）。这一步是秀米账号登录，必须人来点。\n面板：' + deps.studioUrl(sessionId));
          }
          // 没有创建工具 = 走「复制到秀米 → 粘贴 → Ctrl+S」这条路（这条路是实测能真进「我的图文」的）
          const noCreate = /没有创建图文|没有.*创建图文的工具/.test(String(error.message || ''));
          if (noCreate) {
            store.updateProject(cwd, project.id, (p) => {
              p.status = 'ready';
              return p;
            });
            store.addEvent(cwd, project.id, 'publish', '已备好粘贴版（秀米 MCP 没有新建图文接口）');
            return ok('秀米 MCP 没有「新建图文」的接口，所以不能由接口直接建稿。已经做完的部分：\n'
              + upNote + '\n\n接着两步就能进「我的图文」（实测可行）：\n'
              + '1) 在面板点「复制到秀米」——它会把排版好的正文（图用图床地址）放进剪贴板，并在新标签打开 https://xiumi.us/#/studio/papers；\n'
              + '2) 在「我的图文」点「新建图文」（选空白）→ 正文区 Ctrl+V → 右上「保存」（或 Ctrl+S），标题填大标题。\n\n'
              + '面板：' + deps.studioUrl(sessionId) + '\n去这里看结果：https://xiumi.us/#/studio/papers');
          }
          const extra = error.schema ? '\n接口 schema：' + JSON.stringify(error.schema).slice(0, 1200) : '';
          const tools = error.tools ? '\n可用工具：' + error.tools.map((t) => t.name).join(', ') : '';
          return bad('发布失败：' + error.message + extra + tools + '\n' + upNote);
        }
      },
    },
    {
      name: 'xiumi_templates',
      description: '看秀米模板商店里可免费复用的图文模板（免登录，本地缓存 24 小时）。按关键词在标题/作者里找，给出标题、作者、复制量与预览链接，供「按主题挑模板」或「照着它的气质定配色」时参考。注意：这里只做参考与预览，把成品直接塞进别人的模板还没做。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          q: { type: 'string', description: '关键词，如 党建 / 讲座 / 换届 / 校园 / 学术' },
          limit: { type: 'number', description: '返回条数，默认 8，最多 20' },
          refresh: { type: 'boolean', description: '忽略缓存重新拉一遍（整站免费模板只有前 216 个能匿名拉到）' },
        },
      },
      execute: async (args) => {
        let catalog = args.refresh ? null : templates.readCatalog();
        if (!catalog) {
          try {
            catalog = await templates.refreshCatalog();
          } catch (error) {
            return bad('模板目录没拉到：' + ((error && error.message) || String(error)) + '（离线时这块用不了，不影响自创版式）');
          }
        }
        const limit = Math.min(20, Math.max(1, Math.floor(Number(args.limit) || 8)));
        const items = templates.searchCatalog(catalog.items, { q: args.q, limit });
        if (!items.length) {
          return ok('没搜到「' + (args.q || '') + '」。换个词试试，例如 党建 / 讲座 / 换届 / 校园；也可以 refresh:true 重新拉一遍。');
        }
        const lines = ['秀米免费模板（本地缓存 ' + (catalog.items || []).length + ' 条' + (args.q ? '，关键词「' + args.q + '」' : '') + '）'];
        items.forEach((it, i) => {
          lines.push((i + 1) + '. ' + (it.title || '未命名') + ' · ' + (it.author || '佚名') + ' · 已被复制 ' + (it.copies || 0) + ' 次');
          if (it.showUrl) lines.push('   预览：' + it.showUrl);
        });
        lines.push('挑定之后两个用法：①照它的气质给这篇换配色（xiumi_set_theme）；②把预览链接发给人看看是不是这个味道。要把成品塞进模板本体还没做。');
        return ok(lines.join('\n'));
      },
    },
    {
      name: 'xiumi_template_shows',
      description: '看「我的图文」里哪些篇能当模板套（自己账号里用「使用模板」存下来的免费模板）：每篇给出槽位形状（文字槽/图片槽）、是否已发布、是不是我们自己刚做完的成品（会被排除）。秀米没有「列模板」接口，能套的只有自己账号里的这些篇。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          refresh: { type: 'boolean', description: '忽略 24 小时缓存，重新逐篇读一遍形状（约 4 秒，首次会慢）' },
        },
      },
      execute: async (args, exec) => {
        const { cwd } = sessionOf(deps, exec);
        const items = await templateShows.inspectAccountShows(cwd, { refresh: Boolean(args.refresh) });
        const list = items.filter((it) => it.isTemplate);
        const ours = items.filter((it) => it.likelyFilled);
        if (!list.length) {
          return ok('账号里没有能套的模板（判据：图片槽 ≥' + templateShows.TEMPLATE_MIN_IMAGE_SLOTS + '、文字槽 ≥' + templateShows.TEMPLATE_MIN_TEXT_SLOTS + '）。去秀米模板库挑一篇点「使用模板」，它会出现在「我的图文」里，再回来刷新。');
        }
        const lines = ['我的图文里可套的模板 ' + list.length + ' 篇：'];
        for (const it of list) {
          lines.push('· ' + it.showId + '｜' + it.title + '｜文字 ' + it.textSlots + ' / 图 ' + it.imageSlots + (it.released ? '｜已发布' : '') + '\n  编辑：' + it.editUrl);
        }
        if (ours.length) lines.push('（已排除 ' + ours.length + ' 篇我们自己填过的成品：' + ours.map((o) => o.showId).join('、') + '）');
        lines.push('下一步：xiumi_template_apply(project_id, show_id?)——不传 show_id 就按题材与槽位自动挑。');
        return ok(lines.join('\n'));
      },
    },
    {
      name: 'xiumi_template_apply',
      description: '把这篇图文的文字与图片灌进一篇免费模板：复制模板 → 传图进秀米图床 → 按槽位绑定文字图片，成品直接出现在秀米「我的图文」。默认 dryRun 只预检（零副作用：不复制、不上传）。不传 show_id 时按题材命中与槽位够用自动挑，并给出理由。文稿不删改、图片必须全部用上。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          project_id: { type: 'string', description: '工程 id；省略用当前工程的' },
          show_id: { type: 'number', description: '要套的模板作品 id（来自 xiumi_template_shows）；省略则自动挑' },
          dry_run: { type: 'boolean', description: 'true=只预检不落库（默认 true）；确认无误再传 false 真跑' },
          blank_unused: { type: 'boolean', description: '没用到的图片槽用透明图占位，默认 true' },
          title_postfix: { type: 'string', maxLength: 8, description: '副本标题后缀，最多 8 个字（秀米硬限制）' },
        },
      },
      execute: async (args, exec) => {
        const { sessionId, cwd } = sessionOf(deps, exec);
        const project = currentProject(cwd, sessionId, args);
        const dryRun = args.dry_run !== false;
        let showId = Number(args.show_id) || 0;
        let picked = null;
        if (!showId) {
          const items = await templateShows.inspectAccountShows(cwd, {});
          const rank = templateShows.rankTemplates({ project, items });
          if (!rank.picked) return bad('账号里没有可套的模板：先在秀米模板库点「使用模板」存一篇，再 xiumi_template_shows 刷新');
          picked = rank.picked;
          showId = picked.showId;
        }
        const out = await templateShows.fillTemplate({
          project,
          cwd,
          templateShowId: showId,
          dryRun,
          titlePostfix: args.title_postfix || '·' + new Date().toISOString().slice(11, 16).replace(':', ''),
          blankUnused: args.blank_unused !== false,
          readAsset: dryRun
            ? null
            : (name) => {
                const file = store.assetPath(cwd, project.id, name);
                return fs.existsSync(file) ? fs.readFileSync(file) : null;
              },
        });
        if (!dryRun) {
          store.updateProject(cwd, project.id, (p) => {
            p.blocks = project.blocks;
            return p;
          });
          if (out.ok) store.addEvent(cwd, project.id, 'template', '已套用模板（秀米作品 ' + out.showId + '）');
        }
        const lines = [];
        lines.push(dryRun ? '预检（没有落库，也没有复制作品）' : out.ok ? '已灌进模板，成品在「我的图文」：' + out.showId : '灌内容没成功');
        lines.push('模板：' + showId + (picked ? '（自动挑：' + picked.title + '，分数 ' + picked.score + '｜' + (picked.reasons || []).join('；') + '）' : ''));
        lines.push('绑定 ' + out.bindings + ' 个槽；上传新图 ' + (out.uploaded || 0) + ' 张' + (out.failedUploads && out.failedUploads.length ? '，失败 ' + out.failedUploads.length + ' 张' : ''));
        if (out.editUrl) lines.push('编辑页：' + out.editUrl);
        if (out.warnings && out.warnings.length) lines.push('要注意：\n· ' + out.warnings.join('\n· '));
        if (!out.ok) {
          lines.push('接口回执：' + String(out.text || '').slice(0, 600));
          if (!dryRun) lines.push('复制出来的空稿已删进回收站（避免堆垃圾稿）。');
        }
        return ok(lines.join('\n'));
      },
    },
    {
      name: 'xiumi_template_fill',
      description: '把内容灌进「已经复制好的那一篇」（不再复制）。只允许改本插件复制出来的、还没发布的副本（归属校验），避免覆盖别人的或已发布的稿子。默认 dry_run。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          project_id: { type: 'string', description: '工程 id；省略用当前工程的' },
          show_id: { type: 'number', description: '要灌的那一篇（本插件复制出来的副本）' },
          dry_run: { type: 'boolean', description: '默认 true；false 才真写' },
          blank_unused: { type: 'boolean', description: '空图槽填透明图，默认 true' },
        },
        required: ['show_id'],
      },
      execute: async (args, exec) => {
        const { sessionId, cwd } = sessionOf(deps, exec);
        const project = currentProject(cwd, sessionId, args);
        const showId = Number(args.show_id);
        const dryRun = args.dry_run !== false;
        await templateShows.assertFillTarget(cwd, showId, project);
        let upload = null;
        if (!dryRun) {
          upload = await uploadProjectAssets(project, {
            readAsset: (name) => {
              const file = store.assetPath(cwd, project.id, name);
              return fs.existsSync(file) ? fs.readFileSync(file) : null;
            },
          });
          store.updateProject(cwd, project.id, (p) => {
            p.blocks = project.blocks;
            return p;
          });
        }
        const spec = templateFill.parseSpec(await templateFill.fetchSpec(showId));
        const blank = args.blank_unused === false ? '' : dryRun ? templateFill.cachedBlankImageUrl() : await templateFill.blankImageUrl();
        const plan = templateFill.planFill({ spec, project, blankImageUrl: blank });
        const out = await templateFill.applyFill(showId, plan, { dryRun });
        const lines = [
          (dryRun ? '预检' : out.ok ? '已写入' : '写入没成功') + '（作品 ' + showId + '，绑定 ' + plan.bindings.length + ' 槽' +
            (out.updatedSlots != null ? '，接口说更新了 ' + out.updatedSlots + ' 槽' : '') + '）',
        ];
        if (upload && upload.uploaded.length) lines.push('上传新图 ' + upload.uploaded.length + ' 张');
        if (plan.warnings.length) lines.push('要注意：\n· ' + plan.warnings.join('\n· '));
        if (out.notes.length) lines.push('判定说明：' + out.notes.join('；'));
        if (!out.ok) lines.push('回执：' + String(out.text || '').slice(0, 600));
        return ok(lines.join('\n'));
      },
    },
  ];
}

export function registerTools(ctx, deps) {
  const offs = [];
  for (const def of toolDefs(deps)) {
    try {
      const off = ctx.tools.register({
        name: def.name,
        description: def.description,
        parameters: def.parameters,
        // 形态必须与宿主的工具注册一致：output 是 { schema, render }，
        // 不是裸 schema——传裸 schema 会被注册器拒掉，模型侧直接看不到这些工具。
        output: { schema: OUT_SCHEMA, render: renderText },
        execute: async (args, exec) => {
          try {
            return await def.execute(args || {}, exec);
          } catch (error) {
            return bad((error && error.message) || String(error));
          }
        },
      });
      offs.push(typeof off === 'function' ? off : () => {});
    } catch (error) {
      deps.log('[xiumi] 工具注册失败 ' + def.name + '：' + (error && error.message));
      throw error;
    }
  }
  return () => offs.forEach((off) => off());
}
