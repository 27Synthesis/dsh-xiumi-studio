/* 秀米工作台前端：只做三件事——看进程、换主题、送出去。
   数据全走 /xiumi/api/*，没有隐藏状态；断开轮询也不影响已在磁盘上的工程。 */
(function () {
  var qs = new URLSearchParams(location.search);
  var SESSION = qs.get('session') || '';
  var EMBED = qs.get('embed') === '1';
  if (EMBED) document.body.classList.add('embed');
  if (!SESSION) SESSION = localStorage.getItem('xiumi.session') || '';
  else localStorage.setItem('xiumi.session', SESSION);

  var state = null;
  var lastStamp = '';
  var outlineActive = -1;

  var el = function (id) { return document.getElementById(id); };

  function api(path, body) {
    var url = '/xiumi/api' + path + (path.indexOf('?') >= 0 ? '&' : '?') + 'session=' + encodeURIComponent(SESSION);
    var init = body
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ session: SESSION }, body)) }
      : { method: 'GET' };
    return fetch(url, init).then(function (res) {
      return res.json().then(function (payload) {
        if (!res.ok || payload.ok === false) {
          var err = new Error(payload.error || ('HTTP ' + res.status));
          err.payload = payload;
          err.status = res.status;
          throw err;
        }
        return payload;
      });
    });
  }

  // toast 文案里如果出现地址，必须做成真链接（提示里的蓝字不能只是字）：点击走 openLink，
  // 系统浏览器 / 新标签 / 复制兜底三条路都有 toast 反馈。没有地址时还是纯文字。
  function toast(text, bad) {
    var wrap = el('toasts');
    var node = document.createElement('div');
    node.className = 'toast' + (bad ? ' bad' : '');
    var raw = String(text == null ? '' : text);
    var re = /https?:\/\/[^\s"'<>）)】]+/g;
    var last = 0;
    var m;
    while ((m = re.exec(raw))) {
      if (m.index > last) node.appendChild(document.createTextNode(raw.slice(last, m.index)));
      (function (href) {
        var a = document.createElement('a');
        a.className = 'toast-link';
        a.setAttribute('href', href);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        a.textContent = href;
        a.onclick = function (e) { e.preventDefault(); openLink(href, '已在浏览器打开这条地址'); };
        node.appendChild(a);
      }(m[0]));
      last = m.index + m[0].length;
    }
    if (!last) node.textContent = raw;
    else if (last < raw.length) node.appendChild(document.createTextNode(raw.slice(last)));
    wrap.appendChild(node);
    setTimeout(function () { node.style.opacity = '0'; node.style.transition = 'opacity 240ms'; }, 2600);
    setTimeout(function () { node.remove(); }, 3000);
  }

  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // 顶栏只报工作区名：路径本身对人没用，还容易把截图里的隐私带出去
  function shortCwd(p) {
    if (!p) return '';
    var parts = String(p).split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : p;
  }

  function renderProjects() {
    var list = el('projectList');
    var rows = (state.projects || []).map(function (p) {
      var li = document.createElement('li');
      if (state.project && p.id === state.project.id) li.className = 'active';
      li.innerHTML = '<b>' + escapeHtml(p.title) + '</b><i>' + (p.status === 'published' ? '已发布' : '草稿') +
        ' · ' + (p.images || 0) + ' 图 · ' + fmtTime(p.updatedAt) + '</i>';
      li.onclick = function () {
        api('/active', { projectId: p.id }).then(load).catch(function (e) { toast(e.message, true); });
      };
      return li;
    });
    list.innerHTML = '';
    rows.forEach(function (r) { list.appendChild(r); });
    if (!rows.length) {
      var li = document.createElement('li');
      li.innerHTML = '<i>把 Word 发给我，我在这里建第一篇</i>';
      list.appendChild(li);
    }
  }

  var TYPE_LABEL = {
    kicker: '标眉', title: '标题', subtitle: '副题', lead: '导语', section: '小标',
    image: '图片', paragraph: '正文', quote: '引用', list: '列表', divider: '分隔', end: '结尾', signature: '落款'
  };

  function renderOutline() {
    var list = el('outline');
    var blocks = (state.project && state.project.blocks) || [];
    el('outlineCount').textContent = blocks.length ? blocks.length + ' 块' : '';
    list.innerHTML = '';
    var imgNo = 0;
    blocks.forEach(function (b, i) {
      var li = document.createElement('li');
      if (i === outlineActive) li.className = 'active';
      if (b.type === 'image') {
        imgNo += 1;
        li.classList.add('img');
      }
      var text = b.type === 'image'
        ? ('图 ' + imgNo + (b.caption ? ' · ' + b.caption : ''))
        : (b.number ? b.number + ' · ' : '') + (b.text || '');
      li.innerHTML = '<span class="tag">' + (TYPE_LABEL[b.type] || b.type) + '</span><span class="txt">' + escapeHtml(text) + '</span>';
      li.onclick = function () {
        outlineActive = i;
        renderOutline();
        scrollToBlock(i);
      };
      list.appendChild(li);
    });
  }

  // ── 主题：色板推导与 CSS 变量 ─────────────────────────────────────
  // 面板不自己定颜色。五套主题的展示色来自宿主 GET /xiumi/api/themes（字段直接取自
  // host/themes.mjs），这里只做「paper / ink / accent → 派生色」的算术，再写进 :root 的
  // CSS 变量；studio.css 里所有颜色都是 var(--…)，所以换主题时面板和正文一起变。
  var THEMES = [];
  var themesPromise = null;

  function parseHex(h) {
    var s = String(h || '').replace('#', '').trim();
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (s.length !== 6) return null;
    var n = parseInt(s, 16);
    if (isNaN(n)) return null;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function toHex(c) {
    var f = function (v) { return ('0' + Math.max(0, Math.min(255, Math.round(v))).toString(16)).slice(-2); };
    return '#' + f(c.r) + f(c.g) + f(c.b);
  }
  // w=0 取 base，w=1 取 toward。toward 传 rgb 三元组，源码里因此不出现任何色值字面量。
  function mixToward(base, toward, w) {
    var b = parseHex(base);
    if (!b) return base;
    return toHex({
      r: b.r + (toward.r - b.r) * w,
      g: b.g + (toward.g - b.g) * w,
      b: b.b + (toward.b - b.b) * w
    });
  }
  var LIGHT = { r: 255, g: 255, b: 255 };
  var DARK = { r: 0, g: 0, b: 0 };
  function mix(a, b, w) {
    var to = parseHex(b);
    return to ? mixToward(a, to, w) : a;
  }
  function lighten(c, w) { return mixToward(c, LIGHT, w); }
  function darken(c, w) { return mixToward(c, DARK, w); }
  function alpha(c, a) {
    var p = parseHex(c);
    return p ? ('rgba(' + p.r + ',' + p.g + ',' + p.b + ',' + a + ')') : c;
  }

  // 一套主题 → 一组 CSS 变量。语义和 studio.css 顶部保持一致：
  // --paper 是纸、--sheet 是"要印出来那块白"、--wash 是右栏、--accent 是强调色，
  // --line 直接取主题线色，--bad 用 accent 压深（不另立第六种红）。
  function paletteFor(t) {
    var paper = t.paper;
    var ink = t.ink || t.sub;
    var sub = t.sub || mix(ink, paper, 0.42);
    var accent = t.accent;
    var gold = t.gold || accent;
    var bad = mix(accent, ink, 0.34);
    return {
      'paper': paper,
      'paper-2': lighten(paper, 0.55),
      'paper-3': mix(paper, ink, 0.06),
      'paper-glass': alpha(lighten(paper, 0.55), 0.78),
      'sheet': lighten(paper, 0.84),
      'wash': t.wash || mix(paper, ink, 0.05),
      'ink': ink,
      'ink-2': sub,
      'ink-3': mix(sub, paper, 0.38),
      'line': t.line || mix(paper, ink, 0.12),
      'line-2': alpha(ink, 0.16),
      'line-3': alpha(ink, 0.24),
      'accent': accent,
      'accent-soft': t.accentSoft || lighten(accent, 0.86),
      'accent-deep': darken(accent, 0.18),
      'accent-line': alpha(accent, 0.45),
      'accent-glow': alpha(accent, 0.14),
      'gold': gold,
      'gold-soft': alpha(gold, 0.18),
      'bad': bad,
      'bad-soft': alpha(bad, 0.07),
      'bad-line': alpha(bad, 0.34),
      'shadow': '0 20px 60px ' + alpha(ink, 0.10),
      'shadow-card': '0 2px 10px ' + alpha(ink, 0.05),
      'shadow-phone': '0 10px 30px ' + alpha(ink, 0.12),
      'shadow-toast': '0 10px 30px ' + alpha(ink, 0.22),
      'glow-a': alpha(accent, 0.05),
      'glow-b': alpha(gold, 0.07),
      'placeholder-a': mix(paper, ink, 0.05),
      'placeholder-b': mix(paper, ink, 0.09)
    };
  }

  function applyTheme(t) {
    if (!t || !t.paper || !t.ink) return null;
    var pal = paletteFor(t);
    var root = document.documentElement;
    Object.keys(pal).forEach(function (k) { root.style.setProperty('--' + k, pal[k]); });
    var id = t.id || t.key || '';
    root.setAttribute('data-theme', id);
    if (document.body) document.body.setAttribute('data-theme', id);
    return pal;
  }

  function themeList() {
    if (THEMES.length) return THEMES;
    return (state && state.themes) || [];
  }
  function themeById(id) {
    return themeList().filter(function (t) { return (t.id || t.key) === id; })[0] || null;
  }
  // 没有工程时也要有配色：优先素白（最中性），再退第一套。
  function defaultTheme() {
    return themeById('subai') || themeList()[0] || null;
  }
  // 主题表只取一次；失败就退回 /state 里带的那份，再失败也不拦工作台——
  // studio.css 的 :root 还有系统色兜底。
  function loadThemes(force) {
    if (themesPromise && !force) return themesPromise;
    themesPromise = fetch('/xiumi/api/themes?session=' + encodeURIComponent(SESSION))
      .then(function (res) {
        if (!res.ok) throw new Error('主题表 HTTP ' + res.status);
        return res.json();
      })
      .then(function (payload) {
        var list = (payload && payload.themes) || [];
        if (list.length) THEMES = list;
        return THEMES;
      })
      .catch(function () {
        themesPromise = null;   // 下次轮询再试，宿主重载后能自己恢复
        if (!THEMES.length && state && state.themes) THEMES = state.themes;
        return THEMES;
      });
    return themesPromise;
  }
  function cssVar(name) {
    var v = getComputedStyle(document.documentElement).getPropertyValue('--' + name);
    return (v || '').trim();
  }

  // 色板：每个圆点就是那套主题本身（纸色打底、强调色作内圈），当前工程的主题带一圈墨线。
  function renderSwatches() {
    var box = el('swatches');
    if (!box) return;
    box.innerHTML = '';
    var list = themeList();
    if (!list.length) {
      var wait = document.createElement('span');
      wait.className = 'swatch-name';
      wait.textContent = '主题表未就绪';
      box.appendChild(wait);
      return;
    }
    var currentId = state.project ? state.project.theme : '';
    list.forEach(function (t) {
      var id = t.id || t.key;
      var wrap = document.createElement('div');
      wrap.className = 'swatch-wrap';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'swatch' + (currentId === id ? ' on' : '');
      btn.title = t.name + (t.tagline ? ' · ' + t.tagline : '');
      btn.setAttribute('aria-label', '主题「' + t.name + '」');
      btn.style.background = t.paper;
      var dot = document.createElement('i');
      dot.style.background = t.accent;
      btn.appendChild(dot);
      btn.onclick = function () {
        if (!state.project) return;
        api('/theme', { projectId: state.project.id, theme: id })
          .then(function () { toast('换成「' + t.name + '」'); return load(true); })
          .catch(function (e) { toast(e.message, true); });
      };
      var name = document.createElement('span');
      name.className = 'swatch-name';
      name.textContent = t.name;
      wrap.appendChild(btn);
      wrap.appendChild(name);
      box.appendChild(wrap);
    });
  }

  function renderCover() {
    var frame = el('coverFrame');
    if (state.project && state.project.cover) {
      frame.innerHTML = '<img alt="封面" src="/xiumi/api/coverimg/' + encodeURIComponent(state.project.id) +
        '/cover.png?session=' + encodeURIComponent(SESSION) + '&t=' + Date.now() + '" />';
      var coverImg = frame.querySelector('img');
      if (coverImg) coverImg.onerror = function () {
        // 封面的地址是死的（工程里有 cover 但文件不在盘上）：说清楚，别留个空框
        frame.innerHTML = '<span class="cover-empty" style="color:var(--bad)">封面没加载出来：点「重新生成封面」</span>';
      };
    } else {
      frame.innerHTML = '<span class="cover-empty">还没有封面</span>';
    }
  }

  // 大纲与素材列表共用：按块序号把预览滚到大致位置（iframe 内锚点在跨文档时更脆）
  function scrollToBlock(i) {
    var frame = el('preview');
    var count = ((state.project && state.project.blocks) || []).length;
    try {
      var doc = frame.contentDocument;
      if (doc && doc.documentElement) {
        var h = doc.documentElement.scrollHeight;
        frame.contentWindow.scrollTo({ top: (i / Math.max(1, count)) * h, behavior: 'smooth' });
      }
    } catch (e) { /* 跨域时忽略 */ }
  }

  // 素材只增不减，所以这里最重要的是「有没有图片没被用上」——那是硬约束，不是提醒。
  function renderAssets() {
    var list = el('assetList');
    var p = state.project;
    var assets = (p && p.assets) || [];
    var blocks = (p && p.blocks) || [];
    var usedAt = {};
    blocks.forEach(function (b, i) { if (b.type === 'image' && b.asset) usedAt[b.asset] = i; });
    var usedCount = Object.keys(usedAt).length;
    el('assetHint').textContent = assets.length ? (usedCount + ' / ' + assets.length + ' 用上') : '';
    if (!assets.length) {
      list.innerHTML = '<li style="cursor:default"><span class="nm" style="grid-column:1/4;color:var(--ink-3)">还没有素材：先导入带图的 Word，或把图拖到上面。</span></li>';
      return;
    }
    list.innerHTML = '';
    assets.forEach(function (a) {
      var li = document.createElement('li');
      var idx = usedAt[a.name];
      var isUsed = typeof idx === 'number';
      if (!isUsed) li.className = 'unused';
      li.innerHTML = '<img alt="" src="/xiumi/api/asset/' + encodeURIComponent(p.id) + '/' + encodeURIComponent(a.name) +
        '?session=' + encodeURIComponent(SESSION) + '" />' +
        '<span class="nm" title="' + escapeHtml(a.name) + '">' + escapeHtml(a.name) + '</span>' +
        '<span class="badge">' + (isUsed ? '第 ' + (idx + 1) + ' 块' : '未用上') + '</span>' +
        '<button class="del" type="button" title="去掉这张素材（正文里这张图也会一起删掉）">✕</button>';
      li.onclick = function () { if (isUsed) scrollToBlock(idx); };
      // 缩略图也会因为文件丢失/权限变成空白：至少让这一行看起来是「丢了」，而不是空框
      var thumb = li.querySelector('img');
      if (thumb) thumb.onerror = function () {
        thumb.classList.add('miss');
        thumb.title = '这张素材的缩略图没加载出来：检查文件是不是还在盘上';
      };
      var del = li.querySelector('.del');
      del.onclick = function (e) {
        e.stopPropagation();
        if (!window.confirm('去掉「' + a.name + '」？' + (isUsed ? '\n正文里这张图也会一起删掉。' : ''))) return;
        api('/assets/remove', { projectId: p.id, name: a.name })
          .then(function () { toast('已去掉 ' + a.name); return load(true); })
          .catch(function (err) { toast(err.message, true); });
      };
      list.appendChild(li);
    });
  }

  function readImageFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve({ name: file.name, data: String(reader.result || '') }); };
      reader.onerror = function () { reject(new Error('读不出 ' + file.name)); };
      reader.readAsDataURL(file);
    });
  }

  // 图片和文字分开发时，人不想离开预览：点「补图」或把图拖进来，插完立刻重新渲染。
  function uploadImages(fileList) {
    if (!state || !state.project) { toast('还没有工程：先用 Word 建一篇，再补图', true); return; }
    var files = Array.prototype.slice.call(fileList || []).filter(function (f) { return /^image\//.test(String(f.type || '')); });
    if (!files.length) { toast('只支持 png / jpg / gif / webp', true); return; }
    var zone = el('dropZone');
    var label = zone ? zone.querySelector('b') : null;
    var before = label ? label.textContent : '';
    if (zone) zone.classList.add('busy');
    if (label) label.textContent = '正在插入 ' + files.length + ' 张…';
    Promise.all(files.map(readImageFile))
      .then(function (rows) { return api('/assets', { projectId: state.project.id, files: rows }); })
      .then(function (payload) {
        var added = payload.added || [];
        toast('补进 ' + added.length + ' 张图');
        if (payload.skipped && payload.skipped.length) toast(payload.skipped.join('；'), true);
        return load(true);
      })
      .catch(function (e) { toast(e.message, true); })
      .then(function () {
        if (zone) zone.classList.remove('busy');
        if (label) label.textContent = before;
      });
  }

  function renderStats() {
    var s = state.stats || { chars: 0, images: 0, sections: 0, blocks: 0 };
    var items = [
      ['字数', s.chars], ['图片', s.images], ['小节', s.sections], ['块', s.blocks]
    ];
    el('stats').innerHTML = items.map(function (row) {
      return '<div><dt>' + row[0] + '</dt><dd>' + row[1] + '</dd></div>';
    }).join('');
  }

  function renderXiumi() {
    var x = state.xiumi || {};
    var connected = !!x.connected;
    el('xiumiRow').innerHTML = '<span class="dot' + (connected ? ' on' : '') + '"></span>' +
      (connected ? ('已连接' + (x.authorizedAt ? ' · ' + fmtTime(x.authorizedAt) : ''))
        : '未连接：先 <button class="linky" type="button" id="xiumiConnectLink">连接秀米</button>（登录一次就够）');
    var xlink = el('xiumiConnectLink');
    if (xlink) xlink.onclick = connect;
    el('btnConnect').textContent = connected ? '重新授权' : '连接秀米账号';

    // 顶栏芯片：右侧栏 embed 态整条右栏是隐藏的，授权入口只能在顶栏
    var chip = el('btnXiumiChip');
    if (chip) {
      chip.classList.toggle('on', connected);
      var label = el('chipLabel');
      if (label) label.textContent = connected ? (EMBED ? '秀米 ✓' : '秀米 · 已连接') : (EMBED ? '连接秀米' : '连接秀米账号');
      chip.title = connected
        ? '已连接秀米' + (x.authorizedAt ? '（' + fmtTime(x.authorizedAt) + '）' : '') + ' · 已连接时不用再点，点一下是重新授权'
        : '点这里用你自己的秀米账号登录一次（授权前发布不了）';
    }
  }

  function renderTimeline() {
    var list = el('timeline');
    var events = (state.project && state.project.events) || [];
    if (!events.length) {
      list.innerHTML = '<li><span class="dotcol"><span class="d"></span></span><span>还没有动作。给我素材，我开始排。</span></li>';
      return;
    }
    list.innerHTML = events.slice().reverse().slice(0, 24).map(function (e) {
      return '<li class="k-' + escapeAttr(e.kind || '') + '"><span class="dotcol"><span class="d"></span></span>' +
        '<span><time>' + fmtTime(e.at) + '</time>' + escapeHtml(e.text) + '</span></li>';
    }).join('');
  }

  function renderPreview() {
    setPreviewAlert('', false);
    if (!state.project) {
      // 空态在 iframe 里，读不到父页的 CSS 变量，所以取当前主题算好的值写进去
      el('preview').srcdoc = '<body style="margin:0;display:grid;place-items:center;height:100vh;font:13px/1.9 -apple-system,system-ui;color:' +
        cssVar('ink-3') + ';background:' + cssVar('sheet') +
        ';text-align:center;padding:0 28px;"><div><b style="display:block;font-size:15px;color:' +
        cssVar('ink') + ';margin-bottom:8px;">这里会长出你的图文</b>把 Word（或分开发的图 + 文字）发给我，我先拆结构、配模板，再逐块排。</div></body>';
      return;
    }
    var src = '/xiumi/api/render?mode=fragment&projectId=' + encodeURIComponent(state.project.id) +
      '&session=' + encodeURIComponent(SESSION) + '&t=' + encodeURIComponent(state.project.updatedAt || '');
    var frame = el('preview');
    frame.onload = tunePreviewDoc;
    frame.src = src;
  }

  // 预览 iframe 只该有正文：浏览器默认的 8px 边距和那条粗滚动条会让"手机框"显得脏。
  function tunePreviewDoc() {
    try {
      var doc = el('preview').contentDocument;
      if (!doc || !doc.head) return;
      if (!doc.getElementById('xm-preview-chrome')) {
        var st = doc.createElement('style');
        st.id = 'xm-preview-chrome';
        st.textContent = 'html,body{margin:0;padding:0;}::-webkit-scrollbar{width:0;height:0;}html{scrollbar-width:none;}';
        doc.head.appendChild(st);
      }
      hardenPreviewImages(doc);
    } catch (e) {
      // 跨域或错误页时别留一块白：至少说清「预览没加载出来」
      setPreviewAlert('预览没加载出来：渲染接口打不开，或这个 iframe 不是同源页面。', true);
    }
  }

  // ── 预览里的图：地址归一 + 失败必须看得见 ────────────────────────────────
  // 宿主渲染片段时，图片地址是 `http://` + 请求头里的 host 拼出来的（host/routes.mjs）。
  // 面板一旦经 https 打开（DSH Go 隧道 / 反代 / desktop 自定义协议），这些 http 地址就
  // 成了混合内容，浏览器会把图整批拦掉：正文照常、图全空——「预览里看不到图」。
  // 客户端在进 iframe 之前把同源地址改成相对地址，协议跟着页面走，不再赌宿主猜对协议。
  function normalizeAssetSrc(src) {
    var raw = String(src || '');
    if (!/^https?:\/\//i.test(raw)) return raw;
    var u;
    try { u = new URL(raw, location.href); } catch (e) { return raw; }
    var loop = function (h) { return h === 'localhost' || h === '127.0.0.1' || h === '[::1]'; };
    // 127.0.0.1 与 localhost 是同一台机器：宿主按请求头拼地址时会写成另一个写法，
    // 那种「同名不同写法」也当同源处理，否则隧道/反代下会误判成外源、把 http 原样留在 https 页面里。
    var sameBox = u.port === location.port && loop(u.hostname) && loop(location.hostname);
    if (u.host !== location.host && !sameBox) return raw;   // 秀米图床等别的源：原样留着
    return u.pathname + u.search;                  // 同源：去掉协议与主机，https 页面也不会被拦
  }

  function assetNameFromSrc(src) {
    var raw = String(src || '');
    if (!raw) return '';
    try {
      var u = new URL(raw, location.href);
      var parts = u.pathname.split('/');
      return decodeURIComponent(parts[parts.length - 1] || '');
    } catch (e) { return ''; }
  }

  // 同一张图在工程数据里还有秀米图床地址（remoteUrl）：本地文件丢了就用它顶上，
  // 预览仍然显示真图，而不是一块红框（AD-3：预览用本地渲染 + 图床真图）。
  function projectAssetRemote(asset) {
    var blocks = (state.project && state.project.blocks) || [];
    for (var i = 0; i < blocks.length; i += 1) {
      var b = blocks[i];
      if (b && b.type === 'image' && b.asset === asset && b.remoteUrl) return b.remoteUrl;
    }
    return '';
  }

  function setPreviewAlert(text, withRetry) {
    var bar = el('previewAlert');
    if (!bar) return;
    if (!text) { bar.hidden = true; bar.innerHTML = ''; return; }
    bar.hidden = false;
    bar.innerHTML = '<span>' + escapeHtml(text) + '</span>' +
      (withRetry ? '<button class="linky" type="button" id="previewAlertRetry">整篇重试</button>' : '');
    var btn = bar.querySelector('#previewAlertRetry');
    if (btn) btn.onclick = reloadPreview;
  }

  function reloadPreview() {
    if (!state.project) return;
    var frame = el('preview');
    frame.onload = tunePreviewDoc;
    frame.src = '/xiumi/api/render?mode=fragment&projectId=' + encodeURIComponent(state.project.id) +
      '&session=' + encodeURIComponent(SESSION) + '&t=' + encodeURIComponent(state.project.updatedAt || '') +
      '&r=' + Date.now();
    toast('重新拉取预览…');
  }

  // 逐张接管预览里的图：改地址 → 失败先试图床 → 还失败就把原因画在图片原来的位置上。
  function hardenPreviewImages(doc) {
    var imgs = doc.querySelectorAll('img');
    var want = ((state.project && state.project.blocks) || []).filter(function (b) { return b.type === 'image'; }).length;
    if (want && !imgs.length) {
      setPreviewAlert('正文有 ' + want + ' 张图，预览里一张都没渲染出来：渲染接口这一环有问题。', true);
      return;
    }
    for (var i = 0; i < imgs.length; i += 1) hardenPreviewImage(doc, imgs[i]);
    refreshPreviewAlert(doc);
  }

  function hardenPreviewImage(doc, img) {
    var raw = img.getAttribute('src') || '';
    var label = assetNameFromSrc(raw);
    if (!raw) {
      markMissingImage(doc, img, '这一段没有图片地址', label || '图片');
      return;
    }
    var norm = normalizeAssetSrc(raw);
    if (norm !== raw) img.setAttribute('src', norm);
    img.setAttribute('data-xm-src', norm);
    img.setAttribute('data-xm-asset', label);
    if (!img.getAttribute('alt')) img.setAttribute('alt', label || '图片');
    img.addEventListener('error', function () { degradePreviewImage(doc, img); });
    // 事件可能已经错过了（脚本接管时这张图早失败过）
    if (img.complete && img.naturalWidth === 0) degradePreviewImage(doc, img);
  }

  // 本地图打不开、图床顶上了：屏幕上显示的还是同一张图，预览没有坏。
  // 这种「已经自愈」的事不该每张图弹一条黑气泡（11 张图 = 11 条，像报错洪水），
  // 只在控制台记一条总数给排障看（T18）。
  var fallbackLabels = [];
  var fallbackTimer = null;
  function noteQuietFallback(label) {
    fallbackLabels.push(label);
    if (fallbackTimer) clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(function () {
      var n = fallbackLabels.length;
      fallbackLabels = [];
      fallbackTimer = null;
      if (n && window.console && console.info) {
        console.info('[xiumi] ' + n + ' 张本地图这次没直接打开，预览已自动改用秀米图床的同一张图（成品不受影响）');
      }
    }, 500);
  }

  function degradePreviewImage(doc, img) {
    if (img.getAttribute('data-xm-missing') === '1') return;
    img.setAttribute('data-xm-missing', '1');
    var label = img.getAttribute('data-xm-asset') || '图片';
    var remote = projectAssetRemote(label);
    if (remote && img.getAttribute('data-xm-tried-remote') !== '1') {
      img.setAttribute('data-xm-tried-remote', '1');
      var probe = new Image();
      // 秀米图床有防盗链：带头 Referer 会 403，必须 no-referrer 才拿得到真图。
      probe.referrerPolicy = 'no-referrer';
      probe.onload = function () {
        removeMissingImage(img);
        img.referrerPolicy = 'no-referrer';
        img.setAttribute('data-xm-missing', '0'); // 图床也可能失败：再失败要能落回原因说明
        img.src = remote;
        noteQuietFallback(label);
        refreshPreviewAlert(doc);
      };
      probe.onerror = function () { explainImageFailure(doc, img); };
      probe.src = remote;
      return;
    }
    explainImageFailure(doc, img);
  }

  // 失败原因不猜：真去请求一次，把 HTTP 状态 / 混合内容 / 断网说清楚。
  function explainImageFailure(doc, img) {
    var src = img.getAttribute('data-xm-src') || img.getAttribute('src') || '';
    var label = img.getAttribute('data-xm-asset') || '图片';
    fetch(src, { method: 'GET', cache: 'no-store' })
      .then(function (r) {
        if (r.ok) markMissingImage(doc, img, '地址能打开，但浏览器没把它当图加载（被拦或格式不对）', label);
        else markMissingImage(doc, img, 'HTTP ' + r.status, label);
      })
      .catch(function () {
        var mixed = location.protocol === 'https:' && /^http:\/\//i.test(src);
        markMissingImage(doc, img, mixed ? '页面是 https、图片地址是 http，被当混合内容拦了' : '网络断了，或这个地址打不开', label);
      });
  }

  function markMissingImage(doc, img, reason, label) {
    var box = img.parentNode;
    if (!box) return;
    removeMissingImage(img);
    var ph = doc.createElement('div');
    ph.className = 'xm-img-missing';
    ph.setAttribute('data-xm-for', label);
    ph.setAttribute('style', 'margin:6px 0;padding:14px 12px;text-align:center;font-size:12px;line-height:1.9;' +
      'border:1px dashed ' + (cssVar('bad') || '#b45') + ';border-radius:6px;' +
      'background:' + (cssVar('bad-soft') || 'transparent') + ';color:' + (cssVar('bad') || '#b45') + ';');
    ph.innerHTML = '<div>图没加载：' + escapeHtml(reason) + '<br />' + escapeHtml(label) + '</div>';
    var retry = doc.createElement('button');
    retry.type = 'button';
    retry.textContent = '重试这张';
    retry.setAttribute('style', 'margin-top:8px;padding:3px 12px;border:1px solid currentColor;border-radius:999px;' +
      'background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;');
    retry.onclick = function () { retryPreviewImage(doc, img, ph); };
    ph.appendChild(retry);
    box.insertBefore(ph, img.nextSibling);
    img.setAttribute('data-xm-broken', '1');
    img.setAttribute('data-xm-last-reason', reason);
    img.style.display = 'none';
    refreshPreviewAlert(doc);
  }

  function removeMissingImage(img) {
    img.removeAttribute('data-xm-broken');
    img.removeAttribute('data-xm-missing');
    img.style.display = '';
    var box = img.parentNode;
    if (!box) return;
    var olds = box.querySelectorAll('.xm-img-missing');
    for (var i = 0; i < olds.length; i += 1) olds[i].remove();
  }

  function retryPreviewImage(doc, img, ph) {
    if (ph && ph.parentNode) ph.remove();
    var label = img.getAttribute('data-xm-asset') || '图片';
    removeMissingImage(img);
    var src = img.getAttribute('data-xm-src') || img.getAttribute('src') || '';
    if (!src) { markMissingImage(doc, img, '这一段没有图片地址', label); return; }
    img.removeAttribute('data-xm-tried-remote');
    // 带上随机参数：素材路由带 max-age=300，别让一次失败被缓存住
    img.src = src + (src.indexOf('?') >= 0 ? '&' : '?') + 'r=' + Date.now();
    toast('重试「' + label + '」…');
    refreshPreviewAlert(doc);
  }

  function refreshPreviewAlert(doc) {
    if (!doc) {
      try { doc = el('preview').contentDocument; } catch (e) { doc = null; }
    }
    var miss = doc ? doc.querySelectorAll('.xm-img-missing').length : 0;
    if (!miss) { setPreviewAlert('', false); return; }
    setPreviewAlert('有 ' + miss + ' 张图没加载出来：原因写在图原来的位置上。', true);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escapeAttr(s) { return String(s == null ? '' : s).replace(/[^a-zA-Z0-9_-]/g, ''); }

  function render() {
    if (!state) return;
    var p = state.project;
    el('cwdLabel').textContent = shortCwd(state.cwd);
    el('docTitle').textContent = p ? p.title : '还没有图文';
    el('docState').innerHTML = '<em></em>' + (p ? (p.status === 'published' ? '已发布' : '草稿') : '空');
    el('docState').classList.toggle('live', !!(p && p.events && p.events.length));
    el('canvasMeta').textContent = p ? ((state.stats.chars || 0) + ' 字 · ' + (state.stats.images || 0) + ' 图') : '';
    el('canvasFoot').textContent = p ? ('主题：' + themeName(p.theme) + ' · 最后更新 ' + fmtTime(p.updatedAt)) : '';
    // 面板跟着工程主题走：纸色、强调色、线色全部由 CSS 变量驱动（色值只活在 host/themes.mjs）
    var theme = themeById(p ? p.theme : '') || defaultTheme();
    applyTheme(theme);
    var note = el('themeNote');
    if (note) {
      note.textContent = theme
        ? ('当前「' + theme.name + '」· ' + (theme.tagline || theme.desc || '') + ' 标题最深、正文居中、注释最浅。')
        : '标题最深、正文居中、注释最浅。';
    }
    el('btnCopy').disabled = !p;
    el('btnExport').disabled = !p;
    el('btnPublish').disabled = !p;
    el('btnCover').disabled = !p;
    renderProjects();
    renderOutline();
    renderSwatches();
    renderCover();
    renderAssets();
    renderStats();
    renderXiumi();
    renderTimeline();
    renderPreview();
    el('shell').hidden = false;
    el('boot').hidden = true;
  }

  function themeName(id) {
    var found = themeById(id);
    return found ? found.name : id;
  }

  function load(force) {
    return loadThemes().then(function () { return api('/state'); }).then(function (payload) {
      state = payload;
      var stamp = (payload.project ? payload.project.updatedAt : '') + '|' + (payload.projects || []).length;
      if (force || stamp !== lastStamp) {
        lastStamp = stamp;
        render();
      } else {
        renderXiumi();
        renderTimeline();
        renderProjects();
      }
      return payload;
    }).catch(function (e) {
      if (el('boot') && !el('boot').hidden) {
        el('boot').innerHTML = '<div style="text-align:center;max-width:320px;line-height:1.9;color:var(--ink-3);font-size:12.5px;">工作台连不上宿主路由：' + escapeHtml(e.message) +
          '<div style="margin-top:10px"><button class="linky" type="button" id="bootRetry">重试</button></div></div>';
        var bootRetry = el('bootRetry');
        if (bootRetry) bootRetry.onclick = function () { load(true); };
      } else {
        toast(e.message, true);
      }
    });
  }

  var XIUMI_PAPERS = 'https://xiumi.us/#/studio/papers';
  var lastAuthUrl = '';

  // 复制完顺手把秀米「我的图文」打开：接下来只剩一次 Ctrl+V
  // 窗口必须在点击的同一个事件里开（异步 fetch 之后再 window.open 会被浏览器拦掉）。
  function openXiumiEditor() {
    try {
      var win = window.open('', 'xiumi-papers');
      return win || null;
    } catch (e) {
      return null;
    }
  }

  function goXiumiEditor(win) {
    if (!win) return false;
    try {
      win.location.replace(XIUMI_PAPERS);
      win.focus();
      return true;
    } catch (e) {
      return false;
    }
  }

  function copyToXiumi(publishing) {
    if (!state.project) return;
    var papersWin = openXiumiEditor();
    var pid = state.project.id;
    var base = '/xiumi/api/render?mode=embed&remote=1&projectId=' + encodeURIComponent(pid) + '&session=' + encodeURIComponent(SESSION);
    // ① 先把图传进秀米图床：秀米服务器取不到 127.0.0.1 的图，地址不换，粘过去就是裂图。
    //    （实测：秀米 MCP 没有「新建图文」的工具，所以粘贴这条路是唯一能真进「我的图文」的。）
    var prep = fetch('/xiumi/api/assets/to-xiumi', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: SESSION, projectId: pid })
    }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });

    prep
      .then(function (up) {
        if (up && up.uploaded && up.uploaded.length) toast('已传 ' + up.uploaded.length + ' 张图进秀米图床');
        if (up && up.failed && up.failed.length) {
          toast('有 ' + up.failed.length + ' 张图没进图床（' + (up.failed[0].error || '未知原因') + '），这类图粘过去会裂', true);
        }
        // ② 渲染的是同一份正文，只是图换成图床地址：预览 / 导出 / 粘贴不分成三套版式（PRINCIPLES §3）
        return fetch(base);
      })
      .then(function (r) {
        if (!r.ok) throw new Error('渲染失败（' + r.status + '）');
        return r.text();
      })
      .then(function (html) {
        if (html.indexOf('这里缺一张图') >= 0) {
          toast('片段里还有缺图位：先补图再复制，否则粘过去会少图', true);
          return;
        }
        var blob = new Blob([html], { type: 'text/html' });
        var text = new Blob([stripTags(html)], { type: 'text/plain' });
        var hint = '已复制。秀米「我的图文」里新建一篇 → 正文区 Ctrl+V → 右上「保存」（或 Ctrl+S），再填标题';
        var steps = '① 点右边「打开我的图文」→ 新建一个图文　② 鼠标点正文区，按 Ctrl+V　③ 按 Ctrl+S 保存';
        if (navigator.clipboard && window.ClipboardItem) {
          return navigator.clipboard.write([new ClipboardItem({ 'text/html': blob, 'text/plain': text })]).then(function () {
            var opened = goXiumiEditor(papersWin);
            if (publishing || !opened) {
              showAuthBar(XIUMI_PAPERS, publishing ? steps : '窗口没自动开：点右边的链接去「我的图文」新建一篇，再按 Ctrl+V。');
              el('authBarLink').textContent = '打开我的图文';
            }
            toast(opened ? hint : hint + '；浏览器没自动开窗口，用顶上那条链接');
          });
        }
        // 兜底：让宿主给完整文档（图片内嵌），在刚开出来的窗口里打开，全选复制
        var docUrl = '/xiumi/api/render?mode=export&embed=1&projectId=' + encodeURIComponent(pid) + '&session=' + encodeURIComponent(SESSION);
        var opened2 = false;
        if (papersWin && !papersWin.closed) {
          try { papersWin.location.replace(docUrl); papersWin.focus(); opened2 = true; } catch (e) { opened2 = false; }
        }
        if (!opened2) {
          showAuthBar(docUrl, '剪贴板不可用：点右边在新标签打开内嵌图版，全选复制后粘进秀米。');
          el('authBarLink').textContent = '打开内嵌图版';
          return;
        }
        toast('剪贴板不可用：已在新窗口打开内嵌图版，全选复制后粘进秀米');
      })
      .catch(function (e) { toast('复制失败：' + e.message, true); });
  }

  function stripTags(html) {
    var d = document.createElement('div');
    d.innerHTML = html;
    return d.textContent || '';
  }

  function exportHtml() {
    if (!state.project) return;
    // 导出 = 宿主 renderStandalone 的完整文档（与预览同一份正文，只多一层文档外壳）
    var url = '/xiumi/api/render?mode=export&projectId=' + encodeURIComponent(state.project.id) + '&session=' + encodeURIComponent(SESSION);
    fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error('渲染失败（' + r.status + '）');
        return r.text();
      })
      .then(function (html) {
        if (html.indexOf('data:image/') < 0 && (state.project.assets || []).length) {
          toast('导出的文件里没有内嵌图片，先别用它：看右边「素材」里有没有标着「图上丢了」的', true);
          var assets = el('assetList');
          if (assets && assets.scrollIntoView) assets.scrollIntoView({ block: 'center', behavior: 'smooth' });
          return;
        }
        var blob = new Blob([html], { type: 'text/html' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (state.project.title || 'xiumi') + '.html';
        a.click();
        toast('HTML 已导出（图片已内嵌，双击就能看）');
      })
      .catch(function (e) { toast('导出失败：' + e.message, true); });
  }

  var connecting = false;
  var pendingPublish = false;   // 点了发布但还没授权：连上后自动接着发

  // 等授权完成：回调页会在同源窗口里 postMessage，同时兜底轮询状态。
  function watchAuthorization(popup) {
    var tries = 0;
    if (connecting) return;
    connecting = true;
    var stop = function () { connecting = false; clearInterval(timer); };
    var done = function () {
      stop();
      try { if (popup && !popup.closed) popup.close(); } catch (e) { /* 关闭被拦就算了 */ }
      hideAuthBar();
      toast('秀米已连接，可以直接发布了');
      load(true).then(function () {
        if (pendingPublish) { pendingPublish = false; publish(); }   // 点发布被挡下的人，连上就直接发
      });
    };
    var timer = setInterval(function () {
      tries += 1;
      if (tries > 120) { stop(); return; }          // 3 分钟没成就不再轮询
      api('/xiumi/status').then(function (st) {
        if (st && st.connected) done();
      }).catch(function () { /* 一会儿再试 */ });
    }, 1500);
    window.addEventListener('message', function (event) {
      if (event.origin !== window.location.origin) return;
      if (event.data && event.data.type === 'xiumi:oauth' && event.data.ok) done();
    }, { once: true });
  }

  // 弹窗被拦时不是只弹一句 toast（那句话里的地址不能点），而是在顶上留一条能点的路。
  // 没有地址就把链接藏起来：href="#" 的「假蓝字」点了什么都发生不了，比不显示更糟。
  function showAuthBar(url, text) {
    var bar = el('authBar');
    var link = el('authBarLink');
    var txt = el('authBarText');
    if (!bar || !link) return;
    lastAuthUrl = String(url || '');
    if (txt) txt.textContent = text || '没能自动打开浏览器。点「复制链接」粘到地址栏回车，或点「手动打开授权页」——登录同意后这里会自动变成「已连接」。';
    if (lastAuthUrl && lastAuthUrl !== '#') {
      link.href = lastAuthUrl;
      link.hidden = false;
    } else {
      link.href = '#';
      link.hidden = true;
    }
    bar.hidden = false;
  }

  // 复制一条地址：clipboard 优先，失败退回 textarea + execCommand（Electron / 老浏览器还有这条路）。
  function copyText(text) {
    var s = String(text || '');
    if (!s) return Promise.reject(new Error('没有可复制的地址'));
    var legacy = function () {
      var ta = document.createElement('textarea');
      ta.value = s;
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } finally { document.body.removeChild(ta); }
      if (!ok) throw new Error('手动选中这条地址复制：' + s);
      return true;
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(s).catch(legacy);
    }
    return Promise.resolve().then(legacy);
  }

  // 一个出口管所有「提示里的蓝字」：Electron 交给系统浏览器；网页里先开窗口，
  // 被拦就复制地址、把能点的链接留在顶部黄条上。每个分支都有一句 toast，不静默。
  function openLink(url, okText) {
    var target = String(url || '');
    if (!target || target === '#') {
      toast('这里还没有可打开的链接：先点「连接秀米」', true);
      return false;
    }
    var desktop = window.dshDesktop;
    if (desktop && typeof desktop.openExternal === 'function') {
      try {
        desktop.openExternal(target);
        toast(okText || '已在系统浏览器打开');
        return true;
      } catch (e) { /* 落到 window.open */ }
    }
    // 注意：features 里带 noopener 时 window.open 一律返回 null，没法拿它判断「被拦了」；
    // 这里不用 noopener，开出来之后再把 win.opener 清掉。
    var win = null;
    try { win = window.open(target, '_blank'); } catch (e) { win = null; }
    if (win) {
      try { win.opener = null; } catch (e) { /* 跨域时置空会被拒，无妨 */ }
      toast(okText || '已在新标签打开');
      return true;
    }
    showAuthBar(target, '浏览器拦住了新标签：地址已经复制，也可以点右边的链接直接打开。');
    el('authBarLink').textContent = '直接打开这条链接';
    copyText(target).then(function () {
      toast('新标签被拦了，已复制地址：粘到浏览器地址栏回车就能打开');
    }).catch(function (e) {
      toast(e.message || '复制失败', true);
    });
    return false;
  }

  // 复制授权链接：iframe 里弹窗可能被静默拦掉，粘贴到自己浏览器是最不会失败的一条路。
  function copyAuthUrl() {
    if (!lastAuthUrl) {
      toast('还没有可复制的授权链接：先点「连接秀米」', true);
      return;
    }
    copyText(lastAuthUrl).then(function () {
      toast('授权链接已复制：粘到浏览器地址栏回车（登录同意后这里会自动连上）');
    }).catch(function (e) {
      toast(e.message || '复制失败：手动选中这条地址', true);
    });
  }

  function hideAuthBar() {
    var bar = el('authBar');
    if (bar) bar.hidden = true;
  }

  // 面板活在 iframe 里：window.open / target=_blank 会被 Electron 或浏览器静默拦掉，
  // 用户看到的就是「点了没反应」。所以授权页交给宿主用系统默认浏览器打开，不赌弹窗。
  function openAuthOutside(target) {
    return fetch('/xiumi/api/oauth/open?url=' + encodeURIComponent(target), { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .catch(function () { return { ok: false }; });
  }

  function connect() {
    var chip = el('btnXiumiChip');
    if (chip) chip.classList.add('busy');
    api('/oauth/start').then(function (payload) {
      hideAuthBar();
      if (!payload || !payload.url) throw new Error('宿主没给出授权地址');
      return openAuthOutside(payload.url).then(function (r) {
        if (r && r.ok) {
          toast('已在浏览器打开秀米登录页：登录并点「同意授权」，这里会自动变成已连接');
        } else {
          showAuthBar(payload.url, '没能自动打开浏览器。点「复制链接」，粘到浏览器地址栏回车；登录同意后这里会自动连上。');
          toast('需要你手动开一下授权页：顶上有「复制链接」', true);
        }
        watchAuthorization(null);   // 没弹窗也能靠 1.5s 轮询 /xiumi/status 等到连接
      });
    }).catch(function (e) {
      toast(e.message, true);
    }).then(function () {
      setTimeout(function () { if (chip) chip.classList.remove('busy'); }, 1500);
    });
  }

  // 一键发布＝把「能自动的都做完」：传图 → 渲染 → 写剪贴板 → 打开「我的图文」。
  // 最后那一下 Ctrl+V 只能人来按（浏览器的剪贴板与粘贴事件不接受跨页注入），
  // 面板不假装自己按了：把「还差一步」写得足够清楚，人按一下 Ctrl+V / Ctrl+S 就完成。
  function publish() {
    if (!state.project) return;
    if (!(state.xiumi && state.xiumi.connected)) {
      pendingPublish = true;
      toast('还没连秀米：登录授权后会自动接着发布');
      connect();
      return;
    }
    copyToXiumi(true);
  }

  function layoutImages() {
    if (!state.project) return;
    var btn = el('btnLayoutImages');
    btn.disabled = true;
    api('/layout-images', { projectId: state.project.id })
      .then(function (payload) {
        toast('已按小节分好：' + (payload.moved || 0) + ' 张图');
        return load(true);
      })
      .catch(function (e) { toast(e.message, true); })
      .then(function () { btn.disabled = false; });
  }

  function duplicate() {
    if (!state.project) return;
    var btn = el('btnDuplicate');
    btn.disabled = true;
    btn.textContent = '正在另存…';
    api('/duplicate', { projectId: state.project.id })
      .then(function (payload) {
        toast('已另存一版：' + payload.project.title);
        return load(true);
      })
      .catch(function (e) { toast(e.message, true); })
      .then(function () {
        btn.disabled = false;
        btn.textContent = EMBED ? '另存' : '另存一版';
      });
  }

  function redrawCover() {
    if (!state.project) return;
    var btn = el('btnCover');
    btn.disabled = true;
    btn.textContent = '正在生成…';
    api('/cover', { projectId: state.project.id })
      .then(function () { toast('封面已重绘'); return load(true); })
      .catch(function (e) { toast(e.message, true); })
      .then(function () { btn.disabled = false; btn.textContent = '重新生成封面'; });
  }

  // ── 参考模板：选秀米模板商店里免费的几篇看气质，只做参考，不到模板本体里塞内容 ──
  var tplLoaded = false;
  function renderTemplates(payload) {
    var list = el('tplList');
    var hint = el('tplHint');
    if (!list) return;
    list.innerHTML = '';
    var items = (payload && payload.items) || [];
    if (!items.length) {
      hint.textContent = '';
      var empty = document.createElement('li');
      empty.className = 'tpl-empty';
      empty.textContent = (payload && payload.error) ? payload.error : '没搜到，换个词试试';
      list.appendChild(empty);
      return;
    }
    hint.textContent = items.length + ' / ' + (payload.total || items.length);
    items.forEach(function (it) {
      var li = document.createElement('li');
      li.className = 'tpl-item';
      var thumb = it.cover
        ? '<img src="' + escapeHtml(it.cover) + '" alt="" loading="lazy" referrerpolicy="no-referrer" />'
        : '<span class="tpl-noimg"></span>';
      var link = it.showUrl
        ? '<a href="' + escapeHtml(it.showUrl) + '" target="_blank" rel="noopener noreferrer" title="去秀米看这篇模板">预览</a>'
        : '';
      li.innerHTML = thumb + '<div class="tpl-body"><b>' + escapeHtml(it.title || '未命名') + '</b>' +
        '<i>' + escapeHtml(it.author || '佚名') + ' · 复制 ' + (it.copies || 0) + '</i></div>' + link;
      list.appendChild(li);
      var go = li.querySelector('a');
      if (go) go.addEventListener('click', function (ev) {
        ev.preventDefault();
        openLink(go.getAttribute('href'), '已在浏览器打开这篇模板的秀米阅读页');
      });
    });
  }

  function loadTemplates(q, refresh) {
    var hint = el('tplHint');
    if (!hint) return Promise.resolve();
    if (!refresh && !tplLoaded) hint.textContent = '读取中…';
    tplLoaded = true;
    var path = '/templates?limit=6' + (q ? '&q=' + encodeURIComponent(q) : '');
    var first = refresh ? api('/templates/refresh', {}) : Promise.resolve(null);
    return first
      .then(function () { return api(path); })
      .then(function (payload) { renderTemplates(payload); return payload; })
      .catch(function (e) {
        hint.textContent = '';
        renderTemplates({ items: [], error: e.message });
      });
  }

  // ── 套模板抽屉：选一篇账号里存过的模板，把这篇的文字与图灌进去 ──────────
  // 前端只认宿主返回的 showId/editUrl，不自己拼秀米地址；每一步都要有可见结果：
  // 卡片里回显槽位报表/作品号，失败给黄条 + 一句人话，不白屏、不静默。
  var tplShows = null;        // 最近一次 /template/shows 的返回
  var tplShowsBusy = false;

  // 秀米 copy_show 的 title_postfix 硬限制 8 个字：默认给「·时:分」，输入框里也能改
  var tplPostfixValue = '';
  function defaultPostfix() {
    var d = new Date();
    return '·' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  function currentPostfix() {
    var pf = el('tplPostfix');
    var v = String((pf && pf.value) || tplPostfixValue || '').trim();
    return (v || defaultPostfix()).slice(0, 8);
  }

  function drawerAlert(text) {
    var node = el('tplDrawerAlert');
    if (!node) return;
    if (!text) { node.hidden = true; node.textContent = ''; return; }
    node.hidden = false;
    node.textContent = text;
  }

  // 接口错误翻成人话：405/404 是宿主还没载入这组接口（老版本），其余照实说。
  function templateErrorText(e, kind) {
    var status = String((e && e.status) || '');
    var msg = String((e && e.message) || '读不到模板').replace(/^套模板失败：/, '');
    var verb = kind === 'apply' ? '套模板' : '读模板';
    if (status === '405') return '宿主还没载入新接口，重载插件后可用。（HTTP 405）';
    if (status === '404') return '宿主没认出这个接口（HTTP 404）：先重载插件，再点「刷新」。';
    if (/登录|授权|token|oauth|session|凭证|未连接/i.test(msg)) {
      return '还没连上秀米：点顶栏「连接秀米」登录一次，再回来点「刷新」。（' + msg + '）';
    }
    if (/^5\d\d$/.test(status)) {
      return '宿主' + verb + '时出错了（HTTP ' + status + '）：多半是秀米那边一时不通，点「刷新」再试一次。（' + msg + '）';
    }
    return (kind === 'apply' ? '没套成：' : '读不到模板：') + msg;
  }

  function tplSlotsText(t) {
    var a = t.textSlots == null ? '?' : t.textSlots;
    var b = t.imageSlots == null ? '?' : t.imageSlots;
    return '文字 ' + a + ' 段 · 图位 ' + b + ' 个';
  }

  // 模板标题本身就是题材标签（「商务|科技|创新|行业峰会」这种），拆出来当小字；
  // summary 是给排障看的技术摘要（槽位数/深度），人不需要，别塞进卡片。
  function tplTagsText(t) {
    var parts = String(t.title || '').split(/[|｜/、·]/).map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length >= 2 && s.length <= 12; });
    return parts.length >= 2 ? '题材：' + parts.slice(0, 4).join('、') : '';
  }

  // 项目 id → 工程标题：成品标记要说清「是哪一篇的成稿」，光说「可能是成品」不够。
  function projectTitleOf(id) {
    var list = (state && state.projects) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].title || '';
    return '';
  }

  // 宿主只回字符串理由，没有正负号：按措辞分色（加分/扣分），认不出的一律当说明。
  // 先判扣分——「不够」里含「够」，顺序反了会把硬伤显示成加分。
  var REASON_MINUS = /对不上|偏少|不够|没有|几乎一样|超大标题槽|不适合|只能|放不进去|重复|扣分/;
  var REASON_PLUS = /对得上|够用|够放|贴合/;
  function reasonTone(r) {
    var s = String(r || '');
    if (REASON_MINUS.test(s)) return 'con';
    if (REASON_PLUS.test(s)) return 'pro';
    return 'note';
  }

  function reasonsHtml(reasons) {
    var buckets = { pro: [], con: [], note: [] };
    (reasons || []).forEach(function (r) { buckets[reasonTone(r)].push(r); });
    var sec = function (key, label) {
      if (!buckets[key].length) return '';
      return '<div class="reason-group ' + key + '"><span class="reason-label">' + label + '</span><ul>' +
        buckets[key].map(function (r) { return '<li>' + escapeHtml(String(r)) + '</li>'; }).join('') + '</ul></div>';
    };
    return sec('pro', '加分') + sec('con', '扣分') + sec('note', '其它');
  }

  // 干跑警告混着三种东西，混成一列会让人以为全是毛病：
  // 真跑也会这样（会影响成品）/ 知道就好（只是提示）/ 干跑本身不传图不生成图（正常现象）。
  var WARN_DRY = /干跑|真跑会/;
  var WARN_HARD = /槽位不够|空|放不进去|重复/;
  var WARN_GROUPS = [
    { key: 'hard', label: '会影响成品', hint: '真跑也会这样：换一个模板，或者改一下稿子。' },
    { key: 'info', label: '只是提示', hint: '知道就好，一般不用管。' },
    { key: 'dry', label: '干跑正常现象', hint: '干跑不上传图片、不生成占位图，真跑时会处理。' }
  ];
  function warnGroup(w) {
    var s = String(w || '');
    if (WARN_DRY.test(s)) return 'dry';       // 「干跑…槽是空的」要算正常现象，别被「空」抢走
    if (WARN_HARD.test(s)) return 'hard';
    return 'info';
  }
  function warningsHtml(warnings) {
    var buckets = { hard: [], info: [], dry: [] };
    (warnings || []).forEach(function (w) { buckets[warnGroup(w)].push(w); });
    return WARN_GROUPS.filter(function (g) { return buckets[g.key].length; }).map(function (g) {
      return '<div class="warn-group warn-' + g.key + '">' +
        '<b class="warn-head">' + g.label + '（' + buckets[g.key].length + '）</b>' +
        '<span class="warn-hint">' + g.hint + '</span>' +
        '<ul>' + buckets[g.key].map(function (w) { return '<li>' + escapeHtml(String(w)) + '</li>'; }).join('') + '</ul>' +
      '</div>';
    }).join('');
  }

  // 槽位角色形状：总槽数够、但正文槽不够的模板一样会把长段塞进标题框（T17 的结构打分就是按这个）。
  function tplShapeText(t) {
    var r = t.roleCounts;
    if (!r) return '';
    var parts = ['标题 ' + (r.title || 0), '小节 ' + (r.section || 0), '正文 ' + (r.body || 0)];
    if (Number(r.number || 0) > 0) parts.push('数字 ' + r.number);
    if (Number(r.deco || 0) > 0) parts.push('装饰 ' + r.deco);
    return '结构：' + parts.join(' · ');
  }

  function tplCardHtml(t) {
    var cover = t.cover || '';
    var tags = tplTagsText(t);
    var shape = tplShapeText(t);
    return '<article class="tpl-card" data-show="' + escapeHtml(String(t.showId)) + '">' +
      '<div class="tpl-card-cover">' +
        (cover
          ? '<img src="' + escapeHtml(cover) + '" alt="" loading="lazy" referrerpolicy="no-referrer" />'
          : '<span class="miss">没有封面</span>') +
      '</div>' +
      '<div class="tpl-card-main">' +
        '<b class="tpl-card-title" title="' + escapeHtml(t.title || '') + '">' + escapeHtml(t.title || ('未命名模板 ' + t.showId)) + '</b>' +
        '<span class="tpl-card-meta">' + escapeHtml(tplSlotsText(t)) + ' · ' + (t.released ? '已发布' : '未发布') + '</span>' +
        (shape ? '<span class="tpl-card-shape" title="模板的槽位按角色分：正文要落进正文槽，否则长段会被塞进标题框">' + escapeHtml(shape) + '</span>' : '') +
        (tags ? '<span class="tpl-card-why">' + escapeHtml(tags) + '</span>' : '') +
        '<div class="tpl-card-actions">' +
          '<button class="btn ghost" type="button" data-act="dry">预检</button>' +
          '<button class="btn" type="button" data-act="apply">套用并生成</button>' +
        '</div>' +
        '<div class="tpl-card-out" hidden></div>' +
      '</div>' +
    '</article>';
  }

  // 套过模板的那篇不是模板：槽里已经是本地工程的原文，再灌一次只会重复内容。
  // 后端 rankTemplates 已经不拿它当候选；这里也不给「预检/套用」按钮，只说明原因 + 一个去看的入口。
  function tplFilledCardHtml(t) {
    var proj = projectTitleOf(t.projectId) || '';
    var projShort = proj.length > 20 ? proj.slice(0, 20) + '…' : proj;
    return '<article class="tpl-card filled" data-show="' + escapeHtml(String(t.showId)) + '">' +
      '<div class="tpl-card-cover">' +
        (t.cover
          ? '<img src="' + escapeHtml(t.cover) + '" alt="" loading="lazy" referrerpolicy="no-referrer" />'
          : '<span class="miss">没有封面</span>') +
      '</div>' +
      '<div class="tpl-card-main">' +
        '<b class="tpl-card-title" title="' + escapeHtml(t.title || '') + '">' + escapeHtml(t.title || ('未命名 ' + t.showId)) + '</b>' +
        '<span class="tpl-card-badge">可能是成品</span>' +
        '<span class="tpl-card-meta">' + escapeHtml(tplSlotsText(t)) + (t.released ? ' · 已发布' : '') + '</span>' +
        '<span class="tpl-card-why" title="' + escapeHtml(proj ? '本地工程：' + proj : '') + '">' +
          (projShort ? '本地工程《' + escapeHtml(projShort) + '》里已经排过这篇：' : '槽里已经是本地工程的原文。') +
          '再套模板只会把内容重复一遍，所以不当模板用。</span>' +
        (t.editUrl
          ? '<div class="tpl-card-actions"><a class="linky tpl-filled-open" href="' + escapeHtml(t.editUrl) + '" target="_blank" rel="noopener noreferrer">去秀米看这篇</a></div>'
          : '') +
      '</div>' +
    '</article>';
  }

  function renderTplDrawer() {
    var body = el('tplDrawerBody');
    if (!body) return;
    var data = tplShows;
    if (!data) { body.innerHTML = '<p class="drawer-empty">正在读秀米账号里的模板…</p>'; return; }
    var list = data.templates || [];
    var otherItems = data.others || [];
    // 成品（本地工程的成稿）和「槽位太少当不了模板」都在 others 里：分开数，别混成一句「已经排过」
    var filled = otherItems.filter(function (t) { return t.likelyFilled; });
    var plainOthers = otherItems.length - filled.length;
    var notes = [];
    if (filled.length) notes.push(filled.length + ' 篇是本地工程的成稿（不当模板）');
    if (plainOthers > 0) notes.push(plainOthers + ' 篇槽位太少、当不了模板');
    var countText = list.length + ' 篇可当模板' + (notes.length ? '，另有 ' + notes.join('、') : '');
    var head = '<div class="drawer-ai">' +
      '<button class="btn" type="button" id="btnTplAuto">让 AI 按题材自己挑</button>' +
      '<span class="drawer-count">' + escapeHtml(countText) + '</span>' +
      '<p class="drawer-ai-out" id="tplAutoOut">不指定哪一篇：按标题 / 小节 / 导语里的题材投票，再看正文槽与图位够不够；挑中后原因分加分、扣分两栏列出。</p>' +
      '<label class="drawer-postfix"><span>标题后缀</span>' +
        '<input id="tplPostfix" type="text" maxlength="8" autocomplete="off" spellcheck="false" placeholder="' + escapeHtml(defaultPostfix()) + '" value="' + escapeHtml(tplPostfixValue) + '" />' +
        '<span class="drawer-postfix-hint">最多 8 字</span></label>' +
    '</div>';
    var cardsHtml = list.map(tplCardHtml).join('');
    if (!list.length && !filled.length) {
      cardsHtml = '<p class="drawer-empty">账号里还没有能套的模板：<br />先在秀米模板库点「使用模板」存一篇，再点上面的「刷新」。</p>';
    } else if (!list.length) {
      cardsHtml = '<p class="drawer-empty">这次没有能当模板的（槽位太少，或是本地工程的成稿）。<br />先把别的模板存进账号，再点上面的「刷新」。</p>';
    }
    var filledHtml = filled.length
      ? '<div class="drawer-group">' +
          '<div class="drawer-group-head">可能是成品的几篇' +
            '<span>槽里已经是本地工程的原文，再套一次只会重复内容，所以不给「预检 / 套用」按钮。</span>' +
          '</div>' +
          filled.map(tplFilledCardHtml).join('') +
        '</div>'
      : '';
    body.innerHTML = head + cardsHtml + filledHtml;
    el('btnTplAuto').onclick = autoPickTemplate;
    var pf = el('tplPostfix');
    if (pf) pf.oninput = function () {
      // maxlength 管不住脚本赋值/paste 的极端情况：前端再截一次
      if (pf.value.length > 8) pf.value = pf.value.slice(0, 8);
      tplPostfixValue = pf.value;
    };
  }

  function setCardBusy(card, busy) {
    var btns = card.querySelectorAll('[data-act]');
    for (var i = 0; i < btns.length; i++) btns[i].disabled = busy;
    card.classList.toggle('busy', busy);
  }

  function tplReportText(report) {
    var r = report || {};
    return (r.boundText == null ? '?' : r.boundText) + ' / ' + (r.textSlots == null ? '?' : r.textSlots) + ' 段文字，' +
      (r.boundImage == null ? '?' : r.boundImage) + ' / ' + (r.imageSlots == null ? '?' : r.imageSlots) + ' 个图位';
  }

  // 真跑成功那一行要能一眼核对：模板有多少槽、实际灌进去几张图。
  function tplResultLine(report) {
    var r = report || {};
    return '文字槽 ' + (r.textSlots == null ? '?' : r.textSlots) +
      ' / 图片槽 ' + (r.imageSlots == null ? '?' : r.imageSlots) +
      ' / 用了 ' + (r.boundImage == null ? '?' : r.boundImage) + ' 张图';
  }

  function applyTemplate(card, showId, dry) {
    if (!state || !state.project) { drawerAlert('先在左边选一篇工程，再来套模板。'); return; }
    var out = card.querySelector('.tpl-card-out');
    setCardBusy(card, true);
    out.hidden = false;
    out.innerHTML = dry ? '正在预检：只算槽位，不复制、不产生作品…' : '正在复制模板并把这篇灌进去，十几秒也算正常…';
    api('/template/apply', { projectId: state.project.id, showId: showId, dryRun: dry, titlePostfix: currentPostfix() })
      .then(function (res) {
        var report = res.report || {};
        var cardTitle = (card.querySelector('.tpl-card-title') || { textContent: '' }).textContent || '';
        var tplTitle = res.title || (res.picked && res.picked.title) || cardTitle;
        var warns = res.warnings || [];
        var html = dry
          ? '<b>预检通过</b>：模板《' + escapeHtml(tplTitle) + '》<br />' + escapeHtml(tplReportText(report))
          : '<b>已生成作品 ' + escapeHtml(String(res.showId)) + '</b>' +
            '<div class="tpl-report">' + escapeHtml(tplResultLine(report)) + '</div>' +
            '<span class="tpl-apply-title">' + escapeHtml(res.title || '') + '</span>';
        if (!dry && res.editUrl) {
          html += '<a class="linky tpl-open" href="' + escapeHtml(res.editUrl) + '" target="_blank" rel="noopener noreferrer">去秀米看这篇</a>';
        }
        if (warns.length) html += warningsHtml(warns);
        out.innerHTML = html;
        var link = out.querySelector('.tpl-open');
        if (link) link.onclick = function (e) {
          e.preventDefault();
          openLink(res.editUrl, '已在浏览器打开新作品：' + (res.title || ('作品 ' + res.showId)));
        };
        if (dry) {
          toast('预检完成：' + tplReportText(report) + (warns.length ? '，有 ' + warns.length + ' 条提醒' : ''));
        } else {
          toast('已套模板生成作品 ' + res.showId + (res.editUrl ? '：' + res.editUrl : ''));
          load(true);   // 创作过程里会多一条「已套用模板」，顺手刷出来
        }
      })
      .catch(function (e) {
        var why = String((e && e.message) || '未知错误').replace(/^套模板失败：/, '');
        var failed = (e && e.payload) || {};
        // 删稿那句已经单独显示，warnings 里重复的那条就不再列一遍
        var failWarns = (failed.warnings || []).filter(function (w) {
          return !(failed.cleanedShowId && String(w).indexOf(String(failed.cleanedShowId)) >= 0);
        });
        var failHtml = '<b>没套成：</b>' + escapeHtml(why);
        if (failed.cleanedShowId) {
          failHtml += '<br />复制出来的空稿 ' + escapeHtml(String(failed.cleanedShowId)) + ' 已经删进回收站，账号里不会留垃圾稿。';
        }
        if (failWarns.length) failHtml += warningsHtml(failWarns);
        out.innerHTML = failHtml;
        drawerAlert(templateErrorText(e, 'apply'));
        toast('套模板失败：' + why, true);
      })
      .then(function () { setCardBusy(card, false); });
  }

  function autoPickTemplate() {
    if (!state || !state.project) { drawerAlert('先在左边选一篇工程，再让 AI 挑模板。'); return; }
    var btn = el('btnTplAuto');
    var out = el('tplAutoOut');
    if (btn) btn.disabled = true;
    if (out) out.textContent = '正在按题材打分…';
    drawerAlert('');
    api('/template/apply', { projectId: state.project.id, dryRun: true })
      .then(function (res) {
        var picked = res.picked;
        if (!picked) throw new Error('宿主没回 picked（应该带 showId / title / reasons）');
        var reasons = picked.reasons || [];
        var score = picked.score == null ? '' : '（' + Math.round(picked.score * 100) / 100 + ' 分）';
        if (out) {
          var plus = reasons.filter(function (r) { return reasonTone(r) === 'pro'; }).length;
          var minus = reasons.filter(function (r) { return reasonTone(r) === 'con'; }).length;
          out.innerHTML = '<b>AI 挑了《' + escapeHtml(picked.title || '') + '》</b>' + escapeHtml(score) +
            (reasons.length
              ? '<span class="reason-counts">加分 ' + plus + ' 条 · 扣分 ' + minus + ' 条</span>' + reasonsHtml(reasons)
              : '<span class="reason-counts">没有特别加分或扣分的项</span>');
        }
        var cards = document.querySelectorAll('.tpl-card');
        for (var i = 0; i < cards.length; i++) {
          var on = Number(cards[i].getAttribute('data-show')) === Number(picked.showId);
          cards[i].classList.toggle('on', on);
          if (on && cards[i].scrollIntoView) cards[i].scrollIntoView({ block: 'nearest' });
        }
        toast('AI 挑了「' + (picked.title || '') + '」：' + reasons.length + ' 条理由，确认就点那卡的「套用并生成」');
      })
      .catch(function (e) {
        if (out) out.textContent = '没挑出来：' + (e.message || '未知错误');
        drawerAlert(templateErrorText(e));
        toast('让 AI 挑模板失败：' + (e.message || '未知错误'), true);
      })
      .then(function () { if (btn) btn.disabled = false; });
  }

  function loadTemplateShows(refresh) {
    if (tplShowsBusy) return Promise.resolve(tplShows);
    tplShowsBusy = true;
    drawerAlert('');
    var body = el('tplDrawerBody');
    if (body) body.innerHTML = '<p class="drawer-empty">正在读秀米账号里的模板…</p>';
    return api('/template/shows' + (refresh ? '?refresh=1' : ''))
      .then(function (payload) { tplShows = payload; renderTplDrawer(); return payload; })
      .catch(function (e) {
        tplShows = null;
        // 出错也要留一句人话在列表位置，不能只剩一片空白
        if (body) body.innerHTML = '<p class="drawer-empty">没读到模板列表：原因在上面那条黄条里。点右上「刷新」重试。</p>';
        drawerAlert(templateErrorText(e));
        return null;
      })
      .then(function (payload) { tplShowsBusy = false; return payload; });
  }

  function openTplDrawer() {
    var drawer = el('tplDrawer');
    if (!drawer) return;
    drawer.hidden = false;
    drawer.setAttribute('aria-hidden', 'false');
    if (tplShows) renderTplDrawer();
    else loadTemplateShows(false);
  }

  function closeTplDrawer() {
    var drawer = el('tplDrawer');
    if (!drawer) return;
    drawer.hidden = true;
    drawer.setAttribute('aria-hidden', 'true');
  }
  // 右侧栏最窄只有 300px 左右：长按钮文案会把顶栏顶出屏幕，嵌入态一律用短标签（完整说明留在 title 里）。
  if (EMBED) {
    el('btnCopy').textContent = '复制';
    el('btnPublish').textContent = '发布';
    el('btnDuplicate').textContent = '另存';
  }

  // 套模板抽屉：按钮开合、刷新、卡片里的动作（卡片是动态生成的，用事件委托接）。
  var tplBodyNode = el('tplDrawerBody');
  if (tplBodyNode) tplBodyNode.addEventListener('click', function (e) {
    // 成品卡上的「去秀米看这篇」也走同一条链接通道（真 <a href>，点击有 toast）
    var go = e.target && e.target.closest ? e.target.closest('a.tpl-filled-open') : null;
    if (go) {
      e.preventDefault();
      openLink(go.getAttribute('href'), '已在浏览器打开这篇：它是本地工程的成稿，不是模板');
      return;
    }
    var btn = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    var card = btn.closest('.tpl-card');
    if (!card) return;
    applyTemplate(card, Number(card.getAttribute('data-show')), btn.getAttribute('data-act') === 'dry');
  });
  el('btnTemplates').onclick = openTplDrawer;
  el('btnTplDrawerClose').onclick = closeTplDrawer;
  el('btnTplDrawerRefresh').onclick = function () {
    toast('正在重读账号里的模板…');
    loadTemplateShows(true).then(function (payload) {
      if (payload) toast('读好了：' + (payload.templates || []).length + ' 篇能套');
    });
  };
  document.addEventListener('keydown', function (e) {
    var d = el('tplDrawer');
    if (e.key === 'Escape' && d && !d.hidden) { e.preventDefault(); closeTplDrawer(); }
  });

  el('btnRefresh').onclick = function () { load(true); };
  el('btnCopy').onclick = copyToXiumi;
  el('btnExport').onclick = exportHtml;
  el('btnConnect').onclick = connect;
  el('btnXiumiChip').onclick = connect;
  // 把窄栏（右侧栏）升级成三栏工作台：新标签打开完整页，那里有工程/大纲 + 主题/封面/素材
  var fullBtn = el('btnFull');
  if (fullBtn) fullBtn.onclick = function () {
    var url = location.origin + '/xiumi/studio?session=' + encodeURIComponent(SESSION);
    // 以前是 window.open(..., 'noopener') 再判 !w：noopener 的句柄永远是 null，
    // 于是一边开了标签、一边又冒黄条说「浏览器拦住了新标签」。现在按真实结果说话。
    if (!openLink(url, '已在新标签打开完整工作台：左栏工程与大纲、中间预览、右边主题/封面/素材')) {
      el('authBarLink').textContent = '在新标签打开完整工作台';
    }
  };
  // 授权提示条上的蓝字：统一走 openLink（系统浏览器 / 新标签 / 复制兜底 + toast）
  var authLink = el('authBarLink');
  if (authLink) authLink.onclick = function (e) {
    e.preventDefault();
    openLink(lastAuthUrl, '已在浏览器打开授权页：登录并点「同意授权」，这里会自动变成已连接');
  };
  var authClose = el('authBarClose');
  if (authClose) authClose.onclick = hideAuthBar;
  var authCopy = el('authBarCopy');
  if (authCopy) authCopy.onclick = copyAuthUrl;
  el('btnPublish').onclick = publish;
  el('btnDuplicate').onclick = duplicate;
  el('btnLayoutImages').onclick = layoutImages;
  var tplBtn = el('btnTplSearch');
  if (tplBtn) {
    tplBtn.onclick = function () { loadTemplates(String(el('tplQ').value || '').trim(), false); };
    el('tplQ').onkeydown = function (e) {
      if (e.key === 'Enter') { e.preventDefault(); loadTemplates(String(el('tplQ').value || '').trim(), false); }
    };
    el('btnTplRefresh').onclick = function () {
      var btn = el('btnTplRefresh');
      btn.disabled = true;
      toast('正在重拉模板目录…');
      loadTemplates(String(el('tplQ').value || '').trim(), true).then(function (payload) {
        btn.disabled = false;
        if (!payload) return;
        var n = (payload.items || []).length;
        var total = payload.total == null ? n : payload.total;
        toast(n ? ('模板目录已重拉：' + n + ' / ' + total) : '模板目录已重拉，但一条也没拿到');
      });
    };
  }
  el('btnCover').onclick = redrawCover;
  el('btnAddImages').onclick = function () { el('filePick').click(); };
  el('filePick').onchange = function () { uploadImages(this.files); this.value = ''; };
  var dropZone = el('dropZone');
  if (dropZone) {
    dropZone.onclick = function () { el('filePick').click(); };
    dropZone.addEventListener('dragover', function (e) { e.preventDefault(); dropZone.classList.add('over'); });
    dropZone.addEventListener('dragleave', function () { dropZone.classList.remove('over'); });
    dropZone.addEventListener('drop', function (e) {
      e.preventDefault();
      dropZone.classList.remove('over');
      uploadImages(e.dataTransfer && e.dataTransfer.files);
    });
  }

  // 开发用：?debug=1 时把布局宽度写进 title，便于 headless --dump-dom 量（截图只能看出"被裁"）。
  if (qs.get('debug') === '1') {
    // 也给 _inspect 里的链接回归留个把手：能直接触发黄条/预览失败态，逐条点给人看。
    window.__xm = {
      toast: toast,
      openLink: openLink,
      showAuthBar: showAuthBar,
      setPreviewAlert: setPreviewAlert,
      reloadPreview: reloadPreview,
      renderXiumi: renderXiumi,
      // 真连接着的时候也要能复现「未连接」那句话里的蓝字，才点得出来给人看
      setConnected: function (v) { if (state.xiumi) state.xiumi.connected = !!v; renderXiumi(); },
      openTplDrawer: openTplDrawer,
      loadTemplateShows: loadTemplateShows,
      getTplShows: function () { return tplShows; },
      markMissingTest: function () { setPreviewAlert('有 3 张图没加载出来：原因写在图原来的位置上。', true); }
    };
    setTimeout(function () {
      var de = document.documentElement;
      var wide = [];
      var all = document.querySelectorAll('body *');
      for (var i = 0; i < all.length; i++) {
        var e2 = all[i], rr = e2.getBoundingClientRect();
        if (rr.width > 0 && rr.right > de.clientWidth + 1) {
          wide.push(e2.tagName + (e2.id ? '#' + e2.id : '') + ' w=' + Math.round(rr.width) + ' r=' + Math.round(rr.right));
        }
      }
      document.title = 'DIAG vw=' + de.clientWidth + ' docscroll=' + de.scrollWidth + ' body=' + document.body.scrollWidth + ' wide=' + wide.slice(0, 6).join(' ; ');
    }, 1500);
  }

  load(true);
  if (tplBtn) setTimeout(function () { loadTemplates('', false); }, 900);
  setInterval(function () {
    if (document.visibilityState === 'hidden') return;
    load(false);
  }, 2500);

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r' && e.shiftKey) {
      e.preventDefault();
      load(true);
    }
  });
})();
