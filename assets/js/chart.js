/* ══════════════════════════════════════════════════════════
   chart.js — 自绘实时曲线
   特性：双 Y 轴 / 触摸十字光标读数 / 捏合缩放 / 拖动回看 / 功率面积填充
   ══════════════════════════════════════════════════════════ */

const DPR = Math.min(window.devicePixelRatio || 1, 2.5);
/* 内边距基准；右侧会按实际用到的轴数量动态加宽（见 _updatePad）。
   用户 2026-10-10：轴标签要**贴着绘图区**、整体紧凑 —— 字号 10→9px、
   与轴线的间隙 6→3px，留白 46→34px（"1.5kV" 5 字符 ×9px mono ≈27px 仍放得下）。 */
const PAD_BASE = { l: 34, r: 34, t: 10, b: 22 };
/* 「内侧轴」刻度标签相对绘图区左缘的内缩量（px）。
   用户 2026-10-13 定稿：左侧两个轴 = **一个在绘图区外侧、一个在绘图区内侧**，
   都在最左边那条轴线的两旁 —— 外侧轴标签在左缘外，内侧轴标签压在绘图区内，
   这样绘图区宽度**不被第二个轴吃掉**（不改变曲线图本身）。 */
const AXIS_INNER_INSET = 3;
/* 调色板可由外部切换（亮/暗主题） */
const PALETTE_DARK  = { grid: '#1a2431', gridStrong: '#22303f', txt: '#5d6b80' };
const PALETTE_LIGHT = { grid: '#dfe6ef', gridStrong: '#c9d5e2', txt: '#8494a8' };

/* 漂亮刻度：1-2-5 序列里选最小 step，让段数 ≤5，量程顶 = step 整数倍。
   例：20.8V → step 5V、5 段、量程 25（标签 5/10/15/20/25 全整数）；
       电流下限 10A → step 2A、5 段（0/2/4/6/8/10）。
   ★ 只保留**整数步长**（用户要求：Y 轴标签只显示 1–3 位整数）——
     去掉 .1/.2/.25/.5/2.5/25 这些会在标签上留小数的档位。
     代价：极小量程（<1 单位）时量程顶会被抬到 1，换来标签全整数。 */
/* 漂亮刻度的步长候选（升序，取第一个使格数 ≤ MAX_DIV 的）。
   ⚠ 2026-10-13 一轮：原来只有 [1,2,5,10…]，档位太疏 —— 「曲线坐标偏移倍数」±0.05 的调整
   几乎永远落在同一档（峰值 20V 时 ×1.05~×1.20 全被量化成同样的 25），用户报"改了没反应"。
   补入 3 / 4（**整数**档位）并把格数上限从 5 放宽到 MAX_DIV —— 既让倍数可分辨，
   又保住「轴标签只显示整数」的老要求。
   ⚠ 2026-10-13 二轮：一度补过 1.5 / 2.5，但它们是**非整数**步长 —— 轴标签会被
   shortNum 四舍五入成 0/2/3/5/6 这种不等距序列（用户实测电流轴）。已删掉，
   只留整数档；3 / 4 已足够让偏移倍数体现差异。 */
const NICE_STEPS = [1, 2, 3, 4, 5, 10, 20, 50, 100, 200, 500, 1000];
const MAX_DIV = 8;
/* 参与 Y 轴位分配的主曲线（其余 small 系列不上轴） */
const MAIN_AXIS_IDS = new Set(['vbus', 'ibus', 'pwr']);
function niceScale(rawMax, floorMax = 0) {
  const raw = Math.max(rawMax, floorMax, 1e-6);
  for (const st of NICE_STEPS) {
    const n = Math.ceil(raw / st);
    if (n <= MAX_DIV) return { max: n * st, step: st, n };
  }
  const st = NICE_STEPS[NICE_STEPS.length - 1];
  const n = Math.ceil(raw / st);
  return { max: n * st, step: st, n };
}

export class Chart {
  constructor(canvas, opts = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.store = null;
    this.series = [];              // 可见系列
    this.colors = {};
    this.opts = Object.assign({
      windowMs: 20000,             // 实时窗口
      area: true,                  // 功率面积
      gridX: 10,
      offset: { v: 1.05, i: 1.1, p: 1.15 },
      live: true,
      autoFollow: false,           // true = 松手后自动回到最新（实时监控用）
      gapMs: 2500,                 // 相邻样本超过该间隔 = 断连/停流，曲线断开不连线
    }, opts);
    this.view = { t0: 0, t1: 20000 };   // 当前视窗（ms）
    /* 测量模式（复刻官方 PC 版）：{ t1, t2, drag } —— 两条可拖竖线的时刻（store 时间轴）。
       为 null = 未开启测量；onMeasure 在拖动/抬手时回调（app.js 刷新测量面板）。 */
    this.measure = null;
    this.onMeasure = null;
    this.follow = true;
    /* 总览（「缩放」按钮）：follow 的变体 —— 左端钉在数据起点、右端贴最新，
       窗口随时间自然变宽，曲线一边更新一边保持"全程可见"。
       不是定格快照（用户 2026-10-11 明确：点了缩放也要继续动）。 */
    this.fitAll = false;
    this.hover = null;             // 十字光标索引
    this.tipEl = null;
    this.pal = { ...PALETTE_DARK };
    this.pad = { ...PAD_BASE };      // 绘制内边距，随轴数量动态调整
    /* 轴位变化回调（app.js 用它同步曲线页底部脚注的左/右轴单位）。
       只在「外侧轴单位 | 右轴单位」这个签名变化时触发一次，不是每帧。 */
    this.onAxisChange = null;
    this._axisSig = null;
    this._tipTimer = null;         // 读数浮层自动收起的定时器（拖虚线时会被取消）
    this._raf = null;
    this._bindPointer();
    this._resize();
    window.addEventListener('resize', () => { this._resize(); this.draw(); });
  }

  /* ── 尺寸 ── */
  _resize() {
    const r = this.cv.getBoundingClientRect();
    const w = Math.max(10, r.width), h = Math.max(10, r.height);
    this.cv.width = Math.round(w * DPR);
    this.cv.height = Math.round(h * DPR);
    this.ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    this.W = w; this.H = h;
  }

  setData(store) { this.store = store; }
  setSeries(list) { this.series = list; this._updatePad(); }
  setColors(c) { this.colors = c; }
  setTip(el) { this.tipEl = el; }
  setWindow(ms) { this.opts.windowMs = ms; }
  /** 主题切换：{ grid, gridStrong, txt }，不传的键保持原值 */
  setPalette(p) { Object.assign(this.pal, p || {}); }

  /* ══════════ 指针交互 ══════════ */
  _bindPointer() {
    const cv = this.cv;
    let dragging = false, lastX = 0, lastY = 0, moved = 0, pinch = null, vertPan = false, mDrag = 0, xDrag = false;
    const pts = new Map();
    /* 读数容差（px）：手指按下后的轻微抖动不该被当成「拖动」——
       手机触摸的抖动比鼠标大得多，原来 3px 的阈值会让点按经常被误判成拖图。
       在容差内 = 仍处于读数模式（十字光标 + tooltip 跟随手指）；
       超过容差才让位给横向平移 / 纵向滚页。 */
    const TAP_TOL = 8;

    const localX = (e) => e.clientX - cv.getBoundingClientRect().left;

    cv.addEventListener('pointerdown', (e) => {
      pts.set(e.pointerId, e.clientX);
      if (pts.size === 1) {
        if (this._afTimer) { clearTimeout(this._afTimer); this._afTimer = null; }   // 有操作：取消自动复位
        /* 也取消「读数浮层自动收起」——否则拖着虚线读数突然消失（2026-10-13） */
        if (this._tipTimer) { clearTimeout(this._tipTimer); this._tipTimer = null; }
        dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY; vertPan = false;
        /* ★ 测量模式（2026-10-12 复刻官方）：手指落在测量线附近 → 拖这条线，不做读数/平移。
           容差 34px 是触摸可用的手感（官方 PC 用 10px 鼠标阈值，手机上太小）。 */
        const hit = this.measure ? this._measureHit(localX(e)) : 0;
        if (hit) {
          mDrag = hit;
          this.measure.drag = hit;
          this._clearHover();
          this.draw();
          try { cv.setPointerCapture(e.pointerId); } catch {}
          return;
        }
        /* ★ 拖动读数虚线（十字光标）—— 用户 2026-10-13：
           「曲线 TAB 点一下会出悬浮读数 + 一条虚线，虚线可以拖、读数跟着变；
             拖虚线以外的区域还是平移曲线图」。
           所以按下时先看手指是不是落在**已有的**那条虚线上：是 → 这一整段手势
           都用来拖它（读数实时更新），不再平移；不是 → 走原来的读数/平移逻辑。
           容差 28px 与测量线同量级，手指够得着。 */
        if (this._crosshairHit(localX(e))) {
          xDrag = true;
          this._pick(localX(e), e);
          try { cv.setPointerCapture(e.pointerId); } catch {}
          return;
        }
        /* ⚠ 触摸设备**没有「悬停」**：手指必然先 pointerdown，若按下这一刻不取点，
           下面的 pointermove 会一路走 dragging 分支、`_pick` 永远轮不到 ——
           这就是「鼠标悬停能看读数、手指点了没反应」的根因。
           所以按下就先显示该点读数（鼠标按住同理），之后真拖动再让位。 */
        this._pick(localX(e), e);
      }
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.abs(a - b), span: this.view.t1 - this.view.t0 };
      }
      /* ⚠ 放在最后并 try 包住：这个 API 在合成事件或部分移动端 WebView 的边界情况下会抛
         NotFoundError，一旦抛出就会**中断整个 pointerdown 处理函数** ——
         而取点/读数/开始拖动都在这之前，绝不能被它带崩。
         capture 只是为了在手指划出画布后仍能收到 move；失败也不影响后续判断。 */
      try { cv.setPointerCapture(e.pointerId); } catch {}
    });

    cv.addEventListener('pointermove', (e) => {
      if (pts.has(e.pointerId)) pts.set(e.pointerId, e.clientX);
      /* ★ 拖动测量线（测量模式）：时间直接由落点像素换算，内容边界夹住 */
      if (mDrag && this.measure) {
        const span = this.view.t1 - this.view.t0;
        const w = Math.max(1, this.W - this.pad.l - this.pad.r);
        const px = Math.max(0, Math.min(w, localX(e) - this.pad.l));
        const t = this.view.t0 + px / w * span;
        if (mDrag === 1) this.measure.t1 = t; else this.measure.t2 = t;
        this.draw();
        if (this.onMeasure) this.onMeasure();
        lastX = e.clientX; lastY = e.clientY;
        return;
      }
      /* ★ 拖读数虚线：整段手势都用来移动十字光标，读数浮层跟着变，视图不动 */
      if (xDrag) {
        this._pick(localX(e), e);
        lastX = e.clientX; lastY = e.clientY;
        return;
      }
      if (pts.size === 2 && pinch) {
        const [a, b] = [...pts.values()];
        lastY = e.clientY;
        const d = Math.abs(a - b);
        if (d > 6) {
          const k = pinch.d / d;
          const span = Math.min(Math.max(pinch.span * k, 120), 600000);
          const c = (this.view.t0 + this.view.t1) / 2;
          this.view.t0 = c - span / 2; this.view.t1 = c + span / 2;
          this._setFollow(false);        // 捏合 = 自由查看：两个模式按钮都不再高亮
          this._clearHover();
          this.draw();
        }
        return;
      }
      const dy = e.clientY - lastY;
      if (dragging) {
        const dx = e.clientX - lastX;
        // 纵向滑动 → 滚动页面（touch-action 在部分 WebView 不生效时的手动兜底）
        if (!vertPan && Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx) * 1.4) {
          vertPan = true;
        }
        if (vertPan) {
          const sc = this.cv.closest('.views');
          if (sc) sc.scrollTop -= dy;
          lastX = e.clientX; lastY = e.clientY;
          if (this.hover !== null) { this._clearHover(); this.draw(); }
          return;
        }
        moved += Math.abs(dx);
        if (moved > TAP_TOL) {
          /* 超容差 = 真想平移视图：让出读数（十字光标收起），再平移 */
          const span = this.view.t1 - this.view.t0;
          const dt = -dx / (this.W - this.pad.l - this.pad.r) * span;
          this.view.t0 += dt; this.view.t1 += dt;
          this._setFollow(false);        // 拖动 = 自由查看
          lastX = e.clientX;
          if (this.hover !== null) { this._clearHover(); this.draw(); }
        } else {
          this._pick(localX(e), e);      // 容差内：读数跟随手指（按住滑动即可逐点查看）
        }
      } else {
        this._pick(localX(e), e);
      }
      lastY = e.clientY;
    });

    const up = (e) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (mDrag) {
        mDrag = 0;
        if (this.measure) this.measure.drag = 0;
        this.draw();
        if (this.onMeasure) this.onMeasure();
      }
      if (pts.size === 0) {
        dragging = false;
        vertPan = false;
        xDrag = false;
        if (this.opts.autoFollow) {
          // 松手后 3 秒无操作 → 自动回到最新；期间可自由拖动查看
          if (this._afTimer) clearTimeout(this._afTimer);
          this._afTimer = setTimeout(() => {
            this._afTimer = null;
            this._setFollow(true);
            this.draw();
          }, 3000);
        }
        /* 抬手后读数保留一段时间再自动收起。时长由设置页「曲线读数停留时间」决定
           （app.js 把它同步到本实例的 tipHoldMs，默认 3 秒；**0 = 一直显示**，
           此时不挂定时器，靠再次点击 / 切页 / 清空来收起）。 */
        const hold = this.tipHoldMs ?? 3000;
        if (this._tipTimer) clearTimeout(this._tipTimer);
        if (hold > 0) this._tipTimer = setTimeout(() => { this._tipTimer = null; this._clearHover(); this.draw(); }, hold);
      }
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    /* ⚠ 只有**鼠标**移出画布才收起读数。
       触摸设备上手指抬起 = 离开元素，浏览器会紧接着补一个 pointerleave，
       而那时 up() 已把 dragging 置 false → 条件成立 → **刚弹出来的读数被立刻清掉**，
       用户在设置里把停留时间调到 10s/30s/常驻都没用（定时器还没到就被清了）。
       鼠标抬起后仍悬在元素上、不会触发 pointerleave，所以桌面端一直是对的。 */
    cv.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !dragging) { this._clearHover(); this.draw(); }
    });
  }

  /** 收起十字光标与 tooltip（读数的统一出口） */
  _clearHover() { if (this.hover !== null) this.hover = null; this._hideTip(); }

  /** 读数浮层正显示时，用**当前** series 重新生成内容。
      筛选/颜色一变就调它 —— 否则浮层内容停留在改动前那一组，
      用户会以为"筛选没生效"，得再点一次曲线才更新（用户 2026-10-11 反馈的现象）。 */
  refreshTip() {
    if (this.hover === null) return;
    this.draw();
    this._showTip(this.hover);
  }

  /* 命中最近的样本 */
  _pick(px, e) {
    const s = this.store;
    if (!s || !s.size) return;
    const span = this.view.t1 - this.view.t0;
    const t = this.view.t0 + (px - this.pad.l) / (this.W - this.pad.l - this.pad.r) * span;
    const idx = this._indexAtTime(t);
    if (idx < 0) { this.hover = null; this._hideTip(); this.draw(); return; }
    this.hover = idx;
    this.draw();
    this._showTip(idx, e);
  }

  _indexAtTime(t) {
    const s = this.store;
    if (!s.size) return -1;
    let lo = 0, hi = s.size - 1;
    if (t <= s.at(0, 't')) return 0;
    if (t >= s.at(hi, 't')) return hi;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s.at(mid, 't') < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  _showTip(idx, e) {
    const el = this.tipEl; if (!el) return;
    const s = this.store;
    const time = s.at(idx, 't');
    let html = `<div class="tt-h">${fmtTime(time)}</div>`;
    for (const se of this.series) {
      if (se.small && !this.opts.showSmall) continue;
      const v = s.at(idx, se.id);
      html += `<div class="tt-r"><i class="tt-s" style="background:${this._color(se)}"></i>${se.code}<span class="tt-v">${fmtVal(v, se)}</span></div>`;
    }
    el.innerHTML = html;
    el.classList.add('show');
    const px = this._x(time);
    const py = 14;
    /* ⚠ 浮层是 `translate(-50%)` 居中的，夹边界必须按**自身宽度**算：
       原来写死 `min(宽-8, max(70, px))` —— 左端留的 70px 刚好够半个宽度，看着没事；
       右端只留 8px，右半截直接伸到画布外（用户 2026-10-13 实测："只会跑到右边屏幕外"）。
       `.chart-tip` 是 opacity:0 而不是 display:none，所以这里量 offsetWidth 是准的。
       2026-10-13 二轮：夹的范围再收窄到**绘图区**（两根纵轴之间），别压到轴刻度上。 */
    const half = (el.offsetWidth || 0) / 2;
    const lo = this.pad.l + half + 4, hi = this.W - this.pad.r - half - 4;
    const cx = hi >= lo ? Math.min(hi, Math.max(lo, px)) : (this.pad.l + this.W - this.pad.r) / 2;
    el.style.left = cx + 'px';
    el.style.top = py + 'px';
    el.style.transform = 'translate(-50%, 0)';
  }

  _hideTip() { if (this.tipEl) this.tipEl.classList.remove('show'); }

  _color(se) { return this.colors[se.id] || se.color; }

  /* ══════════ 坐标换算 ══════════ */
  _x(t) {
    const span = this.view.t1 - this.view.t0;
    return this.pad.l + (t - this.view.t0) / span * (this.W - this.pad.l - this.pad.r);
  }
  _y(v, scale) {
    const h = this.H - this.pad.t - this.pad.b;
    return this.pad.t + (1 - (v - scale.min) / (scale.max - scale.min || 1)) * h;
  }

  /* ══════════ 绘制 ══════════ */
  draw() {
    const ctx = this.ctx, s = this.store;
    if (!this.W) this._resize();
    const W = this.W, H = this.H;
    ctx.clearRect(0, 0, W, H);
    const hasVis = this.series.some(x => !(x.small && !this.opts.showSmall));
    if (!s || !s.size) { this._empty('暂无数据'); return; }
    if (!hasVis) { this._empty('未选择曲线'); return; }

    // 跟随模式：视窗贴住最新；数据不足一个窗口时按已有数据自适应，避免左侧一条窄带
    const lastT = s.at(s.size - 1, 't');
    if (this.follow) {
      if (this.fitAll) {
        /* 总览：左端钉数据起点、右端贴最新 —— 每帧重算，所以新数据进来画面继续动。
           ⚠ 起点取 store 首样本的 t，不能写死 0：开「使用系统时间」时 t 是当日毫秒数。 */
        const firstT = s.at(0, 't');
        const span = Math.max(lastT - firstT, 500);
        this.view.t0 = firstT;
        this.view.t1 = lastT + span * 0.005;   // 右端留白与跟随档同比例（0.5%）
      } else {
        const span = Math.min(this.opts.windowMs, Math.max(lastT * 1.06, 1500));
        /* 右端留白 4%→0.5%（用户 2026-10-10 二轮：曲线右端到刻度之间总有一截空白）。
           0.5% 只防最新样本被画布裁半格，肉眼即"贴边"。 */
        let t1 = lastT + span * 0.005;
        let t0 = t1 - span;
        if (t0 < 0) { t0 = 0; t1 = span; }
        this.view.t0 = t0; this.view.t1 = t1;
      }
      /* ★ 测量线**钉死在绝对时刻**，不跟随视窗滚动（用户 2026-10-13 明确）：
         它要量的就是「某个固定时间段」内各曲线怎么变，所以视窗滚过去以后线就该出画，
         而不是跟着一起漂。想看它们时把曲线拖回去 / 用「缩放」即可。 */
    }

    const [i0, i1] = this._visibleRange();
    const plan = this._updatePad();
    /* 轴位变了就通知一次（脚注单位跟随）—— 用单位签名去重，避免每帧回调 */
    const sig = (plan.outer ? plan.outer.unit : '') + '|' + (plan.right ? plan.right.unit : '');
    if (sig !== this._axisSig) { this._axisSig = sig; try { this.onAxisChange?.(plan); } catch {} }
    const scales = this._scales(i0, i1, plan);

    /* 动态轴宽（Beta 15）：左右留白按最宽刻度标签实测收紧 —— 空白还给曲线 */
    ctx.font = '9px ui-monospace, monospace';
    const tickW = (se) => {
      const sc = se && scales[se.id];
      if (!sc) return 0;
      let w = 0;
      for (let i = 0; i <= sc.n; i++)
        w = Math.max(w, ctx.measureText(shortNum(sc.max * (1 - i / sc.n)) + se.unit).width);
      return w;
    };
    /* 轴条宽度 = 最宽刻度文字 + 2px 间隙：绘图区直接延伸到刻度贴上的位置，两侧零空白
       （用户 2026-10-10；画布本身已用负 margin 贴满卡片）。
       2026-10-13：左内侧轴的标签画在**绘图区内**，所以左侧留白只算外侧那一列 ——
       绘图区宽度不因第二个轴变窄（用户要求「不改变曲线图」）。 */
    const wOuter = Math.ceil(tickW(plan.outer));
    const wRight = Math.ceil(tickW(plan.right));
    this.pad.l = Math.max(16, wOuter + 2);
    this.pad.r = plan.right ? Math.max(16, wRight + 2) : 2;

    /* 把绘图区边界同步成容器上的 CSS 变量（--plot-l / --plot-r / --plot-b）：
       曲线页的悬浮窗（测量窗 / 统计窗）用它们把自己限制在**两根纵轴之间、时间轴之上**
       （用户 2026-10-13）。只在值变了才写，避免每帧触发样式重算。
       ⚠ renderOffscreen 的离屏 canvas 没有父节点 → host 为 null，跳过即可。 */
    const host = this.cv.parentElement;
    if (host && host.style) {
      const psig = `${this.pad.l}|${this.pad.r}|${this.pad.b}`;
      if (psig !== this._padSig) {
        this._padSig = psig;
        host.style.setProperty('--plot-l', this.pad.l + 'px');
        host.style.setProperty('--plot-r', this.pad.r + 'px');
        host.style.setProperty('--plot-b', this.pad.b + 'px');
      }
    }

    this._gridOn = this.opts.grid !== false;   // 网格线可关（轴刻度仍显示）
    if (this._gridOn) this._grid(scales, plan);
    for (const se of this.series) {
      if (se.small && !this.opts.showSmall) continue;
      this._line(se, i0, i1, scales);
    }
    this._axes(scales, plan);
    if (this.hover != null) this._crosshair(this.hover, scales);
    if (this.measure) this._measureLines(scales);
  }

  /* ══════════ 测量线（复刻官方 PC 版「测量」：T1/T2 两条可拖竖线 + 逐系列差值）══════════
     官方实现（app.exe 前端源码实证）：两条 markLine 默认落在视窗 30%/70%，可拖动；
     每条线与各曲线的交点画 markPoint 标值；差值面板标题「T1 - T2」，逐系列列出 T1−T2。
     手机端取舍：数值标签只画可见的前 4 条曲线（手机屏幕小，全画会糊成一团），
     完整的逐系列 T1/T2/Δ 走图表下方的测量面板（app.js: renderMeasurePanel）。 */
  _measureLines(scales) {
    const ctx = this.ctx, s = this.store, m = this.measure;
    if (!s || !s.size) return;
    const top = this.pad.t, bot = this.H - this.pad.b;
    const asLine = (t, color, label, active) => {
      const x = this._x(t);
      if (x < this.pad.l - 2 || x > this.W - this.pad.r + 2) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = active ? 2 : 1.2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bot); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '10px ui-monospace, monospace';
      const tw = ctx.measureText(label).width + 8;
      const lx = Math.min(Math.max(x - tw / 2, this.pad.l), this.W - this.pad.r - tw);
      ctx.fillStyle = color;
      ctx.fillRect(lx, top - 12, tw, 12);
      ctx.fillStyle = '#08121f';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, lx + tw / 2, top - 6);
      /* 交点的数值标签：可见曲线里取前 4 条（跳过 small 未开启的） */
      const idx = this._indexAtTime(t);
      let ty = top + 13, n = 0;
      ctx.textAlign = 'left';
      for (const se of this.series) {
        if (se.small && !this.opts.showSmall) continue;
        if (!scales[se.id]) continue;
        const v = s.at(idx, se.id);
        if (!isFinite(v)) continue;
        /* 交点上标出「系列代号 + 数值」，此前只有裸数值，看不出是哪条曲线
           （用户 2026-10-13：「虚线没有标注代表什么数据，比如电流、电压或功率的字母标识」） */
        const txt = se.code + ' ' + v.toFixed(Math.min(se.digits ?? 3, 4)) + se.unit;
        ctx.font = '9px ui-monospace, monospace';
        const w = ctx.measureText(txt).width + 6;
        const bx = Math.min(Math.max(x + 4, this.pad.l), this.W - this.pad.r - w);
        ctx.globalAlpha = 0.92;
        ctx.fillStyle = this._color(se);
        ctx.fillRect(bx, ty, w, 12);
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#08121f';
        ctx.fillText(txt, bx + 3, ty + 6.5);
        ty += 13;
        if (++n >= 4) break;
      }
      ctx.restore();
    };
    const active = m.drag | 0;
    asLine(m.t1, '#22c55e', 'T1', active === 1);
    asLine(m.t2, '#f59e0b', 'T2', active === 2);
  }

  /** 读数虚线（十字光标）命中判定：已经有光标、且手指落在它附近 → 拖它
      （用户 2026-10-13：拖虚线 = 移动读数；拖别处 = 平移曲线图）。
      容差 28px：和测量线同量级，手机手指够得着又不会抢走大部分平移手势。 */
  _crosshairHit(px) {
    if (this.hover === null || !this.store || !this.store.size) return false;
    return Math.abs(px - this._x(this.store.at(this.hover, 't'))) <= 28;
  }

  /** 测量线命中判定：返回 1/2（哪条线），0 = 没命中 */
  _measureHit(px) {
    if (!this.measure || this.W <= 0) return 0;
    const d1 = Math.abs(px - this._x(this.measure.t1));
    const d2 = Math.abs(px - this._x(this.measure.t2));
    const near = Math.min(d1, d2);
    if (near > 34) return 0;
    return d1 <= d2 ? 1 : 2;
  }

  _visibleRange() {
    const s = this.store;
    let a = this._indexAtTime(this.view.t0);
    let b = this._indexAtTime(this.view.t1);
    // 多取一点保证边缘连续
    a = Math.max(0, a - 2); b = Math.min(s.size - 1, b + 2);
    return [a, b];
  }

  /* ══════════ Y 轴位分配 ══════════
     三个轴位：outer（绘图区左缘**外侧**）· inner（左缘**内侧**、压在绘图区里）· right（右）。
     用户 2026-10-13 定稿规则：
       · 功率固定右轴；
       · 电压 + 电流 + 功率 三条都开 → 左外=电压、左内=电流、右=功率；
       · 只有两条 → 都放**最外侧**（左外 + 右），内侧留空：
           电压+电流 → 左外=电压、右=电流（rule「左侧电压、右侧电流」）；
           功率+电压 → 左外=电压、右=功率；功率+电流同理；
       · 只有一条 → 功率上右轴、电压/电流上左外侧。
     主轴之外的小系列（CC/温度/…）在没有主曲线占左轴时补到左外侧。 */
  _isVis(se) { return !!se && !(se.small && !this.opts.showSmall); }

  _plan() {
    const main = this.series.filter(se => MAIN_AXIS_IDS.has(se.id) && this._isVis(se));
    const has = (id) => main.some(se => se.id === id);
    const at = (id) => this.series.find(se => se.id === id) || null;
    const V = has('vbus'), I = has('ibus'), P = has('pwr');
    const cnt = (V ? 1 : 0) + (I ? 1 : 0) + (P ? 1 : 0);

    const plan = { outer: null, inner: null, right: null };
    if (cnt >= 3) {
      plan.outer = at('vbus');
      plan.inner = at('ibus');
      plan.right = at('pwr');
    } else if (cnt === 2) {
      /* 只有两条：都用最外侧；功率固定右轴 */
      if (P) plan.right = at('pwr');
      if (V && I) { plan.outer = at('vbus'); plan.right = plan.right || at('ibus'); }
      else if (V) plan.outer = at('vbus');
      else if (I) plan.outer = at('ibus');
    } else if (cnt === 1) {
      if (P) plan.right = at('pwr');
      else if (V) plan.outer = at('vbus');
      else if (I) plan.outer = at('ibus');
    }
    // 没有主曲线占左轴时（例如大图只勾了小信号），用第一条可见小系列补左外侧
    if (!plan.outer && !plan.inner) {
      const sm = this.series.find(se => se.small && this._isVis(se));
      if (sm) plan.outer = sm;
    }
    return plan;
  }

  /** 轴位优先级：新布局（2026-10-13）由可见曲线集合完全决定，此处仅为兼容旧调用保留 */
  setAxisPref(order) { this.axisPref = Array.isArray(order) ? order.slice() : null; }

  /** 返回本次轴位分配；具体留白宽度在 draw() 里按实测文字宽收紧 */
  _updatePad() {
    const plan = this._plan();
    this.pad = { ...PAD_BASE };
    return plan;
  }

  /* 每条曲线独立量程：max = 可见区间峰值 × 该系列的偏移倍数，再取漂亮刻度。
     此前 V/A 共用一根右轴，功率(20W)把电流(2A)的量程撑大 10 倍，
     曲线全被压在底部 —— 现在各自动态缩放，互不挤压。
     AXIS_FLOOR：电流轴量程下限 10A —— 给电流留出更大量程，
     让电流与功率两条曲线在图上拉开层次（超 10A 仍自动放大）。 */
  _scales(i0, i1, plan) {
    const s = this.store;
    const out = {};
    const of = this.opts.offset;
    const AXIS_FLOOR = { ibus: 10 };
    for (const se of this.series) {
      if (!this._isVis(se)) continue;
      let mx = -Infinity, mn = Infinity;
      const stride = Math.max(1, Math.floor((i1 - i0) / 3000));
      for (let i = i0; i <= i1; i += stride) {
        const v = s.at(i, se.id);
        if (v > mx) mx = v; if (v < mn) mn = v;
      }
      if (!isFinite(mx)) continue;
      const m = se.id === 'vbus' ? of.v : se.id === 'ibus' ? of.i : se.id === 'pwr' ? of.p : 1.15;
      /* 倍数作用在「峰值与轴下限的较大者」上。
         ⚠ 2026-10-13 修：floor 原来作为 niceScale 的硬下限传入，电流轴下限 10A
         会把 3.2A 的峰值完全盖住 → 倍数在 1.0–3.1 区间内毫无作用（用户报"电流那条完全没用"）。
         现在先把 floor 折进基数，再统一乘倍数，倍数对三条曲线都能立即体现。 */
      const sc = niceScale(Math.max(mx, AXIS_FLOOR[se.id] || 0) * m);
      out[se.id] = { min: mn < 0 ? mn * 1.05 : 0, ...sc };
    }
    /* 上了轴的曲线共用同一段数，保证横向网格线在三条轴的标签位置一致 */
    const onAxes = [plan.outer, plan.inner, plan.right].filter(se => se && out[se.id]);
    if (onAxes.length > 1) {
      const n = Math.max(...onAxes.map(se => out[se.id].n));
      for (const se of onAxes) { out[se.id].n = n; out[se.id].max = out[se.id].step * n; }
    }
    return out;
  }

  /* 主轴段数：跟随左外侧轴（缺省则左内 / 右轴）的漂亮刻度段数 */
  _mainN(sc, plan) {
    for (const se of [plan.outer, plan.inner, plan.right]) {
      if (se && sc[se.id]) return sc[se.id].n;
    }
    return 4;
  }

  _grid(sc, plan) {
    const ctx = this.ctx, W = this.W, H = this.H;
    const h = H - this.pad.t - this.pad.b, w = W - this.pad.l - this.pad.r;
    const n = Math.max(1, this._mainN(sc, plan));
    ctx.strokeStyle = this.pal.grid; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const y = Math.round(this.pad.t + h * i / n) + .5;
      ctx.moveTo(this.pad.l, y); ctx.lineTo(this.pad.l + w, y);
    }
    const nx = this.W < 420 ? 4 : this.opts.gridX;
    for (let i = 0; i <= nx; i++) {
      const x = Math.round(this.pad.l + w * i / nx) + .5;
      ctx.moveTo(x, this.pad.t); ctx.lineTo(x, this.pad.t + h);
    }
    ctx.stroke();

    ctx.strokeStyle = this.pal.gridStrong;
    ctx.beginPath();
    ctx.moveTo(this.pad.l + .5, this.pad.t); ctx.lineTo(this.pad.l + .5, this.pad.t + h);
    ctx.moveTo(this.pad.l + w - .5, this.pad.t); ctx.lineTo(this.pad.l + w - .5, this.pad.t + h);
    ctx.moveTo(this.pad.l, this.pad.t + h + .5); ctx.lineTo(this.pad.l + w, this.pad.t + h + .5);
    ctx.stroke();
  }

  _axes(sc, plan) {
    const ctx = this.ctx;
    ctx.font = '9px ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    const h = this.H - this.pad.t - this.pad.b;
    const n = Math.max(1, this._mainN(sc, plan));
    /* 三列刻度共用同一组横线，标签全是 step 整数倍：
       outer = 绘图区**外侧**（左缘以左、右对齐）、inner = 绘图区**内侧**
       （左缘以右、压在绘图区里、左对齐）、right 贴右缘（左对齐）。 */
    const cols = [
      { se: plan.outer, x: this.pad.l - 1,             align: 'right' },
      { se: plan.inner, x: this.pad.l + AXIS_INNER_INSET, align: 'left' },
      { se: plan.right, x: this.W - this.pad.r + 1,    align: 'left'  },
    ];
    for (const c of cols) {
      const se = c.se;
      if (!se || !sc[se.id]) continue;
      ctx.fillStyle = this._color(se);
      ctx.textAlign = c.align;
      for (let i = 0; i <= n; i++) {
        const y = this.pad.t + h * i / n;
        const v = sc[se.id].max * (1 - i / n);
        ctx.fillText(shortNum(v) + se.unit, c.x, y);
      }
    }
    /* 时间轴（用户 2026-10-10 二轮）：紧凑刻度格式 + 首尾内收 ——
       此前 '00:00:00.0' 太长，且首尾标签的中心压在绘图区边界上，文字一半被画布裁掉。
       现在首标签左对齐到绘图区左缘、末标签右对齐到右缘、中间居中，密度 +1 档更紧凑。 */
    ctx.fillStyle = this.pal.txt;
    ctx.textBaseline = 'top';
    const nt = this.W < 420 ? 4 : 6;
    const w = this.W - this.pad.l - this.pad.r;
    for (let i = 0; i <= nt; i++) {
      const t = this.view.t0 + (this.view.t1 - this.view.t0) * i / nt;
      const x = this.pad.l + w * i / nt;
      ctx.textAlign = i === 0 ? 'left' : i === nt ? 'right' : 'center';
      ctx.fillText(fmtTick(t), x, this.pad.t + h + 6);
    }
  }

  _line(se, i0, i1, sc) {
    const ctx = this.ctx, s = this.store;
    const scale = sc[se.id];
    if (!scale) return;
    const color = this._color(se);
    const w = this.W - this.pad.l - this.pad.r;
    const step = Math.max(1, Math.floor((i1 - i0) / (w * 2)));

    const path = new Path2D();
    let started = false;
    let maxY = Infinity, maxI = -1;
    /* 断线检测：相邻样本时间差超过 gapMs（断连/停流）或时间倒退（重连后基准变化）
       → 另起新子路径，不画误导性的跨 gap 连线（用户 2026-10-10） */
    const gapMs = this.opts.gapMs || 2500;
    let lastT = -Infinity;
    /* 面积填充与曲线**逐段同步构建**：每段独立「曲线段 + 底边」闭合。
       旧实现 Path2D(path) 整体复制后只在首尾补底边 —— 后台节流/断流产生多段子路径时，
       closePath 回最后段起点、底边却横跨全窗，画出从左下角斜穿到右上角的大斜坡
       （MuMu 后台节流实测，用户 2026-10-11）。 */
    const area = this.opts.area && !se.small;
    const base = this.pad.t + this.H - this.pad.t - this.pad.b;
    const ap = area ? new Path2D() : null;
    let segStartX = null, lastX = null;
    const closeSeg = () => {
      if (ap && started && lastX != null && segStartX != null) {
        ap.lineTo(lastX, base);
        ap.lineTo(segStartX, base);
        ap.closePath();
      }
    };
    for (let i = i0; i <= i1; i += step) {
      const t = s.at(i, 't');
      const x = this._x(t);
      const y = this._y(s.at(i, se.id), scale);
      if (!started || (t - lastT) > gapMs || t < lastT) {
        closeSeg();                              // 结束上一段：补底边闭合
        path.moveTo(x, y);
        if (ap) { ap.moveTo(x, y); segStartX = x; }
        started = true;
      } else {
        path.lineTo(x, y);
        if (ap) ap.lineTo(x, y);
      }
      lastT = t; lastX = x;
      if (y < maxY) { maxY = y; maxI = i; }
    }
    closeSeg();                                  // 收尾段
    if (!started) return;

    /* 面积填充（Beta13 二轮，用户定稿）：**不要渐变** —— 从曲线到轴底实色浅填充。
       Beta19：逐段闭合（见上），断线段不再斜穿整个画布。 */
    if (area) {
      ctx.fillStyle = hexA(color, .22);
      ctx.fill(ap);
    }

    ctx.lineWidth = se.small ? 1.2 : 1.8;
    ctx.strokeStyle = color;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.shadowColor = hexA(color, .55); ctx.shadowBlur = se.small ? 0 : 5;
    ctx.stroke(path);
    ctx.shadowBlur = 0;
  }

  _crosshair(idx, sc) {
    const ctx = this.ctx, s = this.store;
    const t = s.at(idx, 't');
    const x = Math.round(this._x(t)) + .5;
    const h = this.H - this.pad.t - this.pad.b;
    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = 'rgba(160,180,205,.55)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, this.pad.t); ctx.lineTo(x, this.pad.t + h); ctx.stroke();
    ctx.restore();

    for (const se of this.series) {
      if (se.small && !this.opts.showSmall) continue;
      const scale = sc[se.id];
      if (!scale) continue;
      const v = s.at(idx, se.id);
      const y = this._y(v, scale);
      const c = this._color(se);
      ctx.beginPath(); ctx.arc(x, y, 3.6, 0, Math.PI * 2);
      ctx.fillStyle = c; ctx.fill();
      ctx.strokeStyle = '#0a0e15'; ctx.lineWidth = 1.6; ctx.stroke();
    }
  }

  /** 视图模式变化通知（app.js 用它同步「跟随/缩放」按钮的激活态）。
      只在真正切换时调一次 —— 拖拽是每帧 pointermove，不能每帧回调。 */
  _viewChanged() { try { this.onViewChange?.(); } catch {} }
  /** 统一的 follow 变更入口：值真的变了才通知 */
  _setFollow(v) {
    if (this.follow === v) return;
    this.follow = v;
    this._viewChanged();
  }

  /* ══════════ 离屏渲染（导出图片用，Beta20 追加，用户 2026-10-11）══════════
     把当前视图按指定**逻辑尺寸** + 缩放倍数画到一张独立 canvas 上并返回。
     复用全部绘制逻辑（轴 / 网格 / 曲线 / 刻度 / tooltip 除外），只换画布和尺寸 ——
     刻度字体是固定 px 的，所以逻辑尺寸要贴近手机（约 360 宽），靠 scale 放大出高清图。

     ⚠ 过程中会临时替换 this.cv/ctx/W/H/pad/view；结束一律还原。
       view 也要还原 —— follow 分支每帧会重算它，别把导出用的瞬时值留到屏幕上。
     ⚠ draw() 本身不碰 DOM（已确认），所以离屏 canvas 不进文档也能画。 */
  renderOffscreen(W, H, scale = 3, bg = null) {
    const cv = document.createElement('canvas');
    cv.width = Math.round(W * scale);
    cv.height = Math.round(H * scale);
    const ctx = cv.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const bak = { cv: this.cv, ctx: this.ctx, W: this.W, H: this.H, pad: this.pad, view: { ...this.view } };
    this.cv = cv; this.ctx = ctx; this.W = W; this.H = H; this.pad = { ...PAD_BASE };
    try {
      if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); }
      this.draw();
    } finally {
      this.cv = bak.cv; this.ctx = bak.ctx; this.W = bak.W; this.H = bak.H;
      this.pad = bak.pad; this.view = bak.view;
    }
    return cv;
  }

  _empty(text) {
    const ctx = this.ctx;
    ctx.fillStyle = this.pal.txt;
    ctx.font = '12px -apple-system, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text || '暂无数据', this.W / 2, this.H / 2);
  }
}

/* ══════════ 工具 ══════════ */
export function fmtTime(ms) {
  const s = Math.max(0, ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor(s / 60) % 60;
  const ss = Math.floor(s) % 60;
  const d = Math.floor((s * 10) % 10);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${d}`;
}
/* X 轴刻度专用紧凑时间（用户 2026-10-10 二轮：'00:00:00.0' 太散、两端被裁）：
   <1min → '12.5'（秒.十分位）；<1h → '2:31'（分:秒）；≥1h → '1:02'（时:分）。
   完整格式 fmtTime 用于 tooltip / 底部状态栏。
   ⚠ CSV 不用 fmtTime —— 它只有 0.1s 分辨率，166Hz 下时间戳会成片重复，
   CSV 走 app.js 的 csvTime（毫秒精度）。 */
export function fmtTick(ms) {
  const s = Math.max(0, ms / 1000);
  if (s >= 3600) {
    const hh = Math.floor(s / 3600), mm = Math.floor(s / 60) % 60;
    return `${hh}:${String(mm).padStart(2, '0')}`;
  }
  if (s >= 60) {
    const mm = Math.floor(s / 60), ss = Math.floor(s) % 60;
    return `${mm}:${String(ss).padStart(2, '0')}`;
  }
  const ss = Math.floor(s), d = Math.floor((s * 10) % 10);
  return `${ss}.${d}`;
}
export function fmtVal(v, se) {
  if (v == null || !isFinite(v)) return '—';
  if (se.digits === 5) return v.toFixed(5) + se.unit;
  if (se.digits === 3) return v.toFixed(3) + se.unit;
  if (se.digits === 2) return v.toFixed(2) + se.unit;
  if (se.digits === 1) return v.toFixed(1) + se.unit;
  return Math.round(v) + se.unit;
}
/* Y 轴刻度标签：**只输出整数**（1–3 位），上千折成 k，绝不出现小数。
   （用户要求：坐标轴上的数值只显示整数 1–3 位数，别占地方） */
function shortNum(v) {
  if (Math.abs(v) >= 1000) {
    const k = v / 1000;
    return (Number.isInteger(k) ? k : k.toFixed(1).replace(/\.0$/, '')) + 'k';
  }
  return String(Math.round(v));
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
