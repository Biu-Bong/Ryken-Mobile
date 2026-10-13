/* ══════════════════════════════════════════════════════════
   ryken-protocol.js — RK-X3 USB HID 报文解析
   ──────────────────────────────────────────────────────────
   协议已实测破解（2026-10-09），字段与官方软件显示值逐一对过：

   ◆ 设备→主机（报告 ID 0x00 + 64 字节负载；
        PC 读 65 字节含 ID 字节，Android/UsbRequest 读 64 字节不含）：
     [i]  = 0x55 同步头（i = 0 或 1，两种读取方式只差报告 ID 字节）
     [i+1]= 类型：0x1B 测量帧 / 0x1A 设备信息帧，[i+2]= 负载长度 0x20

   测量帧字段（下标相对同步头 i，官方截图 0.79/3.16/0.07/0.49 四值校验通过）：
       i+3 .. i+6   VBUS   大端 float32   (V)
       i+7 .. i+10  IBUS   大端 float32   (A)      PWR = V × I
       i+11.. i+12  D+     大端 u16       (mV → /1000)
       i+13.. i+14  D-     大端 u16       (mV → /1000)
       i+15.. i+16  CC1    大端 u16       (mV → /1000)
       i+17.. i+18  CC2    大端 u16       (mV → /1000)
       i+19.. i+20  温度    大端 u16       (℃ 整数；官方 Rust 结构体
                    RegularData 顺序 voltage→current→power→d_plus→d_minus
                    →cc1→cc2→temperature 与帧内顺序一致)
     容量(mAh)/能量(Wh)：官方由上位机对电流/功率积分（CSV 列 charge/energy），
     本模块同样在解码时做积分（见 decodeFrame）。

   信息帧：i+16..i+19 = SN（BCD 压缩，如 12 34 56 78 → "12345678"）

   ◆ 主机→设备（64 字节输出报告，[0]=0xAA 魔数，[1]=数据长度）：
     AA 0A 00 1A 0A 09 0B 0F 5A 45  查询设备信息（设备回 0x1A 帧）
     AA 0C FF "ready32" A1 20       启动测量流（单发约 4.5 秒窗口）
     AA 06 06 01 A6 97              1Hz 心跳，持续续期测量流
     实测：B 后 167Hz 数据持续 ~4.5s 自动停；每秒发一次 C 可持续 20s+
     不断流；官方上位机 = 开机发一次 B + 每秒一个 C。
   ══════════════════════════════════════════════════════════ */

export const KNOWN = {
  reportId: 0x00,
  sync: 0x55,
  typeData: 0x1B,   // 测量帧（兼容旧名 type）
  typeInfo: 0x1A,
  type: 0x1B,
  payloadLen: 0x20,
};

/** 开流协议命令（64 字节报告负载，不含报告 ID 字节） */
export const CMD = {
  CMD_INFO:      'aa 0a 00 1a 0a 09 0b 0f 5a 45',
  CMD_START:     'aa 0c ff 72 65 61 64 79 33 32 a1 20',
  CMD_KEEPALIVE: 'aa 06 06 01 a6 97',
  /* ★ CMD4（'aa 06 04 01 86 60' 进入 IAP）已于 beta24 整体移除（用户 2026-10-12 定稿）。
     原因：它在固件里是 FLASH_Unlock + EraseSector(0x08007800)，会擦掉应用固件头；
     且依赖手机能接住设备重新枚举 —— 一加（ColorOS/Android 16）实测经常失败（黑屏/卡死 USB 控制器），
     新机型系统限制只会更严。免按键 HID 升级功能已删除，这里不再保留任何进 IAP 的命令，
     CMD4 从此在代码里不存在。进 IAP 的唯一方式 = 按住「返回」键插线（硬件路径，也是唯一的官方路径）。 */
};

/* 保留旧导出名，避免旧代码引用报错 */
export const FIELD_MAP = {};

export function parseHex(hex) {
  const parts = hex.trim().split(/\s+/);
  const b = new Uint8Array(parts.length);
  for (let i = 0; i < parts.length; i++) b[i] = parseInt(parts[i], 16) & 0xff;
  return b;
}

/** 定位同步头 0x55 的下标（PC 抓包帧在 1，Android 帧在 0），找不到返回 -1 */
export function syncIndex(b) {
  if (b.length >= 4 && b[0] === 0x55) return 0;
  if (b.length >= 4 && b[1] === 0x55) return 1;
  return -1;
}

function f32be(b, off) {
  const dv = new DataView(b.buffer, b.byteOffset + off, 4);
  return dv.getFloat32(0, false);
}

function u16be(b, off) {
  return ((b[off] << 8) | b[off + 1]) & 0xffff;
}

/* ── 容量/能量积分状态（每次解码累积，断流 >2s 视为新会话清零）── */
let _lastT = 0;
let _cap = 0;   // mAh
let _wh = 0;    // Wh

/** 清零按钮/新记录开始时重置容量能量统计 */
export function resetAccum() { _lastT = 0; _cap = 0; _wh = 0; }

/**
 * 解码一帧为测量对象。
 * t    : store 时间轴上的映射时间（含墙钟偏移）
 * rawT : 设备原始时间戳（可选）。容量/能量积分器用它判会话连续性——
 *        否则「使用系统时间」切换时存量 t 整体平移，t < _lastT 会被误判成
 *        新会话，_cap/_wh 清零重积，曲线上容量/能量突跌（2026-10-12 审核修复）。
 * 返回 { t, vbus, ibus, pwr, cc1, cc2, dp, dm, temp, cap, wh }；
 * 信息帧/损坏帧返回 null。
 */
export function decodeFrame(hex, t, rawT) {
  const b = parseHex(hex);
  const i = syncIndex(b);
  if (i < 0) return null;
  if (b[i + 1] !== KNOWN.typeData) return null;
  if (b.length < i + 21) return null;
  const vbus = f32be(b, i + 3);
  const ibus = f32be(b, i + 7);
  if (!isFinite(vbus) || !isFinite(ibus)) return null;
  const dp = u16be(b, i + 11) / 1000;
  const dm = u16be(b, i + 13) / 1000;
  const cc1 = u16be(b, i + 15) / 1000;
  const cc2 = u16be(b, i + 17) / 1000;
  const temp = u16be(b, i + 19);

  // 容量/能量：对电流、功率按时间积分（与官方 CSV 的 charge/energy 同义）
  // 积分用原始时间戳：切换相对/系统时间只平移显示轴，不打断积分
  const it = (rawT == null) ? t : rawT;
  if (it < _lastT || it - _lastT >= 2000) {
    _cap = 0; _wh = 0;                     // 重连/长时间断流：新会话
  } else if (it > _lastT) {
    const dh = (it - _lastT) / 3600000;    // 小时
    _cap += ibus * 1000 * dh;              // A·h → mAh
    _wh += vbus * ibus * dh;               // W·h
  }
  _lastT = it;

  return { t, vbus, ibus, pwr: vbus * ibus, cc1, cc2, dp, dm, temp, cap: _cap, wh: _wh };
}

/** 从设备信息帧（0x1A）提取 BCD 压缩的 SN，如 "12345678" */
export function snFromFrame(hex) {
  const b = parseHex(hex);
  const i = syncIndex(b);
  if (i < 0 || b[i + 1] !== KNOWN.typeInfo || b.length < i + 20) return null;
  let s = '';
  for (let k = i + 16; k <= i + 19; k++) {
    const v = b[k];
    const hi = v >> 4, lo = v & 0x0f;
    if (hi > 9 || lo > 9) return null;
    s += String(hi) + String(lo);
  }
  return s;
}

/** 帧头信息（总能解析，用于调试面板） */
export function frameHeader(hex) {
  const b = parseHex(hex);
  const i = syncIndex(b);
  return {
    len: b.length,
    reportId: b[0],
    syncIdx: i,
    sync: i >= 0 ? b[i] : null,
    type: i >= 0 ? b[i + 1] : null,
    payloadLen: i >= 0 ? b[i + 2] : null,
    seq: b[b.length - 1],
    isDataFrame: i >= 0 && b[i + 1] === KNOWN.typeData,
  };
}

/** 逐字节统计：哪些恒定、哪些变化、范围多少 */
export function analyseFrames(framesHex) {
  if (!framesHex.length) return null;
  const len = Math.max(...framesHex.map(h => h.trim().split(/\s+/).length));
  const cols = [];
  for (let i = 0; i < len; i++) {
    let mn = 255, mx = 0;
    const seen = new Set();
    for (const h of framesHex) {
      const p = h.trim().split(/\s+/);
      if (i >= p.length) continue;
      const v = parseInt(p[i], 16) & 0xff;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      seen.add(v);
    }
    cols.push({ idx: i, min: mn, max: mx, distinct: seen.size, variable: seen.size > 1 });
  }
  return { len, cols, frames: framesHex.length };
}

/** 两个字节数组的差异位置 */
export function diffIdx(hexA, hexB) {
  const a = hexA.trim().split(/\s+/), b = hexB.trim().split(/\s+/);
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

/* ══════════════════════════════════════════════════════════
   协议事件帧（PD 报文 / 文本事件）
   ──────────────────────────────────────────────────────────
   2026-10-10 实机解码，与官方上位机「PD协议分析仪」表格逐行核对通过：
     · 帧格式：55 | 类型字节(=数据长度+5) | 0x30 | 数据 | CRC16(BE) | 帧尾
       - 实测 0x0C=7B、0x10=11B、0x20=27B、0x28=35B；CRC 覆盖到数据尾
     · 设备**自发上报**（只要 START+KEEPALIVE 在跑），无需任何"开启监听"命令
     · 数据段：data[0]=序号/SOP 标记、data[1..2]=PD 消息头(小端)、其后 4B×对象 + 4B CRC32
     · 消息头：type=h&0x1F、obj=(h>>12)&7、rev=((h>>6)&3)+1、dir=(h>>8)&1、id=(h>>9)&7
   文本事件帧：55 0B 03 "accept" CRC16（[2]=0x03，数据即可打印 ASCII）
   ══════════════════════════════════════════════════════════ */

/** CRC16：poly 0x2507 / init 0x11 / 结果 +1 / 不反转（命令帧与上报帧同一算法） */
export function crc16(bytes) {
  let crc = 0x11;
  for (let k = 0; k < bytes.length; k++) {
    crc ^= (bytes[k] & 0xFF) << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? (((crc << 1) ^ 0x2507) & 0xFFFF) : ((crc << 1) & 0xFFFF);
  }
  return (crc + 1) & 0xFFFF;
}

/** 0x1A/0x1B 帧自带的 CRC 位置（相对同步头：0x1A 覆盖 24B、0x1B 覆盖 25B） */
export function frameCrcOk(b, i) {
  const t = b[i + 1], L = t === 0x1A ? 24 : (t === 0x1B ? 25 : 0);
  if (!L || b.length < i + L + 2) return null;
  return ((b[i + L] << 8) | b[i + L + 1]) === crc16(b.slice(i, i + L));
}

/* ── PD 消息类型名表 ──
   控制消息（对象数=0）/ 数据消息（对象数>0）/ 扩展消息（头 bit15=1）
   ✓ 已与官方表格逐行核对：1+obj0=GoodCRC、1+obj7=Source_Capabilities、2=Request、15=Vendor_Defined
   ⚠ 按 PD 规范填、待核对：3=Accept、6=PS_RDY、9=DR_Swap、16=Get_Status（实测那几帧是
     周期性成对出现，名称需要用官方表格行 9+ 复核一次） */
const PD_CTRL = {
  1: 'GoodCRC', 2: 'GotoMin', 3: 'Accept', 4: 'Reject', 5: 'Ping', 6: 'PS_RDY',
  7: 'Get_Source_Cap', 8: 'Get_Sink_Cap', 9: 'DR_Swap', 10: 'PR_Swap', 11: 'VCONN_Swap',
  12: 'Wait', 13: 'Soft_Reset', 14: 'Not_Supported', 15: 'Get_Source_Cap_Extended',
  16: 'Get_Status', 17: 'FR_Swap', 18: 'Get_PPS_Status', 19: 'Get_Country_Codes',
  20: 'Get_Sink_Cap_Extended', 21: 'Get_Source_Info', 22: 'Get_Revision', 23: 'Get_Manufacturer_Info',
};
const PD_DATA = {
  1: 'Source_Capabilities', 2: 'Request', 3: 'BIST', 4: 'Sink_Capabilities',
  5: 'Battery_Status', 6: 'Alert', 7: 'Get_Country_Info', 15: 'Vendor_Defined',
};
const PD_EXT = {
  1: 'Source_Capabilities_Extended', 2: 'Status', 3: 'Get_Battery_Cap', 4: 'Get_Battery_Status',
  5: 'Battery_Capabilities', 6: 'Get_Manufacturer_Info', 7: 'Manufacturer_Info',
  8: 'Security_Request', 9: 'Security_Response', 10: 'Firmware_Update_Request',
  11: 'Firmware_Update_Response', 12: 'PPS_Status', 13: 'Country_Info', 14: 'Country_Codes',
  15: 'Sink_Capabilities_Extended',
};

export function pdTypeName(h, obj) {
  const t = h & 0x1F;
  if (h & 0x8000) return PD_EXT[t] || ('Ext_' + t);
  if (obj === 0) return PD_CTRL[t] || ('Ctrl_' + t);
  return PD_DATA[t] || ('Data_' + t);
}

/** PDO 解析（Source_Capabilities 的数据对象，小端 u32） */
export function decodePDO(v) {
  const t = (v >>> 30) & 3;
  if (t === 0) {           // Fixed Supply
    const mv = ((v >>> 10) & 0x3FF) * 50, ma = (v & 0x3FF) * 10;
    return `Fixed ${(mv / 1000).toFixed(2)}V/${(ma / 1000).toFixed(2)}A`;
  }
  if (t === 1) {           // Battery
    const mn = ((v >>> 10) & 0x3FF) * 50, mx = ((v >>> 20) & 0x3FF) * 50, mw = (v & 0x3FF) * 250;
    return `Battery ${(mn / 1000).toFixed(2)}-${(mx / 1000).toFixed(2)}V/${(mw / 1000).toFixed(2)}W`;
  }
  if (t === 2) {           // Variable Supply
    const mn = ((v >>> 10) & 0x3FF) * 50, mx = ((v >>> 20) & 0x3FF) * 50, ma = (v & 0x3FF) * 10;
    return `Variable ${(mn / 1000).toFixed(2)}-${(mx / 1000).toFixed(2)}V/${(ma / 1000).toFixed(2)}A`;
  }
  const apdo = (v >>> 28) & 3;   // APDO：1=PPS / 2=AVS(EPR)
  const mn = ((v >>> 8) & 0xFF) * 100, mx = ((v >>> 17) & 0xFF) * 100, ma = (v & 0x7F) * 50;
  if (apdo === 2) {
    const av = ((v >>> 8) & 0xFF) * 100;   // 实测这档电压在 [15:8]（与 PPS 相反）——编码待更多样本校准
    return `AVS ≈${(av / 1000).toFixed(2)}V/${(ma / 1000).toFixed(2)}A（待校准）`;
  }
  return `PPS ${(mn / 1000).toFixed(2)}-${(mx / 1000).toFixed(2)}V/${(ma / 1000).toFixed(2)}A`;
}

/** RDO 解析（Request 的数据对象）；scList = 最近一次 Source_Capabilities 的 PDO 列表（用于补电压） */
export function decodeRDO(v, scList) {
  const pos = (v >>> 28) & 0xF;
  const op = ((v >>> 10) & 0x7FF) * 10, mx = (v & 0x3FF) * 10;
  const sc = scList && scList[pos - 1];
  const volt = sc ? ' ' + decodePDO(sc).split(' ')[1].split('/')[0] : '';
  return `PDo${pos}:${volt} ${(op / 1000).toFixed(2)}A / ${(mx / 1000).toFixed(2)}A`;
}

/** 解码器内部状态：最近一次 Source_Capabilities 的 PDO 列表（解 Request 电压用） */
let _lastSC = null;
export function resetProtoState() { _lastSC = null; }
export function lastSourceCaps() { return _lastSC; }

/**
 * 解析协议事件帧。返回 null 表示"不是协议帧"（0x1A/0x1B 或无法解析）。
 * 返回：{ kind:'pd', type, msgType, msg, obj, rev, id, dir, sop, dataHex, objs, notes[] , crcOk }
 *      { kind:'text', text, crcOk }
 */
export function decodeProtocolFrame(hex, ctx = {}) {
  const b = parseHex(hex);
  const i = syncIndex(b);
  if (i < 0) return null;
  const ft = b[i + 1];
  if (ft === KNOWN.typeData || ft === KNOWN.typeInfo) return null;   // 测量帧/信息帧走另一条路
  const len = ft - 5;
  if (len < 1 || i + 3 + len + 2 > b.length) return null;
  const data = b.slice(i + 3, i + 3 + len);
  const crcWant = (b[i + 3 + len] << 8) | b[i + 3 + len + 1];
  const crcOk = crcWant === crc16(b.slice(i, i + 3 + len));
  if (!crcOk) return null;                                          // CRC 不过＝不是完整帧（自同步兜底）

  const printable = data.length > 0 && [...data].every(c => c >= 0x20 && c < 0x7F);
  if (b[i + 2] === 0x03 || printable) {
    return { kind: 'text', text: String.fromCharCode(...data), crcOk, raw: hex };
  }

  const h = data[1] | (data[2] << 8);
  const obj = (h >> 12) & 7, rev = ((h >> 6) & 3) + 1, dir = (h >> 8) & 1, id = (h >> 9) & 7;
  const objs = [];
  for (let k = 0; k < obj; k++) {
    const o = 3 + k * 4;
    if (o + 4 > data.length) break;
    objs.push(((data[o] | (data[o + 1] << 8) | (data[o + 2] << 16) | (data[o + 3] << 24)) >>> 0));
  }
  const msg = pdTypeName(h, obj);
  const notes = [];
  if (msg === 'Source_Capabilities' && objs.length) _lastSC = objs.slice();
  if (msg === 'Source_Capabilities') objs.forEach((v, k) => notes.push(`PDo${k + 1}: ${decodePDO(v)}`));
  if (msg === 'Request' && objs[0] != null) notes.push(decodeRDO(objs[0], ctx.scList || _lastSC));
  const sopNib = (data[0] >> 4) & 0xF;
  return {
    kind: 'pd', type: ft, msgType: h & 0x1F, msg, obj, rev, id, dir,
    sop: sopNib === 0xE ? 'SOP' : (sopNib === 0xC ? 'SOP*' : '0x' + sopNib.toString(16)),
    dataHex: [...data].map(x => x.toString(16).padStart(2, '0').toUpperCase()).join(' '),
    objs, notes, crcOk, raw: hex,
  };
}

/** 帧类型名（调试面板用） */
export function frameTypeName(t) {
  return ({
    0x0B: '文本事件', 0x0C: 'PD报文(7B)', 0x10: 'PD报文(11B)', 0x20: 'PD报文(27B)',
    0x28: 'PD报文(35B)', 0x1A: '信息帧', 0x1B: '测量帧',
  })[t] || ('0x' + (t & 0xFF).toString(16).toUpperCase());
}
