/* ══════════════════════════════════════════════════════════
   app.js — 界面逻辑
   ══════════════════════════════════════════════════════════ */
import { SERIES, SERIES_BY_ID, DataStore, BridgeSource, AndroidSource, Recorder } from './transport.js';
import { makeDemoEngine } from './demo.js';
import { Chart, fmtTime } from './chart.js';
import { decodeFrame, resetAccum, analyseFrames, resetProtoState,
         decodeProtocolFrame, CMD } from './ryken-protocol.js';

/* ── 桥接地址：PC 端跑 bridge.py 后，手机访问同一 WiFi 下该地址 ── */
const BRIDGE_URL = (() => {
  const q = new URLSearchParams(location.search).get('bridge');
  if (q) return q;
  const h = location.hostname && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1'
    ? location.hostname : '127.0.0.1';
  return `ws://${h}:8765`;
})();

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* 版本号以原生 gradle versionName 为准（beta22 实锤：硬编码字符串忘改，界面与 APK 版本漂移）。
   HTML 里的硬编码仅作浏览器/无桥环境兜底。 */
(() => {
  const v = window.Ryken && window.Ryken.version && window.Ryken.version();
  if (!v) return;
  const tb = $('#tbVer');  if (tb) tb.textContent = 'v' + v;
  const ab = $('#appVer'); if (ab) ab.textContent = 'v' + v;
})();

const store = new DataStore();
let source = null;
let recorder = null;
let connected = false;

/* 官方固件源：官网下载页（页面文本含 RKX3Vx.xx-6.zip 等文件名）。
   ⚠ 不是抓包到的 latest.json —— 那是 PC 上位机（Tauri）的自更新清单，
   version 字段是 PC 软件版本（0.4.1），与固件版本是两码事，别混用。 */
const OFFICIAL_FW_URL = 'https://ryken.cn/col.jsp?id=121';
/* 永硕云盘源：社区固件分发空间（伪RYKEN），原生 ysListAsync 走 JWT 会话列文件 */
const YS_FW_URL = 'https://ryken.ys168.com/';

/* ══════════ 设置（持久化） ══════════
   ⚠ 原则（用户 2026-10-10 明确）：**所有设置都要记住上次的值**。
   新增任何界面上的设置项，都必须进 DEF + 在 applySettingsToDOM() 里回填 + 变更时 save()。 */
const DEF = {
  colors: Object.fromEntries(SERIES.map(s => [s.id, s.color])),
  offset: { v: 1.05, i: 1.1, p: 1.15 },
  area: true,
  showSmall: true,
  grid: true,                             // 曲线网格线（可关）
  visible: ['vbus', 'ibus', 'pwr'],
  /* 实时曲线：三条**可同时显示**（2026-10-10 取消「电流与功率互斥」——
     互斥的是 Y 轴位，不是曲线本身，见 chart.js _plan） */
  liveVisible: ['vbus', 'ibus', 'pwr'],
  /* Y 轴位优先级：纵坐标最多两列 —— 功率永远占一个；
     第二个给电压/电流里「最后筛选」的那个（用户 2026-10-10）。
     lastPick 在点 V/A 筛选时更新（实时页分段按钮 + 曲线页 chips 共用）。 */
  lastPick: 'vbus',
  theme: 'auto',                          // dark | light | auto（默认跟随系统，用户 2026-10-10）
  orientation: 'auto',                    // auto | portrait | landscape
  /* ── 「采样与记录」全部参数 ── */
  autoStop: true,                         // 满足条件后自动停止：默认打开（用户 2026-10-10）
  trigBase: '功率',                       // 触发依据
  trigVal: 1.0,                           // 触发小于
  dur: 10,                                // 持续时间（秒）
  sysTime: false,                         // 使用系统时间（默认关，用户 2026-10-11）
  rate: '10SPS',                          // 采样速率（用户 2026-10-13：默认 10SPS；「原生」= 设备原始 ≈125Hz 全收）
  /* ── 协议页 / 曲线页 ── */
  pdMask: false,                          // 屏蔽 CRC
  chartMode: 'curve',                     // curve | measure | stat
  hideStatus: false,                      // 隐藏状态栏（横竖屏都藏）
  hideStatusLand: true,                   // 横屏时自动隐藏状态栏（默认打开，用户 2026-10-10）
  keepOn: false,                          // 屏幕常亮（FLAG_KEEP_SCREEN_ON）
  keepOnRec: true,                        // ★ 记录中保持屏幕常亮（发版前新增，2026-10-13）：
                                          //   息屏会让 WebView 的 JS 泵被系统节流 → 原生队列溢出丢帧。
                                          //   默认开：数据完整性优先；不想用可在设置里关（关了会告警提示丢了多少）
  amoled: false,                          // 暗色模式下用 A 屏纯黑主题
  swipeNav: false,                        // 左右滑动切换页面（默认关：防误触，用户 2026-10-11）
  tipHold: 3000,                          // 曲线读数浮层停留时长 ms（0 = 一直显示；默认 3 秒，用户 2026-10-11）
  demo: false,                            // 演示模式（无设备时显示演示数据，Beta19）
  updateSrc: 'official',                  // 固件更新源模式：official=官网 | ys=永硕云盘 | custom=自定义
  updateUrl: '',                          // 自定义更新源（updateSrc=custom 时用；任意含版本号的页面 / 直链 txt）
  bufMB: 100,                             // 曲线缓存大小 MB（对标官方上位机：100–1000M，默认 100M ≈ 50SPS 下 6 小时）
};
let cfg = load();
/* 曲线缓存容量（MB → 点数，每点 Float64×12 = 96B：100MB ≈ 109 万点）。
   store 在 cfg 之前创建（默认 20 万点），这里按配置重设；分配失败回落 20 万点默认值。 */
function bufPoints(mb) { return Math.max(10000, Math.floor(mb * 1048576 / 96)); }
if (!store.setCapacity(bufPoints(cfg.bufMB))) {
  cfg.bufMB = 100;
  store.setCapacity(200000);
}
function load() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem('ryken.cfg') || '{}'); } catch {}
  const c = Object.assign({}, DEF, raw);
  /* 采样速率旧档位迁移：1K/10K 超出设备能力已删；100SPS 是旧默认 → 统一迁到「默认」 */
  if (c.rate === '1KSPS' || c.rate === '10KSPS' || c.rate === '100SPS') c.rate = 'native';
  /* 配置迁移 cfgV<3：老配置是「电流与功率互斥、最多两条曲线」版本 ——
     曲线恢复三条全开；轴位优先级用新默认（功率固定一个轴 + 电压拿第二个）。
     之后用户手动筛选照常生效，且三条曲线可以同时显示。 */
  if (!(raw.cfgV >= 3)) {
    c.liveVisible = [...DEF.liveVisible];
    c.visible = [...DEF.visible];
    if (!c.lastPick) c.lastPick = DEF.lastPick;
    c.cfgV = 3;
    try { localStorage.setItem('ryken.cfg', JSON.stringify(c)); } catch {}
  }
  /* cfgV<5：默认值调整一次性应用到存量配置（用户 2026-10-10）——
     主题跟随系统 / 满足条件自动停止默认开 / 横屏自动隐藏状态栏。
     恢复默认设置得到同样的结果。 */
  if (!(raw.cfgV >= 5)) {
    c.theme = 'auto';
    c.autoStop = true;
    c.hideStatusLand = true;
    c.cfgV = 5;
    try { localStorage.setItem('ryken.cfg', JSON.stringify(c)); } catch {}
  }
  /* cfgV<6：sysTime 默认改关，一次性应用到存量配置（用户 2026-10-11） */
  if (!(raw.cfgV >= 6)) {
    c.sysTime = false;
    c.cfgV = 6;
    try { localStorage.setItem('ryken.cfg', JSON.stringify(c)); } catch {}
  }
  /* cfgV<7：更新源拆成「官方/自定义」两模式（beta22）。以前填过自定义 URL 的存量用户
     迁到 custom 档，避免被静默切到官方源；没填过的直接用内置官方源。 */
  if (!(raw.cfgV >= 7)) {
    c.updateSrc = (raw.updateUrl || '').trim() ? 'custom' : 'official';
    c.cfgV = 7;
    try { localStorage.setItem('ryken.cfg', JSON.stringify(c)); } catch {}
  }
  /* cfgV<8：新增「永硕源」档。beta22 上午版把永硕链接存成了 custom —— 迁到 ys 档。 */
  if (!(raw.cfgV >= 8)) {
    if (c.updateSrc === 'custom' && /ys168\.com|ysepan\.com/i.test(c.updateUrl || '')) c.updateSrc = 'ys';
    c.cfgV = 8;
    try { localStorage.setItem('ryken.cfg', JSON.stringify(c)); } catch {}
  }
  /* cfgV<9：采样率默认改 50SPS（对标官方上位机），原「默认」（原始速率全收）档迁过去；
     缓存大小夹到 100–2000M。 */
  if (!(raw.cfgV >= 9)) {
    if (c.rate === 'native') c.rate = '50SPS';
    c.bufMB = Math.min(1000, Math.max(100, Math.round(+c.bufMB || 100)));
    c.cfgV = 9;
    try { localStorage.setItem('ryken.cfg', JSON.stringify(c)); } catch {}
  }
  /* cfgV<10：缓存上限 2000→1000M、默认回到 100M（用户 2026-10-12 定稿）。 */
  if (!(raw.cfgV >= 10)) {
    c.bufMB = Math.min(1000, Math.max(100, Math.round(+c.bufMB || 100)));
    c.cfgV = 10;
    try { localStorage.setItem('ryken.cfg', JSON.stringify(c)); } catch {}
  }
  /* cfgV<11：采样速率默认 50SPS → 10SPS（用户 2026-10-13）。原默认 50SPS 的存量配置迁过去。 */
  if (!(raw.cfgV >= 11)) {
    if (c.rate === '50SPS') c.rate = '10SPS';
    c.cfgV = 11;
    try { localStorage.setItem('ryken.cfg', JSON.stringify(c)); } catch {}
  }
  /* cfgV<12：曲线页悬浮窗默认位置改为「底部居中」（用户 2026-10-13）——
     清掉早期拖动记住的旧位置，让新默认位生效（用户那边记的是顶部）。 */
  if (!(raw.cfgV >= 12)) {
    try { localStorage.removeItem('ryken_stats_pos'); localStorage.removeItem('ryken_measure_pos'); } catch {}
    c.cfgV = 12;
    try { localStorage.setItem('ryken.cfg', JSON.stringify(c)); } catch {}
  }
  /* cfgV<13：清掉被 bug 污染的位置缓存（2026-10-13）——
     `clampNow()` 曾在容器尺寸为 0 时把浮层夹成 (0,0) 并写进 localStorage，
     导致浮层每次启动都钉在曲线图左上角。修完再清一次，让设备回到「底部居中」。 */
  if (!(raw.cfgV >= 13)) {
    try { localStorage.removeItem('ryken_stats_pos'); localStorage.removeItem('ryken_measure_pos'); } catch {}
    c.cfgV = 13;
    try { localStorage.setItem('ryken.cfg', JSON.stringify(c)); } catch {}
  }
  /* cfgV<14：曲线页筛选复位成默认「电压/电流/功率」（用户 2026-10-13）——
     之前测试期间把 CC1/CC2/容量/能量 也点开了，存进了配置。这里一次性复位；
     复位后用户再改筛选照旧会被记住（cfg.visible 一直在 save()）。 */
  if (!(raw.cfgV >= 14)) {
    c.visible = [...DEF.visible];
    c.cfgV = 14;
    try { localStorage.setItem('ryken.cfg', JSON.stringify(c)); } catch {}
  }
  return c;
}
function save() { try { localStorage.setItem('ryken.cfg', JSON.stringify(cfg)); } catch {} }

/* ══════════ Toast ══════════ */
let toastEl;
function toast(msg, ms = 1800) {
  appLog(`提示: ${msg}`);
  if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; document.body.appendChild(toastEl); }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('show'), ms);
}

/* ══════════ 导航 ══════════ */
let activeView = 'live';
/* 切页只有这一条路：底部标签栏、顶栏「固件号」跳转都走它，避免两处各写一遍 */
function switchView(v, dir) {
  activeView = v;
  document.getElementById('app')?.setAttribute('data-v', v);   // CSS 按页分支（曲线页横屏隐藏顶栏）
  $$('.tab').forEach(x => x.classList.toggle('is-active', x.dataset.view === v));
  $$('.view').forEach(x => {
    const on = x.id === 'view-' + v;
    x.classList.toggle('is-active', on);
    if (on && dir) {   // 横滑切换：按滑动方向滑入
      x.classList.remove('slide-next', 'slide-prev');
      void x.offsetWidth;
      x.classList.add(dir);
    }
  });
  /* 切到曲线页：**复位「自由查看」回自动模式，但记住你选的是跟随还是缩放**（用户 2026-10-11）。
     语义拆开看：① 拖拽/捏合只是临时看某一段，切页后不该留着那个定格视窗（原来那版正是这么错的 ——
     完全不动 follow，导致拖过之后切页回来还是定格）；② 但「跟随 / 缩放」是用户的选择，
     切换 tab 不该把它抹掉（更早那版一律 follow=true + fitAll 丢失，所以缩放也被复位了）。
     现在只动 follow、不动 fitAll —— 两个诉求同时满足。
     实时页仍强制跟随（那页的语义就是看最新，且没有视图按钮）。 */
  if (v === 'fw') {
    fwRefreshEnv();        // 固件页一打开就检测 U 盘挂载/授权（用户 2026-10-12：不能只在选固件时查）
  }
  if (v === 'chart') {
    bigChart.follow = true;
    syncViewButtons();
    setTimeout(() => { bigChart._resize(); bigChart.draw(); }, 40);
  }
  if (v === 'live')  { liveChart.follow = true; setTimeout(() => { liveChart._resize(); liveChart.draw(); queueFitPortraitLive(); }, 40); }
  /* 切页收起曲线读数浮层 —— 选「一直显示」时尤其必要，否则切回来还挂着上一次的读数 */
  liveChart._clearHover(); bigChart._clearHover();
  const vs = $('#views'); if (vs) vs.scrollTop = 0;
}
$$('.tab').forEach(t => t.addEventListener('click', () => switchView(t.dataset.view)));

/* ══════════ 横滑切换页签（Beta 15）══════════
   水平快速滑动 → 切到上/下一个 TAB，全局生效（用户 2026-10-10：不需避开图表和输入框——
   横滑速度远快于拖动/缩放，输入时键盘弹起也不会横滑）
   ③ 协议报文列表（内部滚动）
   多指（捏合）不触发；斜向或慢拖不触发（要快速、接近水平的横滑）。 */
const TAB_ORDER = ['live', 'chart', 'pd', 'fw', 'set'];
let _swX = null, _swY = 0, _swT = 0, _swChart = false;
document.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) { _swX = null; return; }
  const t = e.target;
  /* 分区灵敏度：图表区低（防拖图误切），其他区域高（轻扫即切） */
  _swChart = !!(t.closest && t.closest('.chart-wrap'));
  _swX = e.touches[0].clientX; _swY = e.touches[0].clientY; _swT = Date.now();
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (_swX != null && e.touches.length !== 1) _swX = null;   // 第二根手指落下 → 取消
}, { passive: true });
document.addEventListener('touchend', (e) => {
  if (!cfg.swipeNav) return;               // 开关关闭 = 不切页（默认，防误触；用户 2026-10-11）
  if (_swX == null) return;
  const dx = e.changedTouches[0].clientX - _swX;
  const dy = e.changedTouches[0].clientY - _swY;
  const dt = Date.now() - _swT;
  _swX = null;
  /* 图表区：75px/450ms/1.4×；其他区域：55px/380ms/1.2× */
  const minDx = _swChart ? 75 : 55;
  const maxDt = _swChart ? 450 : 380;
  const ratio = _swChart ? 1.4 : 1.2;
  if (dt > maxDt) return;
  if (Math.abs(dx) < minDx || Math.abs(dy) > 45 || Math.abs(dx) < Math.abs(dy) * ratio) return;
  const i = TAB_ORDER.indexOf(activeView);
  if (i < 0) return;
  const n = TAB_ORDER[dx < 0 ? Math.min(i + 1, TAB_ORDER.length - 1) : Math.max(i - 1, 0)];
  if (n !== activeView) switchView(n, dx < 0 ? 'slide-next' : 'slide-prev');
}, { passive: true });
/* 顶栏的固件号 = 跳转到「固件」页的入口 */
$('#devVerBtn').addEventListener('click', () => switchView('fw'));

/* 图表实例
   liveChart.autoFollow=false（用户 2026-10-10）：拖动/缩放后**不自动回到最新**，
   想复位点 ⟲ 刷新按钮（btnLiveClear → follow=true） */
const liveChart = new Chart($('#liveChart'), { windowMs: 30000, area: true, showSmall: false, autoFollow: false });
const bigChart  = new Chart($('#bigChart'),  { windowMs: 30000, area: true, showSmall: true });
liveChart.setTip($('#liveTip'));
bigChart.setTip($('#bigTip'));
liveChart.setData(store);
bigChart.setData(store);
/* 曲线页底部脚注的左/右轴单位跟随实际轴位（2026-10-13 三轴布局后不再写死 V/A）：
   左轴可能是电压或电流，右轴是功率 W。 */
bigChart.onAxisChange = (plan) => {
  const fl = $('#footLeft'), fr = $('#footRight');
  if (fl) fl.textContent = plan.outer ? plan.outer.unit : '';
  if (fr) fr.textContent = plan.right ? plan.right.unit : '';
};

function applyChartCfg() {
  /* Y 轴位（2026-10-13 定稿，见 chart.js _plan）：功率固定右轴；
     三条全开 → 左外=电压、左内=电流；只有两条 → 都用最外侧。
     轴位完全由「可见曲线集合」决定，不再依赖 cfg.lastPick。 */
  for (const c of [liveChart, bigChart]) {
    c.setColors(cfg.colors);
    c.opts.offset = cfg.offset;
    c.opts.area = cfg.area;
    c.opts.showSmall = cfg.showSmall;
    c.opts.grid = cfg.grid;
    c.tipHoldMs = cfg.tipHold;            // 读数浮层停留时长（设置页可调）
  }
  const lv = cfg.liveVisible && cfg.liveVisible.length ? cfg.liveVisible : [];
  liveChart.setSeries(SERIES.filter(s => lv.includes(s.id)));
  bigChart.setSeries(SERIES.filter(s => cfg.visible.includes(s.id)));
  /* 筛选/颜色刚变，正在显示的读数浮层要立刻用新 series 重画一遍，
     否则它停在旧内容上，看着像"筛选没生效、要点两次"（用户 2026-10-11）。 */
  liveChart.refreshTip(); bigChart.refreshTip();
}

/* ══════════ 数据策略：采样速率（真降采样）+ 使用系统时间 ══════════
   设备实测 ≈125Hz 上传（早期注释写 166Hz 偏高，K20 实录 26.7min/20万点反推），App 端
   改不了硬件采样率 —— 「采样速率」的真实语义是
   **记录速率**：按间隔降采样后才写进数据缓冲（曲线/统计/采样点数/CSV 全跟随）。
   「原生」= 设备原始速率全收。1/10/50/100 SPS 分别每 1000/100/20/10ms 保留一帧。
   「使用系统时间」= 时间轴在会话时长上叠加墙钟偏移（显示真实系统时间）；
   关闭 = 纯会话相对时间（从 0 起）。两种模式共用同一条相对轴，
   切换时对存量数据 ±wallOff —— **立即生效且时间轴连续**，不用重记。 */
const RATE_MS = { '1SPS': 1000, '10SPS': 100, '50SPS': 20, '100SPS': 10, 'native': 0 };
function applyDataPolicy() {
  if (!source) return;
  source.decimMs = RATE_MS[cfg.rate] ?? 0;
  const wantSys = !!cfg.sysTime;
  if (wantSys !== source.useSysTime) {
    const n = store.size;
    if (n) {                               // 停止记录也有数据：同样平移，避免新旧两段基准拼接
      const lastT = store.at(n - 1, 't');
      if (wantSys) {
        /* 相对 → 系统：偏移 = 当前墙钟 - 最后一个样本的相对时刻 */
        const d = new Date(); d.setHours(0, 0, 0, 0);
        const newOff = (Date.now() - d.getTime()) - lastT;
        shiftStoreT(newOff - (source.wallOff || 0));
        source.useSysTime = true;
        source.wallOff = newOff;
      } else {
        /* 系统 → 相对：撤掉墙钟偏移即可（同一条相对轴） */
        shiftStoreT(-(source.wallOff || 0));
        source.useSysTime = false;
        source.wallOff = 0;
      }
      toast('时间基准已切换，时间轴保持连续');
    } else {
      source.useSysTime = wantSys;
      source.wallOff = 0;
    }
  }
}
/** 整体平移 store 里的时间列（列 0），切换时间基准时保持时间轴连续 */
function shiftStoreT(delta) {
  if (!delta) return;
  const n = store.length, cap = store.capacity, stride = store.n;
  for (let i = 0; i < n; i++) {
    const idx = ((store.head - store.length + i) % cap + cap) % cap;
    store.buf[idx * stride] += delta;
  }
  store.statsDirty = true;
}

/* ══════════ 竖屏实时页：曲线高度精确适配 ══════════
   初始显示时「停止记录/清零」正好贴在底栏上缘、充分利用空间 ——
   曲线高度 = 按钮当前底边与目标位置（视口底 - 底栏高）的差值，一次校正到位。
   采样参数在折叠线以下，滚动可达（用户 2026-10-10 定稿） */
let _fitTimer = null;
let _legendX = {};                        // 图例钉位缓存（px，legend 容器坐标系）
function fitPortraitLive() {
  const land = matchMedia('(orientation: landscape)').matches || innerWidth >= 900;
  if (activeView !== 'live' || land) return;
  const wrap = document.querySelector('#view-live .live-chart');
  const bar = document.querySelector('#view-live .action-bar');
  if (!wrap || !bar) return;
  const tabbar = document.querySelector('.tabbar');
  const tabH = tabbar ? tabbar.getBoundingClientRect().height : 58;
  const target = innerHeight - tabH;                       // 底栏上缘（视口坐标）
  const barBottom = bar.getBoundingClientRect().bottom;
  const delta = Math.round(target - barBottom);
  if (Math.abs(delta) < 2) return;                         // 已到位
  const cur = wrap.getBoundingClientRect().height;
  wrap.style.height = Math.max(150, Math.round(cur + delta)) + 'px';
  ensureChartSize(liveChart);
  liveChart.draw();
}
function queueFitPortraitLive() { clearTimeout(_fitTimer); _fitTimer = setTimeout(fitPortraitLive, 60); }

window.addEventListener('resize', () => queueFitPortraitLive());

/* ══════════ 渲染循环（只画当前可见图表 + 限帧，滑动更流畅）══════════ */
let lastRead = null;
let _lastFrameDraw = 0;
let _szCount = 0;
/* 画布尺寸自检：转屏 / 布局变化后 CSS 尺寸变了而位图没跟上时，一帧内自动恢复
   （用户反馈：横→竖后曲线被压扁不恢复。getBoundingClientRect 14fps 读一次开销可忽略） */
function ensureChartSize(c) {
  const r = c.cv.getBoundingClientRect();
  if (r.width > 0 && r.height > 0 && (Math.round(r.width) !== Math.round(c.W) || Math.round(r.height) !== Math.round(c.H)))
    c._resize();
}
/* 滚动期间暂停重绘：原生惯性滚动时主线程腾出来，动画才顺滑（Beta 15） */
let _scrollPauseUntil = 0;
$('#views').addEventListener('scroll', () => { _scrollPauseUntil = Date.now() + 180; }, { passive: true });

function raf() {
  const now = performance.now();
  if (now - _lastFrameDraw >= 70) {          // ~14fps，肉眼无差但省一半以上算力
    _lastFrameDraw = now;
    _szCount++;
    if (Date.now() < _scrollPauseUntil) { requestAnimationFrame(raf); return; }   // 滚动中：不重绘不写 DOM
    /* 尺寸自检降到每 3 帧（~210ms）：转屏恢复依然够快，滚动时减少布局读取 */
    if (activeView === 'live') { if (_szCount % 3 === 0) ensureChartSize(liveChart); liveChart.draw(); updateReadouts(); }
    else if (activeView === 'chart') {
      if (_szCount % 3 === 0) ensureChartSize(bigChart);
      bigChart.draw();
      updateStats();
      /* 冷启动时 store 还是空的，测量线落不了位 → 第一帧数据到了补上（见 anchorMeasure） */
      if (bigChart._measurePending && cfg.chartMode === 'measure') { anchorMeasure(); renderMeasurePanel(); }
    }
  }
  requestAnimationFrame(raf);
}

/* 无数据时必须清空，否则会一直停在上一帧的残留值上（看着像"假数据"） */
let readoutsBlank = false;

/* 显示宽度恒为 7 个数字（整数位 + 小数位 = 7，小数点不计）。
   ⚠ 这不是 toPrecision(7) —— 那个数的是「有效数字」，前导 0 不计，
   所以 0.054321 会输出 "0.05432100"（9 个数字字符，用户 2026-10-13 报「还是 8 位小数」）。
   用户要的是「加上整数」：不管 10 / 20 / 100 / 1000 V，整数位 + 小数位恒 = 7 →
   20.05432 · 5.000000 · 100.0000 · 1000.000 · 0.054321 */
function sig7(x) {
  if (!isFinite(x)) return '—';
  const intLen = Math.max(1, String(Math.floor(Math.abs(x))).length);
  return x.toFixed(Math.max(0, 7 - intLen));
}

function clearReadouts() {
  if (readoutsBlank) return;
  readoutsBlank = true;
  for (const id of ['mVbus', 'mIbus', 'mPwr', 'mCc1', 'mCc2', 'mDp', 'mDm'])
    { const el = $('#' + id); if (el) el.textContent = '—'; }
  for (const id of ['cTemp', 'cBatt', 'cCap', 'cWh'])
    { const el = $('#' + id); if (el) el.textContent = '—'; }
  for (const id of ['sVbus', 'sIbus', 'sPwr'])
    { const el = $('#' + id); if (el) el.textContent = '等待数据…'; }
  const lg = $('#liveLegend'); if (lg) lg.innerHTML = '';
  const sc = $('#statCards'); if (sc) sc.innerHTML = '';
  /* 采样点数/缓冲占用也要归零 —— 否则清空后这两处还挂着上一会话的数字（Beta20） */
  const pt = $('#fPoints'); if (pt) pt.textContent = '0';
  const bf = $('#fBuf');    if (bf) bf.textContent = '0.00 MB';
}

/* ══════════ 实时读数卡 ══════════ */
function updateReadouts() {
  const n = store.size;
  /* 停止记录时曲线/统计冻结，但当前读数持续走实时帧（source.live）——
     MAX/AVG 等统计仍来自 store（冻结值），只有数值卡在动（用户 2026-10-10） */
  const f = (running || !source?.live) ? (n ? store.row(n - 1) : null) : source.live;
  if (!f) { clearReadouts(); return; }
  readoutsBlank = false;
  lastRead = f;
  /* 整数位 + 小数位 恒 = 7 位 —— 统一走 sig7()（定义处有详细说明） */
  $('#mVbus').textContent = sig7(f.vbus);
  $('#mIbus').textContent = sig7(f.ibus);
  $('#mPwr').textContent  = sig7(f.pwr);
  $('#mCc1').textContent  = f.cc1.toFixed(2);
  $('#mCc2').textContent  = f.cc2.toFixed(2);
  $('#mDp').textContent   = f.dp.toFixed(2);
  $('#mDm').textContent   = f.dm.toFixed(2);
  $('#cTemp').textContent = f.temp.toFixed(1);          // 单位独立 <i>（Beta19）
  $('#cBatt').textContent = f.batt > 0 ? Math.round(f.batt) : '—';
  $('#cCap').textContent  = f.cap.toFixed(0);
  $('#cWh').textContent   = f.wh.toFixed(3);

  // 副标题：最大 / 平均。竖屏 = 数值右侧两行（5 位小数 + 单位）；
  // 横屏 = 卡片底部一行（3 位小数 —— 150–190px 列宽放不下两段 5 位值）。
  // Beta19 定宽列：标签(MAX/AVG 3.5ch) / 数字区(8ch = 7 位有效数字+小数点) / 单位(2ch)
  // 全部固定位置，数字变化不跳动（用户 2026-10-11）；数值前后各留半字宽空隙。
  if (store.size > 20) {
    const st = store.computeStats();
    if (st) {
      const land = window.matchMedia &&
        matchMedia('(orientation: landscape), (min-width: 900px)').matches;
      const dec = land ? 3 : 5;
      const sub = (k, x, u) =>
        `<span class="rs"><i class="k">${k}</i><b>${sig7(x)}</b><u>${u}</u></span>`;
      $('#sVbus').innerHTML = sub('MAX', st.vbus.max, 'V') + sub('AVG', st.vbus.avg, 'V');
      $('#sIbus').innerHTML = sub('MAX', st.ibus.max, 'A') + sub('AVG', st.ibus.avg, 'A');
      $('#sPwr').innerHTML  = sub('MAX', st.pwr.max,  'W') + sub('AVG', st.pwr.avg,  'W');
    }
  }
  $('#fPoints').textContent = store.size.toLocaleString();
  $('#fBuf').textContent = (store.size * 12 * 8 / 1048576).toFixed(2) + ' MB';

  // 图例：当前值实时刷新（功率曲线没有专属轴，靠这里读数）
  // ⚠ 位数刻意压到 2 位 —— 曲线栏横向空间紧张（用户反馈"有效数字太多、占地方"）；
  //   需要 5 位精度时看左边主数据卡，那边一直是 5 位。
  //   停止记录时曲线冻结 → 图例也冻结（与曲线一致），数值卡单独走实时帧。
  const lg = $('#liveLegend');
  if (lg && (running || !source?.live)) {
    lg.innerHTML = (cfg.liveVisible || []).filter(id => SERIES_BY_ID[id]).map(id => {
      const se = SERIES_BY_ID[id];
      return `<span><i style="background:${cfg.colors[id]}"></i>${se.name} ${f[id].toFixed(2)}${se.unit}</span>`;
    }).join('');
  }
}

/* ══════════ 统计卡 ══════════
   表格形式（用户 2026-10-10）：行 = 功率 / 电流 / 电压（功率优先），
   列 = 当前 / 平均 / 最大 —— 取代原来的九张小卡。
   Beta21：同一份 DOM 两套排法 —— 竖屏 = 4 列表（表头 当前/平均/最大）；
   横屏 = hero 风格卡（顶部代号 → 当前值大字 → MAX/AVG 行，参照实时页 hero 卡，
   渲染图 layout_curve_手机.png 定稿，用户 2026-10-11）。
   em 文字直接用 MAX/AVG（竖屏 em 隐藏、表头用中文，互不影响）。 */
function updateStats() {
  const el = $('#statCards');
  if (store.size < 20) return;
  const st = store.computeStats();
  if (!st) return;
  const cur = store.row(store.size - 1);
  /* 统计表 = 「关键指标面板」：**只放电压/电流/功率**（用户 2026-10-11 反馈：
     之前让它跟随 cfg.visible 全量显示，筛选全开时变成 11 张卡，横屏左栏被压扁重叠、
     而且冒出一堆 CC/D±/温度 卡让人看不懂）。
     正确的语义：这一栏恒为主三项；筛选关掉其中某条时，对应卡片才消失（⊆ {V/I/W}），
     不会因为勾了 CC1 就多出一张卡。全关时兜底回退三张，避免空栏。 */
  const MAIN_IDS = ['vbus', 'ibus', 'pwr'];
  const picked = SERIES.filter(s => MAIN_IDS.includes(s.id) && cfg.visible.includes(s.id) && st[s.id]);
  const rows = (picked.length ? picked : SERIES.filter(s => MAIN_IDS.includes(s.id)))
    .map(s => [s.name, s.id, s.unit]);
  /* st-row 包行（Beta19）：竖屏 = 同一张 4 列表（外观不变）；
     横屏 = 每行拆成左栏一张卡（曲线页侧栏，见 app.css 横屏档）。
     不用 display:contents（部分 WebView 排序失效，用户实测）。
     em = 行内值标签：竖屏隐藏（表头已有），横屏侧栏显示（表头隐藏）。
     data-code = 英文代号，横屏 ::after 显示在中文代号旁，竖屏不显示。 */
  const cell = (v, u, c, lab) =>
    `<div class="st-v"${c ? ` style="color:${c}"` : ''}><em>${lab}</em><span>${sig7(v)}<i>${u}</i></span></div>`;
  el.innerHTML =
    `<div class="st-row st-head"><div class="st-h"></div><div class="st-h">当前</div><div class="st-h">平均</div><div class="st-h">最大</div></div>` +
    rows.map(([nm, id, u]) => {
      const c = cfg.colors[id];
      const code = SERIES_BY_ID[id]?.code || nm;
      // 代号直接用字母（VBUS/IBUS/POWER，与实时页 hero/chips 同源），竖屏横屏都显示；
      // --ac 供横屏渐变/左条/单位色
      // 单位必须是 .st-main 的**直接子元素**（grid 第二列 auto 贴右缘）——
      // 嵌进 span 里的话 auto 列没有 item、宽度塌成 0，单位就贴不到右边（实测教训）
      return `<div class="st-row" style="--ac:${c}">` +
        `<div class="st-k" style="color:${c}">${code}</div>` +
        `<div class="st-v st-main" style="color:${c}"><span>${sig7(cur[id])}</span><i>${u}</i></div>` +
        cell(st[id].avg, u, null, 'AVG') + cell(st[id].max, u, null, 'MAX') +
        `</div>`;
    }).join('');
}

/* ══════════ 系列开关 ══════════ */
function buildChips() {
  const box = $('#seriesChips');
  box.innerHTML = SERIES.map(s => `
    <button class="c ${cfg.visible.includes(s.id) ? 'on' : ''}" data-id="${s.id}" style="color:${cfg.colors[s.id]}">
      <i></i>${s.code}
    </button>`).join('');
  $$('.c', box).forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.id;
    /* CC1/CC2 一组、D+/D- 一组：点任一个整组一起开关
       （用户 2026-10-11：与官方 PC 上位机一致 —— 这两对本来就是成对的总线信号）。 */
    const GROUP = { cc1: ['cc1', 'cc2'], cc2: ['cc1', 'cc2'], dp: ['dp', 'dm'], dm: ['dp', 'dm'] };
    const ids = GROUP[id] || [id];
    const on = !cfg.visible.includes(id);        // 以被点那条的当前状态决定整组方向
    for (const x of ids) {
      const i = cfg.visible.indexOf(x);
      if (on && i < 0) cfg.visible.push(x);
      else if (!on && i >= 0) cfg.visible.splice(i, 1);
    }
    /* 轴位归属与实时页共用：电压/电流谁最后被筛选谁上第二个轴 */
    if (id === 'vbus' || id === 'ibus') cfg.lastPick = id;
    save(); applyChartCfg();
    buildChips();                                 // 整组状态变了 → 重建 chips 同步高亮
    liveChart.draw(); bigChart.draw();
  }));
}

/* ══════════ 颜色设置 ══════════ */
function buildColors() {
  const box = $('#colorGrid');
  box.innerHTML = SERIES.map(s => {
    const label = ['vbus', 'ibus', 'pwr'].includes(s.id) ? `${s.name} ${s.code}` : s.name;
    return `
    <label class="color-item">
      <input type="color" data-id="${s.id}" value="${cfg.colors[s.id]}" />
      <span>${label}</span>
    </label>`;
  }).join('');
  $$('input[type=color]', box).forEach(inp => inp.addEventListener('input', () => {
    cfg.colors[inp.dataset.id] = inp.value;
    save(); applyChartCfg(); buildChips(); liveChart.draw(); bigChart.draw();
  }));
}

/* ══════════ 数值步进 ══════════ */
/* 曲线缓存：MB → 容量应用 + 可录时长估算（native 档按实测 ≈125Hz 估） */
function bufTimeText() {
  const rate = { '1SPS': 1, '10SPS': 10, '50SPS': 50, '100SPS': 100 }[cfg.rate] || 125;
  const s = store.capacity / rate;
  if (s < 90) return '约 ' + Math.round(s) + ' 秒';
  const mnt = s / 60;
  if (mnt < 90) return '约 ' + Math.round(mnt) + ' 分钟';
  const h = mnt / 60;
  if (h < 48) return '约 ' + (Math.round(h * 10) / 10) + ' 小时';
  return '约 ' + (Math.round(h / 24 * 10) / 10) + ' 天';
}
function applyBufCapacity() {
  cfg.bufMB = Math.min(1000, Math.max(100, Math.round(+cfg.bufMB || 100)));
  if (!store.setCapacity(bufPoints(cfg.bufMB))) {
    cfg.bufMB = 100;
    store.setCapacity(bufPoints(100));
    toast('内存不足，缓存已回落 100MB');
  }
  const inp = $('#sBufMB');
  if (inp) inp.value = cfg.bufMB;
  const t = $('#sBufTime');
  if (t) t.textContent = bufTimeText();
  save();
}
$$('[data-num]').forEach(btn => btn.addEventListener('click', () => {
  const key = btn.dataset.num, d = parseFloat(btn.dataset.d);
  const map = { trig: '#fTrigVal', dur: '#fDur', ov: '#sOv', oi: '#sOi', op: '#sOp', bufmb: '#sBufMB' };
  const inp = $(map[key]);
  let v = parseFloat(inp.value) || 0;
  v = Math.max(0, +(v + d).toFixed(2));
  inp.value = v;
  if (key === 'ov') cfg.offset.v = v;
  if (key === 'oi') cfg.offset.i = v;
  if (key === 'op') cfg.offset.p = v;
  if (key === 'bufmb') { cfg.bufMB = v; applyBufCapacity(); return; }   // 清空数据 + 落盘都在 applyBufCapacity 里
  // 步进也是设置变更 → 一律落盘（以前 trig/dur 不存，重启就丢回默认）
  if (key === 'trig') cfg.trigVal = v;
  if (key === 'dur')  cfg.dur = v;
  save();
  if (key === 'ov' || key === 'oi' || key === 'op') applyChartCfg();
}));
$('#sBufMB').addEventListener('change', e => { cfg.bufMB = +e.target.value || 100; applyBufCapacity(); });
$('#sArea').addEventListener('change', e => { cfg.area = e.target.checked; save(); applyChartCfg(); });
$('#sGrid').addEventListener('change', e => { cfg.grid = e.target.checked; save(); applyChartCfg(); });

/* ══════════ 开始 / 停止 ══════════ */
/* 「记录中」的唯一状态源。按钮文案/样式只在这里改 ——
   以前连接时自动开始记录后，自动停止会偷偷把文案改回「开始记录」而数据还在流，
   看着就是"开关无效"。现在停止是真停（泵送停掉、界面冻结），状态与文案不会再分叉。 */
let running = false;
function setRecording(on) {
  running = on;
  const b = $('#btnRun');
  b.classList.toggle('running', on);
  $('#btnRunText').textContent = on ? '停止记录' : '开始记录';
  $('.ri', b).classList.toggle('stop', on);
  /* ★ 记录中保持屏幕常亮（发版前修复 2026-10-13）：息屏 → WebView 的 JS 泵被系统节流
     → 原生帧队列（8 分钟）一旦溢出就静默丢数据。默认开着，用户可在设置里关。
     停止记录后恢复成用户自己的「屏幕常亮」设置。 */
  try {
    if (window.Ryken && window.Ryken.setKeepScreenOn) {
      window.Ryken.setKeepScreenOn(on ? (cfg.keepOnRec !== false || !!cfg.keepOn) : !!cfg.keepOn);
    }
  } catch {}
  if (on) { _recWallStart = Date.now(); _recGapWarned = 0; }
}

/* 记录连续性监测（发版前新增 2026-10-13）：
   息屏/后台时 JS 泵被节流，原生队列（qMax=60000 ≈ 8 分钟）之外的部分会丢。
   这里对比「墙钟流逝」与「数据流逝」，缺口 >3 秒即提示用户丢了多少 —— 静默丢数据最致命。 */
let _recWallStart = 0, _recGapWarned = 0;
function checkRecGap() {
  if (!running || !store.size || !_recWallStart) return;
  const n = store.size;
  const dataMs = store.at(n - 1, 't') - store.at(0, 't');
  const wallMs = Date.now() - _recWallStart;
  const gap = wallMs - dataMs;
  if (gap > 3000 && gap > _recGapWarned + 3000) {
    _recGapWarned = gap;
    const sec = Math.round(gap / 1000);
    toast(`⚠ 记录中断过：息屏/后台期间丢了约 ${sec} 秒数据（设置里可开「记录中保持屏幕常亮」避免）`, 6000);
    appLog(`记录缺口: 墙钟 ${Math.round(wallMs / 1000)}s vs 数据 ${Math.round(dataMs / 1000)}s，丢约 ${sec}s（息屏节流）`);
  }
}

$('#btnRun').addEventListener('click', async () => {
  if (running) {
    await recorder.stop();
    setRecording(false);
    toast('已停止记录');
  } else {
    if (!recorder) { toast('未连接数据源'); return; }
    store.clear(); resetAccum();          // 开始记录 = 新会话：清空重来
    await recorder.start();
    setRecording(true);
    toast('开始记录');
  }
});
/* ══════════ 会话数据清空（Beta20，用户 2026-10-11）══════════
   演示数据与真机数据必须严格隔离 —— 否则曲线/统计/读数会把两段数据接在一起，
   看曲线时完全分不出哪段是假的（用户实测反馈）。
   进出演示模式的每一刻都调它；`protocol` 控制是否连协议表一起清
   （「清零」按钮有自己独立的语义，默认不动协议表）。 */
function clearSessionData({ protocol = false } = {}) {
  store.clear();
  if (recorder) recorder.clear();
  resetAccum();
  if (source) { source.live = null; source.resetTimeline(); }
  lastRead = null;
  readoutsBlank = false;                 // 强制重走一次置空（否则被幂等守卫挡住）
  clearReadouts();
  if (protocol) pdReset();
  liveChart.follow = true; bigChart.follow = true;
  syncViewButtons();                     // 清零 = 新会话，回到自动模式（但保留跟随/缩放的选择）
  liveChart.draw(); bigChart.draw();
}

/* 清零（用户 2026-10-10 定稿语义）：彻底清空 + 时间轴归零 + 从零重新开始记录
   —— 与「停止→开始」等效；若原本已停止，按钮自动切回「停止记录」状态 */
$('#btnZero').addEventListener('click', async () => {
  clearSessionData();
  if (!running && recorder) { await recorder.start(); setRecording(true); }
  toast('已清零，从零开始记录');
});
/* ⟲ = 复位：曲线回到跟随最新，不清数据 */
$('#btnLiveClear').addEventListener('click', () => {
  liveChart.follow = true;
  liveChart.draw();
  toast('已复位');
});
/* 实时曲线系列：三条独立多选，**可同时显示 V+A+W**（2026-10-10 取消互斥）——
   互斥的只是 Y 轴位：功率永远占一个轴，电压/电流里最后筛选的拿第二个轴，
   第三条曲线照画（自己的量程、不渲染轴列）。 */
function initLiveSeriesSeg() {
  const sync = () => $$('#liveSeriesSeg .seg')
    .forEach(x => x.classList.toggle('is-active', (cfg.liveVisible || []).includes(x.dataset.v)));
  $$('#liveSeriesSeg .seg').forEach(b => {
    b.addEventListener('click', () => {
      const v = b.dataset.v;
      if (!cfg.liveVisible) cfg.liveVisible = [];
      const i = cfg.liveVisible.indexOf(v);
      if (i >= 0) cfg.liveVisible.splice(i, 1);        // 取消这一条
      else cfg.liveVisible.push(v);
      /* 轴位归属：电压/电流谁最后被筛选，谁跟功率一起上轴 */
      if (v === 'vbus' || v === 'ibus') cfg.lastPick = v;
      sync(); save(); applyChartCfg(); liveChart.draw();
    });
  });
  sync();
}

/* ══════════ 把持久化设置回填到界面 ══════════
   启动时调一次：所有设置项都恢复上次的值（不只是主题/方向/颜色）。 */
function trigUnitOf(base) { return base === '电压' ? 'V' : base === '电流' ? 'A' : 'W'; }

/* 给两条测量线落位（进入「测量」时调用一次）。
   ★ 两条线**钉死在绝对时刻**（用户 2026-10-13 明确：它量的就是某个固定时间段，
     视窗滚过去以后就该出画，而不是跟着一起漂）。所以：
     · 还没有线、或两条都已滚出视窗 → 按当前视窗的 30% / 70% 落位；
     · 只要还有一条看得见 → 保留用户拖出来的位置。
   ⚠ 两种「视窗不可信」的冷启动情形都要兜住，否则线会落在真实数据里不存在的时刻：
     · store 还没有数据（App 刚起来，demo/真机还没推第一帧）→ 先挂起，等有数据再落位；
     · bigChart 还没绘制过 → view 仍是构造函数的默认值 [0, 20000] → 用最新采样时刻重算。 */
function anchorMeasure() {
  const n = store.size;
  if (!n) { bigChart.measure = null; bigChart._measurePending = true; return; }
  bigChart._measurePending = false;
  let span = Math.max(1, bigChart.view.t1 - bigChart.view.t0);
  let end = bigChart.view.t1;
  const lastT = store.at(n - 1, 't');
  if (end < lastT - span * 0.5) {
    span = Math.min(bigChart.opts.windowMs, Math.max(lastT * 1.06, 1500));   // 与 chart 的窗口公式一致
    end = lastT + span * 0.005;
  }
  const cur = bigChart.measure;
  const inView = (t) => t >= bigChart.view.t0 && t <= bigChart.view.t1;
  if (!cur || (!inView(cur.t1) && !inView(cur.t2))) {
    bigChart.measure = { t1: end - span * 0.70, t2: end - span * 0.30, drag: 0 };
  }
}

function applyChartMode(m) {
  $$('#chartMode .seg').forEach(x => x.classList.toggle('is-active', x.dataset.mode === m));
  $('#chartTitle').textContent = m === 'curve' ? '实时测试曲线' : m === 'measure' ? '测量值曲线' : '统计曲线';
  /* ⚠ 这里**不要**再写 `opts.area`（2026-10-13 用户定位到的真凶，和下面 showSmall 同一个坑）：
     原来这行是 `bigChart.opts.area = (m !== 'stat') && cfg.area` —— 进「统计」时**强制关掉**
     面积填充，而 applyChartCfg 又按 `cfg.area` 打开。于是刚切进统计时图上没有填充色，
     随便点一下筛选触发 applyChartCfg 才突然出现（用户实测："只有再次点击重新筛选它才会有填充色"）。
     「启用功率曲线面积填充」是用户设置，唯一的来源就是 cfg.area（applyChartCfg 下发）。 */
  /* ★ 测量模式（2026-10-12 复刻官方 PC 版）：两条测量线，默认落在视窗 30% / 70%
     （官方 marklinePosition:[.3,.7] 同款）；统计模式：图表下方出官方同款统计表。 */
  if (m === 'measure') {
    anchorMeasure();
    const mp = $('#measurePanel');
    mp.classList.add('show');
    renderMeasurePanel();
    mp._clamp?.();        // 显示后容器才有尺寸：像素定位的浮层补夹一次（默认居中位会自动跳过）
  } else {
    bigChart.measure = null;
    $('#measurePanel').classList.remove('show');
  }
  $('#statsTable').classList.toggle('show', m === 'stat');
  if (m === 'stat') { updateStatsTable(); $('#statsTable')._clamp?.(); }
  /* ⚠ 这里**不要**再写 `opts.showSmall`（用户 2026-10-11 定位到的真凶）：
     原来这行是 `bigChart.opts.showSmall = (m !== 'curve')` —— 与 applyChartCfg 里的
     `c.opts.showSmall = cfg.showSmall` 直接冲突，而且极性还写反了。
     chartMode 默认 'curve'，于是 boot() 里 applyChartCfg 先设 true、
     applySettingsToDOM → applyChartMode('curve') 又把它改回 false
     ⇒ `_showTip/_draw` 里 `if (se.small && !showSmall) continue` 把
     CC/D±/温度/容量/能量 全部跳过：chips 和统计表（走 cfg.visible）正常、
     唯独**曲线和读数浮层只出 V/I/W**；用户一动筛选触发 applyChartCfg 才恢复 —— 
     正是"要点两次/关掉再打开才显示"。
     showSmall 现在**唯一来源 = cfg.showSmall**（applyChartCfg 下发）。 */
  bigChart.draw();
}

/* ══════════ 测量面板（复刻官方 PC 版「测量」）══════════
   官方：图表上两条可拖竖线 T1/T2，逐曲线交点标值；面板标题「T1 - T2」，逐系列列 T1−T2。
   手机端：数值标签画在图上（chart.js._measureLines），完整数值走这里，
   并额外给出 Δt —— 官方面板没有，但刷机/充电场景下"两条线之间的时长"是常用量。 */
function renderMeasurePanel() {
  const el = $('#measurePanel');
  if (!el || !bigChart.measure || !store.size) return;
  const m = bigChart.measure;
  const n = store.size;
  const i1 = Math.max(0, Math.min(n - 1, bigChart._indexAtTime(m.t1)));
  const i2 = Math.max(0, Math.min(n - 1, bigChart._indexAtTime(m.t2)));
  const dt = Math.abs(store.at(i2, 't') - store.at(i1, 't'));
  /* 只列当前勾选的系列（与曲线/图例一致）；Δ 用「T1 − T2」——与官方一致（左减右） */
  const rows = SERIES.filter(se => cfg.visible.includes(se.id)).map(se => {
    const a = store.at(i1, se.id), b = store.at(i2, se.id);
    const d = a - b;
    const dg = Math.min(se.digits ?? 3, 4);
    return `<div class="mp-row" style="--ac:${cfg.colors[se.id]}">
      <span class="mp-k">${se.code}</span>
      <span class="mp-v">${d.toFixed(dg)}<i>${se.unit}</i></span>
      <span class="mp-ab">${a.toFixed(dg)} → ${b.toFixed(dg)}</span>
    </div>`;
  }).join('');
  el.innerHTML = `<div class="mp-hd"><span>T1 − T2</span><em>Δt ${fmtFootDur(dt)}</em>` +
    `<span class="mp-hint">拖线测量 · 标题栏可移</span></div>` + rows;
}
bigChart.onMeasure = () => { if (cfg.chartMode === 'measure') renderMeasurePanel(); };

/* ══════════ 统计表（复刻官方 PC 版「统计」）══════════
   官方口径（app.exe 前端源码实证）：
     · 全部 = 总时长（会话时长）/ 容量Ah（累计末值）/ 能量Wh（累计末值）/ 点数（累计读取点数）
     · 窗口 = 图表当前可见区间（官方 = dataZoom 选区）：时长 = 末点−首点，
       容量/能量 = **区间增量 Δ**（不是累计值），点数 = 区间内点数
   我们的「容量」内部单位是 mAh（SERIES 定义），官方统计表用 Ah → 显示时 /1000（4 位小数）。 */
function updateStatsTable() {
  const el = $('#statsTable');
  if (!el) return;
  const zero = { time: 0, ah: 0, wh: 0, pts: 0 };
  let all = { ...zero }, win = { ...zero };
  const n = store.size;
  if (n) {
    const t0v = store.at(0, 't'), t1v = store.at(n - 1, 't');
    all = { time: t1v - t0v, ah: (store.at(n - 1, 'cap') || 0) / 1000,
            wh: store.at(n - 1, 'wh') || 0, pts: n };
    /* 窗口：总览（fitAll）时 = 全部（官方：dataZoom 两端到底时 window = total）；
       否则按视窗 ∩ 数据范围取区间增量 */
    if (bigChart.fitAll && bigChart.follow) {
      win = { ...all };
    } else {
      const i0 = Math.max(0, Math.min(n - 1, bigChart._indexAtTime(Math.max(bigChart.view.t0, t0v))));
      const i1 = Math.max(0, Math.min(n - 1, bigChart._indexAtTime(Math.min(bigChart.view.t1, t1v))));
      if (i1 > i0) {
        win = { time: store.at(i1, 't') - store.at(i0, 't'),
                ah: ((store.at(i1, 'cap') || 0) - (store.at(i0, 'cap') || 0)) / 1000,
                wh: (store.at(i1, 'wh') || 0) - (store.at(i0, 'wh') || 0),
                pts: i1 - i0 + 1 };
      }
    }
  }
  const row = (label, cls, s) =>
    `<div class="stt-row ${cls}"><span class="stt-k">${label}</span>` +
    `<span>${fmtFootDur(s.time)}</span><span>${s.ah.toFixed(4)}</span>` +
    `<span>${s.wh.toFixed(4)}</span><span>${s.pts.toLocaleString()}</span></div>`;
  el.innerHTML =
    `<div class="stt-row stt-hd"><span class="stt-k">统计</span><span>总时长</span>` +
    `<span>容量Ah</span><span>能量Wh</span><span>点数</span></div>` +
    row('全部', 'all', all) + row('窗口', 'win', win);
}

/* ── 浮层拖拽（用户 2026-10-12：统计窗 + 测量窗，位置可拖）──
   只有标题栏可拖（浮层本体 pointer-events:none，图上手势不被挡）；
   位置存 localStorage 跨重启保留；双击标题栏复位回默认位。
   可放置范围 = **绘图区**（两根纵轴之间、时间轴之上），由 chart.js 写在容器上的
   --plot-l / --plot-r / --plot-b 三个 CSS 变量给出（用户 2026-10-13）。 */
function makeFloatDraggable(el, wrap, key, handleSel) {
  if (!el || !wrap) return;
  /* 一旦落成像素坐标，必须清掉 CSS 的「底部居中」transform（translateX(-50%)），
     否则 left 会再被左移半个宽度 —— 位置整体偏掉。 */
  const put = (x, y) => { el.style.transform = 'none'; el.style.left = x + 'px'; el.style.top = y + 'px'; el.style.bottom = 'auto'; };
  /* 可放置矩形（容器坐标系）。取不到 CSS 变量就退回整个容器。 */
  const area = () => {
    const pr = wrap.getBoundingClientRect();
    const num = (k, d) => { const v = parseFloat(wrap.style.getPropertyValue(k)); return isFinite(v) ? v : d; };
    const l = num('--plot-l', 0), r = num('--plot-r', 0), b = num('--plot-b', 0);
    return { left: l, top: 0, right: Math.max(l, pr.width - r), bottom: Math.max(0, pr.height - b) };
  };
  const clampNow = () => {
    /* 只有「像素定位」的浮层才需要夹 —— 默认位由 CSS 的 calc(var(--plot-*)) 自适应，
       这里若照夹会 parseFloat('')=0 → 被钉到左上角。 */
    if (!el.style.top || el.style.top === 'auto') return;
    const pr = wrap.getBoundingClientRect(), r = el.getBoundingClientRect();
    /* ⚠ 容器还没尺寸（所在页 display:none，例如 App 冷启动时停在实时页）→ **直接跳过**。
       以前不判这个：`pr.width/height` 都是 0 → 夹完变成 (0,0)，还写成内联样式，
       于是 CSS 的默认位被永久覆盖 —— 浮层每次启动都钉在曲线图左上角
       （用户 2026-10-13 报的"怎么还是在顶部左上角"就是这个）。 */
    if (!pr.width || !pr.height) return;
    const a = area();
    let x = parseFloat(el.style.left) || 0, y = parseFloat(el.style.top) || 0;
    x = Math.max(a.left, Math.min(x, Math.max(a.left, a.right - r.width)));
    y = Math.max(a.top, Math.min(y, Math.max(a.top, a.bottom - r.height)));
    put(x, y);
  };
  /* 供 applyChartMode 在「显示浮层之后」补夹一次（此时容器才有尺寸） */
  el._clamp = clampNow;
  try {
    const p = JSON.parse(localStorage.getItem(key) || 'null');
    if (p && isFinite(p.x) && isFinite(p.y)) { put(p.x, p.y); clampNow(); }
  } catch {}
  let drag = null;
  const onHandle = (e) => !!(e.target.closest && e.target.closest(handleSel));
  el.addEventListener('pointerdown', (e) => {
    if (!onHandle(e)) return;
    const pr = wrap.getBoundingClientRect(), r = el.getBoundingClientRect();
    /* prev = 拖动前的内联定位，供「只是点了一下、没真移动」时原样还原。
       ⚠ 没有它的话，点一下标题栏也会把 CSS 的「底部居中」换成像素坐标并写进
       localStorage —— 用户明明没拖，浮层却永久离开了默认位（2026-10-13 实测）。 */
    drag = {
      id: e.pointerId, ox: e.clientX - r.left, oy: e.clientY - r.top, pr,
      sx: e.clientX, sy: e.clientY, moved: false,
      prev: { transform: el.style.transform, left: el.style.left, top: el.style.top, bottom: el.style.bottom },
    };
    put(r.left - pr.left, r.top - pr.top);
    try { el.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault(); e.stopPropagation();
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (Math.abs(e.clientX - drag.sx) > 3 || Math.abs(e.clientY - drag.sy) > 3) drag.moved = true;
    const pr = drag.pr, r = el.getBoundingClientRect(), a = area();
    const x = Math.max(a.left, Math.min(e.clientX - pr.left - drag.ox, Math.max(a.left, a.right - r.width)));
    const y = Math.max(a.top, Math.min(e.clientY - pr.top - drag.oy, Math.max(a.top, a.bottom - r.height)));
    put(x, y);
    e.preventDefault(); e.stopPropagation();
  });
  const up = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    if (!d.moved) {           // 只是点了一下标题栏：还原原定位，不记位置
      el.style.transform = d.prev.transform;
      el.style.left = d.prev.left;
      el.style.top = d.prev.top;
      el.style.bottom = d.prev.bottom;
      return;
    }
    try { localStorage.setItem(key, JSON.stringify({ x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0 })); } catch {}
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('dblclick', (e) => {                 // 双击标题栏 = 复位回默认位（绘图区底部居中）
    if (!onHandle(e)) return;
    /* 清掉全部内联定位，交回 CSS 的 calc(var(--plot-*)) —— 别写死 50%/8px，
       那样会盖掉按绘图区算出来的居中位置。 */
    el.style.transform = ''; el.style.left = ''; el.style.top = ''; el.style.bottom = '';
    try { localStorage.removeItem(key); } catch {}
  });
  /* ⚠ 只有「像素定位」的浮层才需要在 resize 时夹回容器内。
     默认位（left:50% + translateX + top:auto）由 CSS 自适应，绝不能走 clampNow ——
     clampNow 用 parseFloat('50%')=50 当 left，会把居中的浮层钉到左边。 */
  window.addEventListener('resize', () => clampNow());   // clampNow 自己会判「是不是像素定位 / 容器有没有尺寸」
}
makeFloatDraggable($('#statsTable'), $('#bigChartWrap'), 'ryken_stats_pos', '.stt-hd');
makeFloatDraggable($('#measurePanel'), $('#bigChartWrap'), 'ryken_measure_pos', '.mp-hd');

function applySettingsToDOM() {
  const sw  = (sel, v) => { const e = $(sel); if (e) e.checked = !!v; };
  const val = (sel, v) => { const e = $(sel); if (e) e.value = v; };
  sw('#fAutoStop', cfg.autoStop);
  sw('#fSysTime',  cfg.sysTime);
  sw('#pdMask',    cfg.pdMask);
  sw('#sArea',     cfg.area);
  sw('#sGrid',     cfg.grid);
  sw('#sHideStatus', cfg.hideStatus);
  sw('#sHideStatusLand', cfg.hideStatusLand);
  sw('#sKeepOn', cfg.keepOn);
  sw('#sKeepOnRec', cfg.keepOnRec !== false);
  sw('#sAmoled', cfg.amoled);
  sw('#sSwipeNav', cfg.swipeNav);
  sw('#sDemo', cfg.demo);
  syncTipHoldSeg();
  val('#fTrigVal', cfg.trigVal);
  val('#fDur',     cfg.dur);
  val('#sOv', cfg.offset.v); val('#sOi', cfg.offset.i); val('#sOp', cfg.offset.p);
  val('#fwUrl', FW_SRC_URLS[cfg.updateSrc] || (cfg.updateUrl || ''));
  $('#fwUrl').readOnly = !!FW_SRC_URLS[cfg.updateSrc];
  $$('#fwSrcSeg .seg').forEach(b => b.classList.toggle('is-active', b.dataset.val === (cfg.updateSrc || 'official')));
  $$('#fTrigBase .seg').forEach(b => b.classList.toggle('is-active', b.dataset.val === cfg.trigBase));
  $('#fTrigUnit').textContent = trigUnitOf(cfg.trigBase);
  $$('#fRate .seg').forEach(b => b.classList.toggle('is-active', b.dataset.val === cfg.rate));
  val('#sBufMB', cfg.bufMB);
  $('#sBufTime').textContent = bufTimeText();
  applyChartMode(cfg.chartMode || 'curve');
}

/* ══════════ 状态栏隐藏：手动开关 + 横屏自动 ══════════ */
let _immSent = null;
function applyImmersion() {
  try {
    const land = matchMedia('(orientation: landscape)').matches || innerWidth >= 900;
    const hidden = !!cfg.hideStatus || (!!cfg.hideStatusLand && land);
    document.documentElement.classList.toggle('imm', hidden);   // 顶栏贴屏幕上缘（CSS）
    if (window.Ryken && window.Ryken.setImmersive && hidden !== _immSent) {
      _immSent = hidden;
      window.Ryken.setImmersive(hidden);
    }
  } catch {}
}
window.addEventListener('resize', () => applyImmersion());

/* 屏幕常亮：窗口 FLAG_KEEP_SCREEN_ON（原生窗口标志，跨 Activity 生命周期持续） */
function applyKeepOn() {
  try {
    if (window.Ryken && window.Ryken.setKeepScreenOn) window.Ryken.setKeepScreenOn(!!cfg.keepOn);
  } catch {}
}

/* ══════════ 触发依据：迷你分段选择，单位联动 V/A/W ══════════ */
$$('#fTrigBase .seg').forEach(b => b.addEventListener('click', () => {
  $$('#fTrigBase .seg').forEach(x => x.classList.toggle('is-active', x === b));
  cfg.trigBase = b.dataset.val;
  $('#fTrigUnit').textContent = trigUnitOf(cfg.trigBase);
  save();
}));

/* 采样速率：迷你分段选择（真降采样记录速率；「原生」= 设备原始速率全收，默认档 50SPS 对标官方） */
$$('#fRate .seg').forEach(b => b.addEventListener('click', () => {
  $$('#fRate .seg').forEach(x => x.classList.toggle('is-active', x === b));
  cfg.rate = b.dataset.val;
  const bt = $('#sBufTime'); if (bt) bt.textContent = bufTimeText();   // 速率变了，可录时长跟着变
  save(); applyDataPolicy();
}));

/* 数值输入框：手输也要记住 */
$('#fTrigVal').addEventListener('change', e => { cfg.trigVal = parseFloat(e.target.value) || 0; save(); });
$('#fDur').addEventListener('change',     e => { cfg.dur     = parseFloat(e.target.value) || 0; save(); });
['#sOv', '#sOi', '#sOp'].forEach((sel, i) => {
  $(sel).addEventListener('change', e => {
    cfg.offset[['v', 'i', 'p'][i]] = parseFloat(e.target.value) || 0;
    save(); applyChartCfg();
  });
});
/* 开关类 */
$('#fAutoStop').addEventListener('change', e => { cfg.autoStop = e.target.checked; save(); });
$('#fSysTime').addEventListener('change',  e => { cfg.sysTime  = e.target.checked; save(); applyDataPolicy(); });
/* 状态栏隐藏：手动开关（横竖屏都藏）+ 横屏自动 */
$('#sHideStatus').addEventListener('change', e => {
  cfg.hideStatus = e.target.checked; save(); applyImmersion();
});
$('#sHideStatusLand').addEventListener('change', e => {
  cfg.hideStatusLand = e.target.checked; save(); applyImmersion();
});
/* 屏幕常亮 + A 屏黑主题 */
$('#sKeepOn').addEventListener('change', e => { cfg.keepOn = e.target.checked; save(); applyKeepOn(); });
$('#sKeepOnRec').addEventListener('change', e => {
  cfg.keepOnRec = e.target.checked; save();
  /* 记录中改动立刻生效（不用等下一次开始记录） */
  if (running) setRecording(true);
});
$('#sAmoled').addEventListener('change', e => { cfg.amoled = e.target.checked; save(); applyTheme(); });
$('#sSwipeNav').addEventListener('change', e => { cfg.swipeNav = e.target.checked; save(); });
$('#sDemo').addEventListener('change', e => { cfg.demo = e.target.checked; save(); applyDemoMode(); });
/* 曲线读数停留时间：3/5/10/30 秒 / 常驻（data-h="0" = 不自动收起）。
   用分段按钮而不是原生 select —— WebView 里的 select 是系统控件，样式不受控。 */
function syncTipHoldSeg() {
  const v = String(cfg.tipHold ?? 3000);
  $$('#tipHoldSeg .seg').forEach(b => b.classList.toggle('is-active', b.dataset.h === v));
}
$$('#tipHoldSeg .seg').forEach(b => b.addEventListener('click', () => {
  cfg.tipHold = +b.dataset.h;
  save(); applyChartCfg(); syncTipHoldSeg();
}));

/* ══════════ 演示模式（Beta19，用户 2026-10-11）══════════
   开启：无真设备时生成演示数据（测量帧 + PD 协商序列），各页面同显。
   关闭：回到真机路径。
   ★ 与真机联动（用户 2026-10-11）：demo 开启期间每秒探测真机——
     真机连上 → 自动挂起 demo、走真机数据（提示）；拔掉 → 自动恢复 demo。
     cfg.demo 始终表示「用户意图」：开着就拔插循环切换；原本关着就一直关。 */
/* 演示模式的固定设备信息（用户 2026-10-13 定）：
   演示 / 截图时顶栏与「关于」页显示这套值 —— 机型 X3 / SN 88888888 / 固件 1.20。
   这样演示模式截出来的图可直接公开，不必打码。 */
const DEMO_DEVICE = { name: 'X3', sn: '88888888', version: '1.20' };

function startDemoEngine() {
  source.demo = makeDemoEngine();
  /* 必须经 recorder.stop/start：recorder.start 有 running 守卫，
     只调 source.start() 会被守卫挡住（demo 不会真的起泵） */
  return recorder.stop().then(() => recorder.start()).then(() => {
    clearSessionData({ protocol: true });   // 演示数据从零起，不接在真机数据后面
    if (!pd.running) pdSetRun(true);     // 演示模式自动收报文（按钮态同步）
    setConn('off', '演示模式 · 无真设备', DEMO_DEVICE);
    watchRealDevice();
  });
}
function stopDemoEngine() {
  source.demo = null;
  /* ⚠ 这里不清 demoWatch：真机接管态还要靠它轮询「拔出 → 恢复 demo」；
     watch 的生命周期由调用方管（用户关开关 / 循环自身退出条件） */
  return recorder.stop().then(() => recorder.start()).then(() => {
    clearSessionData({ protocol: true });   // 清掉演示数据，回到干净的会话
  });
}
function watchRealDevice() {
  stopWatchRealDevice();
  source.demoWatch = setInterval(() => {
    /* demo 引擎和「真机接管」两态都要轮询：接管态等拔出恢复；用户关开关后退出 */
    if (!source.demo && !source._realTakeover) { stopWatchRealDevice(); return; }
    let st; try { st = JSON.parse(window.Ryken?.status() || '{}'); } catch { return; }
    if (st.connected && !source._realTakeover) {
      source._realTakeover = true;
      stopDemoEngine().then(() => {      // stopDemoEngine 内部已清空演示数据
        const st = source.status();
        setConn(st.connected ? 'on' : 'off', st.connected ? '已连接' : '未连接');
        toast('检测到真机已连接，演示模式已暂停（演示数据已清空）', 2600);
      }).catch(() => {});
    } else if (!st.connected && source._realTakeover) {
      source._realTakeover = false;
      if (!cfg.demo) { stopWatchRealDevice(); return; }   // 用户中途关了开关：不再自动恢复
      startDemoEngine().then(() => toast('设备已拔出，恢复演示模式（上一段数据已清空）', 2600)).catch(() => {});
    }
  }, 1000);
}
function stopWatchRealDevice() {
  if (source?.demoWatch) { clearInterval(source.demoWatch); source.demoWatch = null; }
  if (source) source._realTakeover = false;
}
function applyDemoMode() {
  if (!(source instanceof AndroidSource)) return;
  if (cfg.demo) {
    if (!source.demo) startDemoEngine().then(() => toast('演示模式已开启', 1800)).catch(() => {});
    return;
  }
  /* 关闭演示模式：引擎在跑 → stopDemoEngine（内部清空）；已在「真机接管」态 →
     这里补一次清空。两种情况下曲线上都可能留着演示数据，必须清掉（用户 2026-10-11） */
  const wasDemo = !!source.demo;
  if (!wasDemo && !source._realTakeover) return;    // 本来就没开演示：静默返回（启动时走这里）
  Promise.resolve(wasDemo ? stopDemoEngine() : clearSessionData({ protocol: true })).then(() => {
    stopWatchRealDevice();               // 用户主动关闭：清掉联动监测
    if (pd.running) pdSetRun(false);
    const st = source.status();
    setConn(st.connected ? 'on' : 'off', st.connected ? '已连接' : '未连接',
      st.device ? { name: st.device.productName || 'RK-X3', sn: st.productSn || '—', version: st.fwVersion || '—' } : null);
    toast('演示模式已关闭，演示数据已清空', 2000);
  }).catch(() => {});
}

/* 「曲线时长」脚注（#footTime）：此前是写死的元素、**从未被任何代码更新**（用户 2026-10-12
   实测发现"时间不会动"）。语义 = 曲线缓冲的已记录时长（最新采样点的时间）：
   记录中实时递增、停止后定格；缓冲为空显示 00:00:00.0。 */
function fmtFootDur(ms) {
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60, d = Math.floor(ms / 100) % 10;
  const p = n => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}.${d}`;
}
let _footTxt = '';
function updateFootTime() {
  const el = $('#footTime');
  if (!el) return;
  let txt = '00:00:00.0';
  try { if (store.size) txt = fmtFootDur(store.at(store.size - 1, 't') || 0); } catch (e) { return; }
  if (txt !== _footTxt) { _footTxt = txt; el.textContent = txt; }
}

/* 自动停止：记录中，触发依据 < 触发阈值 且持续 持续时间 秒 → 自动停止记录 */
let trigBelowSince = 0;
let _statTick = 0;
setInterval(() => {
  updateFootTime();                               // 曲线时长脚注（200ms 一次，txt 不变则不写 DOM）
  checkRecGap();                                  // 记录连续性监测（息屏丢数据告警）
  /* 统计表/测量面板 ~1s 一次（拖动测量线是实时刷新，走 onMeasure 回调，不靠这里） */
  if (++_statTick >= 5) {
    _statTick = 0;
    if (cfg.chartMode === 'stat') updateStatsTable();
    else if (cfg.chartMode === 'measure') renderMeasurePanel();
  }
  const auto = $('#fAutoStop');
  if (!running || !auto || !auto.checked || !store.size) { trigBelowSince = 0; return; }
  const base = $('#fTrigBase .seg.is-active')?.dataset.val || '功率';
  const thr = parseFloat($('#fTrigVal').value) || 0;
  const dur = (parseFloat($('#fDur').value) || 0) * 1000;
  if (thr <= 0 || dur <= 0) { trigBelowSince = 0; return; }
  const key = base === '电压' ? 'vbus' : base === '电流' ? 'ibus' : 'pwr';
  const v = store.at(store.size - 1, key);
  const now = performance.now();
  if (v < thr) {
    if (!trigBelowSince) trigBelowSince = now;
    if (now - trigBelowSince >= dur) {
      trigBelowSince = 0;
      (async () => {
        try { await recorder.stop(); } catch {}
        setRecording(false);
        toast(`已自动停止：${base}低于 ${thr}${$('#fTrigUnit').textContent} 持续 ${dur / 1000}s`, 3200);
      })();
    }
  } else trigBelowSince = 0;
}, 200);

/* 连接状态胶囊 = 重连入口（顶栏不再放独立按钮）：点一下重新拉起连接 */
$('#connPill').addEventListener('click', () => {
  if (window.Ryken && window.Ryken.platform && window.Ryken.platform() === 'android') {
    toast('正在重连功率表…');
    setTimeout(() => {
      let ok = false;
      try { ok = window.Ryken.reconnect(); } catch {}
      toast(ok ? '已重新连接' : '重连未成功，请确认功率表已插好', 2400);
    }, 30);
  } else {
    toast('正在连接桥接服务…');
    probeBridge();
  }
});

/* ══════════ 日志与诊断（设置页，反馈 bug 用）══════════
   ⚠ 2026-10-13 研究结论：**保留**。它是"我连不上设备时唯一的现场证据"——
   buildLogText() 收集的 source.status()（帧计数/端点/读写失败数/lastSend/sysEvents）
   正是本工程排障时最有用的那份数据（X3 SE 枚举、永硕 TLS 失败、startStream 失败
   三个真实案例都靠它定位）。成本极低：400 条内存字符串 + 无定时器、无 IO。
   2026-10-13 增强：额外写入"配置与运行状态"（采样率/缓存/主题/方向/记录状态/点数），
   这几项以前每次都要来回问用户。 */
const appLogs = [];
function appLog(msg) {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  appLogs.push(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${msg}`);
  if (appLogs.length > 400) appLogs.shift();
}
window.addEventListener('error', (e) => appLog(`JS错误: ${e.message} @行${e.lineno || '?'}`));
window.__ryken_log = appLog;   // transport.js 等模块通过它写日志

function buildLogText() {
  const lines = appLogs.slice();
  if (window.__rykenErr && window.__rykenErr.length) {
    lines.push('──── 早期错误（模块加载阶段）────');
    lines.push(...window.__rykenErr.slice(-20));
  }
  /* ★ 当前配置与运行状态（2026-10-13 增强）：这五项是每次定位问题的必问项 ——
     采样速率/缓存大小决定"点数为啥这么少"，主题/方向决定"UI 为啥长这样"，
     记录状态+缓冲占用决定"曲线为啥不动"。以前都要来回问用户，现在日志自带。 */
  lines.push('──── 配置与运行状态 ────');
  try {
    lines.push(`采样速率: ${cfg.rate} | 缓存: ${cfg.bufMB}MB (${bufPoints(cfg.bufMB)} 点) | 曲线模式: ${cfg.chartMode}`);
    lines.push(`主题: ${cfg.theme}${document.documentElement.classList.contains('amoled') ? '(A屏黑)' : ''} | 方向: ${cfg.orientation} | 屏幕: ${window.innerWidth}x${window.innerHeight}`);
    lines.push(`记录中: ${running ? '是' : '否'} | 采样点数: ${store.size} | 曲线时长: ${$('#footTime')?.textContent || '-'} | 演示模式: ${cfg.demo ? '开' : '关'}`);
  } catch (e) { lines.push('配置收集失败: ' + e); }
  lines.push('──── 机型与系统 ────');
  try {
    if (window.Ryken?.deviceInfo) lines.push(window.Ryken.deviceInfo());
    else lines.push('UA: ' + navigator.userAgent);
  } catch (e) { lines.push('机型信息收集失败: ' + e); }
  lines.push('──── 设备状态 ────');
  try {
    if (source instanceof AndroidSource) {
      lines.push(JSON.stringify(source.status(), null, 1));
      lines.push('最近原始帧: ' + JSON.stringify(source.sniff().last || []));
    } else {
      lines.push('source: ' + (source?.constructor?.name || '无'));
    }
    if (window.Ryken) lines.push('USB设备列表: ' + window.Ryken.listDevices());
  } catch (e) { lines.push('状态收集失败: ' + e); }
  lines.push('页面: ' + location.href);
  lines.push('时间: ' + new Date().toLocaleString());
  return lines.join('\n');
}
$('#btnLogGen').addEventListener('click', () => {
  $('#logBox').value = buildLogText();
  toast('日志已生成');
});
$('#btnLogCopy').addEventListener('click', () => {
  const txt = $('#logBox').value || buildLogText();
  $('#logBox').value = txt;
  if (window.Ryken?.copyText) { window.Ryken.copyText(txt); }
  else if (navigator.clipboard) { navigator.clipboard.writeText(txt).then(() => toast('已复制'), () => toast('复制失败，请长按文本框手动复制')); }
  else toast('复制失败，请长按文本框手动复制');
});
$('#btnLogShare').addEventListener('click', () => {
  const txt = $('#logBox').value || buildLogText();
  $('#logBox').value = txt;
  if (window.Ryken?.shareText) window.Ryken.shareText(txt);
  else toast('浏览器环境请用「复制」');
});

/* ══════════ 曲线页 ══════════ */
$$('#chartMode .seg').forEach(b => b.addEventListener('click', () => {
  cfg.chartMode = b.dataset.mode;
  save();
  applyChartMode(cfg.chartMode);
}));
/* 按钮激活态 = 当前**实际生效**的视图模式（用户 2026-10-11：原来两个按钮长得一样，
   看不出哪个生效）。拖拽/捏合进入自由查看时两个都不亮 —— 这本身就是有效信息：
   用户一眼知道"我现在既不在跟随即不在缩放"，点一下就能回去。
   ⚠ 与切换 tab 的复位逻辑配套：切页只复位「自由查看」回自动模式，
     选的是跟随还是缩放（fitAll）要记住。 */
function syncViewButtons() {
  const f = $('#btnFollow'), t = $('#btnFit');
  if (f) f.classList.toggle('on', bigChart.follow && !bigChart.fitAll);
  if (t) t.classList.toggle('on', bigChart.follow && bigChart.fitAll);
}
bigChart.onViewChange = () => {
  syncViewButtons();                               // 拖拽/捏合把 follow 关掉时同步按钮
  if (cfg.chartMode === 'stat') updateStatsTable();   // 窗口统计跟随可见区间
};
syncViewButtons();
/* 跟随：30 秒滚动窗口贴最新；缩放：总览（左端钉数据起点、右端贴最新，曲线继续动）。
   ⚠ 两者都是 follow=true 的变体，区别只在 fitAll —— 拖拽/捏合会把 follow 关掉（自由查看）。 */
const fmtSpan = ms => ms < 60000 ? (ms / 1000).toFixed(1) + ' 秒' : (ms / 60000).toFixed(1) + ' 分钟';
$('#btnFollow').addEventListener('click', () => {
  bigChart.follow = true; bigChart.fitAll = false;
  bigChart.draw(); syncViewButtons();
  toast('已跟随最新（' + fmtSpan(bigChart.opts.windowMs) + '窗口）');
});
$('#btnFit').addEventListener('click', () => {
  if (!store.size) return toast('暂无数据', 1500);
  bigChart.follow = true;      // 右端随新数据走
  bigChart.fitAll = true;      // 左端钉住数据起点 → 总览
  bigChart.draw(); syncViewButtons();
  const [a, b] = store.timeRange();
  toast(`已缩放看全部（${fmtSpan(b - a)}），曲线会继续跟着更新`, 2600);
});
$('#btnExportCsv').addEventListener('click', exportCsv);
$('#btnExportCsv2').addEventListener('click', exportCsv);

/* ══════════ 导出（Beta20 追加，用户 2026-10-11）══════════
   ⚠ Android WebView **不会处理** blob: + a.download（本工程没装 DownloadListener）
   —— 原来那两个导出按钮在 APK 里点了毫无反应，只有 PC 桥接浏览器里能用。
   真机改走原生分块写：JS 切片 → Ryken.fileBegin / fileWrite(B64) / fileEnd，
   落到公共 Download/RYKEN/（API 29+ MediaStore，免权限，文件管理器 / USB 直接可见）。 */
const EXPORT_CHUNK = 131072;                       // 128KiB；base64 分片必须 4 字节对齐
function isAndroidApp() { try { return window.Ryken?.platform?.() === 'android'; } catch { return false; } }
/* 文件名时间戳：20261011-165500（本地时间，可读、天然不重名） */
function fileStamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
/* 文本分块写（CSV）：按行累积到 128KiB 再交原生，避免长字符串拼爆内存 */
function saveTextToFile(name, mime, lines) {
  const R = window.Ryken;
  const path = R.fileBegin(name, mime);
  if (!path) { toast('导出失败：无法创建文件', 3000); return true; }
  try {
    let buf = [], size = 0;
    for (const ln of lines) {
      buf.push(ln); size += ln.length + 1;
      if (size >= EXPORT_CHUNK) {
        if (!R.fileWrite(buf.join('\n') + '\n')) throw new Error('写入中断');
        buf = []; size = 0;
      }
    }
    /* 末块也补换行：CSV 以 LF 收尾更通用（Excel / pandas / 剪贴板拼接都不吃亏） */
    if (buf.length && !R.fileWrite(buf.join('\n') + '\n')) throw new Error('写入中断');
    toast('已导出：' + R.fileEnd(), 3200);
  } catch (e) {
    try { R.fileAbort(); } catch {}
    toast('导出失败：' + (e?.message || e), 3000);
  }
  return true;
}
/* 二进制分块写（PNG base64）；toDataURL 出来的串按 128KiB 切，切点必然 4 字节对齐 */
function saveB64ToFile(name, mime, b64) {
  const R = window.Ryken;
  const path = R.fileBegin(name, mime);
  if (!path) { toast('导出失败：无法创建文件', 3000); return true; }
  try {
    for (let i = 0; i < b64.length; i += EXPORT_CHUNK) {
      if (!R.fileWriteB64(b64.slice(i, i + EXPORT_CHUNK))) throw new Error('写入中断');
    }
    toast('已导出：' + R.fileEnd(), 3200);
  } catch (e) {
    try { R.fileAbort(); } catch {}
    toast('导出失败：' + (e?.message || e), 3000);
  }
  return true;
}
$('#btnExportPng').addEventListener('click', () => {
  if (!store.size) return toast('暂无数据', 1500);
  let cv;
  try { cv = buildExportCanvas(); }
  catch (e) { return toast('导出失败：' + (e?.message || e), 3000); }
  if (isAndroidApp()) {
    const url = cv.toDataURL('image/png');
    return void saveB64ToFile(`ryken-${fileStamp()}.png`, 'image/png', url.slice(url.indexOf(',') + 1));
  }
  cv.toBlob(b => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `ryken-${Date.now()}.png`; a.click();
    toast('图片已导出');
  });
});

/* ══════════ 导出图片：9:16 竖版 + 表头（Beta20 追加，用户 2026-10-11）══════════
   原来直接导曲线 canvas —— 竖屏下画布 ≈1:1，用户说"看起来不太行"；
   且图上没有任何文字说明，别人拿到不知道哪条线是什么、什么时候测的、什么设备。
   现在输出 **9:16**（逻辑 360×640 × 3 倍 = 1080×1920），并合成：
     表头 = 品牌 + 导出时间 / 图表名 / 设备型号·SN·固件 / 数据范围·点数·当前视图；
     中间 = 曲线本体（含纵坐标刻度+单位、横坐标时间刻度）；
     底部 = 图例（两列：色块 + 代号 + 当前值 + 单位）。
   ⚠ 逻辑尺寸必须贴近手机（≈360 宽）—— 图表刻度字号是固定 px 的，
     直接用 1080 逻辑宽会让字小到看不见；靠 scale 放大才能既保持版式又出高清图。 */
const EXP_W = 360, EXP_H = 640, EXP_SCALE = 3, EXP_HEAD = 80;

function buildExportCanvas() {
  const vis = bigChart.series.filter(s => bigChart._isVis(s));
  const footRows = Math.ceil(vis.length / 2);
  const footH = Math.max(52, 22 + footRows * 20);
  const chartH = EXP_H - EXP_HEAD - footH;

  /* 配色跟当前主题走（浅色主题导出的就是浅色图），文字色取 CSS 变量 */
  const cssv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const bg = cssv('--bg') || '#0e1319';
  const tx = cssv('--tx') || '#e6edf5';
  const tx2 = cssv('--tx-2') || '#9fb0c4';
  const tx3 = cssv('--tx-3') || '#5d6b80';
  const line = cssv('--line') || '#22303f';

  const chartCv = bigChart.renderOffscreen(EXP_W, chartH, EXP_SCALE, bg);

  const out = document.createElement('canvas');
  out.width = EXP_W * EXP_SCALE;
  out.height = EXP_H * EXP_SCALE;
  const c = out.getContext('2d');
  c.setTransform(EXP_SCALE, 0, 0, EXP_SCALE, 0, 0);
  c.fillStyle = bg; c.fillRect(0, 0, EXP_W, EXP_H);

  const P = 12;
  const txt = (str, x, y, o = {}) => {
    const { size = 11, color = tx2, align = 'left', weight = 400, mono = false } = o;
    c.font = `${weight} ${size}px ${mono
      ? 'ui-monospace, SFMono-Regular, Menlo, monospace'
      : '-apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif'}`;
    c.fillStyle = color; c.textAlign = align; c.textBaseline = 'alphabetic';
    c.fillText(str, x, y);
  };
  const hr = (y) => { c.strokeStyle = line; c.lineWidth = 1;
    c.beginPath(); c.moveTo(P, y); c.lineTo(EXP_W - P, y); c.stroke(); };

  /* ── 表头：4 行 ── */
  const d = new Date(), p2 = n => String(n).padStart(2, '0');
  txt('RYKEN', P, 22, { size: 16, color: tx, weight: 700 });
  txt(`导出 ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`,
      EXP_W - P, 20, { size: 10, color: tx3, align: 'right', mono: true });
  txt($('#chartTitle')?.textContent || '实时测试曲线', P, 43, { size: 13, color: tx, weight: 600 });

  const devBits = [];
  const dn = $('#devName')?.textContent?.trim(), ds = $('#devSn')?.textContent?.trim(), df = $('#devVer')?.textContent?.trim();
  if (dn && dn !== '—') devBits.push(dn);
  if (ds && ds !== '—') devBits.push('SN ' + ds);
  if (df && df !== '—') devBits.push('固件 ' + df);
  txt(devBits.length ? devBits.join(' · ') : ($('#connText')?.textContent || '未检测到设备'),
      P, 60, { size: 10, color: tx2 });

  const [ta, tb] = store.timeRange();
  const viewTxt = bigChart.fitAll ? '总览' : bigChart.follow ? '跟随最新' : '自由查看';
  txt(`${fmtTime(ta)} ~ ${fmtTime(tb)} · ${store.size.toLocaleString()} 点 · ${viewTxt}`,
      P, 75, { size: 10, color: tx3, mono: true });
  hr(EXP_HEAD - 6);

  /* ── 曲线本体 ── */
  c.drawImage(chartCv, 0, EXP_HEAD, EXP_W, chartH);

  /* ── 底部图例（两列）──
     数值 3 位小数 + 空格 + 单位：7 位有效数字在 360 宽的图例格子里太挤、也不好看 */
  hr(EXP_H - footH + 4);
  const last = store.row(store.size - 1);
  const colW = (EXP_W - P * 2) / 2;
  vis.forEach((s, i) => {
    const x = P + (i % 2) * colW;
    const y = EXP_H - footH + 24 + ((i / 2) | 0) * 20;
    c.fillStyle = cfg.colors[s.id];
    c.fillRect(x, y - 8, 12, 3);
    txt(s.code, x + 17, y, { size: 10, color: tx3 });
    txt(last[s.id].toFixed(3) + ' ' + s.unit, x + 62, y, { size: 10.5, color: tx, mono: true });
  });
  return out;
}

/* CSV 时间列：**毫秒精度**（HH:MM:SS.mmm）。
   ⚠ 不能复用 chart.js 的 fmtTime —— 它只到 0.1s（给 tooltip / 状态栏用的）。
   设备 ≈166Hz、帧间隔 ~6ms，0.1s 里挤 ~17 帧 → 时间戳成片重复、时序信息全废。
   一加真机实测：6549 行只剩 394 个唯一时间戳（每档 19 行同值）。 */
function csvTime(ms) {
  const t = Math.max(0, Math.round(ms));
  const hh = Math.floor(t / 3600000), mm = Math.floor(t / 60000) % 60, ss = Math.floor(t / 1000) % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(t % 1000).padStart(3, '0')}`;
}
/* ══════════ CSV 列定义：导出与导入的**唯一真实来源**（用户 2026-10-11）══════════
   依据 = 逆向报告记录的真实样例（设备盘 `X3 SE/RKX3SE/X3SE_原装_LDZM.csv`，2.9MB）：
     time,voltage,current,power,cc1,cc2,dPlus,dMinus,temperature,phonePower,charge,energy,ed
     00:00:00.000,6.965500,4.050200,28.211668,3.284000,0.000000,3.021000,3.236000,33,0.000000,0.000113,0.000784,0.0
   ⚠ 三处细节必须照抄，否则 PC 端的解析脚本/Excel 模板会错列：
     1) **13 列**，比手机原来的 12 列多了 `ed`；
     2) `temperature` 是**整数**（样例 `33`，不带小数位），其余数值列 6 位小数；
     3) `time` 为相对时间 HH:MM:SS.mmm（与 csvTime 一致）。
   `ed` 列 PC 端含义未定（样例恒 `0.0`），手机没有该数据源 → 照样例输出 `0.0` 占位。

   out = 内部值 → CSV 文本；in = CSV 文本 → 内部值。
   **导出和导入共用这张表**，所以官方格式以后变了（加列 / 改名 / 改精度）
   只改这里一处，两边同时跟上 —— 不需要维护第二份「导入用映射表」。 */
const CSV_COLS = [
  { csv: 'time',        f: 't',    out: v => csvTime(v),           in: s => parseCsvTime(s) },
  { csv: 'voltage',     f: 'vbus', out: v => v.toFixed(6),         in: s => +s },
  { csv: 'current',     f: 'ibus', out: v => v.toFixed(6),         in: s => +s },
  { csv: 'power',       f: 'pwr',  out: v => v.toFixed(6),         in: s => +s },
  { csv: 'cc1',         f: 'cc1',  out: v => v.toFixed(6),         in: s => +s },
  { csv: 'cc2',         f: 'cc2',  out: v => v.toFixed(6),         in: s => +s },
  { csv: 'dPlus',       f: 'dp',   out: v => v.toFixed(6),         in: s => +s },
  { csv: 'dMinus',      f: 'dm',   out: v => v.toFixed(6),         in: s => +s },
  { csv: 'temperature', f: 'temp', out: v => String(Math.round(v)), in: s => Math.round(+s) },
  { csv: 'phonePower',  f: 'batt', out: v => v.toFixed(6),         in: s => +s },
  { csv: 'charge',      f: 'cap',  out: v => v.toFixed(6),         in: s => +s },
  { csv: 'energy',      f: 'wh',   out: v => v.toFixed(6),         in: s => +s },
  { csv: 'ed',          f: null,   out: () => '0.0',               in: null },   // 手机无此数据源，只占位
];
/* 'HH:MM:SS.mmm' → ms（csvTime 的逆运算，和它必须成对维护） */
function parseCsvTime(s) {
  const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(String(s).trim());
  if (!m) return NaN;
  return (+m[1]) * 3600000 + (+m[2]) * 60000 + Math.round(parseFloat(m[3]) * 1000);
}
function exportCsv() {
  if (!store.size) return toast('没有数据');
  const lines = [CSV_COLS.map(c => c.csv).join(',')];
  const stride = Math.max(1, Math.floor(store.size / 200000));
  for (let i = 0; i < store.size; i += stride) {
    const r = store.row(i);
    lines.push(CSV_COLS.map(c => (c.f ? c.out(r[c.f]) : c.out())).join(','));
  }
  if (isAndroidApp()) return void saveTextToFile(`ryken-${fileStamp()}.csv`, 'text/csv', lines);
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ryken-${Date.now()}.csv`; a.click();
  toast('CSV 已导出');
}
/* ══════════ 导入记录：直接读 PC 上位机导出的 CSV（Beta20 追加，用户 2026-10-11）══════════
   用户要求：「PC 里导出的 CSV 直接就能导入手机上，读它的数据，不用再转译、不用再映射；
   以后官方格式更新了，咱们也跟着更新」。所以这里**按表头列名去 CSV_COLS 里认列**，
   不维护第二份映射表 —— 列顺序换了也能读，认不出的列直接忽略（比如 `ed`）。
   HTML 里 `ed` 那列手机没有对应字段（f:null）→ 读到就跳过，不影响其余列。 */
async function importCsv(file) {
  toast('正在导入…', 60000);                       // 先给反馈（大文件解析会占住主线程）
  await new Promise(r => setTimeout(r, 40));        // 让 toast 先渲染出来
  let text;
  try { text = await file.text(); }
  catch (e) { return toast('读取失败：' + (e?.message || e), 3000); }

  const rows = text.split(/\r?\n/).filter(l => l.trim().length);
  if (rows.length < 2) return toast('文件里没有数据行', 2600);
  const head = rows[0].split(',').map(s => s.trim().replace(/^\ufeff/, ''));  // 去 BOM
  /* 表头 → 列定义；认不出的列留 null */
  const cols = head.map(name => CSV_COLS.find(c => c.csv === name) || null);
  if (!cols.some(c => c && c.f)) return toast('认不出这个 CSV：表头与 PC 上位机格式不符', 3400);
  const use = cols.map((c, i) => (c && c.f) ? { f: c.f, i, cnv: c.in } : null).filter(Boolean);
  if (!use.some(u => u.f === 't')) return toast('缺少 time 列，无法建立时间轴', 3200);

  const parsed = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i].split(',');
    if (cells.length < 2) continue;
    const o = {};
    let bad = false;
    for (const u of use) {
      const v = u.cnv(cells[u.i]);
      if (!isFinite(v)) { bad = true; break; }
      o[u.f] = v;
    }
    if (!bad) parsed.push(o);
  }
  if (!parsed.length) return toast('没有解析出有效数据行', 2600);

  /* 导入 = 打开一段**离线记录**：先停实时记录并清空当前会话，
     否则导入的曲线会和正在采集的数据接在一起（和演示模式隔离同一套道理）。 */
  try { await recorder?.stop(); } catch {}
  setRecording(false);
  clearSessionData({ protocol: true });
  /* ⚠ clearSessionData 里的 resetTimeline() 会把 freezeStore 解除（那是给「清零后继续记录」用的）——
     导入是离线数据，必须再冻上，否则源头的泵会继续往 store 里追加实时帧、把导入的曲线接脏。
     冻结后 source.live 照旧更新，实时读数不受影响。 */
  if (source) source.freezeStore = true;
  const cap = store.capacity;
  for (const o of parsed) store.push(o);            // 超过 capacity 时环形缓冲自动丢最旧的

  bigChart.fitAll = true;                           // 已完成的一段记录 → 直接总览看全部
  switchView('chart');                              // 内部复位 follow + 重绘 + 同步按钮
  const dropped = parsed.length > cap ? `（缓冲区上限 ${cap.toLocaleString()} 点，只保留最新一段）` : '';
  toast(`已导入 ${Math.min(parsed.length, cap).toLocaleString()} 点${dropped}｜离线数据，点「开始记录」会清空`, 4200);
}

$('#btnImport').addEventListener('click', () => {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.csv,text/csv';
  inp.onchange = () => { const f = inp.files?.[0]; if (f) importCsv(f); };
  inp.click();
});

/* ══════════ PD 协议分析仪（2026-10-10 实机解码 · 协议帧格式见 ryken-protocol.js 注释）
   设备把 CC 线上抓到的 PD 报文**自发**流出来（不需要"开启协议监听"命令，只要数据流在跑）。
   本页只负责「收集 + 显示」：开始 = 开始收表；停止 = 冻结表格；清空 = 清空表格。
   字段与官方「PD协议分析仪」逐项对齐（含 PDO/RDO 备注）。 */
/* ⚠ sel 存的是**报文行号 no**（单调递增、永不复用），不是数组下标 ——
   下标会在 pd.rows 超上限 shift() 后整体前移，选中项漂移到后一条报文上，
   表现就是「详情被新报文顶掉、看不住刚点的那条」（Beta20 用户实测）。 */
const pd = { running: false, rows: [], sel: null, scList: null, t0: 0, events: [], seq: 0, stick: true };
const PD_MAX = 400;

function fmtElapsed(ms) {
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
/* 行内短格式 mm:ss.mmm：54px 的耗时列刚好放下（hh:mm:ss.mmm 会被列宽裁掉毫秒） */
function fmtElapsedShort(ms) {
  const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}

function pdEmpty() {
  return '<div class="pd-empty">等待协议报文…<br />插上快充头，让设备完成一次 PD 协商<br />（拔插一次充电头即可触发）</div>';
}
const PD_DETAIL_EMPTY = '<div class="pd-detail-empty">点击上方报文查看解析详情</div>';

function pdRenderEvents() {
  const el = $('#pdEvents');
  if (!el) return;
  if (!pd.events.length) { el.textContent = ''; el.classList.remove('on'); return; }
  el.textContent = '检测到：' + pd.events.slice(-3).map(e => e.text).join(' · ');
  el.classList.add('on');
}

/* ══════════ 协议页渲染（Beta20 重构，用户 2026-10-11）══════════
   三条约束，都是从「看不住刚点的那条报文」这个现象反推出来的：
   1) **选中项用行号 no**（见 pd.sel 注释），不用数组下标；
   2) 新报文**增量追加 DOM**，不再整表 innerHTML 重建 —— 重建会打断列表
      惯性滚动、也会让触摸点选落空（报文密集时每 50ms 一次）；
   3) 用户点开详情后**暂停自动跟随**（pd.stick=false），否则新报文把列表
      一次次滚到底、正在看的报文被挤出可视区；手动滚回底部即恢复跟随。 */
function pdViewRows() { return pd.rows.filter(r => !(cfg.pdMask && r.msg === 'GoodCRC')); }

function pdRowHtml(r) {
  return `<div class="pd-item${r.no === pd.sel ? ' sel' : ''}" data-no="${r.no}">
      <span class="no">${r.no}</span>
      <span class="sop">${r.sop}</span>
      <span class="msg">${r.msg}</span>
      <span class="id">${r.id}</span>
      <span class="dir ${r.dir ? 'src' : 'snk'}">${r.dir ? 'SRC→SNK' : 'SNK→SRC'}</span>
      <span class="el">${fmtElapsedShort(r.el)}</span>
      <span class="vi">${r.vbus == null ? '—' : r.vbus.toFixed(3) + 'V ' + r.ibus.toFixed(3) + 'A'}</span>
    </div>`;
}
const pdIsEmptyNode = () => !!$('#pdList')?.firstElementChild?.classList.contains('pd-empty');
function pdScrollIfStick() { const l = $('#pdList'); if (pd.stick && l) l.scrollTop = l.scrollHeight; }

/* 全量重绘：清空、屏蔽开关切换、启动回填时用 */
function pdRender() {
  const list = $('#pdList');
  if (!list) return;
  const rows = pdViewRows();
  $('#pdCount').textContent = String(rows.length);
  if (!rows.length) { list.innerHTML = pdEmpty(); pd.sel = null; pdDetailEmpty(); return; }
  list.innerHTML = rows.map(pdRowHtml).join('');
  pdScrollIfStick();
  pdShowDetail();
}
/* 新增一条报文：只追加一个节点（不重建整表，滚动/点选不被打断） */
function pdAppendDom(r) {
  const list = $('#pdList');
  if (!list) return;
  if (pdIsEmptyNode()) list.innerHTML = '';
  list.insertAdjacentHTML('beforeend', pdRowHtml(r));
  $('#pdCount').textContent = String(pdViewRows().length);
  pdScrollIfStick();
  if (r.no === pd.sel) pdShowDetail();
}
/* rows 超上限被 shift 掉一条：同步摘掉列表首行（被屏蔽的行不在 DOM 里，别误摘） */
function pdDropDom(out) {
  if (!(cfg.pdMask && out.msg === 'GoodCRC')) $('#pdList')?.firstElementChild?.remove();
  if (pd.sel === out.no) { pd.sel = null; pdShowDetail(); }
  const c = $('#pdCount'); if (c) c.textContent = String(pdViewRows().length);
}
/* 把某一行滚进可视区（用矩形差算，不用 scrollIntoView —— 那会连带滚整个 .views） */
function pdEnsureVisible(no) {
  const l = $('#pdList'), el = $(`#pdList .pd-item[data-no="${no}"]`);
  if (!l || !el) return;
  const lr = l.getBoundingClientRect(), er = el.getBoundingClientRect();
  if (er.top < lr.top) l.scrollTop += er.top - lr.top;
  else if (er.bottom > lr.bottom) l.scrollTop += er.bottom - lr.bottom;
}
function pdMarkSel() {
  $$('#pdList .pd-item').forEach(el => el.classList.toggle('sel', +el.dataset.no === pd.sel));
  if (pd.sel != null) pdEnsureVisible(pd.sel);
  pdShowDetail();
}
function pdDetailEmpty() { const el = $('#pdDetail'); if (el) el.innerHTML = PD_DETAIL_EMPTY; }
/* 详情内容只由「选中的那一行」决定，新报文不会改它（除非它被挤出 400 条窗口） */
function pdShowDetail() {
  const r = pd.sel == null ? null : pd.rows.find(x => x.no === pd.sel);
  if (!r) pdDetailEmpty(); else pdDetail(r);
}
/* 清空协议页（清空按钮 / 进出演示模式时统一走这里） */
function pdReset() {
  resetProtoState();                       // 清掉上一场会话的 Source_Capabilities 缓存，防跨会话串注释
  pd.rows = []; pd.sel = null; pd.scList = null; pd.events = []; pd.seq = 0; pd.stick = true;
  const list = $('#pdList');
  if (list) list.innerHTML = pdEmpty();
  pdDetailEmpty();
  const c = $('#pdCount'); if (c) c.textContent = '0';
  pdRenderEvents();
}

function pdDetail(r) {
  $('#pdDetail').innerHTML = `
    <h4>#${r.no} ${r.msg}</h4>
    <dl class="pd-kv">
      <dt>SOP</dt><dd>${r.sop}（帧类型 0x${r.type.toString(16).toUpperCase()}）</dd>
      <dt>报文</dt><dd>type=${r.msgType} · ${r.obj} 对象 · Rev V${r.rev} · ID ${r.id}</dd>
      <dt>方向</dt><dd>${r.dir ? 'SRC → SNK' : 'SNK → SRC'}</dd>
      <dt>耗时</dt><dd>${fmtElapsed(r.el)}</dd>
      <dt>VBUS/IBUS</dt><dd>${r.vbus == null ? '—' : r.vbus.toFixed(4) + ' V / ' + r.ibus.toFixed(4) + ' A'}</dd>
      <dt>数据</dt><dd>${r.dataHex}</dd>
    </dl>
    ${r.notes && r.notes.length ? `<div class="pd-pdo">${r.notes.join('<br>')}</div>` : ''}`;
}

/** 收到协议帧（transport.js 回调）：文本事件进提示条，PD 报文进表 */
function pdFeed(pf) {
  if (pf.kind === 'text') {
    pd.events.push({ text: pf.text });
    if (pd.events.length > 50) pd.events = pd.events.slice(-50);   // 上限防挂机无限增长（只显示最后 3 条）
    pdRenderEvents();
    return;
  }
  if (!pd.running && !(source && source.demo)) return;   // 「停止」后不再收表（与官方一致）；演示模式免门（自动收）
  const live = (source && source.live) || (store.size ? store.row(store.size - 1) : null);
  /* no 走独立计数器：原来用 rows.length+1，超上限 shift() 后行号会重复 */
  const row = { ...pf, no: ++pd.seq, el: pd.t0 ? Date.now() - pd.t0 : 0,
                vbus: live ? live.vbus : null, ibus: live ? live.ibus : null };
  pd.rows.push(row);
  if (pd.rows.length > PD_MAX) pdDropDom(pd.rows.shift());
  if (!(cfg.pdMask && row.msg === 'GoodCRC')) pdAppendDom(row);
}

function pdSetRun(on) {
  pd.running = on;
  $('#btnPdText').textContent = on ? '停止' : '开始';
  $('#btnPdRun').classList.toggle('primary', !on);
  if (on) { pd.t0 = Date.now(); pd.stick = true; }   // 重新开始收表 = 回到跟随最新
  /* 关键：只有给设备发"开闸"命令，它才会往主机上报 PD 报文（0x0C/0x10/0x20/0x28）
     与文本事件（0x0B）。命令是 2026-10-10 从官方上位机「开始」抓包得到的：
     AA 07 03 01 00 65 49（见 RykenUsb.protoListen）。 */
  try { window.Ryken?.protoListen?.(on, 0); } catch {}
  toast(on ? '开始接收协议报文' : '已停止（表格冻结）');
}

$('#btnPdRun').addEventListener('click', () => pdSetRun(!pd.running));
$('#btnPdClear').addEventListener('click', () => { pdReset(); toast('已清空'); });
$('#pdList').addEventListener('click', e => {
  const it = e.target.closest('.pd-item');
  if (!it) return;
  pd.sel = +it.dataset.no;
  pd.stick = false;          // 用户开始看某一条 → 停止自动跟随，别把正在看的顶走
  pdMarkSel();
});
/* 手动滑回底部 = 恢复自动跟随（只有用户点开详情后才有「恢复」这一说） */
$('#pdList').addEventListener('scroll', () => {
  const l = $('#pdList');
  if (l && l.scrollHeight - l.scrollTop - l.clientHeight < 24) pd.stick = true;
}, { passive: true });
$('#pdMask').addEventListener('change', e => {
  cfg.pdMask = e.target.checked; save();
  pdRender();
  toast(e.target.checked ? '已屏蔽 GoodCRC' : '显示全部报文');
});

/* ══════════ 固件 ══════════
   版本量纲（2026-10-12 统一）：可比较数值 = 主×10000 + 次×100 + 构建号。
   V2.00 → 20000，V1.22-3 → 12203，V1.21-1 → 12101 —— 构建号必须参与比较，
   否则 V1.22-1 和 V1.22-3 分不开（官网标题/社区盘文件名都带 -N 构建号）。
   设备 INFO 帧只报 V2.00 级别（无构建号，构建按 0），与固件内容探测同一量纲。 */
function verVal(maj, min, b) { return maj * 10000 + min * 100 + (b || 0); }
function fmtVer(v) {
  if (v == null) return '—';
  const b = v % 100, min = Math.floor(v / 100) % 100, maj = Math.floor(v / 10000);
  return 'V' + maj + '.' + String(min).padStart(2, '0') + (b ? '-' + b : '');
}
function fwVerNum(s) {
  const m = /(\d{1,2})\.(\d{1,2})(?:-(\d{1,3}))?/.exec(String(s || ''));
  return m ? verVal(+m[1], +m[2], m[3] ? +m[3] : 0) : null;
}
let fwLocalName = '';
/* 刷写要的是文件内容，不只是名字 —— 原来这里只存了 name，点了「立即升级」没有料可用 */
let fwLocalFile = null;
/* ★ 选完固件**立刻**把字节读进内存（2026-10-12 踩坑修正）。
   原因：Android WebView 里 <input type=file> 给的 File 对象，其底层 content URI 的
   读权限只在当前前台期间有效 —— 一旦因为弹 SAF 授权把 App 切到后台，
   回来再调 file.arrayBuffer() 就会失败（用户看到的现象正是"授权后点升级，
   提示读取本地固件失败"）。固件才 500 多 KB，直接缓存成字节数组最省事。 */
let fwLocalBytes = null;

/* 从固件文件里提取版本号。
   ① 文件名优先（官方有时命名成 RKX3V2.00.bin）；
   ② 文件名没有就翻文件内容 —— 实测固件里含 "FW:    V2.00.0.000.10.20.30.PE1"，
      严格模式 V\d{1,2}\.\d{2} 在整包 552,720 B 里**只命中这一处**（2026-10-12 验证），
      和设备 INFO 帧报回来的 0xC8(=200 → V2.00) 完全对应，可以放心用。 */
async function fwDetectVersion(bytes, name) {
  const byName = fwVerNum(name);
  if (byName != null) return { ver: byName, src: '文件名' };
  try {
    const buf = bytes || new Uint8Array(0);
    let s = '';
    const STEP = 0x8000;
    for (let i = 0; i < buf.length; i += STEP)
      s += String.fromCharCode.apply(null, buf.subarray(i, i + STEP));
    const m = /V(\d{1,2})\.(\d{2})/.exec(s);
    if (m) return { ver: verVal(+m[1], +m[2], 0), src: '文件内容' };
  } catch (e) {
    appLog('固件版本检测失败: ' + (e && e.message));
  }
  return { ver: null, src: '' };
}

/* 检查 U 盘刷写环境。返回 {mount, auth} 两段文字，页面分两行显示 ——
   mount = 挂载情况，auth = 授权情况。
   ⚠ 只讲 U 盘本身的事，**不掺固件号 / SN** —— 那是设备当前状态，
   混进"本地固件"这一行会让人分不清说的是文件还是设备（用户 2026-10-12 要求）。
   ⚠ 这一步必须放在「选择固件」阶段做，不能留到「立即升级」——
   请求 SAF 授权会把 App 切到后台，WebView 被回收重载后 File 对象就没了。 */
function fwCheckIapEnv() {
  const R = window.Ryken;
  if (!R || !R.iapVolumes) return { mount: '浏览器环境，不支持直接刷写', auth: '' };
  let vs = [];
  try { vs = JSON.parse(R.iapVolumes() || '[]'); } catch (e) {}
  const devs = vs.filter(x => x.removable && !x.emulated);
  if (!devs.length) {
    return { mount: 'U 盘：未检测到', auth: '请按住测试仪「返回」键再插线' };
  }
  const names = devs.map(x => x.label || x.uuid).join(' / ');
  const authed = R.iapFolder() && iapFolderIsDevice();
  const hint = devs.length > 1
    ? '（手机上挂着多块 U 盘，认准根目录有 Ready.TXT 的那块）'
    : '';
  return authed
    ? { mount: 'U 盘：已挂载 ' + names, auth: '授权：已就绪，可直接升级' + (hint ? ' ' + hint : '') }
    : { mount: 'U 盘：已挂载 ' + names, auth: '授权：未申请 —— 点「立即升级」时选中「USB设备」' + (hint ? ' ' + hint : '') };
}

/* 刷新「本地固件」行的第 2/3 行（U 盘挂载 / 授权说明），第 1 行（固件信息）原样保留。
   用户 2026-10-12 的要求：**固件页一打开就检测**（不管有没有选固件），
   **授权回来后立刻更新** —— 原来只在选固件时查一次，授权回来那两行还停在"未授权"，
   让人以为授权没生效。
   触发点：① 切到固件页时 ② SAF 授权回来时（__ryken_iap）③ 选完固件时。 */
function fwRefreshEnv() {
  const el = $('#fwFile');
  if (!el) return;
  const env = fwCheckIapEnv();
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const spans = el.querySelectorAll(':scope > span');
  const l1 = spans[0] ? spans[0].outerHTML : '<span>未选择固件</span>';
  el.innerHTML = l1 + `<span>${esc(env.mount)}</span>` + (env.auth ? `<span>${esc(env.auth)}</span>` : '');
}

/* 自定义确认对话框（用户 2026-10-12：原生 confirm 太丑，要 UI 风格一致）。
   样式见 app.css 的 .fw-confirm-*，追加在文件末尾（避开 @media 块）。 */
function fwConfirm(title, text, okLabel) {
  return new Promise(resolve => {
    const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const mask = document.createElement('div');
    mask.className = 'fw-confirm-mask';
    mask.innerHTML = `<div class="fw-confirm"><h4>${esc(title)}</h4><p>${esc(text)}</p>` +
      `<div class="btns"><button class="btn ghost" data-r="0">取消</button>` +
      `<button class="btn primary" data-r="1">${esc(okLabel || '确认')}</button></div></div>`;
    document.body.appendChild(mask);
    const done = r => { mask.remove(); resolve(r); };
    mask.querySelector('[data-r="0"]').onclick = () => done(0);
    mask.querySelector('[data-r="1"]').onclick = () => done(1);
  });
}

$('#btnPickFw').addEventListener('click', () => {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.bin,.hex,.rkf,.img';
  inp.onchange = async () => {
    const f = inp.files[0];
    if (!f) return;
    fwLocalFile = f;
    fwLocalName = f.name;
    const kb = (f.size / 1024).toFixed(0);
    $('#fwFile').textContent = `${f.name}（${kb} KB） · 正在识别版本…`;
    $('#btnUpgrade').disabled = false;

    // ★ 先把内容读进内存：切后台后 File 就读不出来了（见 fwLocalBytes 的注释）
    fwLocalBytes = null;
    try {
      fwLocalBytes = new Uint8Array(await f.arrayBuffer());
    } catch (e) {
      appLog('固件内容读取失败: ' + (e && e.message));
      $('#fwFile').textContent = `${f.name}（${kb} KB） · ⚠ 无法读取文件内容，请重新选择`;
      toast('读取固件失败，请重新选择（若反复失败，先把文件复制到手机内部存储再选）', 5000);
      return;
    }

    const det = await fwDetectVersion(fwLocalBytes, f.name);
    const cur = fwVerNum($('#fwCur').textContent);
    const env = fwCheckIapEnv();
    const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

    // 第 1 行：固件信息（文件名 + 大小 + 版本）
    // 文案从简：不写"来自文件内容"（本地固件当然是本地的）、不写"与当前相同"
    //（相同是常态，没必要占字）；只有和当前版本不一致时才提示差异。
    let l1 = `${esc(f.name)}（${kb} KB）`;
    if (det.ver != null) {
      l1 += ` · 版本 ${fmtVer(det.ver)}`;
      if (cur != null) {
        if (det.ver > cur) l1 += ' 比当前新 ✓';
        else if (det.ver < cur) l1 += ` ⚠ 低于当前 ${fmtVer(cur)}`;
      }
    } else {
      l1 += ' · 未识别到版本号（不影响刷写）';
    }
    // 第 2 行：U 盘挂载　第 3 行：授权说明
    $('#fwFile').innerHTML =
      `<span>${l1}</span><span>${esc(env.mount)}</span>` +
      (env.auth ? `<span>${esc(env.auth)}</span>` : '');

    appLog('选中固件: ' + f.name + ' 版本=' +
      (det.ver == null ? '未识别' : fmtVer(det.ver) + '(' + det.src + ')') +
      ' | ' + env.mount + ' | ' + env.auth);
  };
  inp.click();
});

/* 原生异步抓取（审核 3.2 修复）：同步 fetchText 会把 JS 线程卡到 16s（曲线停跳、按钮无响应），
   fetchTextAsync 立即返回、HTTP 在原生后台线程跑，结果经 __rykenFetchText(id, txt) 回传。 */
let _fetchSeq = 0;
const _fetchCbs = new Map();
window.__rykenFetchText = function (id, txt) {
  const c = _fetchCbs.get(id);
  if (!c) return;
  _fetchCbs.delete(id);
  clearTimeout(c.timer);
  c.resolve(txt);
};
function nativeFetchText(url) {
  return new Promise((resolve, reject) => {
    const id = ++_fetchSeq;
    const timer = setTimeout(() => {          // 兜底：原生 8s+8s 之外再留余量
      _fetchCbs.delete(id);
      reject(new Error('超时（20s）'));
    }, 20000);
    _fetchCbs.set(id, { resolve, reject, timer });
    try { window.Ryken.fetchTextAsync(url, id); }
    catch (e) { _fetchCbs.delete(id); clearTimeout(timer); reject(e); }
  });
}
/* 永硕云盘列表：原生 ysListAsync 走 JWT 会话（分享页 JS 渲染，fetchText 拿不到内容），
   回传与 fetchText 同通道（__rykenFetchText），文本 = 全部目录名+文件名（含版本号）。 */
function nativeYsList(url) {
  return new Promise((resolve, reject) => {
    const id = ++_fetchSeq;
    const timer = setTimeout(() => {
      _fetchCbs.delete(id);
      reject(new Error('超时（45s）'));          // 永硕要串 20+ 个目录请求，给足余量
    }, 45000);
    _fetchCbs.set(id, { resolve, reject, timer });
    try { window.Ryken.ysListAsync(url, id); }
    catch (e) { _fetchCbs.delete(id); clearTimeout(timer); reject(e); }
  });
}

/* 检查更新：真实请求。原生桥 fetchTextAsync 走 Kotlin HTTP（无 CORS 限制，异步不冻屏），
   浏览器环境回落 fetch。更新源可以是任意页面/文本，只要文本里含版本号（如 V2.00）。 */
let fwJumpUrl = '';                       // 「最新版本」点击跳转地址（每次检查成功后更新）
$('#fwNew').addEventListener('click', () => {
  if (!fwJumpUrl) return;
  if (window.Ryken && window.Ryken.openExternal) { try { window.Ryken.openExternal(fwJumpUrl); } catch (e) {} }
  else window.open(fwJumpUrl, '_blank');  // 浏览器环境
});

$('#btnCheckFw').addEventListener('click', async () => {
  /* 未连接真机就拒绝检查（用户 2026-10-12 定稿）：查哪个机型、和本地哪个版本比，
     两个前提都依赖当前连接的设备 —— 没连就是空转。演示模式除外（有虚拟设备）。 */
  if (source instanceof AndroidSource && !source.demo) {
    const stConn = source.status();
    if (!stConn.connected) {
      fwJumpUrl = ''; $('#fwNew').classList.remove('jump');
      $('#fwNew').textContent = '未连接设备';
      toast('未连接功率表 —— 检查更新只针对当前连接的机型', 2600);
      return;
    }
  }
  const mode = cfg.updateSrc || 'official';
  const url = (mode === 'official' ? OFFICIAL_FW_URL : mode === 'ys' ? YS_FW_URL : (cfg.updateUrl || '').trim());
  if (!url) { $('#fwNew').textContent = '未配置更新源'; toast('自定义源请先填写 URL', 2600); return; }
  fwJumpUrl = ''; $('#fwNew').classList.remove('jump');
  $('#fwNew').textContent = '检查中…';
  try {
    let txt;
    const isYs = /^https?:\/\/[^/]*(ys168\.com|ysepan\.com)([:/]|$)/i.test(url);
    if (window.Ryken && window.Ryken.ysListAsync && isYs) {
      /* 永硕云盘：分享页是 JS 渲染的 SPA，fetchText 只能拿到空壳 ——
         原生走 JWT 会话列全部分类+文件名（文件名自带版本号 RKX3V2.00.rar） */
      txt = await nativeYsList(url);
      if (txt.startsWith('YS_ERROR')) throw new Error(txt.slice(9));
    } else if (window.Ryken && window.Ryken.fetchTextAsync) {
      txt = await nativeFetchText(url);
    } else {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
      clearTimeout(to);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      txt = await r.text();
    }
    if (txt.startsWith('HTTP_ERROR')) throw new Error(txt.slice(11));
    if (txt.startsWith('FETCH_ERROR')) throw new Error(txt.slice(12));
    /* 剥掉 HTML 标签再匹配：官网的「固件下载(V1.22-3)」标题被 span 拆成
       "固件</span><span>下 载(...)" —— 不剥标签版本号永远连不起来（beta22 实测踩坑） */
    txt = txt.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
             .replace(/<[^>]*>/g, '');
    /* 防呆：latest.json 是 PC 上位机（Tauri）自更新清单 —— version 是 PC 软件版本号，
       与固件版本无关（抓包实锤：云端 0.4.1，而 RK-X3 固件已 V2.00）。指到它就明说。 */
    if (/"pub_date"\s*:/.test(txt) && /"signature"\s*:/.test(txt)) {
      let pc = (txt.match(/"version"\s*:\s*"([^"]+)"/) || [])[1] || '?';
      throw new Error(`这是 PC 上位机的更新清单（软件版本 ${pc}），不是固件版本 —— 请改用官方源`);
    }
    /* 机型→版本族提取。官方页混多条产品线，旧逻辑「取全文最大」会把 U1（SE 出厂固件）
       的 V1.10 错当成 RK-X3 的最新版（官方 RKX3 主固件其实停在 V1.02，V2.00 在第三方渠道）。
       按连接设备的型号选族：productName 含 SE → SE 族（U1固件），否则 X3 族（RKX3V*）。
       第三方「版本.txt」按行写「型号 版本」，如 RK-X3 V2.00 / RK-X3SE V1.10。 */
    const stS = (source && typeof source.status === 'function') ? source.status() : {};
    const family = modelFamily((stS.device || {}).productName, stS.fwVersion);
    const best = pickFwVersion(txt, family);
    if (!best) throw new Error(`页面里没有 ${family === 'SE' ? 'X3 SE' : 'RK-X3'} 的版本号`);
    const famName = best.fam === 'SE' ? 'X3 SE' : 'RK-X3';
    /* 跳转地址：官方源 → 官网下载页；永硕源 → 对应机型最新固件直链（点击直接下载 .rar）；
       自定义 → 用户填的源本身。没有直链时永硕回落分享页。 */
    fwJumpUrl = mode === 'official' ? OFFICIAL_FW_URL
      : mode === 'ys' ? (fwFileUrl(txt, best.fam, best.v) || YS_FW_URL)
      : url;
    $('#fwNew').classList.add('jump');
    $('#fwNew').textContent = `${fmtVer(best.v)}·${famName}`;
    const cur = fwVerNum($('#fwCur').textContent);
    if (cur != null && best.v > cur) {
      $('#btnUpgrade').disabled = false;
      toast(`发现新版本 ${fmtVer(best.v)}（${famName}）`);
    } else {
      $('#fwNew').textContent = `${fmtVer(best.v)}·${famName}（已是最新）`;
      toast('当前固件已是最新');
    }
  } catch (e) {
    $('#fwNew').textContent = '检查失败';
    toast('检查失败：' + (e.name === 'AbortError' ? '超时' : e.message), 3000);
  }
});

/* ══════════ 上位机自身的更新检查（用户 2026-10-13）══════════
   源 = 仓库的 Releases 地址。取文本走和固件检查**同一条通路**：原生桥 fetchTextAsync
   （Kotlin HTTP，无 CORS 限制、异步不冻屏），浏览器环境回落 fetch。
   ⚠ 别直接抓 Releases 页的 HTML —— 那个页面是 JS 渲染的，拿到的是空壳；
     改抓**同域的 releases.atom**（静态 XML 订阅源），第一个 <entry><title> 就是最新 tag。 */
const APP_REPO_URL = 'https://github.com/Biu-Bong/Ryken-Mobile';
const APP_RELEASES_URL = APP_REPO_URL + '/releases';
let appJumpUrl = '';                      // 「最新版本」点击跳转地址（检查成功后填）

/** 版本串 → 数字数组：'v1.2.3' → [1,2,3]；解析不出返回 null */
function verParts(s) {
  const m = String(s || '').match(/(\d+(?:\.\d+)*)/);
  return m ? m[1].split('.').map(Number) : null;
}
/** a > b 返回 1，a < b 返回 -1，相等/无法比较返回 0 */
function verCmp(a, b) {
  const A = verParts(a), B = verParts(b);
  if (!A || !B) return 0;
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const d = (A[i] || 0) - (B[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

$('#appNew')?.addEventListener('click', () => {
  if (!appJumpUrl) return;
  if (window.Ryken && window.Ryken.openExternal) { try { window.Ryken.openExternal(appJumpUrl); } catch (e) {} }
  else window.open(appJumpUrl, '_blank');
});

$('#btnAppUpdate')?.addEventListener('click', async () => {
  const out = $('#appNew');
  if (!out) return;
  appJumpUrl = ''; out.classList.remove('jump');
  out.textContent = '检查中…';
  try {
    const url = APP_RELEASES_URL + '.atom';
    let txt;
    if (window.Ryken && window.Ryken.fetchTextAsync) {
      txt = await nativeFetchText(url);
    } else {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
      clearTimeout(to);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      txt = await r.text();
    }
    if (txt.startsWith('HTTP_ERROR')) throw new Error(txt.slice(11));
    if (txt.startsWith('FETCH_ERROR')) throw new Error(txt.slice(12));
    /* 仓库还没发过 Release：atom 里没有 <entry> —— 明说，别报"检查失败"让人以为网络坏了 */
    if (!/<entry[\s>]/.test(txt)) {
      appJumpUrl = APP_RELEASES_URL; out.classList.add('jump');
      out.textContent = '暂无 Release';
      toast('仓库还没有发布 Release');
      return;
    }
    const first = txt.split(/<entry[\s>]/)[1] || '';
    /* 优先取 /releases/tag/<tag> —— tag 才是版本号；<title> 是 release 的展示标题，
       有人会写成「Ryken Mobile v1.0.0」甚至带上日期，抠数字容易抓错。 */
    const tag = (first.match(/\/releases\/tag\/([^"'<\s]+)/) || [])[1]
             || (first.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1];
    if (!tag) throw new Error('订阅源里没有版本号');
    const cur = ($('#appVer')?.textContent || '').trim();
    if (verCmp(tag, cur) > 0) {
      appJumpUrl = APP_RELEASES_URL; out.classList.add('jump');
      out.textContent = `${tag} ↓`;
      toast(`发现新版本 ${tag}（当前 ${cur || '?'}）`, 3200);
    } else {
      out.textContent = `${tag}（已是最新）`;
      toast('上位机已是最新版本');
    }
  } catch (e) {
    /* 失败也让它能点进 Releases 页手动看 —— 总比卡在"检查失败"好 */
    appJumpUrl = APP_RELEASES_URL; out.classList.add('jump');
    out.textContent = '检查失败';
    toast('检查失败：' + (e.name === 'AbortError' ? '超时' : e.message), 3000);
  }
});

/* 型号 → 版本族：产品名含 SE 即 SE 族。⚠ X3 SE 的 USB 描述符 productName=null（固件没写），
   这时用固件版本段判：U1 固件（SE 专属）占 1.01–1.19 段，X3 主固件是 1.02/1.20+/2.00
   （1.02 两边都有历史版本，归 X3）。未连接/版本未知 → X3。 */
function modelFamily(name, fwVer) {
  const n = (name || '').toUpperCase().replace(/[\s_-]/g, '');
  if (n.includes('SE')) return 'SE';
  const v = fwVerNum(fwVer);
  if (v != null) {
    const maj = Math.floor(v / 10000), min = Math.floor(v / 100) % 100;
    if (maj === 1 && min >= 1 && min <= 19 && min !== 2) return 'SE';
  }
  return 'X3';
}
/* 版本匹配模式（单一来源，pickFwVersion / fwVerOf 共用）。构建号 -N 一并捕获。
   四类来源：官网文件名（RKX3V1.02-6.zip）、**官网下载区标题（固件下载(V1.22-3)）**、
   官网正文（出厂默认U1固件（V1.10））、永硕盘文件名/行式 txt（RK-X3 V2.00）。
   ★ 官网那个 RKX3V1.02-6.zip 是没人清的老链接，真正的官方最新版在下载区标题里
   （2026-10-12 实证：标题 V1.22-3 与社区盘内测 RKX3V1.22-3.rar 完全对应）。
   栏目里旧标题「固件下载(V1.2-3)」同模式但数值更小，取最大自然淘汰。 */
const FW_PATS = [
  // RKX3V1.02-6.zip / RKX3 主固件（V2.00）—— 上下文含 SE 时归 SE 族（防"RKX3 SE 固件（V…"）
  { re: /RKX3([^0-9V]{0,8})V?(\d{1,2})\.(\d{1,2})(?:-(\d{1,3}))?/g,
    fam: mm => (/SE/i.test(mm[1]) ? 'SE' : 'X3'), g: 2, b: 4 },
  // 官网下载区标题：固件下 载(V1.22-3)（letter-spacing 可能把"下载"拆开，\s* 兜住）
  { re: /固件下\s*载[（(]\s*V?(\d{1,2})\.(\d{1,2})(?:-(\d{1,3}))?[）)]/g,
    fam: () => 'X3', g: 1, b: 3 },
  // SE 出厂：出厂默认U1固件（V1.10）
  { re: /U1固件[（(]\s*V?(\d{1,2})\.(\d{1,2})(?:-(\d{1,3}))?[）)]/g,
    fam: () => 'SE', g: 1, b: 3 },
  // SE 专属：RKX3SE_U1V1.10.rar（社区盘 SE 固件命名，带 "_U1V" 前缀，通用模式卡在形状外）
  { re: /RKX3SE[^0-9]{0,4}U1V?(\d{1,2})\.(\d{1,2})(?:-(\d{1,3}))?/gi,
    fam: () => 'SE', g: 1, b: 3 },
  // 第三方行式：RK-X3 V2.00 / RK-X3SE V1.10 / X3 SE 2.00
  { re: /RK-?X3[ \-]?(SE)?[ \-]*[：:]?\s*V?(\d{1,2})\.(\d{1,2})(?:-(\d{1,3}))?/gi,
    fam: mm => (mm[1] ? 'SE' : 'X3'), g: 2, b: 4 },
];
/** 单个字符串（文件名/标题/行）里的最大版本 → { v, fam } 或 null */
function fwVerOf(s) {
  let best = null;
  let m;
  for (const p of FW_PATS) {
    p.re.lastIndex = 0;
    while ((m = p.re.exec(s))) {
      const v = verVal(+m[p.g], +m[p.g + 1], p.b && m[p.b] ? +m[p.b] : 0);
      const fam = p.fam(m);
      if (v > 0 && (!best || v > best.v)) best = { v, fam };
    }
  }
  return best;
}
/* 从页面文本里挑指定机型的最大固件版本。返回 { v, fam } 或 null。
   txt 行格式：目录名/文件名单独成行；永硕源的文件行是「文件名\t直链」。 */
function pickFwVersion(txt, family) {
  let best = null;
  for (const line of txt.split('\n')) {
    const hit = fwVerOf(line);
    if (!hit) continue;
    if (family && hit.fam !== family) continue;
    if (!best || hit.v > best.v) best = hit;
  }
  return best;
}
/* 永硕源专用：找到版本等于 best.v 的那一行文件，取它的直链（「最新版本」点击跳转用） */
function fwFileUrl(txt, family, bestV) {
  for (const line of txt.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const hit = fwVerOf(line.slice(0, tab));
    if (hit && hit.v === bestV && (!family || hit.fam === family)) return line.slice(tab + 1).trim();
  }
  return '';
}
/* 更新源模式切换：官方/永硕 = 内置地址（输入框只读展示）；自定义 = 用户可编辑 */
const FW_SRC_URLS = { official: OFFICIAL_FW_URL, ys: YS_FW_URL };
$$('#fwSrcSeg .seg').forEach(b => b.addEventListener('click', () => {
  $$('#fwSrcSeg .seg').forEach(x => x.classList.toggle('is-active', x === b));
  cfg.updateSrc = b.dataset.val;
  const inp = $('#fwUrl');
  if (FW_SRC_URLS[cfg.updateSrc]) { inp.value = FW_SRC_URLS[cfg.updateSrc]; inp.readOnly = true; }
  else { inp.value = cfg.updateUrl || ''; inp.readOnly = false; inp.focus(); }
  save();
}));
$('#fwUrl').addEventListener('change', e => {
  if (cfg.updateSrc === 'custom') { cfg.updateUrl = e.target.value.trim(); save(); }
});

/* ══════════ 固件刷写（2026-10-12 打通）══════════
   设备端流程（已在 K20 Pro / Android 13 与 Windows 上各验证过一遍）：
     按住测试仪「返回」键 → 插线 → 设备枚举为大容量存储（VID 2409 / PID 0926）
     → Android vold 自动挂载 RKX3IAP 卷（8.35MB FAT，文件管理器里显示为「USB设备」）
     → 往该卷根目录写 RKX3.bin → 文件名 Ready.TXT 变 Success.TXT
     → 设备自动脱开 U 盘、重枚举回 HID（不用手动拔插）

   ⚠ 一个绕不过的前提：进 IAP 只能靠硬件按键。固件里没有任何"用命令进 IAP"的通路
     （命令表已完整枚举：AA 的 CMD 0..6 + 55 帧 + A5 三路，CMD>6 只认 0xFF），
     进 IAP 的判定条件就是 GPIOB bit2 被按住。所以这一步必须由人完成。

   写入分块：固件 552,720 B，一次性跨 JNI 传 base64 会把 WebView 卡死；
   每块 96 KiB，且长度必须 4 字节对齐（Base64.decode 的要求）。

   为什么必须先查 Ready.TXT：它是"设备真的处于 U 盘模式"的唯一可靠标志，
   没有它说明卷还没挂上，硬写会把文件丢到错误的地方。 */
let iapPickResolve = null;

/* 原生 SAF 授权回调（MainActivity.onActivityResult 里 evaluateJavascript 触发） */
window.__ryken_iap = function (uri) {
  fwRefreshEnv();          // ★ 授权回来立刻刷新 U 盘挂载/授权两行（用户 2026-10-12 要求）
  const cb = iapPickResolve; iapPickResolve = null;
  if (cb) cb(uri || '');
};

function iapPickFolder() {
  return new Promise(resolve => {
    if (!(window.Ryken && window.Ryken.iapPickFolder)) { resolve(''); return; }
    iapPickResolve = resolve;
    let ok = false;
    /* 把「上次成功授权的卷 uuid」传给原生：SAF 会用 EXTRA_INITIAL_URI 直接定位到那个卷。
       一加实测踩坑：手机上挂两块 U 盘时，createOpenDocumentTreeIntent() 会定位到
       storageVolumes 里的**第一个** removable 卷 —— 可能是另一块 U 盘（B8FB-9237），
       用户在 SAF 里根本不知道该换到哪个，选错就被 Ready.TXT 校验打回。
       记住上次选对的卷，第二次起直接跳到位。 */
    try { ok = window.Ryken.iapPickFolder(localStorage.getItem('iapUuid') || ''); } catch (e) { ok = false; }
    if (!ok) { iapPickResolve = null; resolve(''); return; }
    // 用户在系统界面里迟迟不动作 → 兜底，别让 Promise 永远挂着
    setTimeout(() => {
      if (iapPickResolve === resolve) { iapPickResolve = null; resolve(''); }
    }, 120000);
  });
}

/* Uint8Array → base64。按 32 KiB 分段喂 fromCharCode：一次 apply 太多参数会爆栈 */
function iapB64(u8) {
  let bin = '';
  const STEP = 0x8000;
  for (let i = 0; i < u8.length; i += STEP)
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + STEP));
  return btoa(bin);
}

function iapSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function iapProg(pct, text) {
  const box = $('#fwProgress'), bar = $('#fwBar'), pl = $('#fwPl');
  if (box) box.classList.add('show');
  if (bar) bar.style.width = pct + '%';
  if (pl) pl.textContent = text || (pct + '%');
}

function iapListFiles() {
  try {
    const R = window.Ryken;
    if (!R) return [];
    /* SAF 单通道（用户 2026-10-12 定稿）：原 File 直写通道依赖"所有文件访问权限"，
       实测即便授予，U 盘升级仍会弹 SAF 授权 → 那个权限已整体移除。 */
    if (R.iapList) return JSON.parse(R.iapList() || '[]');
    return [];
  } catch (e) { return []; }
}

/* 刷机后设备会进入"半死"态（能枚举、能 open，但 OUT 写请求完成却传 0 字节，读全空）。
   先试「软拔插」：USB 标准请求 SET_CONFIGURATION(0)→(1) 让设备重新配置端点
   （实测设备接受这两个请求，且不会破坏正常状态）。成功就不用麻烦用户物理拔插。
   返回 true = 已恢复；false = 软拔插无效，需要提示用户物理拔插。 */
async function iapTrySoftRecover() {
  const R = window.Ryken;
  if (!R || !R.usbReset) return false;
  try {
    appLog('尝试软拔插（SET_CONFIGURATION 0→1）');
    appLog('软拔插结果: ' + R.usbReset());
    await iapSleep(900);
    R.reconnect();
    await iapSleep(4500);
    const s = JSON.parse(R.status());
    if (s.frames > 0 && (s.productSn || s.fwVersion)) {
      appLog('软拔插成功，数据已恢复（frames=' + s.frames + '）');
      return true;
    }
    appLog('软拔插后仍无数据: frames=' + s.frames + ' lastSend=' + s.lastSend);
  } catch (e) {
    appLog('软拔插异常: ' + (e && e.message));
  }
  return false;
}

/* 刷机收尾：先试软拔插，不行再让用户物理拔插 */
async function iapFinish(ok, msg) {
  window.Ryken.wakeLockRelease && window.Ryken.wakeLockRelease();   // ★ 成功出口统一释放唤醒锁
  const soft = await iapTrySoftRecover();
  const hint = $('#fwHint');
  if (hint) {
    hint.classList.add('show');
    hint.innerHTML = soft
      ? '✅ <b>' + msg + '，设备已自动恢复（无需拔插）。</b>'
      : '✅ <b>' + msg + '，设备已自动重启。</b><br>' +
        '⚠ <b>请把设备拔下来再插一次</b>（不要按「返回」键）—— 设备自行重启后 App 会显示' +
        '「已连接」但读不到 SN / 固件版本 / 测量值，这是设备 USB 端点未复位导致的，' +
        'App 侧已尝试软拔插但无效，只能物理拔插。';
  }
  iapProg(100, soft ? '完成（已自动恢复）' : '完成 · 请拔插设备');
  toast(soft ? msg + '，已自动恢复' : msg + ' —— 请拔下设备再插一次', 6000);
}

/* 当前插着的**所有**可移动卷 uuid（一加等设备可能同时挂多块 U 盘，
   2026-10-12 实测：一加上同时有 D366-1696（功率表 IAP 盘）和 B8FB-9237（另一块 U 盘），
   只取第一个会导致用户选了另一块时被误判为"选错了"。 */
function iapRemovableUuids() {
  try {
    const vs = JSON.parse(window.Ryken.iapVolumes() || '[]');
    return vs.filter(x => x.removable && !x.emulated && (x.uuid || '').length > 0)
             .map(x => x.uuid.toUpperCase());
  } catch (e) { return []; }
}

/* 已授权的目录是不是当前插着的某块可移动 U 盘？
   treeUri 形如 content://.../tree/D366-1696%3A，含卷 uuid；内部存储是 primary%3A。 */
function iapFolderIsDevice() {
  const f = (window.Ryken && window.Ryken.iapFolder) ? window.Ryken.iapFolder() : '';
  if (!f) return false;
  const uuids = iapRemovableUuids();
  if (!uuids.length) return false;
  const fu = f.toUpperCase();
  return uuids.some(u => fu.indexOf(u) >= 0);
}

$('#btnUpgrade').addEventListener('click', async () => {
  const R = window.Ryken;
  appLog('固件升级请求: local=' + fwLocalName + ' cur=' + $('#fwCur').textContent + ' new=' + $('#fwNew').textContent);

  if (!R || !R.iapWriteBegin) {
    $('#fwHint').classList.add('show');
    toast('浏览器版不支持直接刷写，请在 Ryken Mobile App 内操作', 3200);
    return;
  }
  if (!fwLocalBytes || !fwLocalBytes.length) { toast('请先点「选择固件」挑一个 bin 文件', 2800); return; }

  // ① 目录授权校验。
  //    正常路径下授权已经在「选择固件」阶段做完（fwCheckIapEnv 会报状态），
  //    所以走到这里绝大多数情况已经就绪，不会再弹任何系统界面。
  //    ⚠ 万一仍需弹 SAF：必须提前告诉用户"授权后要重新选一次固件" ——
  //    切后台会让 WebView 重载、fwLocalFile 丢失。这不是程序坏了，
  //    而是 <input type=file> 的固有限制（File 对象无法持久化）。
  if (R.iapFolder() && !iapFolderIsDevice()) {
    appLog('已授权目录不是 U 盘，清除重选: ' + R.iapFolder());
    R.iapClearFolder();
  }
  if (!R.iapFolder()) {
    toast('首次使用需授权 U 盘：授权后请重新点一次「选择固件」', 6500);
    const uri = await iapPickFolder();
    if (!uri) { toast('未选择目录，已取消', 2600); return; }
    if (!iapFolderIsDevice()) {
      R.iapClearFolder();
      toast('选错了：请选「USB设备」(RKX3IAP)，不要选内部存储', 5200);
      appLog('授权后校验失败，已清除: ' + uri);
      return;
    }
    // ★ 授权成功的当下就验证这个卷 —— 根目录必须有 Ready.TXT（功率表 IAP 盘的唯一标志）。
    //   一加实测踩坑：手机上挂着两块 U 盘（D366-1696 功率表 + B8FB-9237 别的），
    //   SAF 里用户选错一块，等点「立即升级」才发现卷里没 Ready.TXT，来回折腾。
    let list = [];
    try { list = JSON.parse(R.iapList() || '[]'); } catch (e) {}
    if (!list.some(x => /^ready\.txt$/i.test(x.name || ''))) {
      R.iapClearFolder();      // 错的授权不留着，下次点升级重新弹 SAF
      toast('选的这个 U 盘不是功率表的 IAP 盘（根目录没有 Ready.TXT）——请重新授权，选 8.35MB 的那个卷', 7000);
      appLog('授权的卷无 Ready.TXT，已清除: ' + uri);
      return;
    }
    // ★ 记住这个卷的 uuid：下次 SAF 用 EXTRA_INITIAL_URI 直接定位到它（不用再翻列表）
    try {
      const fu = uri.toUpperCase();
      const hit = iapRemovableUuids().find(u => fu.indexOf(u) >= 0);
      if (hit) { localStorage.setItem('iapUuid', hit); appLog('已记住功率表卷: ' + hit); }
    } catch (e) { appLog('记录卷 uuid 失败: ' + (e && e.message)); }
    // 授权成功。此时固件字节应该还在内存里（选固件时就缓存好了）；
    // 若为 null 说明页面被系统回收重载过，变量全丢了 → 只能请用户重选。
    if (!fwLocalBytes || !fwLocalBytes.length) {
      toast('U 盘授权成功 ✓ 请重新点「选择固件」', 5500);
      appLog('授权完成但 fwLocalBytes 已丢失（页面重载），已提示用户重选');
      return;
    }
    /* 用户 2026-10-12 最新要求（覆盖早前"授权后返回手动点"）：
       **授权 + Ready.TXT 验证通过 → 直接继续刷写**，不再让用户点第二次。
       （"启动权"顾虑由前面的双重流程保证：选固件是主动动作、Ready.TXT 验证已过滤错卷。） */
    toast('U 盘已授权 ✓ 继续升级…', 3000);
    appLog('授权完成（Ready.TXT 验证通过），自动继续刷写');
    // 不 return —— 落到后面的分块写入流程
  }

  // ② 确认设备真的在等待升级（Ready.TXT 是唯一可靠标志），并按情况区分提示 ——
  //    两种失败原因完全不同，混成一句"未开启 U 盘模式"会让人查错方向。
  const files0 = iapListFiles();
  if (!files0.some(x => /^ready\.txt$/i.test(x.name || ''))) {
    $('#fwHint').classList.add('show');
    if (!iapRemovableUuid()) {
      toast('没检测到 U 盘：请按住测试仪「返回」键再插线', 4500);
    } else {
      toast('U 盘已挂载，但设备不在等待升级状态：请按住「返回」键重新插线', 4800);
    }
    appLog('iapList = ' + JSON.stringify(files0));
    return;
  }

  // ③ 分块写入
  const name = fwLocalName || 'RKX3.bin';
  // ★ 用选固件时缓存好的字节，不再碰 File 对象 ——
  //   切到后台（弹 SAF 授权）后 File 的底层 URI 权限会被系统释放，
  //   那时再调 arrayBuffer() 必然失败（用户实测："授权后点升级，提示读取本地固件失败"）。
  const buf = fwLocalBytes;
  if (!buf || !buf.length) {
    toast('固件内容已失效，请重新点「选择固件」', 5200);
    appLog('fwLocalBytes 为空，需重新选固件');
    return;
  }

  /* 写入通道：SAF（用户 2026-10-12 定稿 —— 原 File 直写通道依赖"所有文件访问权限"，
     实测即便授予，U 盘升级仍会弹 SAF 授权，那个权限已整体移除） */
  appLog('写入通道: SAF');
  R.wakeLockAcquire && R.wakeLockAcquire();      // ★ 防刷写期间 USB 控制器挂起

  // iapWriteBegin 返回的是**错误字符串**（"" = 成功），不再返回 Boolean ——
  // 早期版本把异常吞成"权限或空间不足"，实际是 Invalid URI，排查方向全错。
  const wErr = R.iapWriteBegin(name);
  if (wErr) {
    toast('创建文件失败：' + wErr, 5200);
    appLog('iapWriteBegin 失败: ' + wErr);
    R.wakeLockRelease && R.wakeLockRelease(); return;
  }

  const CHUNK = 96 * 1024;
  let off = 0;
  try {
    while (off < buf.length) {
      const slice = buf.subarray(off, off + CHUNK);
      if (R.iapWriteB64(iapB64(slice))) throw new Error('写入被中断');
      off += slice.length;
      iapProg(Math.round(off / buf.length * 100),
              '写入 ' + Math.round(off / 1024) + ' / ' + Math.round(buf.length / 1024) + ' KB');
    }
    if (R.iapWriteEnd()) throw new Error('收尾失败');
  } catch (e) {
    R.iapWriteAbort();
    iapProg(0, '失败');
    toast('写入失败：' + e.message, 3600);
    return;
  }
  appLog('固件已写入 ' + name + '（' + buf.length + ' B），等待设备升级');
  iapProg(100, '已写入，设备升级中…');

  // ④ 等设备吃掉文件：Success.TXT 出现 = 完成；
  //    Ready.TXT 与固件文件同时消失 = 设备已接收、正在烧录
  //
  // ⚠ 两种结局都必须提示用户「拔插一次」，这不是客套话：
  //    刷机完成时设备是**自己重新枚举**回 HID 的（没经历真正的掉电重启），于是
  //    UsbDeviceConnection 会进入一种半死状态 —— open 成功、claimInterface 成功、
  //    端点描述符也完全正常，但 OUT 方向的写请求会「立即完成却传输 0 字节」
  //    （实测 lastSend = "out-done(3ms pos=0)"，正常应为 pos=64）。
  //    后果极具误导性：App 显示「已连接」、型号也读得到（那来自 USB 描述符，不需要设备应答），
  //    但 SN、固件版本、所有测量值全是空的（读请求全部零长返回，实测 38632 次）。
  //    只有物理拔插（= 设备重新上电）能清掉，代码侧无法绕过。
  const nameRe = new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
  for (let i = 0; i < 60; i++) {
    await iapSleep(1500);
    const l = iapListFiles();
    if (l.some(x => /^success\.txt$/i.test(x.name || ''))) {
      appLog('检测到 Success.TXT，升级完成');
      await iapFinish('升级完成');
      return;
    }
    if (!l.some(x => /^ready\.txt$/i.test(x.name || '')) && !l.some(x => nameRe.test(x.name || ''))) {
      appLog('Ready.TXT 与固件文件均已消失 → 设备已接收并开始烧录');
      await iapFinish('烧录完成');
      return;
    }
  }
  iapProg(100, '未见 Success');
  toast('已写入但没等到 Success.TXT —— 请看设备屏幕确认', 4200);
  window.Ryken.wakeLockRelease && window.Ryken.wakeLockRelease();   // 超时出口释放唤醒锁
});
/* btnUpgrade 的成功/烧录完成两个出口共用 iapFinish（内部已统一释放唤醒锁） */

$('#btnReadOffline').addEventListener('click', () => toast('连接真机后可读取离线记录'));
$('#btnReadLogo').addEventListener('click', () => toast('连接真机后可读取开机图'));
$('#btnReset').addEventListener('click', () => {
  cfg = { ...DEF, colors: { ...DEF.colors }, offset: { ...DEF.offset },
          visible: [...DEF.visible], liveVisible: [...DEF.liveVisible],
          lastPick: DEF.lastPick };
  save(); location.reload();
});

/* ══════════ 主题（暗色 / 亮色 / 跟随系统）══════════
   「跟随系统」由原生推送：Android WebView 的 prefers-color-scheme 不可靠
   （matchMedia 收不到系统深浅切换），MainActivity.onConfigurationChanged
   读 uiMode 后调 __ryken_nightmode —— 浏览器环境仍走 matchMedia。 */
const mqLight = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
try { mqLight && mqLight.addEventListener && mqLight.addEventListener('change', () => { if (cfg.theme === 'auto') applyTheme(); }); } catch {}
window.__ryken_nightmode = (night) => {
  try {
    window.__sysNight = !!night;
    appLog(`系统深色模式: ${night ? '深色' : '浅色'}`);
    if ((cfg.theme || 'dark') === 'auto') applyTheme();
  } catch {}
};

function applyTheme() {
  const t = cfg.theme || 'dark';
  /* 跟随系统：优先用原生推送的夜间模式状态（Android），浏览器回落 matchMedia */
  const sysLight = window.__sysNight === undefined
    ? !!(mqLight && mqLight.matches)
    : !window.__sysNight;
  const resolved = t === 'auto' ? (sysLight ? 'light' : 'dark') : t;
  document.documentElement.dataset.theme = resolved;
  /* A 屏黑：仅在暗色主题下生效 —— 纯黑背景（OLED 不发光、更省电更沉浸） */
  document.documentElement.classList.toggle('amoled', resolved === 'dark' && !!cfg.amoled);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'light' ? '#f6f8fb' : (cfg.amoled ? '#000000' : '#0b0e14'));
  const pal = resolved === 'light'
    ? { grid: '#dfe6ef', gridStrong: '#c9d5e2', txt: '#8494a8' }
    : { grid: '#1a2431', gridStrong: '#22303f', txt: '#5d6b80' };
  for (const c of [liveChart, bigChart]) { c.setPalette(pal); }
  if (window.Ryken && window.Ryken.setNativeTheme) {
    try { window.Ryken.setNativeTheme(resolved === 'light'); } catch {}
  }
  $$('#themeSeg .seg').forEach(b => b.classList.toggle('is-active', b.dataset.t === t));
}
$$('#themeSeg .seg').forEach(b => b.addEventListener('click', () => {
  cfg.theme = b.dataset.t;
  save(); applyTheme();
}));

/* ══════════ 屏幕方向（自动 / 锁竖屏 / 锁横屏）══════════
   旋转由原生层 setRequestedOrientation 完成；横屏布局切换交给
   CSS 的 @media (orientation: landscape) —— 视口一转过去就生效，
   所以「系统自动旋转」和「设置里强制横屏」两条路走的是同一套样式。 */
function applyOrientation() {
  const o = cfg.orientation || 'auto';
  $$('#orientSeg .seg').forEach(b => b.classList.toggle('is-active', b.dataset.o === o));
  try {
    if (window.Ryken && window.Ryken.setOrientation) window.Ryken.setOrientation(o);
  } catch {}
}
$$('#orientSeg .seg').forEach(b => b.addEventListener('click', () => {
  cfg.orientation = b.dataset.o;
  save(); applyOrientation();
}));
/* 方向变化后画布尺寸跟着变，两个图表都要重新量一次 */
window.addEventListener('orientationchange', () => {
  setTimeout(() => {
    liveChart._resize(); liveChart.draw();
    bigChart._resize();  bigChart.draw();
    queueFitPortraitLive();
  }, 260);
  setTimeout(queueFitPortraitLive, 800);   // 布局彻底稳定后再校一次
});

/* ══════════ 原始数据 · 协议调试面板 ══════════ */
let dbgTimer = null;

function isAndroidEnv() {
  try { return !!(window.Ryken && window.Ryken.platform && window.Ryken.platform() === 'android'); }
  catch { return false; }
}

function startDebugPanel() {
  $('#btnDbgClear')?.addEventListener('click', () => {
    if (source instanceof AndroidSource) { source.frames = []; source.total = 0; }
    renderDebug(); toast('已清空');
  });
  $('#btnDbgCopy')?.addEventListener('click', async () => {
    const fr = collectFrames();
    if (!fr.length) return toast('还没有数据');
    const head = collectStatusText();
    const txt = `# RYKEN RK-X3 raw HID frames  (${fr.length})\n# ${head}\n# —— 每行一帧，64 字节 hex ——\n` + fr.join('\n');
    try { await navigator.clipboard.writeText(txt); toast(`已复制 ${fr.length} 帧`); }
    catch { toast('复制失败，请长按选中'); }
  });
  $('#btnDbgSnap')?.addEventListener('click', () => {
    renderDebug();
    $('#dbgBytes')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    toast('已刷新');
  });
  $('#btnDbgTry')?.addEventListener('click', () => {
    if (!isAndroidEnv()) return toast('仅安卓真机可用');
    const r = window.Ryken.tryRequest();
    const el = $('#dbgDiag'); el.classList.add('show');
    el.textContent = 'tryRequest → ' + r;
    toast('已用备用方式试读', 1500);
  });
  $('#btnDbgReconnect')?.addEventListener('click', () => {
    if (!isAndroidEnv()) return toast('仅安卓真机可用');
    toast('正在重连设备…');
    window.Ryken.reconnect();
  });
  dbgTimer = setInterval(renderDebug, 1200);
  renderDebug();
}

function collectFrames() {
  if (source instanceof AndroidSource) return source.frames.slice(-400);
  return [];
}

function collectStatusText() {
  if (isAndroidEnv()) {
    const st = source instanceof AndroidSource ? source.status() : {};
    const d = st.device || {};
    return `android | connected=${st.connected} streaming=${st.streaming} fps=${(st.fps || 0).toFixed(1)} | ` +
           `${d.productName || 'RK-X3'} SN=${st.productSn || '—'} VID=${d.vidHex || ''} PID=${d.pidHex || ''} | ${st.error || ''}`;
  }
  return source instanceof BridgeSource ? 'bridge' : 'browser';
}

/* ⚠ 半死态检测（2026-10-12 实测规律，三次验证）
   设备「自己重新枚举」之后（刷机完成、退出 U 盘模式 —— 都不掉电）会进入半死态：
   能枚举、能 open、claimInterface 也成功，但 **OUT 写请求"完成却传 0 字节"**，
   IN 全部零长返回。表现为 connected=true、streaming=true，但 frames 恒为 0。

   已试过且**无效**的恢复手段：App 侧 close/open/reconnect、
   以及用 USB 标准请求 SET_CONFIGURATION(0)→(1) 做的"软拔插"。
   **只有物理拔插（设备真正掉电重新上电）能恢复。**

   命中就在界面上明确提示，别让用户以为 App 坏了 —— 这个坑今天已经骗过我们一次。 */
let zombieLastToast = 0;
function checkZombie(st) {
  if (!st || !st.connected) return false;
  const zombie = (st.frames || 0) === 0 && (st.zeroRun || 0) > 300;
  if (!zombie) return false;
  if (Date.now() - zombieLastToast > 30000) {      // 最多 30 秒提醒一次，别刷屏
    zombieLastToast = Date.now();
    toast('⚠ 设备已连接但收不到数据 —— 请把设备拔下来再插一次', 7000);
    appLog('检测到半死态: frames=0 zeroRun=' + st.zeroRun + ' lastSend=' + (st.lastSend || ''));
  }
  return true;
}

function renderDebug() {
  const stat = $('#dbgStat'), box = $('#dbgBytes'), hint = $('#dbgHint');
  if (!stat || !box) return;

  if (isAndroidEnv()) {
    const st = source instanceof AndroidSource ? source.status() : {};
    const zombie = checkZombie(st);
    stat.textContent = zombie
      ? `⚠ 已连接但收不到数据 —— 请拔下设备再插一次`
      : `${st.connected ? '● 已连接' : '○ 未连接'} · ${st.streaming ? '推流中' : '空闲'} · ` +
        `${(st.fps || 0).toFixed(1)} fps · 累计 ${source instanceof AndroidSource ? source.total : 0} 帧` +
        (st.error ? ` · ⚠ ${st.error}` : '');
    const dg = $('#dbgDiag');
    if (dg) {
      dg.classList.add('show');
      dg.textContent =
        `设备: ${st.device ? (st.device.productName + ' SN=' + (st.productSn || '—') +
          '  ' + st.device.vidHex + ':' + st.device.pidHex) : '未识别'}\n` +
        `端点: ${st.ep || '—'}   尝试=${st.tries || 0}  超时=${st.timeouts || 0}  ` +
        `上次返回=${st.lastRet == null ? '—' : st.lastRet}  帧数=${st.frames || 0}\n` +
        `接口: ${st.diag || '—'}`;
    }
  } else if (source instanceof BridgeSource) {
    stat.textContent = `桥接模式 · ${connectStateText()}`;
  } else {
    stat.textContent = '未连接 · 真机需在安卓 App 内运行，或电脑启动 bridge.py';
  }

  const frames = collectFrames();
  const last = frames[frames.length - 1];
  const ana = analyseFrames(frames.slice(-200));

  if (!last) {
    box.innerHTML = '';
    if (hint) hint.textContent = isAndroidEnv()
      ? '还没收到数据。确认功率表已插入手机（USB OTG），并在顶部点一下连接授权。'
      : '真机数据需要：① 安卓 App 内运行，或 ② 电脑跑 bridge.py 后手机同 WiFi 访问。';
    return;
  }

  const bytes = last.trim().split(/\s+/);
  const headerIdx = new Set([0, 1, 2, 3]);
  box.innerHTML = bytes.map((v, i) => {
    const c = ana && ana.cols[i];
    const cls = ['b'];
    if (c && c.variable) cls.push('v');
    if (headerIdx.has(i)) cls.push('hs');
    const range = c && c.variable ? `${c.min.toString(16)}~${c.max.toString(16)}` : '';
    return `<div class="${cls.join(' ')}" title="idx ${i} ${range}"><i>${i}</i>${v.toUpperCase()}</div>`;
  }).join('');

  if (hint) {
    const sidx = ana ? ana.cols.filter(c => c.variable).map(c => c.idx).join(',') : '';
    hint.textContent = ana
      ? `${ana.frames} 帧样本 · 变化字节：${sidx || '（无）'}。加负载后点「快照」并用「复制」把数据发我即可完成解码。`
      : '';
  }
}

function connectStateText() {
  try { return JSON.stringify(source?.status?.() || {}); } catch { return ''; }
}

/* ══════════ 连接 ══════════ */
function setConn(state, text, dev) {
  connected = state === 'on';
  appLog(`连接状态: ${text}`);
  $('#connPill').classList.toggle('on', connected);
  $('#connText').textContent = text;
  if (dev) {
    $('#devName').textContent = dev.name || '—';
    $('#devSn').textContent = dev.sn || '—';
    $('#devVer').textContent = dev.version || '—';
    $('#aboutDevName').textContent = dev.name || '—';
    $('#fwCur').textContent = dev.version || '—';
  }
  updateAbout();
}

/* 「关于」页设备信息：尽量读全（型号/SN/固件/USB），拿不到就如实显示 — */
function updateAbout() {
  const set = (id, v) => { const el = $('#' + id); if (el) el.textContent = v || '—'; };
  let st = null;
  try { st = source?.status?.() || null; } catch {}
  /* 演示模式（且未被真机接管）→ 显示固定假设备信息，避免真机 SN 进截图 */
  const dm = (source?.demo && !source?._realTakeover) ? DEMO_DEVICE : null;
  set('aboutDevName', dm ? dm.name : (st?.device?.productName || null));
  set('aboutSn', dm ? dm.sn : (st?.productSn || null));
  set('aboutFw', dm ? dm.version : (st?.fwVersion || null));
  set('aboutUsb', st?.device ? `${st.device.vidHex || '?'}:${st.device.pidHex || '?'}` : null);
}

/* ══════════ 沉浸 / 全面屏：原生把 状态栏·导航栏·左右挖孔 的尺寸传进来，页面自己垫
   左/右是给「左挖孔 / 右挖孔 / 刘海」用的 —— 横屏时挖孔在侧边，内容必须让开，
   但顶栏/底栏的背景仍然铺满到物理边缘。 ══════════ */
function applySysBars(top, nav, left, right) {
  const r = document.documentElement.style;
  r.setProperty('--sys-t', (top || 0) + 'px');
  r.setProperty('--sys-b', (nav || 0) + 'px');
  r.setProperty('--sys-l', (left || 0) + 'px');
  r.setProperty('--sys-r', (right || 0) + 'px');
}
window.__ryken_sysbars = applySysBars;

async function boot() {
  applyTheme();
  applyOrientation();
  applyImmersion();
  applyKeepOn();
  initLiveSeriesSeg();
  buildChips(); buildColors(); applyChartCfg();
  applySettingsToDOM();   // 所有设置项回填上次的值
  const av = $('#appVer');
  if (av && $('#aboutVer')) $('#aboutVer').textContent = 'Ryken Mobile ' + av.textContent;
  /* 顶栏的软件版本号与 #appVer 同源，避免两处版本字符串各自漂移 */
  if (av && $('#tbVer')) $('#tbVer').textContent = av.textContent;
  const isAndroid = !!(window.Ryken && window.Ryken.platform && window.Ryken.platform() === 'android');

  if (isAndroid) {
    await bootAndroid();
  } else {
    // 浏览器/桌面：只探测 PC 桥接（bridge.py）；连不上就显示未连接，不填充任何数据
    setConn('off', '未连接');
    probeBridge();
  }

  startDebugPanel();
  queueFitPortraitLive();                 // 竖屏实时页曲线高度适配（字体加载后再校一次）
  setTimeout(queueFitPortraitLive, 700);
}

async function bootAndroid() {
  // 系统栏高度：insets 回调早于 JS 就绪，这里主动补查一次
  try {
    const sb = JSON.parse(window.Ryken.sysbars() || '{}');
    applySysBars(sb.top, sb.nav, sb.left, sb.right);
  } catch {}
  const as = new AndroidSource(store);
  as.decode = (hex, t, rawT) => decodeFrame(hex, t, rawT);   // rawT：原始时间戳，容量/能量积分器用它判会话连续（切换系统时间不打断积分）
  as.decodeProto = (hex) => decodeProtocolFrame(hex);   // PD 报文 / 文本事件（协议事件帧）
  as.onProto = (pf) => pdFeed(pf);
  source = as;
  recorder = new Recorder(as, store);
  applyDataPolicy();

  const st = as.status();
  if (st.device) {
    setConn(st.connected ? 'on' : 'off', st.connected ? '已连接' : '待连接', {
      name: st.device.productName || 'RK-X3',
      sn: st.productSn || '—',
      version: st.fwVersion || "—",
    });
  } else {
    setConn('off', '未检测到设备');
  }

  try {
    await recorder.start();
    setRecording(true);          // 连接后自动开始记录 → 按钮必须显示「停止记录」
  } catch (e) {
    toast('USB 启动失败：' + e.message, 3000);
  }

  // 1.8 秒后仍无数据：如实显示连接状态（不填充任何模拟数据）
  setTimeout(() => {
    if (as.total > 0) return;
    const st0 = as.status();
    setConn(st0.connected ? 'on' : 'off',
      st0.connected ? (st0.streaming ? '已连接 · 等待数据' : '已连接 · 空闲') : '未连接');
  }, 1800);

  // 真机数据开始流动时刷新连接状态
  // 真机数据开始流动后，把 SN/固件刷新为产品级信息（信息帧解出前先用 USB 序列号）
  let snFixed = false;
  as.onRawFrames = () => {
    if (snFixed || as.demo) return;      // 演示模式：不拿真机状态覆盖演示文案
    const s = as.status();
    if (!s.productSn) return;
    snFixed = true;
    setConn('on', s.streaming ? '已连接' : '已连接·空闲', s.device
      ? { name: s.device.productName || 'RK-X3', sn: s.productSn || '—', version: s.fwVersion || '—' } : null);
  };

  // 主进程连接状态变化时回调
  window.__ryken_state = (conn, streaming) => {
    appLog(`USB事件: connected=${conn} streaming=${streaming}`);
    if (as.demo) return;                 // 演示模式：USB 事件不改演示文案
    const s = as.status();
    setConn(conn ? 'on' : 'off',
      conn ? (streaming ? '已连接' : '已连接·空闲') : '未连接',
      s.device ? { name: s.device.productName || 'RK-X3', sn: s.productSn || '—', version: s.fwVersion || '—' } : null);
  };

  applyDemoMode();                       // 上次会话开着演示模式 → 启动后自动接管
}

async function probeBridge() {
  const bs = new BridgeSource(store, BRIDGE_URL);
  bs.probeMs = 1500;
  try {
    await bs.start();
    await source?.stop();
    source = bs;
    source.onDevice = (d) => setConn('on', d.product || 'RK-X3', d);
    recorder = new Recorder(bs, store);
    applyDataPolicy();
    await recorder.start();
    setRecording(true);
    setConn('on', '已连接');
    toast('已连接功率表');
  } catch {
    // 没有桥接服务：保持未连接，不出任何数据
  }
}

/* 连接胶囊的点击只挂一个 listener（app.js:795，按 platform 分支重连）——
   原先这里还有第二个 listener 弹浏览器桥接地址，App 环境下是噪音，已删 */

/* 输入框聚焦时，滚动到键盘上方的可见位置，方便边看边输入。
   同时隐藏底栏（#app.kb）—— 否则底栏垫在键盘上沿，输入框被它顶在半空
   （用户 2026-10-10：输入框要贴到输入法框的上边缘，不是被底栏抬着）。 */
document.addEventListener('focusin', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
    document.getElementById('app')?.classList.add('kb');
    setTimeout(() => t.scrollIntoView({ block: 'center', behavior: 'smooth' }), 320);
  }
});
let _kbTimer = null;
document.addEventListener('focusout', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
    clearTimeout(_kbTimer);
    _kbTimer = setTimeout(() => {
      if (!document.activeElement || !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName))
        document.getElementById('app')?.classList.remove('kb');
    }, 180);
  }
});

boot();
requestAnimationFrame(raf);
