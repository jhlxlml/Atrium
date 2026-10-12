/* ============================================================
   Atrium · trash.js
   回收站视图：把「删掉的图片」集中展示，可逐张/批量找回
   - 数据来源：App.trash（桌面版由主进程 userData/trash-log.json 持久化，跨启动保留）
   - 预览：文件已被移走，只能从系统回收站的 $R 里读回内容（Native.trashPreview）
   - 选择：点击切换 + 拖拽框选（与图库同一套交互语义）
   - 找回：还原所选 / 还原单张 → Native.restoreFiles 把文件搬回原路径，
           成功后条目回到图库、记录从列表移除
   依赖：util.js / native.js（均在前面加载）
   ============================================================ */
(function (global) {
  'use strict';

  const Util = global.Util;
  const $ = Util.$;

  const Trash = {
    view: null, grid: null, empty: null, countEl: null, box: null,
    data: [],                 // 删除记录（最新在前）
    sel: new Set(),           // 选中的记录 id
    previews: new Map(),      // id -> dataURL（避免重复向主进程要图）
    _io: null,
    _busy: false,
    onRestore: null,          // (recs) => Promise<number>  由 App 提供（真正执行还原）
    onForget: null,           // (recs) => Promise<void>
    onClear: null,            // () => Promise<void>
    onClose: null,            // () => void
    onToast: null,            // (msg, opts?) => void

    /* ---------- 装配 ---------- */
    init(opts) {
      this.view = $('#trashView');
      if (!this.view) return;
      this.grid = $('#tvGrid');
      this.empty = $('#tvEmpty');
      this.countEl = $('#tvCount');
      opts = opts || {};
      this.onRestore = opts.onRestore || null;
      this.onForget = opts.onForget || null;
      this.onClear = opts.onClear || null;
      this.onClose = opts.onClose || null;
      this.onToast = opts.onToast || null;

      $('#tvBack').addEventListener('click', () => this.close());
      $('#tvRestore').addEventListener('click', () => this.restoreSelected());
      $('#tvForget').addEventListener('click', () => this.forgetSelected());
      $('#tvSelectAll').addEventListener('click', () => this.selectAll(true));
      $('#tvInvert').addEventListener('click', () => this.invert());
      $('#tvClear').addEventListener('click', () => this.clearAll());
      $('#tvOpenRb').addEventListener('click', () => { if (global.Native) global.Native.openRecycleBin(); });

      this._wireMarquee();
      return this;
    },

    isOpen() { return !!(this.view && !this.view.hidden); },

    /** 打开回收站视图（数据由调用方先灌好） */
    open(list) {
      if (Array.isArray(list)) this.setData(list);
      if (!this.view) return;
      this.view.hidden = false;
      document.body.classList.add('trash-open');
      this.render();
    },

    close() {
      if (!this.view) return;
      this.view.hidden = true;
      document.body.classList.remove('trash-open');
      this.sel.clear();
      if (this.onClose) this.onClose();
    },

    setData(list) {
      this.data = Array.isArray(list) ? list.slice() : [];
      const alive = new Set(this.data.map((r) => r && r.id));
      for (const id of Array.from(this.sel)) if (!alive.has(id)) this.sel.delete(id);
      // 预览缓存随手回收，避免长时间运行堆积
      for (const id of Array.from(this.previews.keys())) if (!alive.has(id)) this.previews.delete(id);
      if (this.isOpen()) this.render();
    },

    /* ---------- 选择 ---------- */
    isSel(rec) { return !!(rec && rec.id && this.sel.has(rec.id)); },
    selected() { return this.data.filter((r) => this.isSel(r)); },

    toggle(rec, force) {
      if (!rec || !rec.id) return;
      const on = force === undefined ? !this.sel.has(rec.id) : !!force;
      if (on) this.sel.add(rec.id); else this.sel.delete(rec.id);
      this._syncRow(rec);
      this._syncBar();
    },

    selectAll(on) {
      this.sel.clear();
      if (on !== false) for (const r of this.data) if (r && r.id) this.sel.add(r.id);
      this._paintAll();
      this._syncBar();
    },

    invert() {
      const next = new Set();
      for (const r of this.data) if (r && r.id && !this.sel.has(r.id)) next.add(r.id);
      this.sel = next;
      this._paintAll();
      this._syncBar();
    },

    clearSelection() { this.sel.clear(); this._paintAll(); this._syncBar(); },

    /* ---------- 渲染 ---------- */
    render() {
      if (!this.grid) return;
      const list = this.data;
      this.grid.textContent = '';
      if (this.countEl) {
        this.countEl.textContent = list.length
          ? `${list.length} 张待找回`
          : '';
      }
      if (this.empty) this.empty.hidden = list.length > 0;
      if (!list.length) { this._syncBar(); return; }

      const frag = document.createDocumentFragment();
      for (const rec of list) frag.appendChild(this._card(rec));
      frag.appendChild(this.box);          // 选框始终在最后，且 render 不会被它清掉
      this.grid.appendChild(frag);
      this._syncBar();
      this._observePreviews();
    },

    _card(rec) {
      const el = document.createElement('figure');
      el.className = 'tv-card' + (this.isSel(rec) ? ' is-sel' : '');
      el._rec = rec;

      const ph = document.createElement('div');
      ph.className = 'tv-ph';
      const img = document.createElement('img');
      img.alt = rec.name || '';
      img.decoding = 'async';
      img.draggable = false;
      const cached = this.previews.get(rec.id);
      if (cached) img.src = cached; else img.classList.add('pending');
      ph.appendChild(img);
      el.appendChild(ph);

      const chk = document.createElement('span');
      chk.className = 'tv-chk';
      chk.innerHTML = Util.icon('i-check');
      chk.title = '选择';
      el.appendChild(chk);

      const one = document.createElement('button');
      one.type = 'button';
      one.className = 'tv-one';
      one.textContent = '还原';
      one.title = '还原到原位置';
      one.addEventListener('click', (e) => {
        e.stopPropagation();
        this.restoreSelected([rec]);
      });
      el.appendChild(one);

      const cap = document.createElement('figcaption');
      cap.className = 'tv-cap';
      const nm = document.createElement('span');
      nm.className = 'tv-name';
      nm.textContent = rec.name || (String(rec.path || '').split(/[\\/]/).pop() || '?');
      nm.title = nm.textContent;
      const meta = document.createElement('span');
      meta.className = 'tv-meta';
      meta.textContent = [global.App && global.App._fmtSize ? global.App._fmtSize(rec.size) : Util.fmtBytes(rec.size),
        global.App && global.App._fmtAgo ? global.App._fmtAgo(rec.ts) : ''].filter(Boolean).join(' · ');
      const pt = document.createElement('span');
      pt.className = 'tv-path';
      pt.textContent = rec.path || '';
      pt.title = rec.path || '';
      cap.appendChild(nm); cap.appendChild(meta); cap.appendChild(pt);
      el.appendChild(cap);

      el.addEventListener('click', (e) => {
        if (e.target.closest('.tv-one')) return;
        e.preventDefault();
        this.toggle(rec);
      });
      el._img = img;
      return el;
    },

    /** 只更新一张卡片的选中态（避免整体重绘导致预览闪烁） */
    _syncRow(rec) {
      const cards = this.grid ? this.grid.children : [];
      for (const c of cards) {
        if (c._rec === rec || (c._rec && rec && c._rec.id === rec.id)) {
          c.classList.toggle('is-sel', this.isSel(rec));
          break;
        }
      }
    },

    _paintAll() {
      if (!this.grid) return;
      for (const c of this.grid.children) {
        if (c._rec) c.classList.toggle('is-sel', this.isSel(c._rec));
      }
    },

    _syncBar() {
      const n = this.sel.size;
      const set = (id, txt, dis) => {
        const b = $(id);
        if (!b) return;
        b.textContent = txt;
        b.disabled = !!dis;
      };
      set('#tvRestore', n ? `还原所选（${n}）` : '还原所选', n === 0);
      set('#tvForget', n ? `移除记录（${n}）` : '移除记录', n === 0);
      const inv = $('#tvInvert'); if (inv) inv.disabled = !this.data.length;
      const sa = $('#tvSelectAll');
      if (sa) {
        const all = n > 0 && n === this.data.length;
        sa.textContent = all ? '取消全选' : '全选';
        sa.disabled = !this.data.length;
      }
      const cl = $('#tvClear'); if (cl) cl.disabled = !this.data.length;
    },

    /* ---------- 预览：进入视口才去回收站里取图 ---------- */
    _observePreviews() {
      if (this._io) { this._io.disconnect(); this._io = null; }
      const cards = this.grid ? Array.from(this.grid.children) : [];
      const need = cards.filter((c) => c._img && c._img.classList.contains('pending'));
      if (!need.length) return;
      if (!Util.can.IntersectionObserver) { need.forEach((c) => this._loadPreview(c)); return; }
      this._io = new IntersectionObserver((ents) => {
        for (const en of ents) {
          if (!en.isIntersecting) continue;
          this._io.unobserve(en.target);
          this._loadPreview(en.target);
        }
      }, { rootMargin: '200px' });
      need.forEach((c) => this._io.observe(c));
    },

    async _loadPreview(card) {
      const rec = card._rec, img = card._img;
      if (!rec || !img) return;
      img.classList.remove('pending');
      if (this.previews.has(rec.id)) { img.src = this.previews.get(rec.id); return; }
      if (!global.Native || !global.Native.active) return;
      const r = await global.Native.trashPreview(rec);
      if (!r || !r.ok || !r.url) { card.classList.add('tv-noprev'); return; }
      if (!card.isConnected) return;
      this.previews.set(rec.id, r.url);
      img.src = r.url;
      img.classList.add('ld');
    },

    /* ---------- 框选 ---------- */
    _wireMarquee() {
      this.box = document.createElement('div');
      this.box.className = 'tv-marquee';
      this.box.hidden = true;

      let base = null, additive = false;
      const hit = (rect) => {
        const cards = Array.from(this.grid.children).filter((c) => c._rec && c !== this.box);
        const out = [];
        for (const c of cards) {
          const x1 = c.offsetLeft, y1 = c.offsetTop;
          const x2 = x1 + c.offsetWidth, y2 = y1 + c.offsetHeight;
          if (x2 > rect.x1 && x1 < rect.x2 && y2 > rect.y1 && y1 < rect.y2) out.push(c._rec);
        }
        return out;
      };

      Util.dragSelect({
        root: this.grid,
        box: this.box,
        toLocal: (cx, cy) => {
          const r = this.grid.getBoundingClientRect();
          return { x: cx - r.left + this.grid.scrollLeft, y: cy - r.top + this.grid.scrollTop };
        },
        shouldStart: (e) => !e.target.closest('.tv-one') && !e.target.closest('.tv-chk'),
        onMove: (rect, e) => {
          if (!base) { additive = !!(e && (e.shiftKey || e.ctrlKey || e.metaKey)); base = additive ? new Set(this.sel) : null; }
          const hits = hit(rect);
          this.sel = new Set(base || []);
          for (const r of hits) if (r.id) this.sel.add(r.id);
          this._paintAll();
          this._syncBar();
        },
        onEnd: (rect) => { base = null; additive = false; },
      });
    },

    /* ---------- 操作 ---------- */
    async restoreSelected(list) {
      const recs = Array.isArray(list) ? list : this.selected();
      if (!recs.length || this._busy) return;
      this._busy = true;
      try {
        if (this.onRestore) await this.onRestore(recs);
      } finally { this._busy = false; }
    },

    async forgetSelected() {
      const recs = this.selected();
      if (!recs.length || this._busy) return;
      this._busy = true;
      try { if (this.onForget) await this.onForget(recs); }
      finally { this._busy = false; }
    },

    async clearAll() {
      if (!this.data.length || this._busy) return;
      this._busy = true;
      try { if (this.onClear) await this.onClear(); }
      finally { this._busy = false; }
    },

    /** 从列表里摘掉若干记录（还原/遗忘后调用） */
    drop(recs) {
      const ids = new Set((recs || []).map((r) => r && r.id));
      this.data = this.data.filter((r) => !ids.has(r.id));
      for (const id of ids) { this.sel.delete(id); this.previews.delete(id); }
      this.render();
    },
  };

  global.Trash = Trash;
})(window);
