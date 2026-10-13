/* ══════════ 演示模式帧引擎（Beta19，用户 2026-10-11）══════════
   无真设备时生成与真机同格式的帧（0x1B 测量帧 + 0x30/0x0B 协议事件帧），
   走同一条解码路径（decodeFrame / decodeProtocolFrame）→ 实时页、曲线页、
   统计、协议页全部有演示数据。比例预览：配合 MuMu 等模拟器调整窗口分辨率，
   即可在小屏上预览平板 / 大平板布局（页面按窗口尺寸响应式自适应）。 */
import { crc16 } from './ryken-protocol.js';

/* ── 0x1B 测量帧：55 1B 20 | VBUS f32be@3 | IBUS f32be@7 | D+ u16be@11 |
      D- @13 | CC1 @15 | CC2 @17 | 温度 u16be@19 | … | CRC16 @25（覆盖 25B）── */
function measFrame(seq, v, i, dp, dm, cc1, cc2, temp) {
  const b = new Uint8Array(64);
  const dv = new DataView(b.buffer);
  b[0] = 0x55; b[1] = 0x1b; b[2] = 0x20;
  dv.setFloat32(3, v, false);          // VBUS big-endian
  dv.setFloat32(7, i, false);          // IBUS
  dv.setUint16(11, Math.round(dp * 1000), false);
  dv.setUint16(13, Math.round(dm * 1000), false);
  dv.setUint16(15, Math.round(cc1 * 1000), false);
  dv.setUint16(17, Math.round(cc2 * 1000), false);
  dv.setUint16(19, Math.round(temp), false);
  b[21] = 0x22; b[37] = 0xc1; b[38] = 0xea; b[45] = 0x83; b[46] = 0xec;
  b[56] = 0x40; b[58] = 0x48; b[60] = 0x20;
  b[63] = seq % 10;
  const crc = crc16(b.slice(0, 25));
  b[25] = (crc >> 8) & 0xff; b[26] = crc & 0xff;
  return [...b].map(x => x.toString(16).padStart(2, '0')).join(' ');
}

/* ── 0x30 PD 事件帧：55 | 类型字节 | 30 | [seq, hdrLo, hdrHi, obj×4n, crc32×4] | CRC16 ──
   ⚠ 解码器 len = 类型字节 - 5 → 类型字节 = data长度(含CRC32的4B) + 5。
     实测对照：0x0C=0 obj、0x10=1 obj、0x20=5 obj、0x28=7 obj（ft = 12 + 4×obj数）。
   消息头（小端 u16）：type=h&1F、obj=(h>>12)&7、rev=((h>>6)&3)+1、方向=(h>>8)&1、id=(h>>9)&7 */
function pdFrame(seq, type, dir, objs, id = 0, rev = 2) {
  const h = (type & 0x1f) | ((id & 7) << 9) | (dir & 1) << 8 | (((rev - 1) & 3) << 6) | ((objs.length & 7) << 12);
  const n = 12 + objs.length * 4;      // 类型字节 = 物理帧长 = data(7+4n) + 5
  const b = new Uint8Array(n);
  const dv = new DataView(b.buffer);
  b[0] = 0x55; b[1] = n; b[2] = 0x30;
  b[3] = 0xe0 | (seq & 0x0f);   // 高 4 位 = SOP 标记 0xE（解码器读 data[0]>>4 得 SOP），低 4 位 = 序号
  dv.setUint16(4, h, true);            // 消息头小端
  objs.forEach((o, k) => dv.setUint32(6 + k * 4, o >>> 0, true));   // obj 小端（解码器 data[o]|data[o+1]<<8…）
  const crc = crc16(b.slice(0, n - 2));
  b[n - 2] = (crc >> 8) & 0xff; b[n - 1] = crc & 0xff;
  return [...b].map(x => x.toString(16).padStart(2, '0')).join(' ');
}

/* Fixed PDO：电压 mV/50 <<10 | 电流 mA/10 */
const pdoFixed = (mv, ma) => ((Math.round(mv / 50) & 0x3ff) << 10 | (Math.round(ma / 10) & 0x3ff)) >>> 0;

/* 文本事件帧：55 | 3+str.length | 03 | ASCII | CRC16 */
function textFrame(str) {
  const n = 3 + str.length + 2;
  const b = new Uint8Array(n);
  b[0] = 0x55; b[1] = n; b[2] = 0x03;
  for (let i = 0; i < str.length; i++) b[3 + i] = str.charCodeAt(i);
  const crc = crc16(b.slice(0, n - 2));
  b[n - 2] = (crc >> 8) & 0xff; b[n - 1] = crc & 0xff;
  return [...b].map(x => x.toString(16).padStart(2, '0')).join(' ');
}

/* ══ 演示引擎：闭包状态，每 ~50ms 被调一次，返回本批帧 ══ */
export function makeDemoEngine() {
  let t = 1000, seq = 0, pseq = 0, phase = 0, phaseAt = 0;
  /* PD 协商剧本：每 7s 重演一轮（对齐真实 PD 时序） */
  const script = [
    { at: 0,    run: () => [pdFrame(++pseq, 1, 0, [pdoFixed(5000, 3000), pdoFixed(9000, 3000), pdoFixed(12000, 3000), pdoFixed(15000, 3000), pdoFixed(20000, 5000)], 1)] },  // Source_Capabilities 5 档
    { at: 700,  run: () => [textFrame('accept')] },
    { at: 900,  run: () => [pdFrame(++pseq, 2, 1, [0x500641f4], 2)] },        // Request 20V/5A（PDo5）
    { at: 1300, run: () => [pdFrame(++pseq, 3, 0, [], 2)] },                  // Accept
    { at: 2100, run: () => [pdFrame(++pseq, 6, 0, [], 2)] },                  // PS_RDY
    { at: 2600, run: () => [pdFrame(++pseq, 1, 0, [pdoFixed(5000, 3000), pdoFixed(9000, 3000), pdoFixed(12000, 3000), pdoFixed(15000, 3000), pdoFixed(20000, 5000)], 3)] },
  ];
  return function frames() {
    t += 48;                                   // 每批推进 48ms（≈166Hz ÷ 每批 8 帧）
    const out = [];
    const now = t;
    /* 测量帧：20V 档 3.2A 充电工况，带纹波 + 慢漂移，让曲线活起来。
       ⚠ 批内帧间隔必须是 **6ms**（166Hz），不是 48ms —— 48ms 步长会让每批 8 帧
       横跨 384ms，与下一批（只推进 48ms）重叠 7 帧，时间戳成片重复：
       导出 CSV 时 3376 行只有 429 个唯一时间戳，曲线 X 轴也是乱的。
       批推进 48ms + 帧间隔 6ms → 时间轴 1:1 走、采样点 ~160/s，与真机对齐。 */
    for (let k = 0; k < 8; k++) {
      const tt = now - 6 * (8 - k);
      const v = 20 + 0.05 * Math.sin(tt / 900) + 0.02 * Math.sin(tt / 137);
      const i = 3.2 + 0.06 * Math.sin(tt / 700) + 0.015 * Math.sin(tt / 61);
      out.push({ t: tt, hex: measFrame(seq++, v, i, 0.55, 0.48, 2.71, 2.68, 31 + Math.sin(tt / 5000)) });
    }
    /* 协议剧本 */
    const cyc = now % 7000;
    for (const s of script) {
      if (cyc >= s.at && cyc - s.at < 48) out.push(...s.run().map(hex => ({ t: now, hex })));
    }
    return out;
  };
}
