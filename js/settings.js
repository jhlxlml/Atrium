/* ============================================================
   Atrium · settings.js
   设置面板：构建 / 摆放 / 交互 / 应用
   ------------------------------------------------------------
   设计原则
   - 与「最近删除」完全同款：fixed 浮层 + 重挂 <body>，避开 .ctrls 的
     overflow 裁剪与层叠上下文（否则窄窗下会被瓦片盖住，点不进去）。
   - 所有项都落到 State.settings 并即时生效 + 落盘；「恢复默认」一键回退。
   - 面板本身只负责 UI；具体生效逻辑通过 opts.apply(key, value) 回调，
     由 App 统一处理（那里才拿得到 Grid / Lightbox / body 等引用）。
   ============================================================ */
(function (global) {
  'use strict';

  const Util = global.Util;
  const State = global.State;
  // 无障碍共用件（焦点陷阱）。缺失时降级为"不装陷阱"，不影响面板本身可用。
  const A11y = global.A11y;

  /* 官方仓库地址。「关于」面板展示它、更新结果里的「查看新版本」也回落到它。
     与主进程 deploy/electron/updatelib.js 的 REPO_URL 同值 —— 那一边是
     openExternal 白名单的唯一前缀，两边写歪了外链就会打不开（有回归锁着）。 */
  const REPO_URL = 'https://github.com/jhlxlml/Atrium';

  const Settings = {
    init(opts) {
      this.el = {
        btn: Util.$('#setBtn'),
        panel: Util.$('#setPanel'),
        body: Util.$('#setBody'),
        close: Util.$('#setClose'),
        reset: Util.$('#setReset'),
        ver: Util.$('#setVer'),
        head: Util.$('.sp-head'),
      };
      // 版本号来自 App.VERSION（唯一来源），报障时可直接看这一处
      if (this.el.ver) {
        const v = (global.App && global.App.VERSION) || '';
        this.el.ver.textContent = v ? ' · v' + v : '';
      }
      this.apply = (opts && opts.apply) || function () {};
      this.onOpen = (opts && opts.onOpen) || null;
      const E = this.el;
      if (!E.btn || !E.panel || !E.body) return;

      // 面板移到 <body>：躲开 .ctrls 的 overflow 裁剪与层叠上下文
      if (E.panel.parentElement !== document.body) document.body.appendChild(E.panel);

      E.btn.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
      E.close.addEventListener('click', () => this.toggle(false));
      E.reset.addEventListener('click', () => this.resetAll());

      // 点击外部收起（面板已挂 body，需同时判断按钮与面板）
      document.addEventListener('click', (e) => {
        if (E.panel.hidden) return;
        if (E.btn.contains(e.target)) return;
        if (E.panel.contains(e.target)) return;
        this.toggle(false);
      });
      // 视口变化 / 滚动跟随（fixed 浮层不随文档流走）
      const follow = () => { if (!E.panel.hidden) this.place(); };
      global.addEventListener('resize', Util.rafThrottle(follow), { passive: true });
      global.addEventListener('scroll', Util.rafThrottle(follow), { passive: true });

      // Esc 关闭（优先于图库的其他 Esc 行为）
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !E.panel.hidden) {
          e.preventDefault(); e.stopPropagation();
          this.toggle(false);
        }
      }, true);

      this.build();
    },

    /* ---------- 显隐与定位 ---------- */
    toggle(force) {
      const p = this.el.panel;
      if (!p) return;
      const show = force === undefined ? p.hidden : !!force;
      if (show && this.onOpen) this.onOpen();
      // 文件夹可能在面板关着的时候被加载/移除 → 动态选项（相框相册）得重建
      if (show && this._builtSig !== this._sig()) this.build();
      if (show) this.sync();               // 打开时把最新状态刷到控件（外部可能改过）
      p.hidden = !show;                    // 先显隐再测量（隐藏时尺寸恒为 0）
      this.el.btn.setAttribute('aria-expanded', String(show));
      this.el.btn.classList.toggle('is-on', show);
      if (show) {
        this.place();
        // 焦点陷阱：移入面板 → Tab 圈住 → 关闭还原到顶栏那颗齿轮。
        // 必须放在 p.hidden=false **之后** —— 隐藏元素不可聚焦，先移焦会落空。
        // 初始焦点给面板容器本身而不是第一个控件：读屏会先播报「设置，对话框」，
        // 用户才知道自己进了哪儿；再按 Tab 才进第一个控件。
        // 容器带不带 tabindex 由 A11y.trap 统一保证，这里不重复。
        if (A11y && A11y.trap) this._releaseTrap = A11y.trap(p, { initial: p });
      } else if (this._releaseTrap) {
        this._releaseTrap();
        this._releaseTrap = null;
      }
    },

    /** 动态选项的依据：当前已加载的来源列表。变了就得重建面板 */
    _sig() {
      return (State.sources || []).map((s) => s.id + ':' + s.name).join('|');
    },

    /** 贴按钮右下角放置；下方空间不足翻到上方；四边留 12px；顶部不越过顶栏 */
    place() {
      const p = this.el.panel, btn = this.el.btn;
      if (!p || !btn || p.hidden) return;
      const b = btn.getBoundingClientRect();
      const vw = global.innerWidth, vh = global.innerHeight;
      const GAP = 10, MARGIN = 12;
      const w = p.offsetWidth || 352;
      const h = p.offsetHeight || 480;

      let left = b.right - w;
      left = Math.max(MARGIN, Math.min(left, vw - w - MARGIN));

      let top = b.bottom + GAP;
      if (top + h > vh - MARGIN) {
        const above = b.top - GAP - h;
        top = above >= MARGIN ? above : Math.max(MARGIN, vh - h - MARGIN);
      }
      p.style.left = Math.round(left) + 'px';
      p.style.top = Math.round(top) + 'px';
    },

    /* ---------- 构建面板内容 ---------- */
    build() {
      const body = this.el.body;
      body.textContent = '';
      this._rows = {};

      for (const g of this.groups()) {
        const sec = document.createElement('section');
        sec.className = 'sp-group';
        const h = document.createElement('div');
        h.className = 'sp-group-h';
        h.textContent = g.title;
        sec.appendChild(h);
        for (const row of g.rows) sec.appendChild(this._row(row));
        body.appendChild(sec);
      }
      this.sync();
    },

    /** 设置项定义（分六组，覆盖外观 / 浏览 / 隐私 / 相框 / 数据 / 关于） */
    groups() {
      // 相框 **v1.11.0 起转为正式功能**（v1.8.1~v1.10.0 期间是"实验功能、默认隐藏"）。
      // 仍保留「显示相框入口」这个总开关：关掉时整组收起，给不用它的人一个清爽的面板。
      // groups() 是**状态相关**的：build() 每次都重新调用它，所以能反映当前的 showFrame。
      const frameRows = [
        {
          key: 'showFrame', type: 'switch', name: '显示相框入口',
          desc: '打开后顶栏出现相框图标：桌面版会开一个无边框、置顶、按图片比例的窗口，随机轮播相册里的图片',
          rebuild: true,   // 这个开关会改变本组的行数 → 点击后必须重建面板，只 sync() 是刷不出来的
        },
      ];
      if (State.settings.showFrame) {
        frameRows.push(
          {
            key: 'frameSrc', type: 'select', name: '相框相册',
            desc: '相框从哪个相册随机取图',
            // 选项是动态的：文件夹随用户加载/移除而变，所以每次重建面板时现算
            options: () => {
              const out = [['all', '全部图片'], ['fav', '只看收藏']];
              for (const s of (State.sources || [])) out.push([s.id, s.name]);
              return out;
            },
          },
          {
            key: 'frameMs', type: 'range', name: '更换间隔', desc: '相框里每张图停留多久',
            min: 2000, max: 60000, step: 1000, unit: '秒', scale: 1000,
          },
          {
            key: 'frameFit', type: 'seg', name: '填充方式',
            desc: '适应窗口＝整张完整可见；填满窗口＝不留边但可能裁掉边缘',
            options: [['contain', '适应'], ['cover', '填满']],
          },
          {
            key: 'frameDock', type: 'select', name: '窗口停靠边',
            desc: '相框窗口贴到屏幕哪一条边。拖动窗口靠近屏幕边缘也会自动吸附并记到这里（拖离则取消）',
            options: [
              ['none', '不吸附'], ['left', '贴左边'], ['right', '贴右边'],
              ['top', '贴上边'], ['bottom', '贴下边'],
            ],
          }
        );

        // 「输出屏幕」**只在真的有多块屏时**才出现：单屏下它只有一项可选，
        // 等于一个"点了没反应"的开关（本项目对这种东西一贯零容忍）。
        // 屏幕清单由 App.init() 异步拉取后写进 State.displays。
        if ((State.displays || []).length > 1) {
          frameRows.push({
            key: 'frameDisplay', type: 'select', name: '输出屏幕',
            desc: '相框开在哪一块屏幕上；「跟随主窗口」表示与主窗口同一块屏。外接屏拔掉后会自动回落到主窗口所在屏',
            options: () => [['auto', '跟随主窗口']].concat(
              (State.displays || []).map((d) => [String(d.id), d.label || '屏幕'])
            ),
          });
        }

        frameRows.push({
          key: '__frame', type: 'button', name: '开始相框',
          desc: '随机轮播相册：单击下一张、按住图片拖动可移动窗口、移动鼠标到下缘出控制条、Esc 退出（桌面版会开一个无边框、置顶、按图片比例的窗口）',
          label: '开始',
        });
      }

      return [
        {
          title: '外观',
          rows: [
            {
              key: 'theme', type: 'seg', name: '主题', desc: '界面配色方案',
                options: [['light', '浅色'], ['dark', '深色'], ['auto', '跟随系统']],
              },
              /* 排列模式（v1.12.0）。与顶栏那排图标是**同一个设置值**
                 （State.settings.mode）：这里点了立刻换排法（走 applySetting），
                 顶栏点了则在面板下次打开时刷新选中态（sync 是面板自己的事）。
                 关键是 App.applySetting 里必须有 case 'mode'，否则这里点了
                 只写入状态、界面纹丝不动 —— 本项目栽过五次的那种静默失效。
                 标签刻意用短词：面板宽 352px，四个中文标签放不下。 */
              {
                key: 'mode', type: 'seg', name: '排列模式',
                desc: '图片怎么排（与顶栏左侧那排图标同效）',
                options: [
                  ['small', '小图'], ['medium', '中图'],
                  ['masonry', '瀑布流'], ['single', '单列'],
                ],
              },
              {
                key: 'density', type: 'seg', name: '信息密度', desc: '网格留白与行高',
                options: [['cozy', '舒适'], ['compact', '紧凑']],
              },
            { key: 'showNames', type: 'switch', name: '显示文件名', desc: '网格瓦片底部叠加文件名' },
            { key: 'showCnt', type: 'switch', name: '来源显示数量', desc: '文件夹标签上的图片张数' },
            {
              key: 'alwaysOnTop', type: 'switch', name: '窗口置顶',
              desc: '让窗口始终浮在其它窗口之上',
            },
          ],
        },
        {
          /* 桌面集成：托盘 / 关闭行为 / 全局快捷键。
             整组按**能力探测**决定是否出现 —— 拿不到托盘的运行环境里
             不会留下"点了没反应"的开关（本项目对死开关零容忍）。 */
          title: '桌面集成',
          rows: desktopRows(),
        },
        {
          title: '浏览与查看',
          rows: [
            {
              key: 'wheelMode', type: 'seg', name: '滚轮行为', desc: '灯箱内滚动鼠标时',
              options: [['zoom', '缩放图片'], ['nav', '切换图片']],
            },
            { key: 'animOn', type: 'switch', name: '过渡动画', desc: '图片切换与缩放的动效' },
            { key: 'infoAuto', type: 'switch', name: '自动显示图片信息', desc: '打开大图时展开右侧信息栏' },
            { key: 'stripAuto', type: 'switch', name: '自动显示缩略图条', desc: '打开大图时展开底部胶片条' },
            {
              key: 'slideshowMs', type: 'range', name: '幻灯片间隔', desc: '自动播放时每张停留时长',
              min: 1000, max: 12000, step: 500, unit: '秒', scale: 1000,
            },
          ],
        },
        {
          // 行数由上面的 frameRows 决定（showFrame 关着时只有 1 行）
          title: '相框',
          rows: frameRows,
        },
        {
          title: '隐私与安全',
          rows: privacyRows(),
        },
        {
          title: '数据',
          rows: [
            { key: 'rememberLast', type: 'switch', name: '记住上次位置', desc: '下次打开恢复文件夹与浏览进度' },
            {
              key: '__clearCache', type: 'button', name: '清除缓存',
              desc: '清掉缩略图与尺寸缓存，释放磁盘占用；下次打开会重新生成', label: '清除',
            },
            { key: '__clearFavs', type: 'button', name: '清空收藏', desc: '取消全部星标（不删文件）', label: '清空', danger: true },
            { key: '__clearRots', type: 'button', name: '清除旋转记录', desc: '所有图片恢复原始朝向（不删文件）', label: '清除' },
          ],
        },
        {
          title: '关于',
          rows: [
            {
              key: '__about', type: 'button', name: '关于 Atrium',
              desc: '版本信息 · 功能简介 · 隐私说明 · 数据存放位置', label: '查看',
            },
          ],
        },
      ];
    },

    /**
     * 按钮类设置项的分发表。**新增一个 type:'button' 的行，必须在这里加一条**，
     * 否则按钮会（又一次）静默失效。回归套件会断言这张表与定义一一对应。
     */
    actions: {
      __clearCache() { this.clearCache(); },
      __clearFavs() { this.clearFavs(); },
      __clearRots() { this.clearRots(); },
      __about() { this.showAbout(); },
      __frame() { if (global.App) global.App.enterFrame(); },
    },

    /** 按 key 触发按钮动作；缺实现时给出显式告警（而不是静默无响应） */
    runAction(key) {
      const fn = this.actions[key];
      if (typeof fn === 'function') { fn.call(this); return; }
      if (global.console && global.console.warn) {
        global.console.warn('[settings] 按钮未接线：' + key + '（请在 Settings.actions 里补实现）');
      }
      global.App.toast('该功能暂不可用', { urgent: true });
    },

    _row(def) {
      const row = document.createElement('div');
      row.className = 'sp-row';
      // options 允许写成函数：像「相框相册」这种要列出当前已加载文件夹的选项，
      // 必须每次重建面板时现算，不能在建面板那一刻就定死。
      const opts = typeof def.options === 'function' ? (def.options() || []) : (def.options || []);

      const lab = document.createElement('div');
      lab.className = 'sp-label';
      const nm = document.createElement('div');
      nm.className = 'sp-name';
      nm.textContent = def.name;
      lab.appendChild(nm);
      if (def.desc) {
        const ds = document.createElement('div');
        ds.className = 'sp-desc';
        ds.textContent = def.desc;
        lab.appendChild(ds);
      }
      row.appendChild(lab);

      const ctl = document.createElement('div');
      ctl.className = 'sp-ctl';
      row.appendChild(ctl);

      if (def.type === 'switch') {
        const sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'sp-switch';
        sw.setAttribute('role', 'switch');
        sw.title = def.name;
        sw.addEventListener('click', () => {
          // 被 enabledWhen 置灰的项不该响应点击（disabled 在部分浏览器下
          // 仍会派发 click，所以这里再挡一道，双保险）
          if (sw.disabled) return;
          const next = !State.settings[def.key];
          State.setSetting(def.key, next);
          this.apply(def.key, next);
          // 少数开关会改变面板自身的行数（「显示相框入口」关闭时收起整组选项）——
          // 那种情况必须重建 DOM，只 sync() 是刷不出来的。
          // 其余开关没有 rebuild 标记，仍走原来的 sync()，行为一字未变。
          if (def.rebuild) {
            this.build();
            if (!this.el.panel.hidden) this.place();   // 展开后变高，可能顶出视口底部
          } else {
            // 打开/关闭「系统托盘图标」会让「关闭时最小化到托盘」的可用性变化，
            // 所以开关也要重跑一次可用性判定。
            this._applyEnabled();
            this.sync();
          }
        });
        ctl.appendChild(sw);
        this._rows[def.key] = { type: 'switch', el: sw, enabledWhen: def.enabledWhen };

      } else if (def.type === 'seg') {
        const seg = document.createElement('div');
        seg.className = 'sp-seg';
        for (const [val, text] of opts) {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = text;
          b.dataset.val = val;
          b.addEventListener('click', () => {
            State.setSetting(def.key, val);
            this.apply(def.key, val);
            this.sync();
          });
          seg.appendChild(b);
        }
        ctl.appendChild(seg);
        this._rows[def.key] = { type: 'seg', el: seg };

      } else if (def.type === 'range') {
        const num = document.createElement('input');
        num.type = 'number';
        num.className = 'sp-num';
        num.min = String(def.min / (def.scale || 1));
        num.max = String(def.max / (def.scale || 1));
        num.step = String((def.step || 1) / (def.scale || 1));
        const sfx = document.createElement('span');
        sfx.className = 'sp-suffix';
        sfx.textContent = def.unit || '';
        const commit = (raw) => {
          let v = Number(raw);
          if (!isFinite(v)) return;
          v = Math.max(def.min, Math.min(def.max, Math.round(v * (def.scale || 1))));
          State.setSetting(def.key, v);
          this.apply(def.key, v);
          this.sync();
        };
        num.addEventListener('change', () => commit(num.value));
        ctl.appendChild(num);
        if (def.unit) ctl.appendChild(sfx);
        this._rows[def.key] = { type: 'range', el: num, scale: def.scale || 1 };

      } else if (def.type === 'button') {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'sp-btn' + (def.danger ? ' danger' : '');
        b.textContent = def.label || '执行';
        // 统一走 runAction 分发（见下方 actions）。
        // v1.6.0 的「清空缩略图缓存」曾经就是在这里漏了 else-if 分支：
        // 按钮画得出来、点得下去，但没有任何反应 —— 静默失效，用户只会觉得"坏了"。
        // 现在改成查表分发 + 未接线时告警，并在回归里断言"每个按钮键都有对应实现"。
        b.addEventListener('click', () => this.runAction(def.key));
        ctl.appendChild(b);
        this._rows[def.key] = { type: 'button', el: b };

      } else {  // select
        const sel = document.createElement('select');
        sel.className = 'sp-select';
        for (const [val, text] of opts) {
          const o = document.createElement('option');
          o.value = val; o.textContent = text;
          sel.appendChild(o);
        }
        sel.addEventListener('change', () => {
          State.setSetting(def.key, sel.value);
          this.apply(def.key, sel.value);
        });
        ctl.appendChild(sel);
        this._rows[def.key] = { type: 'select', el: sel };
      }

      return row;
    },

    /** 把 State.settings 的当前值刷到所有控件（打开面板 / 任何变更后调用） */
    sync() {
      this._applyEnabled();
      const s = State.settings, R = this._rows || {};
      for (const k in R) {
        const r = R[k];
        if (r.type === 'switch') {
          const on = !!s[k];
          r.el.classList.toggle('is-on', on);
          r.el.setAttribute('aria-checked', String(on));
        } else if (r.type === 'seg') {
          for (const b of r.el.children) b.classList.toggle('is-on', b.dataset.val === String(s[k]));
        } else if (r.type === 'range') {
          r.el.value = String(Math.round(s[k] / r.scale));
        } else if (r.type === 'select') {
          // 选项是动态的：来源被移除后旧值可能已不在列表里 → 回落到「全部图片」
          const want = String(s[k]);
          const has = Array.prototype.some.call(r.el.options, (o) => o.value === want);
          if (!has && k === 'frameSrc') {
            State.setSetting(k, 'all');
            r.el.value = 'all';
          } else {
            r.el.value = want;
          }
        }
      }
    },

    /**
     * 逐项重算可用性（enabledWhen）。
     * 为什么要有：有些设置只在另一个设置开着时才有意义（「关闭时最小化到托盘」
     * 依赖「系统托盘图标」）。把它们直接藏起来会让用户以为功能没了；置灰 + 说明
     * 才能表达"要先开上面那个"。置灰是**每次 sync 都重算**的，不会因为
     * 依赖项在别处被改而留下过期的灰。
     */
    _applyEnabled() {
      const R = this._rows || {};
      for (const k in R) {
        const r = R[k];
        if (!r.enabledWhen) continue;
        let on = true;
        try { on = !!r.enabledWhen(); } catch (e) { on = true; }  // 判定函数抛错时不要误锁
        r.el.disabled = !on;
        const row = r.el.closest ? r.el.closest('.sp-row') : null;
        if (row) row.classList.toggle('is-disabled', !on);
      }
    },

    async clearFavs() {
      const n = State.favs.size;
      if (!n) { global.App.toast('还没有收藏的图片'); return; }
      const yes = await global.App.modal({
        title: '清空全部收藏？',
        body: `将取消 <b>${n}</b> 张图片的星标。<br>这只是浏览标记，<b>不会删除任何文件</b>。`,
        confirmText: '清空收藏',
        danger: true,
      });
      if (!yes) return;
      State.clearFavs();
      global.App.toast(`已清空 ${n} 条收藏`);
    },

    /** 清除全部旋转记录（P1-4）：网格与灯箱都回到原始朝向，不动文件 */
    async clearRots() {
      const n = State.rotationCount;
      if (!n) { global.App.toast('还没有旋转过的图片'); return; }
      const yes = await global.App.modal({
        title: '清除全部旋转记录？',
        body: `将把 <b>${n}</b> 张图片恢复为原始朝向。<br>这只是浏览时的旋转，<b>不会改动或删除任何文件</b>。`,
        confirmText: '清除记录',
      });
      if (!yes) return;
      State.clearRotations();
      global.App.toast(`已清除 ${n} 条旋转记录`);
    },

    /**
     * 一键清除本机缓存（v1.7.0）。
     *
     * 清什么、不清什么，都要说清楚 —— 用户按"清除缓存"最怕的就是"顺手删了别的东西"：
     *   清 → 缩略图落盘缓存、图片尺寸缓存
     *   不清 → 原图文件、收藏、旋转记录、记住的文件夹、界面设置
     *
     * 刻意**不动内存里的缩略图缓存**：内存 LRU 持有的是当前正在显示的 blob URL，
     * 清掉会让已显示的图当场变成空白。清磁盘就够了，当前这一屏照常显示。
     */
    async clearCache() {
      const tc = global.Loader && global.Loader.thumbCache;
      const dc = global.Loader && global.Loader.dimsCache;
      if (!tc && !dc) { global.App.toast('当前环境没有可清除的缓存'); return; }

      const st = tc ? await tc.stats() : { count: 0 };
      const ds = dc ? await dc.stats() : { count: 0, mem: 0 };
      const nThumb = (st && st.count) | 0;
      // 尺寸缓存分「已落盘」与「还在内存」两部分：刚记录的记录要 1.2s 才落盘。
      // 报数只用于告知用户，取两者较大值，避免出现"内存里明明有、却显示 0 条"。
      const nDim = Math.max((ds && ds.count) | 0, (ds && ds.mem) | 0);
      if (!nThumb && !nDim) { global.App.toast('缓存已经是空的'); return; }

      const yes = await global.App.modal({
        title: '清除本机缓存？',
        body: '将清除本机保存的：<br>'
          + `· 缩略图缓存 <b>${nThumb}</b> 条<br>`
          + `· 图片尺寸缓存 <b>${nDim}</b> 条<br><br>`
          + '之后重新打开文件夹会重新生成缩略图（第一次会稍慢一点）。<br>'
          + '<b>不会删除任何原图</b>，也不影响收藏、旋转记录和记住的文件夹。',
        confirmText: '清除缓存',
      });
      if (!yes) return;

      await tc.clear();
      if (dc) await dc.clear();
      global.App.toast(`已清除缓存：缩略图 ${nThumb} 条 / 尺寸 ${nDim} 条`);
    },

    /**
     * 关于面板：软件介绍。全部内容都从运行时读取（版本号取 App.VERSION 唯一来源），
     * 不写死任何会过期的数字。
     */
    async showAbout() {
      const v = (global.App && global.App.VERSION) || '';
      const esc = Util.esc;
      const N = global.Native;
      const canUpdate = !!(N && N.canUpdate);
      const body = ''
        + '<div class="vf-about">'
        + '<div class="vf-about-h">'
        + '<span class="vf-about-name">Atrium</span>'
        + '<span class="vf-about-ver">v' + esc(v) + '</span>'
        + '<span class="vf-about-tag">Electron 版</span>'
        + '</div>'
        + '<p class="vf-about-lede">一个只在本机运行的照片浏览器。打开文件夹就能看 —— '
        + '不联网、不上传、不在你的照片目录里生成任何额外文件。</p>'

        + '<div class="vf-about-sec">'
        + '<div class="vf-about-t">能做什么</div>'
        + '<ul class="vf-about-ul">'
        + '<li>多文件夹来源：一个窗口里并排看多个目录，点标签即切</li>'
        + '<li>四种排列：小图 / 中图（等高网格） / 瀑布流（手机相册那种错落） / 单列整屏，滚轮缩放、拖动平移、旋转看片</li>'
        + '<li>灯箱：双指缩放、缩略图胶片条、拍摄信息（EXIF）</li>'
        + '<li>收藏与筛选：星标、按名称/大小/时间/拍摄时间排序</li>'
        + '<li>删除移入系统回收站，可撤回；批量导出到指定文件夹</li>'
        + '<li>旋转朝向会被记住（按文件持久化，重开保持一致）</li>'
        + '</ul></div>'

        + '<div class="vf-about-sec">'
        + '<div class="vf-about-t">隐私</div>'
        + '<p class="vf-about-p">全部处理都在你的电脑上完成：<strong>不埋点、不上传任何图片</strong>。'
        + '没有账号，也不需要登录。</p>'
        + '<p class="vf-about-p">默认<strong>完全不出网</strong>。唯一的例外是'
        + '「设置 → 隐私与安全 → 检查更新」——那是你主动打开的可选项，'
        + '打开后启动时会读一次 GitHub 的公开版本号（只读，不发送任何本机信息）。</p></div>'

        + '<div class="vf-about-sec">'
        + '<div class="vf-about-t">数据放在哪</div>'
        + '<p class="vf-about-p">缩略图、图片尺寸、设置、收藏与旋转记录都存在'
        + '<strong>应用目录下的 data 子目录</strong>里 —— 便携版自带数据，'
        + '把整个文件夹拷走就带走了全部设置（换台机器不必重新配）。'
        + '这些都可以在「设置 → 数据 → 清除缓存」一键清掉。</p></div>'

        + '<div class="vf-about-sec">'
        + '<div class="vf-about-t">开源与更新</div>'
        + '<p class="vf-about-p">源码、更新日志与问题反馈都在 GitHub：'
        + '<a class="vf-about-link" data-ext="1" href="' + REPO_URL + '"'
        + ' rel="noreferrer noopener">github.com/jhlxlml/Atrium</a>'
        + '（GPL-3.0 许可）。</p>'
        + (canUpdate
          ? '<div class="vf-about-upd">'
            + '<button type="button" class="btn btn-ghost" data-act="checkUpdate">检查更新</button>'
            + '<span class="vf-about-upd-r" data-role="updResult">当前 v' + esc(v) + '</span>'
            + '</div>'
          : '')
        + '</div>'

        + '<div class="vf-about-sec">'
        + '<div class="vf-about-t">技术</div>'
        + '<p class="vf-about-p">纯 vanilla JavaScript 手写，<strong>第三方运行时依赖 0</strong>；'
        + '没有框架、没有打包器。基于 Electron（独立便携包，解压即用）。</p></div>'
        + '</div>';

      await global.App.modal({
        title: '关于 Atrium',
        body: body,
        confirmText: '知道了',
        single: true,
        /* onMount：面板刚插进 DOM 之后接一次线。
           为什么不能在 body 字符串里写 onclick —— 那要往 HTML 里塞代码，
           与全项目"事件一律 addEventListener"的写法不一致，也没法传闭包。 */
        onMount: (bodyEl) => {
          const btn = bodyEl.querySelector('[data-act="checkUpdate"]');
          const out = bodyEl.querySelector('[data-role="updResult"]');
          if (btn) btn.addEventListener('click', () => this.checkUpdateInline(btn, out));
          /* 外链一律交给主进程（白名单）打开，绝不让窗口自己导航 ——
             主窗口的 will-navigate 本来就会拦掉外链，不拦的话点了就是"没反应"。 */
          bodyEl.addEventListener('click', (ev) => {
            const a = ev.target && ev.target.closest ? ev.target.closest('a[data-ext]') : null;
            if (!a) return;
            ev.preventDefault();
            if (global.App && global.App.openExternal) global.App.openExternal(a.getAttribute('href'));
          });
        },
      });
    },

    /**
     * 「关于」面板里的「检查更新」按钮：**就地**显示结果，不另开弹层
     * （弹层套弹层会把两个焦点陷阱叠起来，Esc 归谁管就说不清了）。
     * 请求期间按钮禁用，避免连点发出一串请求。
     */
    async checkUpdateInline(btn, out) {
      const N = global.Native;
      const say = (text, cls) => {
        if (!out) return;
        out.textContent = text;
        out.className = 'vf-about-upd-r' + (cls ? ' ' + cls : '');
      };
      if (!N || !N.canUpdate) { say('当前环境不支持检查更新', 'is-err'); return; }
      if (btn && btn.disabled) return;
      if (btn) btn.disabled = true;
      say('正在访问 GitHub…');
      const r = await N.checkUpdate((global.App && global.App.VERSION) || '');
      if (btn) btn.disabled = false;
      if (!r || !r.ok) {
        say('检查失败：' + global.App._updateErrText(r && r.reason), 'is-err');
        return;
      }
      if (!r.hasUpdate) { say('已是最新版本（v' + r.current + '）'); return; }
      say('发现新版本 v' + r.latest + '（当前 v' + r.current + '）', 'is-new');
      // 就地补一个「查看」外链：走同一条白名单 IPC，不在窗口内导航
      const a = document.createElement('a');
      a.className = 'vf-about-link';
      a.setAttribute('data-ext', '1');
      a.href = r.url || (REPO_URL + '/releases');
      a.textContent = '查看新版本';
      out.appendChild(document.createTextNode(' '));
      out.appendChild(a);
    },

    resetAll() {
      State.resetSettings();
      this.rebuildAndApply();
      global.App.toast('已恢复默认设置');
    },

    /** 恢复默认后：重建面板 + 把全部设置项重新应用到界面 */
    rebuildAndApply() {
      this.build();
      for (const k of ALL_KEYS) this.apply(k, State.settings[k]);
    },
  };

  /**
   * 「隐私与安全」组的行定义。
   * 前两行是恒定的；「检查更新」按**能力探测**决定出不出现 ——
   * 它是本应用**唯一**会联网的功能，拿不到该能力的运行环境里
   * 不该留下一个点了没反应的开关（与 desktopRows() 同一个取舍）。
   * 注意它是 switch 但**不是**"纯 UI 项"：打开的那一刻就会真的出一次网，
   * 所以点击后由 App.applySetting 立刻发起一次检查（见那里的 case 'updateCheck'）。
   */
  function privacyRows() {
    const rows = [
      { key: 'confirmDelete', type: 'switch', name: '删除前确认', desc: '防止误删，建议保持开启' },
      { key: 'blurPreview', type: 'switch', name: '模糊预览', desc: '所有图片打码，等同顶栏眼睛按钮' },
    ];
    const N = global.Native;
    if (N && N.canUpdate) {
      rows.push({
        key: 'updateCheck', type: 'switch', name: '检查更新',
        desc: '启动时访问 GitHub 的公开版本接口，有新版本就提示（默认关闭；只读取版本号，不上传任何本机信息）',
      });
    }
    return rows;
  }

  /**
   * 「桌面集成」组的行定义。
   * 按**能力探测**逐条决定：拿不到托盘的运行环境里不显示托盘相关的开关，
   * 而不是画一个点了没反应的死开关（本项目对死开关零容忍）。
   * 「关闭时最小化到托盘」还依赖「系统托盘图标」开着 —— 用 enabledWhen 置灰，
   * 而不是藏起来：藏起来用户会以为功能没了，置灰能说明"要先开上面那个"。
   */
  function desktopRows() {
    const N = global.Native;
    const rows = [];
    if (N && N.canTray) {
      rows.push({
        key: 'trayOn', type: 'switch', name: '系统托盘图标',
        desc: '在任务栏通知区显示 Atrium 图标：可一键显示/隐藏窗口，并快速打开文件夹或回收站',
      });
      rows.push({
        key: 'trayClose', type: 'switch', name: '关闭时最小化到托盘',
        desc: '点窗口的关闭按钮时收进托盘而不退出；关掉时点关闭即退出程序（需先开启系统托盘）',
        enabledWhen: () => !!State.settings.trayOn,
      });
    }
    if (N && N.canHotkey) {
      rows.push({
        key: 'hotkeyOn', type: 'switch', name: '全局快捷键 Ctrl+Alt+A',
        desc: '任何时候按下都能把 Atrium 叫到最前面；该组合已被其它程序占用时会提示并自动关闭',
      });
    }
    return rows;
  }

  /** 需要「重新应用」的设置键（恢复默认时全量重放） */
  const ALL_KEYS = [
    'theme', 'density', 'showNames', 'showCnt', 'alwaysOnTop',
    'wheelMode', 'animOn', 'infoAuto', 'stripAuto', 'slideshowMs',
    'confirmDelete', 'blurPreview', 'rememberLast',
    /* updateCheck 与上面那些"纯 UI 项"不同：它有真实副作用（出网）。
       但登记它的理由与相框那组一样 —— 它是面板上真实存在的一行，
       漏登记就等于"恢复默认后这一项不参与重放"（开关还停在开着的状态，
       下一次启动照样出网）。通用不变量断言会当场抓到这个遗漏。 */
    'updateCheck',
    /* 相框组：frameSrc / frameMs / frameFit 与 frameDock 一样，都是"进相框那一刻
       才被 frame.js 读取"的键，主窗口这边**没有活的界面**要刷 —— 但**必须登记**：
       它们是面板上真实存在的行，漏登记就等于"恢复默认后这一项不参与重放"。
       （applySetting 对它们没有 case，落到 default: break 是**安全的 no-op**；
       这里登记的是"重放表完整性"，与"有没有分支"是两件事。）
       这条不再是靠人记 —— run_all.js 有一条通用不变量断言：
       面板里的每一行都必须 ∈ ALL_KEYS，缺哪个直接报出来。 */
    'showFrame', 'frameSrc', 'frameMs', 'frameFit', 'frameDock', 'frameDisplay',
    'mode', 'sortKey', 'sortDir', 'pageSize',
    'trayOn', 'trayClose', 'hotkeyOn',
  ];
  /* 对外暴露只为回归能锁住它 —— 这个列表是"恢复默认"的重放表，
     漏登记一个键的后果是**静默**的：面板看着刷新了，那一项却不生效。
     本项目已因此栽过四次（见 MEMORY.md §22），所以宁可多一条断言。 */
  Settings.ALL_KEYS = ALL_KEYS;

  global.Settings = Settings;
})(window);
