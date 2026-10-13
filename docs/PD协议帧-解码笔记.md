# RYKEN 协议事件帧（PD 报文）解码笔记

> 2026-10-10 实测解码，**用官方上位机「PD协议分析仪」表格逐行比对验证通过**。
> 证据：`.tmp-fw2/pd_evidence/`（原始帧日志 + 上位机表格截图）。工具：`probe_protocol.py`。

## 0. 一句话结论

设备会把 CC 线上抓到的 **PD 报文原样流出来**（不需要任何"开启监听"命令——只要 INFO+START+KEEPALIVE 在跑，
一旦有协议通信就自动上报）。手机端完全可以自己解析出
**消息类型 / 方向 / 对象数 / 协议版本 / 报文 ID / 原始 HEX**，并能进一步解 PDO / RDO。

## 1. 帧格式（协议事件帧）

```
[0]      0x55                 同步头
[1]      <类型字节>：= 报文数据长度 + 5   ← 0x0C=7B、0x10=11B、0x20=27B、0x28=35B …（实测完全吻合）
[2]      0x30                 （PD 事件帧固定；文本事件帧为 0x03）
[3..N]   PD 报文数据（长度 = [1] - 5）
[N+1..]  CRC16（大端），覆盖 [0..N]
[?]      帧尾（时间戳/遥测等，尚未完全解出）
```

- **CRC 与命令帧同一算法**：poly `0x2507` / init `0x11` / 结果 `+1` / 不反转。
- 数据自同步：即使不知道长度，也可**暴力试长度直到 CRC 对上**（`probe_protocol.py` 就是这么做的）。
- 注意 PC 端读取含报告 ID 字节（同步头在 idx=1）；Android 端在 idx=0。

## 2. PD 报文数据段

```
data[0]   = 设备序号/标记（每帧递增，形如 C9 CA CB CC ED EE …）
data[1..2]= PD 消息头（小端 u16）
data[3..] = 数据对象（每个 4 字节，小端）+ 末尾 4 字节 CRC32
```

### 消息头解码（**已用 8 行表格逐条验证**）

| 字段 | 取法 | 实测例证 |
| --- | --- | --- |
| 消息类型 type | `h & 0x1F` | 1=GoodCRC/Source_Capabilities、2=Request、15=Vendor_Defined … |
| 数据对象数 obj | `(h >> 12) & 7` | `0x71A1`→7 ✓（上位机显示 Obj=7） |
| 协议版本 rev | `((h >> 6) & 3) + 1` | `0x0041`→V2 ✓、`0x71A1`→V3 ✓ |
| 方向 | `(h >> 8) & 1`：1=SRC→SNK，0=SNK→SRC | 全部 8 行对上 ✓ |
| 报文 ID | `(h >> 9) & 7` | 全 0 ✓ |
| 扩展标志 | `(h >> 15) & 1` | — |

**类型名判别注意**：type=1 且 obj=0 → `GoodCRC`；type=1 且 obj>0 → `Source_Capabilities`（同一 type 值，靠 obj 区分）。

### 对照记录（上位机表格 vs 我们解的）

| 上位机显示 | 我们的解码 | 帧类型字节 |
| --- | --- | --- |
| SOP* Vendor_Defined SNK→SRC Obj1 V3 | hdr=0x108F → type15 obj1 rev3 dir0 ✓ | 0x10 |
| SOP* GoodCRC SRC→SNK V1 | hdr=0x0101 → type1 obj0 ✓ | 0x0C |
| SOP* Vendor_Defined SRC→SNK Obj5 V3 | hdr=0x518F → type15 obj5 dir1 ✓ | 0x20 |
| SOP GoodCRC SNK→SRC V1 | hdr=0x0001 ✓ | 0x0C |
| SOP Source_Capabilities SRC→SNK Obj7 V3 | hdr=0x71A1 → type1 obj7 ✓ | 0x28 |
| SOP GoodCRC SNK→SRC V2 | hdr=0x0041 ✓ | 0x0C |
| SOP Request SNK→SRC Obj1 V3 | hdr=0x1082 → type2 obj1 ✓ | 0x10 |
| SOP GoodCRC SRC→SNK V1 | hdr=0x0121 ✓ | 0x0C |

### PDO / RDO 也能解（同一个例子已验）

- **Source_Capabilities**（obj=7）：`2C 91 01 08` → 0x0801912C：Fixed 档，电压 = bits[19..10]×50mV = 100×50 = **5.00V**；
  依次 `2C D1 02 00`→9.00V、`2C C1 03 00`→12.00V、`2C B1 04 00`→15.00V …
  （上位机 Note 列正是 "Fixed: 5.00V 9.00V 12.00…" ✓）
- **Request**（obj=1）：RDO = `F4 D1 07 53` → 0x5307D1F4：对象位置 bits[31..28] = 5 → 第 5 档 = 20V/5A
  （上位机 Note："PDo5: Fixed:20.00V,5.00A" ✓）

## 3. 另一类：文本事件帧

```
55 0B 03 "accept" 15 29 …        type=0x0B，[1]-5 = 6 = 字符串长度
```
- 实测在**拔插充电器瞬间**出现（3 次），payload 是 ASCII 小写消息名（`accept`）。
- 后面跟着一段"身份块"（UID 尾 + SN + 版本 + START 参数 + CRC），与 0x1A 信息帧同源。
- 推测：设备的**事件标签帧**（可直接当"识别到的协议动作"显示）。

## 4. 触发条件（重要）

- **不需要"开启协议监听"命令**：官方上位机点「开始」时经调试器捕获，**没有发出任何 HID 命令**
  （只有 INFO/START/KEEPALIVE）；随后拔插充电器，设备就自发上报了事件帧。
- 手机端只要维持数据流（START + 1Hz KEEPALIVE），协议事件帧就会自己来。

## 5. 手机端实现建议

1. `ryken-protocol.js` 增加 `decodeProtocolFrame()`：
   - 类型字节 ≠ 0x1A/0x1B 时进入协议分支；
   - 用 `[1] - 5` 取数据长度（或用 CRC 自校验兜底）；
   - 解 header（type/obj/rev/dir/id）+ 输出 Data HEX；type=0x0B 时直接输出文本。
2. 协议页（当前是桩）改成：表格 `No. | SOP | Msg | Obj | Rev | 方向 | 数据(HEX) | 备注(PDO/RDO)`，
   V/I 用同一时刻的 0x1B 帧补。
3. 消息类型名字表按 PD 规范 + 上位机缓存里出现的名字（GoodCRC/GotoMin/Accept/Reject/PS_RDY/
   Get_Source_Cap/…/EPR_* / Vendor_Defined…）建。

## 6. 未解（不影响主功能）

- 帧尾 4/2 字节的含义（疑似时间戳/遥测，与 0x1B 尾部同源字段）；
- `[2]=0x30` 的语义（PD 事件帧固定值）；
- SOP / SOP* 的判别依据（[1] 与上位机 SOP 列不完全一致，可能需从报文内容或设备侧标记取）。
- 「Elapsed / VBUS / IBUS」列的来源字段未定位（手机端可用自家 0x1B 流代替）。

---

## 7. 「开闸」命令（2026-10-10 抓包确认）

**官方「PD协议分析仪 → 开始」会发这条命令**（调试器抓包，2 次连发）：

```
AA 07 03 01 00 65 49        ← 开（类型 0）
结构：AA | 07(整帧长度) | 03(协议监听) | 01(开=1/关=0) | 00(类型: 0=PD, 1=UFCS) | CRC16(BE)
同结构推得：关 = AA 07 03 00 00 E7 B0 ；UFCS 开 = AA 07 03 01 01 40 50 ；UFCS 关 = AA 07 03 00 01 C2 A9
```
- CRC 用同一算法复算，与实抓字节完全一致（`65 49` ✓）。
- **点击「开始」后设备立刻回一条 0x0B 文本事件**（"accept"）——三次实验（open_cmd4/5 等）都在点后 0.5~1s 内出现 ✓；点失败的那次（open_cmd3）则没有。
- ✅ **已验证（含"先关后开"）**：
  - 发 **OFF** → 设备立刻回一条 0x0B `"accept"`（对"关闭"的确认）；
  - 发 **ON** → 不回 ack（监听已开时 ON 无状态变化不回包）。
  - ⚠ 排障教训：**PC 端手写命令必须带 0x00 报告 ID 前缀**（65 字节：`00 + AA… + CRC`）。
    第一次测试手写的 65 字节少了前缀 → Windows HID 把首字节当报告 ID → 设备全部忽略，
    造成"命令无效"的假象（白折腾了一轮）。
  - 拔插数据线重新上电**不会**重置监听状态（表 MCU 由 HID 口供电，插回即恢复）。
- 官方上位机「开始」的完整前置序列（原样记录，供回放对照）：
  `INFO(aa 0a 00 1a 0a 0a 10 0c b4 0b) ×2 → START(aa 0c ff "ready" dd 80 4e 6c) → KEEPALIVE 1Hz ×11 → ON ×2`
  注：INFO 尾部 3 字节随会话变化（Oct9 是 `09 0b 0f`、今天有 `0a 0f 11`/`0a 10 0c`），
  且**响应里的 START 参数随之变化**（`33 32` / `dd 80` …）⇒ 疑似"挑战-应答"式会话串（待证）。

## 8. 手机端接入（Beta17）

- `RykenUsb.protoListen(on, type)`：发上述开/关命令（Kotlin 侧已内置 4 条含 CRC 的完整帧）。
- `RykenBridge.protoListen(on, type)` → JS `window.Ryken.protoListen(on, type)`。
- `app.js::pdSetRun()`：点「开始」→ 发开闸命令；点「停止」→ 发关闭命令。数据流（START+KEEPALIVE）仍照旧。
