/**
 * DSH 右侧栏席位：只做一件事——把 /xiumi/studio?embed=1&session=<id> 塞进面板。
 *
 * 为什么是 iframe 而不是把整个工作台写成 React：工作台的排版预览必须和
 * 「发布出去的 HTML」是同一份渲染结果，宿主侧渲染 → 页面 → iframe 自取，
 * 这条链上只有一个渲染实现，不会出现「面板好看、发出去变形」。
 */
window.__ModuleLoader__.load({
  id: "dsh-xiumi-studio",
  factory: function (require) {
    var React = require("react");
    var module = { exports: {} };
    var exports = module.exports;

    var name = "dsh-xiumi-studio";
    var inject = ["slots", "sessions"];
    var TAB_ID = "dsh-xiumi-studio";
    var TAB_KIND = "xiumi-studio";

    function service(ctx, key) {
      try {
        return typeof ctx.get === "function" ? ctx.get(key) : undefined;
      } catch (e) {
        return undefined;
      }
    }

    function currentSessionId(ctx, readMounted) {
      try {
        var sessions = service(ctx, "sessions");
        var snapshot = sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : null;
        if (snapshot && snapshot.current) return snapshot.current;
        var mounted = readMounted ? readMounted() : null;
        if (mounted) return mounted;
        if (snapshot && Array.isArray(snapshot.ids) && snapshot.ids.length === 1) return snapshot.ids[0];
      } catch (e) {
        /* 拿不到就当没有会话 */
      }
      return null;
    }

    // 面板壳（右侧栏这一圈）跟着当前主题走：色值唯一来源是宿主 /xiumi/api/state 里的 themes（themes.mjs）。
    // 拿不到就用系统色（Canvas / CanvasText / GrayText），这里不写任何一个色值。
    var CSS = [
      ".xm-panel{position:absolute;inset:0;display:flex;flex-direction:column;background:var(--xm-paper,Canvas);}",
      ".xm-panel-frame{flex:1;width:100%;border:0;display:block;background:var(--xm-paper,Canvas);}",
      ".xm-panel-empty{position:absolute;inset:0;display:grid;place-items:center;padding:24px;text-align:center;",
      "font:13px/1.9 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:var(--xm-sub,GrayText);background:var(--xm-paper,Canvas);}",
      ".xm-panel-empty b{display:block;font-size:15px;color:var(--xm-ink,CanvasText);margin-bottom:6px;}"
    ].join("");

    /**
     * 面板壳的颜色从主题来：/xiumi/api/state 里既有当前工程的 theme，也有五套主题的展示色。
     * 只写自己的 --xm-* 变量，不碰宿主的任何变量；拿不到就吃系统色，工作台照常能用。
     */
    function themeById(list, id) {
      if (!Array.isArray(list) || !list.length) return null;
      for (var i = 0; i < list.length; i += 1) {
        if (list[i] && list[i].id === id) return list[i];
      }
      return list[0];
    }

    function applyThemeVars(state) {
      if (!state) return;
      var theme = themeById(state.themes, state.project && state.project.theme);
      if (!theme) return;
      var root = typeof document !== "undefined" ? document.documentElement : null;
      if (!root || !root.style) return;
      var map = {
        "--xm-paper": theme.paper,
        "--xm-ink": theme.ink,
        "--xm-sub": theme.sub,
        "--xm-accent": theme.accent,
      };
      for (var key in map) {
        if (map[key]) root.style.setProperty(key, map[key]);
      }
    }

    var themedSession = "";
    // 面板刚打开先拉一次，别等 2.6s 的轮询——否则会先闪一下系统色。
    function syncTheme(sessionId) {
      if (!sessionId || sessionId === themedSession) return;
      themedSession = sessionId;
      fetch("/xiumi/api/state?session=" + encodeURIComponent(sessionId), { headers: { accept: "application/json" } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (state) { applyThemeVars(state); })
        .catch(function () { /* 壳颜色拿不到就吃系统色，不影响工作台 */ });
    }

    function ensureStyles() {
      var id = "dsh-xiumi-studio/panel.css";
      var found = document.querySelector('style[data-plugin-css="' + id + '"]');
      if (found) return function () {};
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-xiumi-studio";
      tag.dataset.pluginCss = id;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return function () {
        tag.remove();
      };
    }

    function apply(ctx) {
      var offStyles = ensureStyles();
      ctx.effect(function () {
        return function () {
          offStyles();
        };
      }, "xiumi: 面板样式");

      var getMounted = function () {
        return null;
      };
      var openOfficial = null;

      var Panel = function (props) {
        var sessionId = props.sessionId || currentSessionId(ctx, getMounted);
        // 不用 hooks：宿主面板的 React 版本不归我们管，syncTheme 自己按 session 去重，渲染里调一次就够。
        syncTheme(sessionId);
        if (!sessionId) {
          return React.createElement(
            "div",
            { className: "xm-panel-empty" },
            React.createElement("div", null,
              React.createElement("b", null, "秀米工作台"),
              "先在一个会话里打开这个面板：工作台需要知道该读写哪个工作目录。")
          );
        }
        var src = "/xiumi/studio?embed=1&session=" + encodeURIComponent(sessionId);
        return React.createElement(
          "div",
          { className: "xm-panel" },
          React.createElement("iframe", {
            className: "xm-panel-frame",
            src: src,
            title: "秀米工作台",
            // allow-downloads 必须给：面板里的「导出 HTML」是 blob 下载，沙箱不带这一项会静默失败。
            sandbox: "allow-same-origin allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads allow-clipboard-write",
          })
        );
      };

      var Title = function () {
        return React.createElement("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px" } },
          React.createElement("span", {
            style: {
              width: "14px", height: "14px", borderRadius: "4px", background: "var(--xm-accent,CanvasText)", color: "var(--xm-paper,Canvas)",
              fontSize: "10px", lineHeight: "14px", textAlign: "center", fontFamily: "serif",
            },
          }, "米"),
          "秀米工作台");
      };

      try {
        var seat = ctx.inject(["sidebarRightTabs", "sidebarRight"], function (injected) {
          var pick = function (key) {
            try {
              if (injected && typeof injected.get === "function") {
                var v = injected.get(key);
                if (v !== undefined) return v;
              }
            } catch (e) { /* 继续按对象取 */ }
            return injected ? injected[key] : undefined;
          };
          var tabs = pick("sidebarRightTabs");
          var sidebarRight = pick("sidebarRight");
          if (sidebarRight && sidebarRight.mounted && sidebarRight.mounted.getSnapshot) {
            getMounted = function () {
              try {
                return sidebarRight.mounted.getSnapshot();
              } catch (e) {
                return null;
              }
            };
          }
          var offs = [];
          if (tabs && typeof tabs.register === "function") {
            offs.push(tabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              priority: "extension",
              title: function () { return "秀米工作台"; },
              guide: [{
                id: "studio",
                order: 46,
                title: function () { return "秀米工作台"; },
                description: function () { return "公众号图文：Word 拆稿 → 主题排版 → 直接投进秀米「我的图文」"; },
              }],
            }));
          }
          var slots = ctx.slots;
          if (slots && typeof slots.inject === "function") {
            offs.push(slots.inject("sidebar.right.pane.tab", function () {
              return slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID }, Panel);
            }));
            offs.push(slots.inject("sidebar.right.pane.tab.title", function () {
              return slots.register({ name: "sidebar.right.pane.tab.title", key: TAB_ID }, Title);
            }));
          }
          if (sidebarRight && typeof sidebarRight.openTab === "function") {
            openOfficial = function () {
              sidebarRight.openTab(TAB_KIND);
            };
          }
          return function () {
            for (var i = offs.length - 1; i >= 0; i--) {
              try {
                offs[i]();
              } catch (e) { /* 卸载时忽略 */ }
            }
            openOfficial = null;
          };
        });
        ctx.effect(function () {
          return function () {
            try {
              seat && seat.dispose && seat.dispose();
            } catch (e) { /* ignore */ }
          };
        }, "xiumi: 右侧栏席位");

        // 宿主工具（xiumi_open / xiumi_import_docx）只写一条 open 请求；
        // 这里轮询看到它，就把右侧栏切到工作台，让"AI 在排稿"这件事人一眼能看见。
        ctx.effect(function () {
          var stopped = false;
          var lastSeen = 0;
          var missing = 0;
          var timer = setInterval(function () {
            if (stopped || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
            var sessionId = currentSessionId(ctx, getMounted);
            if (!sessionId) return;
            fetch("/xiumi/api/state?session=" + encodeURIComponent(sessionId), { headers: { accept: "application/json" } })
              .then(function (r) { return r.ok ? r.json() : null; })
              .then(function (state) {
                applyThemeVars(state);
                if (stopped || !state || !state.openRequest) return;
                missing = 0;
                var at = state.openRequest.at;
                if (!at || at === lastSeen) return;
                lastSeen = at;
                if (!openOfficial) return;
                try {
                  openOfficial();
                } catch (e) {
                  return; // 官方右侧栏还没就绪，下一轮再试
                }
                fetch("/xiumi/api/open-ack", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ session: sessionId, at: at }),
                }).catch(function () { /* ack 失败无所谓，下一轮会重来 */ });
              })
              .catch(function () {
                missing += 1;
                if (missing === 6) {
                  console.warn("[dsh-xiumi-studio] 读不到 /xiumi/api/state，面板不会自动打开");
                }
              });
          }, 2600);
          return function () {
            stopped = true;
            clearInterval(timer);
          };
        }, "xiumi: 面板自动打开");
      } catch (error) {
        console.warn("[dsh-xiumi-studio] 右侧栏席位注入失败：", error);
      }
    }

    module.exports = { name: name, inject: inject, apply: apply };
    return module.exports;
  },
});
