package cn.ryken.mobile

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.hardware.usb.UsbRequest
import android.os.Build
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.io.File
import java.util.ArrayDeque
import java.util.Locale

/**
 * RK-X3 / X3 SE / X3 Pro 功率表 USB 通信
 *
 * 协议（2026-10-09 实测破解，官方上位机抓包 + 重放验证）：
 *   VID 0x2E3C / PID 0xAF03，厂商自定义 HID（UsagePage 0xFF00）
 *   主机→设备（64 字节输出报告，[0]=0xAA 魔数 [1]=长度）：
 *     AA 0C FF "ready32" A1 20  启动测量流（单发约 4.5 秒窗口，会自动停）
 *     AA 06 06 01 A6 97         1Hz 心跳，持续续期（官方一直发，断则 ~5s 后停流）
 *     AA 0A 00 1A 0A 09 0B 0F 5A 45  查询设备信息
 *   设备→主机：同步头 0x55；0x1B=测量帧（大端 f32 电压/电流，~167Hz），
 *              0x1A=信息帧（BCD 压缩 SN）
 */
object RykenUsb {
    const val VID = 0x2E3C
    const val PID = 0xAF03
    const val REPORT_LEN = 65
    private const val ACTION_PERM = "cn.ryken.mobile.USB_PERMISSION"
    private const val TAG = "RykenUsb"

    // ── 开流协议命令（64 字节负载；[0]=AA [1]=长度 [2..]=数据）──────
    private val CMD_INFO      = cmd("aa 0a 00 1a 0a 09 0b 0f 5a 45")
    private val CMD_START     = cmd("aa 0c ff 72 65 61 64 79 33 32 a1 20")
    private val CMD_KEEPALIVE = cmd("aa 06 06 01 a6 97")

    /* ── 协议监听的"开闸"命令（2026-10-10 从官方上位机抓包确认）──────
       官方「PD协议分析仪 → 开始」发出：AA 07 03 01 00 65 49（CRC 已用同算法复算一致）
       结构：AA | 07 | 03(协议监听) | 01(开/00=关) | 00(类型: 0=PD, 1=UFCS) | CRC16(BE)
       ⚠ 只有发过这条命令，设备才会往主机上报 PD 报文（0x0C/0x10/0x20/0x28）与文本事件（0x0B）。 */
    private val CMD_PROTO_PD_ON   = cmd("aa 07 03 01 00 65 49")
    private val CMD_PROTO_PD_OFF  = cmd("aa 07 03 00 00 e7 b0")
    private val CMD_PROTO_UFCS_ON = cmd("aa 07 03 01 01 40 50")

    /** 协议监听开关（type: 0=PD，1=UFCS）。异步投递，由读线程发出。 */
    fun protoListen(on: Boolean, type: Int = 0): Boolean {
        val b = when {
            type == 1 && on -> CMD_PROTO_UFCS_ON
            type == 1 -> cmd("aa 07 03 00 01 c2 a9")      // UFCS 关
            on -> CMD_PROTO_PD_ON
            else -> CMD_PROTO_PD_OFF
        }
        val ok = sendReport(b.copyOf())
        lastSendInfo = (if (ok) "proto-listen-queued:" else "proto-listen-fail:") + (if (on) "on" else "off")
        return ok
    }

    private fun cmd(hex: String): ByteArray {
        val out = ByteArray(64)
        hex.trim().split(' ').forEachIndexed { i, s -> out[i] = s.toInt(16).toByte() }
        return out
    }

    class Frame(val t: Long, val data: ByteArray)

    var manager: UsbManager? = null
        private set

    var device: UsbDevice? = null
        private set

    private var claimed: MutableList<UsbInterface> = mutableListOf()
    /** 候选输入端点（接口, 端点）。首选不灵时会依次轮换试。 */
    private var candidates: MutableList<Pair<UsbInterface, UsbEndpoint>> = mutableListOf()
    private var candIdx = 0

    var conn: UsbDeviceConnection? = null
        private set

    @Volatile
    var running: Boolean = false
        private set

    @Volatile var lastError: String = ""
    @Volatile var diag: String = ""
    @Volatile var startCalls: Int = 0
    @Volatile var lastStartOk: String = ""
    @Volatile var readTries: Long = 0
    @Volatile var readTimeouts: Long = 0
    @Volatile var lastRet: Int = 0
    @Volatile var frameTotal: Long = 0

    // ── 读循环细分统计 ──────────────────────────────────────
    // 背景（javap 实证 android-34）：UsbRequest **没有 getStatus()**，URB 错误状态读不到；
    // 且 requestWait(long) 超时是**抛 TimeoutException**而不是返回 null。
    // 因此旧代码用同一个 readTimeouts 把三种情况混在一起，日志无法判读：
    //   rwTimeout —— 300ms 内没完成（设备在 NAK，正常但无数据）
    //   rwZero    —— 请求立刻完成但 0 字节（设备回零长包 / 端点 STALL）
    //   rwExc     —— requestWait 抛了非超时的异常
    /** 正常超时（TimeoutException）次数 */
    @Volatile var rwTimeout: Long = 0
    /** 完成但 0 字节次数 */
    @Volatile var rwZero: Long = 0
    /** 非超时异常次数 */
    @Volatile var rwExc: Long = 0
    /** 单次 requestWait 的墙钟耗时：判定「它到底有没有在等」 */
    @Volatile var waitAvgMs: Double = 0.0
    @Volatile var waitMaxMs: Long = 0
    private var waitSumMs = 0L
    private var waitN = 0L
    /** 连续零长完成计数（一收到真帧就归零）——端点 STALL 的唯一间接判据触发点 */
    @Volatile var zeroRun: Long = 0
    @Volatile var zeroRunMax: Long = 0
    /** IN 端点 HALT 状态：-1 未知 / 0 正常 / 1 被 STALL */
    @Volatile var epHaltIn: Int = -1
    @Volatile var clearHaltCount: Int = 0
    /** OUT（命令通道）完成耗时 */
    @Volatile var outLastMs: Long = 0
    @Volatile var outMaxMs: Long = 0
    /** 信息帧尾部原始字节（相对同步头 i+20..i+25）：确认「版本号 / START 参数」到底落在哪 */
    @Volatile var infoTail: String = ""
    /** 信息帧完整 hex（最后一次）：版本字段溯源用 */
    @Volatile var infoFrameHex: String = ""

    /** 测量帧（0x1B）计数：魔数扫描的命中判据 */
    @Volatile var measTotal: Long = 0
    @Volatile var curEp: String = ""

    private var thread: Thread? = null
    private var hbThread: Thread? = null

    @Volatile private var lastFrameAtMs = 0L
    /** 最近一个测量帧（0x1B）时刻：心跳补发 START 的判据，避免被 0x1A 应答帧误导 */
    @Volatile private var lastMeasAtMs = 0L

    /** 待取走的帧队列（JS 侧轮询消费） */
    private val queue = ArrayDeque<Frame>()
    private val qLock = Any()
    /* 帧队列深度（发版前修复 2026-10-13）：原 600 帧 ≈ 4.8 秒 @125Hz ——
       息屏/后台时 WebView 的 JS 泵被系统节流，队列超过 5 秒就溢出丢帧（静默丢数据！）。
       60000 帧 ≈ 8 分钟 @125Hz，内存约 4MB（Frame 只存 ByteArray+时间戳），
       让"息屏几分钟后回来"不丢数据；再长仍会丢，故另有 UI 层告警与记录时保持屏幕常亮。 */
    private val qMax = 60000

    @Volatile private var frameCount = 0L
    @Volatile private var fpsWindowStart = 0L
    @Volatile var fps: Double = 0.0
        private set

    /** 原始快照：最近 N 帧，用于解码分析 */
    private val sniffer = ArrayDeque<ByteArray>()
    private val snifferMax = 400
    /** 非测量帧（信息帧等）持久留存：不会被 166Hz 测量流冲出 */
    private val infoFrames = ArrayDeque<ByteArray>()
    private val infoMax = 40
    /** 系统级事件时间线（权限/插拔/开流/异常），日志诊断用 */
    private val sysEvents = ArrayDeque<String>()
    private val sysEventsMax = 80
    /** 帧数时间线：每 5 秒记录一次累计帧数，用于定位断流时刻 */
    private val frameTimeline = ArrayDeque<String>()
    private var lastTimelineAt = 0L

    fun addSysEvent(msg: String) {
        synchronized(sysEvents) {
            val d = java.text.SimpleDateFormat("HH:mm:ss.SSS", java.util.Locale.US)
                .format(java.util.Date())
            if (sysEvents.size >= sysEventsMax) sysEvents.pollFirst()
            sysEvents.addLast("$d $msg")
        }
    }

    fun sysEventList(): List<String> = synchronized(sysEvents) { sysEvents.toList() }
    fun frameTimelineList(): List<String> = synchronized(frameTimeline) { frameTimeline.toList() }

    /** GET_STATUS(ENDPOINT)：返回 2 字节，bit0 = HALT。返回 -1 表示请求本身失败。
     *  UsbRequest 没有 getStatus()，URB 报错读不到 —— 端点是唯一能从外部观测的故障点。 */
    private fun endpointHalt(c: UsbDeviceConnection, epAddr: Int): Int {
        val buf = ByteArray(2)
        val n = try { c.controlTransfer(0x82, 0x00, 0x0000, epAddr, buf, 2, 500) } catch (_: Exception) { -1 }
        if (n < 2) return -1
        return buf[0].toInt() and 0x01
    }

    /** CLEAR_FEATURE(ENDPOINT_HALT)：端点被 STALL 后不会自愈，必须主机显式清 */
    private fun clearHalt(c: UsbDeviceConnection, epAddr: Int): Boolean =
        try { c.controlTransfer(0x02, 0x01, 0x0000, epAddr, null, 0, 500) >= 0 } catch (_: Exception) { false }

    val isOpen: Boolean get() = conn != null
    val deviceName: String get() = device?.productName?.takeIf { it.isNotBlank() } ?: "RK-X3"

    var onStateChanged: (() -> Unit)? = null

    // ── 权限 / 插拔广播 ───────────────────────────────────
    private val permReceiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            when (i.action) {
                ACTION_PERM -> {
                    val granted = i.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                    val d = i.getParcelableExtra<UsbDevice>(UsbManager.EXTRA_DEVICE)
                    Log.i(TAG, "permission granted=$granted device=${d?.deviceName}")
                    addSysEvent("USB权限: granted=$granted device=${d?.deviceName}")
                    if (granted && d != null) {
                        openDevice(c, d)
                        if (conn != null) startStream()
                    } else {
                        lastError = "用户拒绝了 USB 权限"
                    }
                    onStateChanged?.invoke()
                }
                UsbManager.ACTION_USB_DEVICE_DETACHED -> {
                    Log.i(TAG, "设备已拔出")
                    addSysEvent("USB设备已拔出")
                    onDetached()
                }
            }
        }
    }

    @Volatile private var initialized = false
    private var appCtx: Context? = null
    private var lastDump = 0L

    fun init(ctx: Context) {
        if (initialized) return          // Activity 与 Service 都可能调 init，只走一次
        initialized = true
        appCtx = ctx.applicationContext
        manager = ctx.getSystemService(Context.USB_SERVICE) as UsbManager
        val f = IntentFilter().apply {
            addAction(ACTION_PERM)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
        if (Build.VERSION.SDK_INT >= 33) {
            ctx.registerReceiver(permReceiver, f, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            ctx.registerReceiver(permReceiver, f)
        }
        // 命令通道：150ms 轮询，必须比外部写 cmd.txt 的节奏快，否则会被覆盖丢命令
        Thread {
            while (true) {
                try { Thread.sleep(150) } catch (_: Exception) { break }
                try { pollCmdFile() } catch (_: Exception) {}
            }
        }.also { it.isDaemon = true; it.start() }

        // 诊断落盘：1.2s 一次，与读线程解耦，保证 diag.txt 始终反映当前状态
        Thread {
            while (true) {
                try { Thread.sleep(1200) } catch (_: Exception) { break }
                try { dumpDiag(true) } catch (_: Exception) {}
            }
        }.also { it.isDaemon = true; it.start() }
    }

    /** 文件命令通道：cmd.txt 内容为十六进制字节（空格分隔），执行后写 cmdresult.txt 并删除 cmd.txt */
    private fun pollCmdFile() {
        val c = appCtx ?: return
        val f = File(c.getExternalFilesDir(null), "cmd.txt")
        if (!f.exists()) return
        val txt = try { f.readText().trim() } catch (_: Exception) { return }
        try { f.delete() } catch (_: Exception) {}
        if (txt.isEmpty()) return

        // 高速轮询模式：cmd.txt 内容为 "POLL <次数> <间隔ms>"
        // 用于复现 PC 端上位机 166Hz 的轮询节奏（文件通道本身只有 ~3Hz，跑不出来）
        if (txt.startsWith("POLL")) {
            val p = txt.split(Regex("[\\s,]+"))
            val count = p.getOrNull(1)?.toIntOrNull() ?: 200
            val ivl = (p.getOrNull(2)?.toLongOrNull() ?: 6L).coerceAtLeast(0L)
            Thread {
                val b = ByteArray(64); b[0] = 0x55.toByte()
                val t0 = System.currentTimeMillis()
                for (i in 0 until count) {
                    synchronized(outLock) {
                        while (pendingOut.size >= 16) pendingOut.pollFirst()
                        pendingOut.addLast(b)
                    }
                    if (ivl > 0) try { Thread.sleep(ivl) } catch (_: Exception) {}
                }
                val dt = System.currentTimeMillis() - t0
                try {
                    File(c.getExternalFilesDir(null), "cmdresult.txt").writeText(
                        "POLL done count=$count ivl=$ivl ms=$dt rate=${if (dt > 0) count * 1000 / dt else 0}/s frames=${frameTotal}\n"
                    )
                } catch (_: Exception) {}
            }.also { it.isDaemon = true; it.start() }
            return
        }

        val parts = txt.split(Regex("[\\s,]+")).filter { it.isNotEmpty() }
        // 不再补齐到 64：按实际给出的字节数发送。
        // 设备很可能解析变长命令（长度本身是协议的一部分），补齐会破坏语义。
        val bytes = ByteArray(parts.size.coerceAtMost(64))
        var n = 0
        for (i in bytes.indices) {
            val v = parts[i].removePrefix("0x").toIntOrNull(16) ?: break
            bytes[i] = v.toByte(); n++
        }
        val payload = if (n == bytes.size) bytes else bytes.copyOf(n)
        val queued = sendReport(payload)
        try {
            File(c.getExternalFilesDir(null), "cmdresult.txt")
                .writeText("sent=$n queued=$queued lastSend=${lastSendInfo} frames=${frameTotal}\nhex=${hex(payload)}\n")
        } catch (_: Exception) {}
    }

    fun release(ctx: Context) {
        try { ctx.unregisterReceiver(permReceiver) } catch (_: Exception) {}
        close()
    }

    // ── 设备查找 ──────────────────────────────────────────
    fun findDevice(): UsbDevice? {
        val m = manager ?: return null
        val all = m.deviceList.values
        all.firstOrNull { it.vendorId == VID && it.productId == PID }?.let { return it }
        return all.firstOrNull { d ->
            (0 until d.interfaceCount).any { i -> d.getInterface(i).interfaceClass == UsbConstants.USB_CLASS_HID }
        }
    }

    fun describe(d: UsbDevice): JSONObject {
        val o = JSONObject()
        o.put("vid", d.vendorId)
        o.put("pid", d.productId)
        o.put("vidHex", String.format(Locale.US, "0x%04X", d.vendorId))
        o.put("pidHex", String.format(Locale.US, "0x%04X", d.productId))
        o.put("deviceName", d.deviceName)
        o.put("productName", d.productName ?: "")
        o.put("manufacturer", d.manufacturerName ?: "")
        o.put("isRyken", d.vendorId == VID && d.productId == PID)
        try { o.put("serial", d.serialNumber ?: "") } catch (_: SecurityException) { o.put("serial", "") }
        return o
    }

    fun listDevices(): JSONArray {
        val arr = JSONArray()
        manager?.deviceList?.values?.forEach { arr.put(describe(it)) }
        return arr
    }

    // ── 连接 ──────────────────────────────────────────────
    fun connect(ctx: Context, target: UsbDevice? = null): Boolean {
        val m = manager ?: run { lastError = "USB 服务不可用"; return false }
        val d = target ?: findDevice() ?: run { lastError = "没找到功率表"; return false }
        if (!m.hasPermission(d)) {
            lastError = "等待 USB 授权"
            requestPermission(ctx, d)
            return false
        }
        openDevice(ctx, d)
        return conn != null
    }

    private fun requestPermission(ctx: Context, d: UsbDevice) {
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
        val pi = PendingIntent.getBroadcast(ctx, 0,
            Intent(ACTION_PERM).setPackage(ctx.packageName), flags)
        manager?.requestPermission(d, pi)
    }

    private val openLock = Any()

    private fun openDevice(ctx: Context, d: UsbDevice) {
        synchronized(openLock) {
            /* 已连接同一设备：直接复用。
               —— 但**半死时必须排除**（2026-10-12 实测踩到）：
               设备自行重新枚举后连接会失效，此时 autoConnect() 拿到的仍然是"同一设备"，
               走复用分支就直接 return 了 —— 连接没重建、zeroRun 不归零、
               握手也不会重做，于是 App 永远读不到 SN / 固件号。
               （判据：zeroRun 是否归零是"startStream 有没有被调用"的唯一外部标志。） */
            if (conn != null && device == d && !isHalfDead()) return
            // 换设备/重连 → 重置参数扫描状态（上一台表的扫描结论不适用于新表）
            sweepResult = ""; sweepProgress = ""; foundStartParam = null; sweeping = false
            close()
            val m = manager ?: return
        val c = m.openDevice(d) ?: run { lastError = "打开设备失败"; return }

        val sb = StringBuilder()
        sb.append("ifaces=").append(d.interfaceCount)
        val cds = mutableListOf<Pair<UsbInterface, UsbEndpoint>>()
        for (i in 0 until d.interfaceCount) {
            val f = d.getInterface(i)
            sb.append(" | i").append(f.id)
                .append(" cls=").append(f.interfaceClass)
                .append(" eps=").append(f.endpointCount)
            for (e in 0 until f.endpointCount) {
                val ep = f.getEndpoint(e)
                sb.append(" [0x").append(Integer.toHexString(ep.address))
                    .append(" t=").append(ep.type)
                    .append(" d=").append(ep.direction)
                    .append(" pkt=").append(ep.maxPacketSize)
                    .append(" iv=").append(ep.interval).append("]")
                val isIn = ep.direction == UsbConstants.USB_DIR_IN
                val okType = ep.type == UsbConstants.USB_ENDPOINT_XFER_INT ||
                             ep.type == UsbConstants.USB_ENDPOINT_XFER_BULK
                if (isIn && okType && ep.maxPacketSize >= 32) cds.add(f to ep)
            }
        }
        if (cds.isEmpty()) {
            lastError = "设备没有可用的输入端点"
            diag = sb.append(" => 无候选端点").toString()
            c.close(); return
        }
        // HID 接口优先
        cds.sortByDescending { if (it.first.interfaceClass == UsbConstants.USB_CLASS_HID) 1 else 0 }

        // 占用所有候选所在接口（同一接口只占一次）
        val done = HashSet<Int>()
        var claimAny = false
        for ((f, _) in cds) {
            if (!done.add(f.id)) continue
            var ok = c.claimInterface(f, true)
            if (!ok) ok = c.claimInterface(f, false)
            if (ok) { claimed.add(f); claimAny = true }
            sb.append(" claim").append(f.id).append("=").append(ok)
        }
        if (!claimAny) {
            lastError = "无法占用 USB 接口"
            diag = sb.toString()
            c.close(); return
        }

        candidates = cds
        candIdx = 0
        conn = c; device = d
        lastError = ""

        // 新连接：重置握手与会话信息。
        // ⚠ 之前 handshakeDone 从不复位，第二次连接起 maybeHandshake 直接跳过，
        //   版本号一直停在下面被删掉的 bcdDevice 兜底值（USB 硬件版本，不是固件版本）。
        handshakeDone = false
        fwVersion = ""      // 未知就显示 "—"，绝不猜
        productSn = ""
        snRaw = ByteArray(0)
        infoRaw = ByteArray(0)
        infoTail = ""
        infoFrameHex = ""
        bcdDevice = readBcdDevice(c)

        // HID 设备必须显式设空闲率，否则可能一直不推报告（Windows 侧由 HID 驱动代劳）
        val (f0, e0) = cds[0]
        val idle = try { c.controlTransfer(0x21, 0x0A, 0x0000, f0.id, null, 0, 500) } catch (e: Exception) { -99 }
        val proto = try { c.controlTransfer(0x21, 0x0B, 0x0001, f0.id, null, 0, 500) } catch (e: Exception) { -99 }
        sb.append(" | setIdle=").append(idle).append(" setProto=").append(proto)
            .append(" startEp=0x").append(Integer.toHexString(e0.address))
            .append(" candidates=").append(cds.size)
        diag = sb.toString()
        addSysEvent("设备已打开: ifaces=${d.interfaceCount} claim成功=${claimed.size} setIdle=$idle setProto=$proto ep=${candidates.getOrNull(0)?.second?.address}")
        dumpDiag(true)
        Log.i(TAG, "已连接 ${d.deviceName}  $diag")
        }
    }

    /**
     * 控制传输探针：设备活着但中断管道静默时，用 HID 控制请求直接取报告。
     * GET_REPORT 能把「当前输入报告」要过来，绕过中断端点。
     */
    @Volatile var probeResult: String = ""

    fun probe() {
        val c = conn ?: run { probeResult = "未连接"; return }
        val f = candidates.getOrNull(candIdx)?.first ?: run { probeResult = "无接口"; return }
        val sb = StringBuilder()
        val buf = ByteArray(REPORT_LEN)
        fun ctl(name: String, rt: Int, rq: Int, wv: Int, wl: Int) {
            val n = try { c.controlTransfer(rt, rq, wv, f.id, buf, wl, 800) } catch (e: Exception) { -99 }
            sb.append(name)
                .append(" rt=0x").append(Integer.toHexString(rt))
                .append(" rq=0x").append(Integer.toHexString(rq))
                .append(" => ").append(n)
            if (n > 0) sb.append("  ").append(hex(buf.copyOf(minOf(n, buf.size))))
            sb.append('\n')
        }
        ctl("GET_REPORT(std)", 0x81, 0x01, 0x0100, REPORT_LEN)
        ctl("GET_REPORT(cls)", 0xA1, 0x01, 0x0100, REPORT_LEN)
        ctl("GET_IDLE",        0x81, 0x02, 0x0000, 1)
        ctl("GET_PROTOCOL",    0x81, 0x03, 0x0000, 1)
        ctl("GET_RPT_DESCR",   0x81, 0x06, 0x2200, 64)
        probeResult = sb.toString()
        dumpDiag(true)
    }

    // ── 诊断落盘（ColorOS 屏蔽 app logcat，只能写文件）────────
    /** 生成完整诊断文本（写 diag.txt 与「日志与诊断」页面共用） */
    fun buildDiagText(): String = buildString {
        val d = device
        append("time=").append(System.currentTimeMillis()).append('\n')
        append("connected=").append(conn != null).append('\n')
        append("streaming=").append(running).append('\n')
        append("device=").append(if (d != null) "${d.deviceName} v=${d.vendorId} p=${d.productId} ifaces=${d.interfaceCount}" else "null").append('\n')
        append("candidates=").append(candidates.size).append(" idx=").append(candIdx).append('\n')
        append("ep=").append(curEp).append(" mode=").append(readMode).append('\n')
        append("startCalls=").append(startCalls).append(" lastStart=").append(lastStartOk).append('\n')
        append("productSn=").append(if (productSn.isEmpty()) "(未解出)" else productSn)
            .append("  fwVersion=").append(if (fwVersion.isEmpty()) "(未解出)" else fwVersion)
            .append("  bcdDevice=").append(bcdDevice.ifEmpty { "(读不到)" })
            .append("  lastSend=").append(lastSendInfo).append('\n')
        append("snRaw=").append(snRaw.joinToString(" ") { "%02x".format(it) }).append('\n')
        append("infoFrameHex=").append(infoFrameHex.ifEmpty { "(未收到信息帧)" }).append('\n')
        append("sweep=").append(if (sweeping) "进行中 $sweepProgress" else "空闲")
            .append("  result=").append(sweepResult).append('\n')
        // ⚠ 标签从 timeouts 改成 noData：本版起 readTimeouts 只统计「零长完成」，
        //   超时（TimeoutException）已单独计入下面的 rw.timeout。旧标签会误导判读。
        append("tries=").append(readTries).append(" noData=").append(readTimeouts)
            .append(" (零长完成，不含超时；见下行 rw 分解)")
            .append(" lastRet=").append(lastRet).append(" frames=").append(frameTotal).append('\n')
        // ── 读循环三态分解：判定「设备在 NAK / 回零长包 / 端点被 STALL」的唯一依据 ──
        append("rw: timeout=").append(rwTimeout).append(" zeroLen=").append(rwZero)
            .append(" exc=").append(rwExc).append('\n')
        append("zeroRun=").append(zeroRun).append(" (max=").append(zeroRunMax)
            .append(")  epHaltIn=").append(epHaltIn)
            .append(" clearHalt=").append(clearHaltCount).append('\n')
        append("waitAvgMs=").append(String.format(Locale.US, "%.3f", waitAvgMs))
            .append(" waitMaxMs=").append(waitMaxMs)
            .append(" => ").append(
                if (waitAvgMs <= 0.0) "(无样本)"
                else if (waitAvgMs < 1) String.format(Locale.US, "%.0f 次/秒（基本没在等）", 1000.0 / waitAvgMs)
                else String.format(Locale.US, "%.0f 次/秒", 1000.0 / waitAvgMs)
            ).append('\n')
        append("out: lastMs=").append(outLastMs).append(" maxMs=").append(outMaxMs).append('\n')
        append("infoTail=").append(infoTail.ifEmpty { "(未收到信息帧)" }).append('\n')
        append("fps=").append(fps).append('\n')
        append("lastError=").append(lastError).append('\n')
        append("diag=").append(diag).append('\n')
        if (probeResult.isNotEmpty()) append("--- probe ---\n").append(probeResult)
        append("--- 事件时间线 ---\n")
        synchronized(sysEvents) { sysEvents.forEach { append(it).append('\n') } }
        append("--- 帧数时间线(每5s) ---\n")
        synchronized(frameTimeline) { frameTimeline.forEach { append(it).append('\n') } }
        append("--- raw preview ---\n")
        synchronized(rawPreview) { rawPreview.forEach { append(it).append('\n') } }
        // 非测量帧（信息帧等）单独留存：166Hz 测量流会把它们冲出环形缓冲
        append("--- info/other frames ---\n")
        synchronized(infoFrames) {
            infoFrames.forEach { append(hex(it) + frameVI(it)).append('\n') }
        }
        append("--- recent frames (").append(recentFrames.size).append(") ---\n")
        synchronized(recentFrames) { recentFrames.forEach { append(it).append('\n') } }
    }

    fun dumpDiag(force: Boolean = false) {
        val c = appCtx ?: return
        val now = System.currentTimeMillis()
        if (!force && now - lastDump < 1500) return
        lastDump = now
        try {
            File(c.getExternalFilesDir(null), "diag.txt").writeText(buildDiagText())
        } catch (_: Exception) {}
    }

    fun close() {
        stopStream()
        for (f in claimed) { try { conn?.releaseInterface(f) } catch (_: Exception) {} }
        claimed = mutableListOf()
        try { conn?.close() } catch (_: Exception) {}
        conn = null; device = null
        candidates = mutableListOf(); candIdx = 0
        synchronized(qLock) { queue.clear() }
    }

    fun onDetached() {
        lastError = "设备已断开"
        close()
        onStateChanged?.invoke()
    }

    /**
     * "半死"连接判定：连着、读线程也在跑，但**一个数据帧都没收到**。
     *
     * 这种情况 `running` 是 true，所以 MainActivity 里"流停了就重连"的判据抓不到它；
     * 而握手（INFO 帧 → SN / 固件号）只在建立新连接时做一次（maybeHandshake 里
     * `if (handshakeDone) return`），所以这条连接永远读不到设备信息。
     * → 必须主动拆掉重建。
     */
    fun isHalfDead(): Boolean =
        conn != null && running && frameTotal == 0L && zeroRun > 300L

    /**
     * 尝试「软拔插」——不物理拔插，强制设备重新走一遍 USB 配置流程。
     *
     * 背景：设备在**自行重新枚举**后（刷机完成、退出 U 盘模式）会进入一种半死态：
     * 能枚举、能 open、claimInterface 也成功，但 OUT 写请求"完成却传输 0 字节"
     * （实测 lastSend="out-done(3ms pos=0)"），IN 全部零长返回。
     * 实测只有**物理拔插**（= 设备真正掉电）能恢复。
     *
     * 这里试的原理：USB 标准请求 SET_CONFIGURATION(0) 会让设备进入"未配置"状态
     * （所有端点禁用），再 SET_CONFIGURATION(1) 重新配置 —— 很多固件会在这两步里
     * 重新初始化端点，效果可能等价于拔插。
     *
     * ⚠ 这只是实验：如果设备固件在"未配置"态没做完整重置，就无效（那就只能拔插）。
     *    返回一串诊断文本，供上层如实显示，别猜。
     */
    fun usbReset(): String {
        val d = device ?: return "no-device"
        val sb = StringBuilder()
        try {
            close()
            Thread.sleep(300)
            val m = manager ?: return "no-manager"
            val c = m.openDevice(d) ?: return "reopen-fail"
            sb.append("reopen=ok ")
            // SET_CONFIGURATION(0)：让设备进入未配置态（端点全禁用）
            try {
                val r0 = c.controlTransfer(0x00, 0x09, 0, 0, null, 0, 500)
                sb.append("cfg0=$r0 ")
            } catch (e: Exception) { sb.append("cfg0=EXC(${e.javaClass.simpleName}) ") }
            Thread.sleep(250)
            // 再配置回来（配置号一般为 1）
            try {
                val r1 = c.controlTransfer(0x00, 0x09, 1, 0, null, 0, 500)
                sb.append("cfg1=$r1 ")
            } catch (e: Exception) { sb.append("cfg1=EXC(${e.javaClass.simpleName}) ") }
            try { c.close() } catch (_: Exception) {}
            sb.append("done")
        } catch (e: Exception) {
            sb.append("EXC:").append(e.javaClass.simpleName)
        }
        addSysEvent("软拔插尝试: $sb")
        return sb.toString()
    }

    /**
     * 最强的一种「软拔插」：直接向 usbfs 发 **USBDEVFS_RESET**（端口级复位）。
     *
     * 比 SET_CONFIGURATION 更底层 —— 它让 USB 控制器对设备做一次真正的复位，
     * 等价于主机侧重新枚举，是目前唯一有希望替代物理拔插的软件手段。
     *
     * 实现：UsbDeviceConnection.getFileDescriptor() 拿到已打开设备的 fd，
     * 用 java.io.FileDescriptor 包一层（反射写 descriptor 字段），再走 Os.ioctl。
     * USBDEVFS_RESET = _IO('U', 20) = ('U' shl 8) or 20 = 0x5514
     *
     * ⚠ 反射 + ioctl 都是非常规手段，失败就如实返回错误字符串，不猜。
     */
    fun usbFsReset(): String {
        val c = conn ?: return "no-conn"
        val fdInt = try { c.fileDescriptor } catch (e: Exception) { return "no-fd:${e.javaClass.simpleName}" }
        if (fdInt < 0) return "bad-fd:$fdInt"
        return try {
            val f = java.io.FileDescriptor()
            val fl = java.io.FileDescriptor::class.java.getDeclaredField("descriptor")
            fl.isAccessible = true
            fl.setInt(f, fdInt)
            /* ⚠ android.system.Os.ioctl 是 @hide API —— 编译期直接写 ioctl() 会
               "Unresolved reference"（2026-10-12 踩到，害得整包编译失败）。
               只能反射调用；若被 Android 的 hidden API 限制拦住，会抛异常，如实返回，不猜。 */
            val osCls = Class.forName("android.system.Os")
            val m = osCls.getMethod(
                "ioctl", java.io.FileDescriptor::class.java, Integer.TYPE, Integer.TYPE)
            val r = m.invoke(null, f, 0x5514, 0) as Int
            "ioctl-reset-ok(fd=$fdInt ret=$r)"
        } catch (e: Exception) {
            val cause = e.cause
            "ioctl-exc:${e.javaClass.simpleName}" +
                (if (cause != null) "/${cause.javaClass.simpleName}" else "") +
                ":${(e.message ?: "").take(70)}"
        }
    }

    // ── 数据流 ────────────────────────────────────────────
    @Volatile var readMode: String = ""
    @Volatile var rawPreview: MutableList<String> = mutableListOf()
    private val recentFrames = ArrayDeque<String>()

    private fun emitFrame(b: ByteArray) {
        synchronized(qLock) {
            if (queue.size >= qMax) queue.pollFirst()
            queue.addLast(Frame(System.currentTimeMillis(), b))
        }
        synchronized(sniffer) {
            if (sniffer.size >= snifferMax) sniffer.pollFirst()
            sniffer.addLast(b)
        }
        if (b.size >= 2 && (b[1].toInt() and 0xFF) != 0x1B) {
            synchronized(infoFrames) {
                if (infoFrames.size >= infoMax) infoFrames.pollFirst()
                infoFrames.addLast(b)
            }
        }
        synchronized(rawPreview) {
            if (rawPreview.size < 8) rawPreview.add(hex(b) + frameVI(b))
        }
        // 落盘用的最近帧（不用界面就能被 adb 取走）
        synchronized(recentFrames) {
            if (recentFrames.size >= 80) recentFrames.pollFirst()
            recentFrames.addLast(hex(b) + frameVI(b))
        }
        lastFrameAtMs = System.currentTimeMillis()
        if (frameVI(b).isNotEmpty()) {
            lastMeasAtMs = System.currentTimeMillis()
            measTotal++
        }
        frameTotal++
        frameCount++
        val now = System.currentTimeMillis()
        if (now - lastTimelineAt >= 5000) {
            lastTimelineAt = now
            synchronized(frameTimeline) {
                if (frameTimeline.size >= 72) frameTimeline.pollFirst()
                val d = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date())
                frameTimeline.addLast("$d frames=$frameTotal fps=${fps.toInt()}")
            }
        }
        val dt = now - fpsWindowStart
        if (dt >= 1000) {
            fps = frameCount * 1000.0 / dt
            frameCount = 0; fpsWindowStart = now
        }
    }

    fun startStream(): Boolean {
        startCalls++
        if (running) { lastStartOk = "already-running"; return true }
        val c = conn ?: run { lastError = "还没连接"; lastStartOk = "no-conn"; addSysEvent("startStream失败: 没连接"); return false }
        if (candidates.isEmpty()) { lastError = "没有输入端点"; lastStartOk = "no-endpoint"; addSysEvent("startStream失败: 没有输入端点"); return false }
        running = true
        frameCount = 0; fpsWindowStart = System.currentTimeMillis()
        readTries = 0; readTimeouts = 0; frameTotal = 0; lastRet = 0
        rwTimeout = 0; rwZero = 0; rwExc = 0
        zeroRun = 0; zeroRunMax = 0; epHaltIn = -1; clearHaltCount = 0
        waitAvgMs = 0.0; waitMaxMs = 0; waitSumMs = 0; waitN = 0
        outLastMs = 0; outMaxMs = 0
        synchronized(rawPreview) { rawPreview = mutableListOf() }

        val (_, e0) = candidates[candIdx]
        curEp = "0x" + Integer.toHexString(e0.address)
        // 中断端点必须走 UsbRequest；bulkTransfer 在内核侧会被拒（-EINVAL）
        readMode = if (e0.type == UsbConstants.USB_ENDPOINT_XFER_INT) "UsbRequest" else "bulkTransfer"
        val pkt = if (e0.maxPacketSize > 0) e0.maxPacketSize else REPORT_LEN
        lastStartOk = "ok:$readMode:$curEp:pkt=$pkt"
        addSysEvent("startStream#$startCalls: $lastStartOk")
        Log.i(TAG, "开始读流 $curEp mode=$readMode pkt=$pkt")
        dumpDiag(true)

        thread = Thread {
            try {
                if (readMode == "UsbRequest") requestLoop(c, pkt) else bulkLoop(c, pkt)
            } catch (e: Throwable) {
                lastError = "读线程异常: $e"
                Log.e(TAG, "读线程异常", e)
            }
            running = false
            dumpDiag(true)
            Log.i(TAG, "读流结束")
        }.also { it.isDaemon = true; it.start() }

        // ── 开流：官方协议 = 查询信息 + START，之后 1Hz KEEPALIVE 续期 ──
        sendReport(CMD_INFO)
        sendReport(currentStartCmd())
        lastFrameAtMs = System.currentTimeMillis()
        lastMeasAtMs = System.currentTimeMillis()
        hbThread?.join(200)
        hbThread = Thread {
            var lastProbeAt = 0L
            var sweepTriggered = false
            // ── 握手阶段：持续重发 INFO（每 700ms）直到信息帧到达并完成动态连接。
            //    不限次数——部分设备（X3 SE 实测）开流初期不回 0x1A，流稳定后才应答。──
            //    ⚠ 关键修复：原来这里**只**发 INFO。设备不回 0x1A → handshakeDone 永远 false
            //      → 而「2.5s 无测量帧就补发 START」在循环之后 → **START 一生只发过 t=0 那一次**。
            //      vivo 那两份日志就是这个状态，看日志根本分不清「START 被拒」和「START 从没重发」。
            //      官方节奏是 INFO→INFO→START(隔 2ms)，这里每两拍 INFO 跟一发 START。
            var infoTries = 0
            var startTries = 0
            while (running && !handshakeDone) {
                infoTries++
                sendReport(CMD_INFO)
                if (infoTries % 4 == 1) addSysEvent("INFO重发 #$infoTries")
                if (infoTries % 2 == 0) {
                    sendReport(currentStartCmd()); startTries++
                    if (startTries % 4 == 1) addSysEvent("START补发 #$startTries（握手未完成）")
                }
                val target = System.currentTimeMillis() + 700
                while (running && !handshakeDone && System.currentTimeMillis() < target) {
                    try { Thread.sleep(50) } catch (_: Exception) {}
                }
            }
            if (running) addSysEvent("握手完成（INFO重试 $infoTries 次，START 补发 $startTries 次）")
            while (running) {
                try { Thread.sleep(1000) } catch (_: Exception) { break }
                if (!running) break
                if (sweeping) continue   // 扫描期间心跳暂停，避免旧魔数污染命中判定
                val now = System.currentTimeMillis()
                sendReport(CMD_KEEPALIVE)
                // 流寿命 ~4.5s：若已 2.5s 没有测量帧，补一枪 START 重新开流
                // （判据用 0x1B 测量帧时刻，0x1A 应答帧不算，否则探针会抑制补发）
                if (now - lastMeasAtMs > 2500) {
                    sendReport(currentStartCmd())
                }
                // ── 静默探针（诊断 START 被拒 vs OUT 通道失效）──
                // 长时间无任何帧时周期性发 INFO：设备若回 0x1A → OUT 通、START 被固件拒；
                // 若从不回应 → 每次开流后那帧 0x1A 是设备自发包，OUT 实际没送达（vivo 兼容问题）。
                val silentFor = now - lastFrameAtMs
                if (silentFor > 6000 && now - lastProbeAt > 5000) {
                    lastProbeAt = now
                    sendReport(CMD_INFO)
                    addSysEvent("静默探针: INFO已发 (已静默${silentFor / 1000}s)")
                }
                // ── 参数自动扫描：静默 15s 且已拿到信息帧（才有候选字节）时启动 ──
                if (!sweepTriggered && silentFor > 15000 && infoRaw.size >= 26 && sweepResult.isEmpty()) {
                    sweepTriggered = true
                    Thread { runSweep() }.also { it.isDaemon = true; it.start() }
                }
            }
        }.also { it.isDaemon = true; it.start() }
        return true
    }

    /** 中断端点：UsbRequest + requestWait
     *  要点：始终保持「一个 URB 在飞」。只在 transfer 完成（请求已出队）后才再次 queue，
     *  绝不在超时路径上 cancel 后立刻 re-queue —— 那样会撞上
     *  IllegalStateException: this request is currently queued，读线程直接死掉。 */
    private fun requestLoop(c: UsbDeviceConnection, pkt: Int) {
        val (ifx, ep) = candidates[candIdx]

        // 找 OUT 端点（命令通道）
        var epOut: UsbEndpoint? = null
        for (i in 0 until ifx.endpointCount) {
            val e = ifx.getEndpoint(i)
            if (e.direction == UsbConstants.USB_DIR_OUT) { epOut = e; break }
        }

        var req = UsbRequest()
        if (!req.initialize(c, ep)) {
            lastError = "UsbRequest.initialize 失败"
            readMode = "init-failed"
            return
        }
        val bb = ByteBuffer.allocate(pkt)
        bb.clear()
        // 上一个流的 UsbRequest 可能还没完全收尾（重连竞态），queue 短暂重试
        var qOk = false
        for (attempt in 0 until 8) {
            if (req.queue(bb)) { qOk = true; break }
            Thread.sleep(50)
        }
        if (!qOk) {
            lastError = "首次 queue 失败"
            readMode = "queue-failed"
            try { req.close() } catch (_: Exception) {}
            return
        }

        // OUT 请求也由本线程独占，杜绝与 sendReport 抢 requestWait
        var outReq: UsbRequest? = null
        epOut?.let {
            val o = UsbRequest()
            if (o.initialize(c, it)) { outReq = o; lastSendInfo = "out-ready" }
            else lastSendInfo = "out-init-fail"
        }
        val outBuf = ByteBuffer.allocate(64)
        var outBusy = false
        var outBusySince = 0L

        while (running) {
            // 有命令且 OUT 空闲 → 排队发出
            if (!outBusy && outReq != null) {
                var cmd: ByteArray? = null
                synchronized(outLock) { if (pendingOut.isNotEmpty()) cmd = pendingOut.pollFirst() }
                if (cmd != null) {
                    outBuf.clear()
                    outBuf.put(cmd); outBuf.flip()
                    if (outReq!!.queue(outBuf)) {
                        outBusy = true; outBusySince = System.currentTimeMillis()
                        lastSendInfo = "queued"
                    } else {
                        lastSendInfo = "out-queue-fail"
                    }
                }
            }
            // OUT 卡住超过 3 秒就取消，避免阻塞后续命令
            if (outBusy && System.currentTimeMillis() - outBusySince > 3000) {
                try { outReq?.cancel() } catch (_: Exception) {}
                outBusy = false
                lastSendInfo = "out-timeout"
                addSysEvent("OUT超时取消")
            }

            // ⚠ 这里必须量墙钟：vivo 日志里 tries 高达 341/s，而 requestWait(300ms)
            //   若真在阻塞最多只能有 ~3/s。不量时间就无法证明「它到底等了没有」。
            val tWait0 = System.nanoTime()
            var r: UsbRequest? = null
            try {
                // 扫描期间缩短等待窗口，把 OUT 命令的吞吐从 ~3/s 提到 ~35/s
                val waitMs = if (sweeping) 25L else 300L
                r = if (Build.VERSION.SDK_INT >= 26) c.requestWait(waitMs) else c.requestWait()
            } catch (e: java.util.concurrent.TimeoutException) {
                // ⚠ requestWait(long) 的超时是**抛 TimeoutException**，不是返回 null（javap 实证）。
                //   这是"设备在 NAK"的正常表现，不能当故障塞进 sysEvents ——
                //   否则设备一沉默，80 条环形缓冲 24 秒就被刷满，真事件全被挤掉。
                rwTimeout++
            } catch (e: Exception) {
                rwExc++
                if (rwExc <= 5) addSysEvent("requestWait异常: $e")
            }
            val waitMsCost = (System.nanoTime() - tWait0) / 1_000_000
            waitSumMs += waitMsCost; waitN++
            waitAvgMs = if (waitN > 0) waitSumMs.toDouble() / waitN else 0.0
            if (waitMsCost > waitMaxMs) waitMaxMs = waitMsCost
            readTries++

            when {
                r === req -> {
                    val n = bb.position()
                    lastRet = n
                    if (n > 0) {
                        zeroRun = 0
                        val copy = bb.array().copyOf(n)
                        tryExtractSn(copy)
                        maybeHandshake(copy)
                        emitFrame(copy)
                    } else {
                        // 请求**立刻完成但 0 字节**。URB 错误状态在 Android 侧读不到，
                        // 所以只能靠端点 HALT 位来间接判定「设备回零长包」还是「端点被 STALL」。
                        readTimeouts++; rwZero++; zeroRun++
                        if (zeroRun > zeroRunMax) zeroRunMax = zeroRun
                        if (zeroRun % 300L == 0L) {
                            val halt = endpointHalt(c, ep.address)
                            epHaltIn = halt
                            addSysEvent("零长完成 ${zeroRun} 次（尚未收到任何数据帧）: " +
                                "端点0x${Integer.toHexString(ep.address)} halt=$halt")
                            if (halt == 1) {
                                if (clearHalt(c, ep.address)) {
                                    clearHaltCount++
                                    addSysEvent("已发送 CLEAR_FEATURE(ENDPOINT_HALT)，继续读")
                                }
                            }
                            dumpDiag(true)
                        }
                    }
                    bb.clear()
                    if (!req.queue(bb)) {
                        Log.w(TAG, "queue 失败，重建 UsbRequest")
                        addSysEvent("IN queue失败，重建 UsbRequest")
                        try { req.close() } catch (_: Exception) {}
                        val nr = UsbRequest()
                        if (!nr.initialize(c, ep)) { lastError = "重建 UsbRequest 失败"; break }
                        req = nr
                        if (!req.queue(bb)) { lastError = "重建后 queue 失败"; break }
                    }
                }
                // ⚠ 必须判 outReq != null：Kotlin 的 === 在两边都是 null 时也成立
                outReq != null && r === outReq -> {
                    outBusy = false
                    outLastMs = System.currentTimeMillis() - outBusySince
                    if (outLastMs > outMaxMs) outMaxMs = outLastMs
                    // UsbRequest 无 getStatus()，只能看耗时：3s 卡死由上面的 out-timeout 兜。
                    // position 在 OUT 方向是否回填无保证 → 不作为「发了几个字节」的判据。
                    lastSendInfo = "out-done(${outLastMs}ms pos=${outBuf.position()})"
                }
                r == null -> { lastRet = -4 }   // requestWait 正常不返回 null（超时是抛异常）
                else -> { /* 其他请求完成，忽略 */ }
            }
            dumpDiag()
        }
        try { req.close() } catch (_: Exception) {}
        try { outReq?.close() } catch (_: Exception) {}
        addSysEvent("读线程退出: running=$running lastRet=$lastRet frames=$frameTotal")
    }

    /** 批量端点：bulkTransfer */
    private fun bulkLoop(c: UsbDeviceConnection, pkt: Int) {
        val buf = ByteArray(pkt)
        var stall = 0
        while (running) {
            val (_, ep) = candidates[candIdx]
            val n = try { c.bulkTransfer(ep, buf, buf.size, 400) } catch (e: Exception) { -2 }
            readTries++
            lastRet = n
            if (n > 0) {
                stall = 0
                // ⚠ 原来这里只调 emitFrame → 走 bulk 端点时 SN/版本号永远解析不出来。
                //   与 requestLoop 对齐，信息帧解析必须在两条读路径上都在场。
                val copy = buf.copyOf(n)
                tryExtractSn(copy)
                maybeHandshake(copy)
                emitFrame(copy)
            } else {
                if (n == 0) readTimeouts++
                if (++stall > 25 && candidates.size > 1) {
                    stall = 0
                    candIdx = (candIdx + 1) % candidates.size
                    curEp = "0x" + Integer.toHexString(candidates[candIdx].second.address)
                }
            }
            dumpDiag()
        }
    }

    fun stopStream() {
        running = false
        // ⚠ 必须等读线程真正退出，才能安全关闭连接；
        //   提前 conn.close() 会撞上在飞的 requestWait → SIGSEGV（一加实测）
        thread?.join(2500)
        thread = null
        hbThread?.join(1500)
        hbThread = null
    }

    // ── 调试用：换端点、用 UsbRequest 试读 ────────────────
    /**
     * 用 UsbRequest 再试一轮（bulkTransfer 不灵时的备用通道）。
     * 返回一段可读的结果描述，供界面显示。
     */
    fun tryRequestRead(timeoutMs: Int = 1500): String {
        if (running) return "读流运行中，跳过（与读线程共用连接，并发会崩溃）"
        val c = conn
        if (c == null) return "未连接"
        if (candidates.isEmpty()) return "无端点"
        val (f, ep) = candidates[candIdx]
        return try {
            val req = UsbRequest()
            if (!req.initialize(c, ep)) return "initialize 失败"
            val bb = ByteBuffer.allocate(REPORT_LEN)
            if (!req.queue(bb)) return "queue 失败"
            val r = if (Build.VERSION.SDK_INT >= 26) c.requestWait(timeoutMs.toLong()) else c.requestWait()
            val got = if (r != null) bb.position() else -1
            val body = if (got > 0) bb.array().take(got).joinToString(" ") {
                String.format(Locale.US, "%02x", it.toInt() and 0xFF)
            } else ""
            req.close()
            "requestWait: ret=${r != null} got=$got $body"
        } catch (e: Exception) {
            "TryRequest 异常: $e"
        }
    }

    fun drainFrames(): JSONArray {
        val arr = JSONArray()
        synchronized(qLock) {
            while (queue.isNotEmpty()) {
                val f = queue.pollFirst() ?: break
                val o = JSONObject()
                o.put("t", f.t)
                o.put("hex", hex(f.data))
                arr.put(o)
            }
        }
        return arr
    }

    fun sniff(): JSONObject {
        val frames = synchronized(sniffer) { sniffer.toList() }
        val o = JSONObject()
        o.put("count", frames.size)
        if (frames.isEmpty()) return o
        val len = frames.maxOf { it.size }
        o.put("len", len)
        val last = JSONArray()
        frames.takeLast(24).forEach { last.put(hex(it)) }
        o.put("last", last)

        val constIdx = JSONArray(); val varIdx = JSONArray()
        val mins = JSONArray(); val maxs = JSONArray()
        for (i in 0 until len) {
            var mn = 255; var mx = 0
            val seen = HashSet<Int>()
            for (f in frames) {
                val v = if (i < f.size) f[i].toInt() and 0xFF else 0
                if (v < mn) mn = v
                if (v > mx) mx = v
                seen.add(v)
            }
            mins.put(mn); maxs.put(mx)
            if (seen.size > 1) varIdx.put(i) else constIdx.put(i)
        }
        o.put("constIdx", constIdx)
        o.put("varIdx", varIdx)
        o.put("min", mins)
        o.put("max", maxs)
        return o
    }

    /** 待发送的输出报告（命令）。由读线程统一收发，避免 requestWait 争用。 */
    private val pendingOut = ArrayDeque<ByteArray>()
    private val outLock = Any()

    @Volatile var lastSendInfo: String = ""
    /** USB 描述符里的 bcdDevice（BCD，如 0x0200 → "2.00"）。
     *  ⚠ 仅作诊断交叉验证，**不参与显示** —— 它是 USB 硬件版本号（REV_0200），
     *    在 PC 表上恰好等于固件版本 2.00，但 SE 上是 0x0001 ≠ 固件 V1.10，语义不可靠。 */
    @Volatile var bcdDevice: String = ""

    private fun readBcdDevice(c: UsbDeviceConnection): String = try {
        val r = c.rawDescriptors
        if (r != null && r.size >= 14) {
            val v = (r[12].toInt() and 0xFF) or ((r[13].toInt() and 0xFF) shl 8)
            String.format(Locale.US, "%X.%02X", v shr 8, v and 0xFF)
        } else ""
    } catch (_: Exception) { "" }

    /** 从设备信息帧解出的产品 SN（BCD 压缩，如 12 34 56 78 → 12345678） */
    @Volatile var productSn: String = ""

    /** USB 描述符注释：fwVersion 不再取 bcdDevice（那是 USB 硬件版本 REV_0200，
     *  与固件版本无关——之前"永远显示 2.00"的根源）。固件版本只认信息帧 SW 字节。 */
    @Volatile var fwVersion: String = ""

    // ── START 参数扫描 ─────────────────────────────────────────────
    // 帧格式（2026-10-09 用 CRC16 逐字节验过，三条命令 3/3 命中）：
    //   AA | LEN(整帧字节数) | DATA | CRC16(BE)     poly=0x2507 init=0x11 结果+1 不反转
    //   START = AA 0C FF "ready" + 2字节参数 + CRC16
    //   抓到的官方帧 aa 0c ff 72 65 61 64 79 33 32 a1 20：
    //     [8][9] = 33 32 ← 参数    [10][11] = a1 20 ← CRC16(前 10 字节)
    //   ⚠ 旧代码把扫描值写进 [10][11]（CRC 字段）且不重算 CRC —— 65536 个变体里
    //     最多只有 1 个是合法帧，扫描在数学上不可能命中。已修正为改 [8][9] + 重算 CRC。
    //   参数来源假设：官方序列 INFO→INFO→START(间隔 2ms)，说明参数取自 0x1A 应答。
    //     佐证：PC 表信息帧 SN 之后是 0f c8 33 32 fc 35，[22][23] 恰好 = 33 32。
    @Volatile var sweeping: Boolean = false
        private set
    @Volatile var sweepResult: String = ""
    @Volatile var sweepProgress: String = ""
    @Volatile private var foundStartParam: ByteArray? = null

    /** 当前应使用的 START 命令（扫描命中后切换到真参数） */
    private fun currentStartCmd(): ByteArray {
        val c = CMD_START.copyOf()
        foundStartParam?.let { setStartParam(c, it[0].toInt() and 0xFF, it[1].toInt() and 0xFF) }
        return c
    }

    /** 把 2 字节参数写进 [8][9] 并重算 CRC 写入 [10][11] */
    private fun setStartParam(c: ByteArray, b0: Int, b1: Int) {
        c[8] = b0.toByte(); c[9] = b1.toByte()
        val crc = crc16(c.copyOfRange(0, 10))
        c[10] = (crc shr 8).toByte(); c[11] = (crc and 0xFF).toByte()
    }

    /** 手动触发（JS 桥 / 调试页）；静默超时也会自动触发 */
    fun sweepMagic(): String {
        if (sweeping) return "扫描进行中: $sweepProgress"
        if (sweepResult.isNotEmpty()) return "上次结果: $sweepResult"
        if (conn == null || !running) return "未连接或读流未运行"
        Thread { runSweep() }.also { it.isDaemon = true; it.start() }
        return "扫描已启动（结果见 diag.txt 的 sweepResult 与 sysEvents）"
    }

    /** 信息帧原始字节（从同步头起）：参数/版本字段溯源的唯一依据 */
    @Volatile private var infoRaw: ByteArray = ByteArray(0)

    /** 候选参数，优先取信息帧尾部相邻窗口；再兜 SN 派生规则；最后 PC 表原值 */
    private fun paramCandidates(): List<Pair<Int, Int>> {
        val out = ArrayList<Pair<Int, Int>>()
        val r = infoRaw
        for (o in intArrayOf(22, 24, 20)) {
            if (r.size >= o + 2) out.add((r[o].toInt() and 0xFF) to (r[o + 1].toInt() and 0xFF))
        }
        out.add(0x33 to 0x32)                       // PC 表实测原值
        val s = snRaw
        if (s.size == 4) {
            val sum = (s[0].toInt() + s[1].toInt() + s[2].toInt() + s[3].toInt()) and 0xFF
            var x = 0
            for (b in s) x = x xor (b.toInt() and 0xFF)
            out.add(sum to 0x20); out.add(x to 0x20); out.add(((-sum) and 0xFF) to 0x20)
        }
        return out
    }

    private fun runSweep() {
        if (sweeping) return
        sweeping = true
        try {
            addSysEvent("参数扫描: 开始 snRaw=${snRaw.joinToString("") { "%02x".format(it) }} infoRaw=${hex(infoRaw)}")
            val tried = HashSet<Int>()
            val cands = ArrayDeque<Pair<Int, Int>>()
            paramCandidates().forEach { cands.add(it) }
            for (b0 in 0..255) for (b1 in 0..255) cands.add(b0 to b1)   // 兜底全空间
            var n = 0
            for ((b0, b1) in cands) {
                if (!running || conn == null) { sweepResult = "中断(连接断开)"; return }
                val key = (b0 shl 8) or b1
                if (!tried.add(key)) continue
                val before = measTotal
                val cmd = CMD_START.copyOf()
                setStartParam(cmd, b0, b1)          // ⚠ 改 [8][9] 并重算 CRC，不是改 CRC 字段
                sendReport(cmd)
                Thread.sleep(40)
                if (measTotal > before) {
                    foundStartParam = byteArrayOf(b0.toByte(), b1.toByte())
                    sweepResult = String.format("HIT: param=%02x %02x (第%d次尝试)", b0, b1, tried.size)
                    addSysEvent("参数扫描: ★命中 [8][9]=${"%02x %02x".format(b0, b1)} (第${tried.size}次尝试)")
                    dumpDiag(true)
                    return
                }
                n++
                if (n % 200 == 0) {
                    sweepProgress = "$n/${tried.size}"
                    addSysEvent("参数扫描: 已试 $n 无命中")
                    dumpDiag(true)
                }
            }
            sweepResult = "无命中(共${tried.size}个变体)"
            addSysEvent("参数扫描: 无命中，参数空间已穷尽")
            dumpDiag(true)
        } catch (_: Exception) {
            sweepResult = "扫描异常"
        } finally {
            sweeping = false
        }
    }

    @Volatile private var handshakeDone = false

    /** CRC16：多项式 0x2507、初值 0x11、结果 +1、不反转（官方协议规范） */
    private fun crc16(data: ByteArray): Int {
        var crc = 0x11
        for (b in data) {
            crc = crc xor ((b.toInt() and 0xFF) shl 8)
            repeat(8) {
                crc = if (crc and 0x8000 != 0) ((crc shl 1) xor 0x2507) and 0xFFFF else (crc shl 1) and 0xFFFF
            }
        }
        return (crc + 1) and 0xFFFF
    }

    private fun fmtVer(v: Int): String =
        if (v >= 100) String.format(Locale.US, "V%d.%02d", v / 100, v % 100)
        else String.format(Locale.US, "V%d.%d", v / 10, v % 10)

    /** 信息帧到达 → 按规范完成动态握手：
     *  提取校验值[22..23]与软件版本[21]，回发连接命令 AA 0C FF "ready" + 校验值 + CRC16 */
    private fun maybeHandshake(f: ByteArray) {
        if (handshakeDone) return
        // ⚠ 必须与 tryExtractSn 用同一套定位。原来这里直接读 f[1]/f[3]/f[20..23]（隐含同步头恒在 0），
        //   而 tryExtractSn 走 syncIndex —— 帧里一旦多一个前缀字节（PC 65B 格式），两者结论会互相打架。
        val i = syncIndex(f)
        if (i < 0 || f.size < i + 26) return
        if ((f[i + 1].toInt() and 0xFF) != 0x1A) return
        handshakeDone = true
        val conn = f[i + 3].toInt() and 0xFF
        val hw = f[i + 20].toInt() and 0xFF
        val sw = f[i + 21].toInt() and 0xFF
        infoRaw = f.copyOfRange(i, f.size)
        infoTail = hex(f.copyOfRange(i + 20, minOf(i + 26, f.size)))
        infoFrameHex = hex(f)
        // 版本只在字节合理时才显示（0x00/0xFF 说明该机型此字段无效 → 界面显示 "—"）
        fwVersion = if (sw in 1..0xFE) fmtVer(sw) else ""
        // 交叉验证：PC 表 [21]=0xC8=200 → "V2.00"，与 bcdDevice 0x0200→"2.00" 及官方 RKX3V2.00 三者一致。
        // 若下一份日志里这两者长期不一致，说明 [21] 不是版本字段，应改回显示 "—"。
        val agree = fwVersion.removePrefix("V") == bcdDevice
        addSysEvent("信息帧: conn=$conn HW=$hw SW=$sw → ${if (fwVersion.isEmpty()) "(无效,不显示)" else fwVersion}" +
            " | bcdDevice=$bcdDevice 交叉验证=${if (agree) "一致" else "不一致⚠"} | tail=$infoTail")
        // 连接命令：AA + LEN(0C) + FF + "ready" + 校验值(2B 原样) + CRC16(2B 大端)，补零至 64
        val cmd = byteArrayOf(0xAA.toByte(), 0x0C, 0xFF.toByte(),
            0x72, 0x65, 0x61, 0x64, 0x79, f[i + 22], f[i + 23])
        val crc = crc16(cmd)
        val full = cmd + byteArrayOf((crc shr 8).toByte(), (crc and 0xFF).toByte())
        sendReport(full + ByteArray(64 - full.size))
        addSysEvent("动态连接命令: ${hex(full)}")
    }

    /** 异步投递一包 64 字节命令，实际发送由读线程负责 */
    fun sendReport(bytes: ByteArray): Boolean {        if (conn == null) { lastSendInfo = "no-conn"; return false }
        synchronized(outLock) {
            while (pendingOut.size >= 8) pendingOut.pollFirst()
            pendingOut.addLast(bytes)
        }
        lastSendInfo = "queued"
        return true
    }

    /** 定位同步头 0x55（PC 抓包帧在 1，Android 帧在 0），找不到返回 -1 */
    private fun syncIndex(b: ByteArray): Int {
        if (b.size >= 4 && (b[0].toInt() and 0xFF) == 0x55) return 0
        if (b.size >= 4 && (b[1].toInt() and 0xFF) == 0x55) return 1
        return -1
    }

    /** 测量帧 → "  → 5.12345V 1.23456A 6.32345W"（写诊断用） */
    private fun frameVI(b: ByteArray): String {
        val i = syncIndex(b)
        if (i < 0 || i + 11 > b.size) return ""
        if ((b[i + 1].toInt() and 0xFF) != 0x1B) return ""
        val v = ByteBuffer.wrap(b, i + 3, 4).order(ByteOrder.BIG_ENDIAN).getFloat()
        val a = ByteBuffer.wrap(b, i + 7, 4).order(ByteOrder.BIG_ENDIAN).getFloat()
        return String.format(Locale.US, "  → %.5fV %.5fA %.5fW", v, a, v * a)
    }

    /** 从帧里尝试提取产品 SN：
     *  X3 系：BCD 压缩（每字节两位十进制，如 12 34 56 78 → 12345678）
     *  X3 SE：HEX 格式（固件字符串 SN: %08X，如 26 03 ea 50 → 2603EA50）
     *  全 0 / 全 FF 视为无效 */
    @Volatile var snRaw: ByteArray = ByteArray(0)
        private set

    private fun tryExtractSn(f: ByteArray) {
        val i = syncIndex(f)
        if (i < 0 || i + 20 > f.size) return
        if ((f[i + 1].toInt() and 0xFF) != 0x1A) return
        // 信息帧全量留痕：handshakeDone 之后 maybeHandshake 不会再记录，这里补上
        infoRaw = f.copyOfRange(i, f.size)
        infoFrameHex = hex(f)
        if (f.size >= i + 26) infoTail = hex(f.copyOfRange(i + 20, i + 26))
        snRaw = f.copyOfRange(i + 16, i + 20)
        val sb = StringBuilder()
        var allBcd = true
        for (k in i + 16..i + 19) {
            val v = f[k].toInt() and 0xFF
            val hi = v shr 4
            val lo = v and 0x0F
            if (hi > 9 || lo > 9) { allBcd = false; break }
            sb.append(hi).append(lo)
        }
        if (allBcd && sb.isNotEmpty()) { productSn = sb.toString(); return }
        // BCD 失败 → 按 X3 SE 的 %08X 十六进制格式显示
        val hexSn = String.format(Locale.US, "%02X%02X%02X%02X",
            f[i + 16], f[i + 17], f[i + 18], f[i + 19])
        if (hexSn != "00000000" && hexSn != "FFFFFFFF") productSn = hexSn
    }

    private fun hex(b: ByteArray): String {
        val sb = StringBuilder(b.size * 3)
        for (x in b) {
            val v = x.toInt() and 0xFF
            if (v < 16) sb.append('0')
            sb.append(Integer.toHexString(v)).append(' ')
        }
        return sb.toString().trim()
    }
}
