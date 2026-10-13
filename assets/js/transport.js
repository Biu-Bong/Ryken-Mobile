/* ══════════════════════════════════════════════════════════
   transport.js — 数据层
   ──────────────────────────────────────────────────────────
   三段式：
     Source（BridgeSource / AndroidSource / UsbSource）
              ↓  emit(frame)
     DataStore（环形缓冲 + 统计 + 订阅）
              ↓
     UI

   frame 约定（与电脑端 CSV 字段一致）：
     { t, vbus, ibus, pwr, cc1, cc2, dp, dm, temp, batt, cap, wh }
     t   : 毫秒（自记录开始）
     vbus: V   ibus: A   pwr: W
     cc1/cc2/dp/dm : V
     temp: ℃   batt: %   cap: mAh   wh: Wh
   ══════════════════════════════════════════════════════════ */

/* ── 数据系列定义（颜色可在设置里改） ── */
export const SERIES = [
  { id:'vbus', name:'电压',  code:'VBUS',  unit:'V',  color:'#22c55e', axis:'left',  digits:5 },
  { id:'ibus', name:'电流',  code:'IBUS',  unit:'A',  color:'#3b82f6', axis:'right', digits:5 },
  { id:'pwr',  name:'功率',  code:'PWR',   unit:'W',  color:'#ef4444', axis:'right', digits:5 },
  { id:'cc1',  name:'CC1',   code:'CC1',   unit:'V',  color:'#ec4899', axis:'left',  digits:2, small:true },
  { id:'cc2',  name:'CC2',   code:'CC2',   unit:'V',  color:'#06b6d4', axis:'left',  digits:2, small:true },
  { id:'dp',   name:'D+',    code:'D+',    unit:'V',  color:'#14b8a6', axis:'left',  digits:2, small:true },
  { id:'dm',   name:'D−',    code:'D-',    unit:'V',  color:'#16a34a', axis:'left',  digits:2, small:true },
  { id:'temp', name:'温度',  code:'TEMP',  unit:'℃', color:'#a855f7', axis:'left',  digits:1, small:true },
  { id:'batt', name:'手机电量', code:'BATT', unit:'%',  color:'#f59e0b', axis:'left',  digits:0, small:true },
  { id:'cap',  name:'容量',  code:'Ah',    unit:'mAh',color:'#38bdf8', axis:'left',  digits:1, small:true },
  { id:'wh',   name:'能量',  code:'Wh',    unit:'Wh', color:'#fb923c', axis:'left',  digits:3, small:true },
];

export const SERIES_BY_ID = Object.fromEntries(SERIES.map(s => [s.id, s]));

/* ══════════════ 环形数据缓冲 ══════════════ */
export class DataStore {
  constructor(capacity = 200000) {
    this.capacity = capacity;
    this.n = Object.keys(FIELDS).length;
    // ⚠ 缓冲区必须是 capacity × 字段数！此前只开了 capacity，
    //   导致 ~16666 帧（100 秒）后写入越界、读取 undefined，渲染循环崩溃
    this.buf = new Float64Array(capacity * this.n);
    this.head = 0;       // 下一个写入位置
    this.length = 0;
    this.t0 = 0;
    this.listeners = new Set();
    this.stats = null;
  }
  push(f) {
    const stride = this.n;
    const off = this.head * stride;
    let i = 0;
    for (const k of Object.keys(FIELDS)) this.buf[off + i++] = f[k] ?? 0;
    if (this.length === 0) this.t0 = f.t;
    this.head = (this.head + 1) % this.capacity;
    if (this.length < this.capacity) this.length++;
    this.statsDirty = true;
  }
  clear() { this.head = 0; this.length = 0; this.statsDirty = true; }
  /* 调整环形缓冲容量（设置页「曲线缓存」，2026-10-12）：重新分配并清空数据。
     每点 = Float64 × 12 字段 = 96B；100MB ≈ 109 万点。分配失败（内存不够）返回 false，
     调用方保留原容量并提示 —— 2GB 档在低配手机的 WebView 里可能直接 OOM。 */
  setCapacity(cap) {
    cap = Math.floor(cap);
    if (!cap || cap === this.capacity) return true;
    try {
      const buf = new Float64Array(cap * this.n);
      this.buf = buf; this.capacity = cap;
      this.head = 0; this.length = 0; this.t0 = 0;
      this.stats = null; this.statsDirty = true;
      return true;
    } catch (e) { return false; }
  }
  get size() { return this.length; }

  /* 取第 i 个样本（0 = 最旧） */
  at(i, field) {
    const idx = (this.head - this.length + i + this.capacity) % this.capacity;
    return this.buf[idx * this.n + FIELDS[field]];
  }
  row(i) {
    const o = {};
    for (const k in FIELDS) o[k] = this.at(i, k);
    return o;
  }
  /* 按时间范围取（用于绘图，返回抽样后的索引数组） */
  timeRange() {
    if (!this.length) return [0, 0];
    return [this.at(0, 't'), this.at(this.length - 1, 't')];
  }
  /* 统计 min/max/avg（每个字段） */
  computeStats() {
    if (!this.statsDirty && this.stats) return this.stats;   // 数据没变就直接用缓存（停止记录后每帧不再白烧重算）
    if (!this.length) return null;
    const keys = Object.keys(FIELDS);
    const out = {};
    for (const k of keys) { out[k] = { min: Infinity, max: -Infinity, sum: 0, first: null, last: null }; }
    const stride = Math.max(1, Math.floor(this.length / 60000));   // 大样本下抽样
    for (let i = 0; i < this.length; i += stride) {
      for (const k of keys) {
        const v = this.at(i, k), o = out[k];
        if (v < o.min) o.min = v;
        if (v > o.max) o.max = v;
        o.sum += v;
        if (o.first === null) o.first = v;
        o.last = v;
      }
    }
    const cnt = Math.ceil(this.length / stride);
    for (const k of keys) out[k].avg = out[k].sum / cnt;
    this.stats = out; this.statsDirty = false;
    return out;
  }
}

const FIELDS = { t:0, vbus:1, ibus:2, pwr:3, cc1:4, cc2:5, dp:6, dm:7, temp:8, batt:9, cap:10, wh:11 };

/* ══════════════ 数据源基类 ══════════════ */
export class BaseSource {
  constructor(store) {
    this.store = store; this.running = false; this.onError = () => {}; this.onData = () => {};
    /* ── 数据策略（由 app.js 按 cfg 下发，见 applyDataPolicy）──
       decimMs    : 降采样间隔 ms；0 = 原始速率全收（设备固定 ≈166Hz 上传）
       useSysTime : true = 时间轴 = 会话时长 + 墙钟偏移（显示真实系统时间）；
                    false = 纯会话相对时间（从 0 起）
       wallOff    : 墙钟偏移 = 会话开始时刻的「当日已过毫秒数」。
                    t = (raw - t0) + wallOff —— 两种模式共用同一条相对时间轴，
                    切换时只需对存量数据 ±wallOff，时间轴天然连续。 */
    this.decimMs = 0;
    this.useSysTime = false;
    this.wallOff = 0;
    this._lastKeepT = null; // 上一个被保留的帧的原始时间戳（降采样判据）
  }
  /** 会话开始时调用：重置时间基准与降采样游标 */
  _sessionReset() {
    this._lastKeepT = null;
    if (this.useSysTime) {
      const d = new Date(); d.setHours(0, 0, 0, 0);
      this.wallOff = Date.now() - d.getTime();
    } else {
      this.wallOff = 0;
    }
  }
  /** 时间轴归零（清零按钮用）：下一帧从 0 起，解除冻结，重新开始记录 */
  resetTimeline() {
    this.t0 = 0;
    this.freezeStore = false;
    this.live = null;
    this._lastKeepT = null;
    this._sessionReset();
  }

  /** 帧级过滤：返回 true = 该帧应写入 store（降采样判据） */
  _accept(rawT) {
    const iv = this.decimMs | 0;
    if (iv > 0) {
      if (this._lastKeepT == null) this._lastKeepT = rawT;
      else if (rawT - this._lastKeepT < iv) return false;
      this._lastKeepT = rawT;
    }
    return true;
  }
  /** 原始时间戳 → store 里的 t（t0 = 会话首帧原始时间戳） */
  _mapT(rawT, t0) {
    return rawT - t0 + (this.useSysTime ? this.wallOff : 0);
  }
  async start() {}
  async stop() {}
}

/* ══════════════ 3) 真机 USB 源（Android 原生 App 内的 JS 桥） ══════════════ */
export class AndroidSource extends BaseSource {
  constructor(store, opts = {}) {
    super(store);
    this.R = window.Ryken;
    this.pollMs = opts.pollMs || 50;      // 20Hz 轮询
    this.timer = null;
    this.t0 = 0;
    this.total = 0;
    this.frames = [];                      // 最近原始帧（调试用）
    this.maxKeep = 400;
    this.lastRaw = [];
    this.onRawFrames = () => {};
    this.onProto = () => {};               // 协议事件帧（PD 报文 / 文本事件）回调
    this._lastFpsAt = 0;
    this.fps = 0;
    /* 演示模式（Beta19，用户 2026-10-11）：非 null 时 pump() 吃演示帧、
       start() 不碰真 USB。帧生成器由 app.js 注入（demo.js），返回 [{t, hex}]。 */
    this.demo = null;
  }

  async start() {
    const R = this.R;
    /* ── 演示模式：完全绕开 USB（不 connect、不 startStream、不重连循环）── */
    if (this.demo) {
      if (!this.running) {
        this.t0 = 0; this.freezeStore = false; this.live = null;
        this._sessionReset();
        this.running = true;
        clearInterval(this.retry);
        this.timer = setInterval(() => this.pump(), this.pollMs);
      }
      return;
    }
    if (!R) throw new Error('不是 Android 环境');
    // ⚠ 不能盲目 connect()：connect → openDevice → close → stopStream，
    //   会把正在跑的流整个杀掉重开（bug 日志实证：startStream#1 后 300ms 被掐，
    //   随后 2ms 内两次 openDevice 触发「首次 queue 失败」）。
    //   已连接且在读流时只保证泵送，不重开 USB。
    try {
      const st = JSON.parse(R.status() || '{}');
      if (!(st.connected && st.streaming)) {
        R.connect();
        R.startStream();
      }
    } catch {
      R.connect();
      R.startStream();
    }
    if (!this.running) {
      /* 新记录会话（用户 2026-10-10）：时间轴从 0 起、解除停止冻结、冲掉原生队列里
         停止期间堆积的旧帧 —— 否则重新开始后曲线"暂无数据"、数值卡读到空缓冲。
         ⚠ 必须以 running 为条件而不是 timer：停止后泵送仍在跑（曲线冻结、数值走 live），
         timer 一直存在，旧守卫 if (this.timer) return 会让会话重置被跳过。 */
      this.t0 = 0;
      this.freezeStore = false;
      this.live = null;
      this._sessionReset();
      try { this.R.pollFrames(); } catch {}
      this.running = true;
      this.timer = setInterval(() => this.pump(), this.pollMs);
      // 自动重连：没连接但有设备时反复尝试（覆盖用户后点「允许」、插拔、读流中断等情况）
      this.retry = setInterval(() => this.tryConnect(), 2500);
    }
  }

  tryConnect() {
    let st;
    try { st = this.status(); } catch { return; }
    if (st.connected) {
      if (!st.streaming) { try { this.R.startStream(); } catch {} }
      return;
    }
    if (!st.hasDevice) return;          // 没插设备就安静等着，不弹窗
    try { this.R.connect(); } catch {}  // 未授权时这里会弹系统授权框
  }

  async stop() {
    /* 「停止记录」语义（用户 2026-10-10 定稿）：**曲线冻结、实时数值继续走**。
       泵送不停 —— 帧继续解码，但不再写入 store（曲线/统计/采样点数全部冻结），
       最新一帧放在 this.live 供数值卡（updateReadouts）持续刷新。
       ⚠ USB 流与握手不动：重新开始记录时秒起。 */
    this.running = false;
    this.freezeStore = true;
  }

  pump() {
    let list;
    try {
      list = this.demo ? this.demo() : JSON.parse(this.R.pollFrames() || '[]');
    } catch { return; }
    if (!list.length) return;
    if (!this.t0) this.t0 = list[0].t;
    let pushed = 0;
    for (const f of list) {
      this.total++;
      if (this.frames.length >= this.maxKeep) this.frames.shift();
      this.frames.push(f.hex);
      /* 协议事件帧（PD 报文 / 文本事件）：与测量帧走两条路，不受降采样影响 */
      if (this.decodeProto) {
        const pf = this.decodeProto(f.hex, f.t);
        if (pf) this.onProto(pf, f);
      }
      /* 降采样：不在保留间隔内的帧只进调试缓冲、不进 store
         （曲线/统计/采样点数/CSV 全部读 store，天然跟随记录速率） */
      if (!this._accept(f.t)) continue;
      const dec = this.decode(f.hex, this._mapT(f.t, this.t0), f.t);
      if (dec) {
        if (this.freezeStore) this.live = dec;   // 停止记录：曲线冻结，最新帧供数值卡继续刷新
        else { this.store.push(dec); pushed++; }
      }
      else if (window.__ryken_log && (this._decFailN || 0) < 3) {
        const s = f.hex || '';
        if (s.startsWith('55 1b') || s.startsWith('00 55 1b')) {
          this._decFailN = (this._decFailN || 0) + 1;
          window.__ryken_log('测量帧解码失败: ' + s.slice(0, 60));
        }
      }
    }
    if (pushed) this.onData();
    this.onRawFrames(this.frames);
  }

  /** 由外部注入（ryken-protocol.js），解码未完成时返回 null */
  decode(hex, t) { return null; }

  status() { try { return JSON.parse(this.R.status()); } catch { return {}; } }
  sniff() { try { return JSON.parse(this.R.sniff()); } catch { return {}; } }
}

/* ══════════════ 4) 桥接源（PC 端 bridge.py + 浏览器） ══════════════ */
export class BridgeSource extends BaseSource {
  constructor(store, url) { super(store); this.url = url; this.ws = null; this.probeMs = 4000; }
  async start() {
    return new Promise((resolve, reject) => {
      this._sessionReset();
      this._t0 = null;
      let ws;
      try { ws = new WebSocket(this.url); } catch (e) { reject(e); return; }
      this.ws = ws;
      const to = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('连接超时')); }, this.probeMs);
      ws.onopen = () => { clearTimeout(to); this.running = true; resolve(); };
      ws.onerror = () => { clearTimeout(to); reject(new Error('无法连接桥接服务')); };
      ws.onclose = () => { this.running = false; };
      ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'frame') {
          if (!this._t0) this._t0 = msg.data.t;
          if (this._accept(msg.data.t)) {
            msg.data.t = this._mapT(msg.data.t, this._t0);
            this.store.push(msg.data); this.onData(msg.data);
          }
        }
        else if (msg.type === 'device') this.onDevice?.(msg.data);
        else if (msg.type === 'raw') this.onRaw?.(msg.data);
      };
    });
  }
  async stop() { if (this.ws) { this.ws.close(); this.ws = null; } this.running = false; }
  send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
}

/* ══════════════ 3) 真机 USB 源（Android USB Host / WebHID，占位） ══════════════ */
export class UsbSource extends BaseSource {
  constructor(store) { super(store); this.unsupported = true; }
  async start() {
    // 安卓 WebView 不支持 WebHID：真机直连需要原生 Android App（USB Host API）。
    // 当前浏览器环境只能走桥接。
    const ua = navigator.userAgent;
    const isAndroid = /Android/i.test(ua);
    throw new Error(isAndroid
      ? '浏览器无法直连 USB HID，请改用桥接模式'
      : '当前环境不支持 WebHID');
  }
}

/* ══════════════ 采集控制器 ══════════════ */
export class Recorder {
  constructor(source, store) {
    this.source = source; this.store = store;
    this.running = false;
    this.points = 0;
  }
  async start() {
    if (this.running) return;
    this.source.onData = () => { this.points++; };
    await this.source.start();
    this.running = true;
  }
  async stop() {
    if (!this.running) return;
    await this.source.stop();
    this.running = false;
  }
  clear() { this.store.clear(); this.points = 0; }
}
