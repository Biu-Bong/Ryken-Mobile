package cn.ryken.mobile

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream

/**
 * 暴露给网页的 JS 接口 —— window.Ryken
 *
 * 网页侧用 setInterval 轮询 pollFrames() 取数据，
 * 解码在 JS 里做，这样改协议映射不用重新编 APK。
 */
class RykenBridge(private val ctx: Context) {

    private val ui = Handler(Looper.getMainLooper())

    @JavascriptInterface
    fun platform(): String = "android"

    /** 真实版本号（gradle versionName）。网页顶栏/关于页用它覆盖 HTML 里的硬编码字符串，
     *  防止"bump 了 gradle 忘改 index.html"造成界面版本与 APK 版本漂移（beta22 实际翻过车）。 */
    @JavascriptInterface
    fun version(): String = try {
        ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: ""
    } catch (e: Exception) { "" }

    @JavascriptInterface
    fun status(): String {
        val o = JSONObject()
        try {
            o.put("platform", "android")
            o.put("connected", RykenUsb.conn != null)
            o.put("streaming", RykenUsb.running)
            o.put("fps", RykenUsb.fps)
            o.put("error", RykenUsb.lastError)
            o.put("hasDevice", RykenUsb.findDevice() != null)
            // 诊断
            o.put("diag", RykenUsb.diag)
            o.put("tries", RykenUsb.readTries)
            o.put("timeouts", RykenUsb.readTimeouts)
            o.put("lastRet", RykenUsb.lastRet)
            o.put("frames", RykenUsb.frameTotal)
            o.put("ep", RykenUsb.curEp)
            o.put("lastSend", RykenUsb.lastSendInfo)
            o.put("productSn", RykenUsb.productSn)
            o.put("fwVersion", RykenUsb.fwVersion)
            o.put("bcdDevice", RykenUsb.bcdDevice)
            o.put("readMode", RykenUsb.readMode)
            o.put("measFrames", RykenUsb.measTotal)
            o.put("infoTail", RykenUsb.infoTail)
            o.put("sweepResult", RykenUsb.sweepResult)
            // ── 读循环三态分解：判定「设备在 NAK / 回零长包 / 端点被 STALL」的唯一依据 ──
            // UsbRequest 没有 getStatus()，URB 错误状态读不到，只能靠这套计数 + 端点 HALT 位。
            o.put("rw", JSONObject().apply {
                put("timeout", RykenUsb.rwTimeout)    // 300ms 内没完成（设备在 NAK）
                put("zeroLen", RykenUsb.rwZero)       // 立刻完成但 0 字节
                put("exc", RykenUsb.rwExc)            // 非超时异常
            })
            o.put("epHaltIn", RykenUsb.epHaltIn)      // -1 未知 / 0 正常 / 1 被 STALL
            o.put("zeroRun", RykenUsb.zeroRun)
            o.put("zeroRunMax", RykenUsb.zeroRunMax)
            o.put("clearHaltCount", RykenUsb.clearHaltCount)
            o.put("waitAvgMs", RykenUsb.waitAvgMs)
            o.put("waitMaxMs", RykenUsb.waitMaxMs)
            o.put("out", JSONObject().apply {
                put("lastMs", RykenUsb.outLastMs)
                put("maxMs", RykenUsb.outMaxMs)
            })
            // 权限与电池优化状态（排查"卡在哪一步"的关键）
            try {
                val d = RykenUsb.device
                val m = RykenUsb.manager
                if (d != null && m != null) o.put("usbPermission", m.hasPermission(d))
            } catch (_: Exception) {}
            try {
                val pm = ctx.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
                o.put("batteryOptIgnored", pm.isIgnoringBatteryOptimizations(ctx.packageName))
            } catch (_: Exception) {}
            o.put("appVersion", try {
                ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName
            } catch (_: Exception) { "?" })
            o.put("sysEvents", JSONArray(RykenUsb.sysEventList()))
            o.put("frameTimeline", JSONArray(RykenUsb.frameTimelineList()))
            val d = RykenUsb.device
            o.put("device", if (d != null) RykenUsb.describe(d) else JSONObject.NULL)
        } catch (e: JSONException) {
            Log.w("RykenBridge", "status: $e")
        }
        return o.toString()
    }

    /** 触发连接：没授权会弹系统授权框，授权后自动打开 */
    @JavascriptInterface
    fun connect(): Boolean {
        return try { RykenUsb.connect(ctx) } catch (e: Exception) {
            Log.w("RykenBridge", "connect: $e"); false
        }
    }

    @JavascriptInterface
    fun disconnect() = RykenUsb.close()

    @JavascriptInterface
    fun startStream(): Boolean = RykenUsb.startStream()

    @JavascriptInterface
    fun stopStream() = RykenUsb.stopStream()

    /** 协议监听"开闸"：开/关设备对 PD(0)/UFCS(1) 报文的上报（官方「PD协议分析仪·开始」同款命令） */
    @JavascriptInterface
    fun protoListen(on: Boolean, type: Int): Boolean =
        try { RykenUsb.protoListen(on, type) } catch (e: Exception) { false }

    /** 取走自上次调用以来累积的帧，返回 JSON 数组 [{t, hex}] */
    @JavascriptInterface
    fun pollFrames(): String = RykenUsb.drainFrames().toString()

    /** 原始快照 + 逐字节变化统计 */
    @JavascriptInterface
    fun sniff(): String = RykenUsb.sniff().toString()

    /** 备用读法：控制传输探针 + UsbRequest 试读一次 */
    @JavascriptInterface
    fun tryRequest(): String {
        RykenUsb.probe()
        return RykenUsb.probeResult + "\n-- " + RykenUsb.tryRequestRead()
    }

    /** 重新打开设备（拔插后救急） */
    @JavascriptInterface
    fun reconnect(): Boolean {
        return try {
            RykenUsb.close()
            Thread.sleep(200)
            val ok = RykenUsb.connect(ctx)
            if (ok) RykenUsb.startStream()
            ok
        } catch (e: Exception) {
            Log.w("RykenBridge", "reconnect: $e"); false
        }
    }

    /**
     * 尝试「软拔插」：不物理拔插，用 USB 标准请求 SET_CONFIGURATION(0)→(1)
     * 强制设备重新配置端点（详见 RykenUsb.usbReset 的注释）。
     * 返回诊断文本；调用后需要再 connect() 一次才会重新开流。
     */
    @JavascriptInterface
    fun usbReset(): String = try {
        RykenUsb.usbReset()
    } catch (e: Exception) {
        Log.w("RykenBridge", "usbReset: $e")
        "EXC:${e.javaClass.simpleName}"
    }

    /**
     * 更强的一档「软拔插」：向 usbfs 发 USBDEVFS_RESET（端口级复位）。
     * 比 usbReset() 的 SET_CONFIGURATION 更底层，等价于主机侧重新枚举。
     */
    @JavascriptInterface
    fun usbFsReset(): String = try {
        RykenUsb.usbFsReset()
    } catch (e: Exception) {
        Log.w("RykenBridge", "usbFsReset: $e")
        "EXC:${e.javaClass.simpleName}"
    }

    /** 发送一个输出报告（hex 字符串，空格分隔），供后续命令探索用 */
    @JavascriptInterface
    fun sendReport(hex: String): Boolean {
        return try {
            val parts = hex.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
            val bytes = ByteArray(parts.size) { parts[it].toInt(16).toByte() }
            RykenUsb.sendReport(bytes)
        } catch (e: Exception) {
            Log.w("RykenBridge", "sendReport: $e"); false
        }
    }

    /** 魔数扫描：自动遍历 START 尾字节找当前表的真魔数（排查按表派生校验） */
    @JavascriptInterface
    fun sweepMagic(): String = RykenUsb.sweepMagic()

    @JavascriptInterface
    fun listDevices(): String = RykenUsb.listDevices().toString()

    @JavascriptInterface
    fun toast(msg: String) {
        ui.post { Toast.makeText(ctx, msg, Toast.LENGTH_SHORT).show() }
    }

    /** 机型与系统信息（日志反馈用：什么手机、什么型号、什么安卓版本） */
    @JavascriptInterface
    fun deviceInfo(): String {
        val o = JSONObject()
        try {
            o.put("brand", android.os.Build.BRAND)
            o.put("manufacturer", android.os.Build.MANUFACTURER)
            o.put("model", android.os.Build.MODEL)
            o.put("device", android.os.Build.DEVICE)
            o.put("android", android.os.Build.VERSION.RELEASE)
            o.put("sdk", android.os.Build.VERSION.SDK_INT)
            val pm = ctx.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
            o.put("batteryOptIgnored", pm.isIgnoringBatteryOptimizations(ctx.packageName))
            o.put("usbHost", ctx.packageManager.hasSystemFeature(android.content.pm.PackageManager.FEATURE_USB_HOST))
            o.put("appVersion", try {
                ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName
            } catch (_: Exception) { "?" })
        } catch (e: Exception) {
            Log.w("RykenBridge", "deviceInfo: $e")
        }
        return o.toString()
    }

    /** 系统栏 + 左右挖孔 inset（网页加载后主动查询用；insets 回调早于 JS 就绪时补此通道） */
    @JavascriptInterface
    fun sysbars(): String =
        "{\"top\":${MainActivity.sysTop},\"nav\":${MainActivity.sysNav}," +
        "\"left\":${MainActivity.sysLeft},\"right\":${MainActivity.sysRight}}"

    /** 屏幕方向：auto（跟随系统自动旋转）/ portrait / landscape */
    @JavascriptInterface
    fun setOrientation(mode: String) {
        try {
            (ctx as? MainActivity)?.setOrientationMode(mode)
        } catch (e: Exception) {
            Log.w("RykenBridge", "setOrientation: $e")
        }
    }

    /** 沉浸：隐藏/恢复状态栏（网页设置「隐藏状态栏」开关；顶部下滑可临时唤出） */
    @JavascriptInterface
    fun setImmersive(hidden: Boolean) {
        try {
            (ctx as? MainActivity)?.setImmersiveMode(hidden)
        } catch (e: Exception) {
            Log.w("RykenBridge", "setImmersive: $e")
        }
    }

    /** 屏幕常亮（网页设置「屏幕常亮」开关）：窗口 FLAG_KEEP_SCREEN_ON，CPU/屏幕策略由系统管 */
    @JavascriptInterface
    fun setKeepScreenOn(on: Boolean) {
        ui.post {
            try {
                val act = ctx as? android.app.Activity ?: return@post
                if (on) act.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else act.window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } catch (e: Exception) {
                Log.w("RykenBridge", "setKeepScreenOn: $e")
            }
        }
    }

    /**
     * 抓取 URL 的文本内容（固件「检查更新」用）。
     * WebView 里 fetch 会被 CORS 拦 —— 原生 HttpURLConnection 没有这个限制，
     * JS 桥方法本身跑在后台线程，同步阻塞 OK（内部 8s 超时）。
     * 失败时返回 "HTTP_ERROR <code>" / "FETCH_ERROR <msg>"，网页侧如实报错。
     *
     * ⚠ 同步版会卡住 JavaBridge 线程最坏 16s（连接+读超时），期间 pollFrames 等
     *   所有桥调用全部停摆 → 实时读数停跳。新代码请用下面的 fetchTextAsync。
     */
    @JavascriptInterface
    fun fetchText(url: String): String {
        return try {
            val conn = java.net.URL(url).openConnection() as java.net.HttpURLConnection
            conn.connectTimeout = 8000
            conn.readTimeout = 8000
            conn.instanceFollowRedirects = true
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android) Ryken-Mobile")
            val code = conn.responseCode
            if (code !in 200..299) {
                conn.disconnect()
                "HTTP_ERROR $code"
            } else {
                conn.inputStream.bufferedReader().use { it.readText() }
            }
        } catch (e: Exception) {
            Log.w("RykenBridge", "fetchText: $e")
            "FETCH_ERROR ${e.message ?: e.javaClass.simpleName}"
        }
    }

    /* ── fetchText 的异步版（2026-10-12 审核 3.2 修复）──
       立即返回，HTTP 在独立线程跑完，结果经 evaluateJavascript 回传：
       window.__rykenFetchText(id, jsonText) —— id 由网页侧生成，jsonText 已 JSON 编码。
       网页侧配套 nativeFetchText()（app.js），Promise 语义，检查更新期间 UI 不再冻结。 */
    private var webViewRef: java.lang.ref.WeakReference<android.webkit.WebView>? = null
    fun bindWebView(w: android.webkit.WebView) { webViewRef = java.lang.ref.WeakReference(w) }

    private fun evalJs(js: String) {
        ui.post {
            try { webViewRef?.get()?.evaluateJavascript(js, null) }
            catch (e: Exception) { Log.w("RykenBridge", "evalJs: $e") }
        }
    }

    @JavascriptInterface
    fun fetchTextAsync(url: String, id: Int) {
        Thread {
            val txt = fetchText(url)   // 复用同步实现（含 8s+8s 超时与错误前缀）
            evalJs("window.__rykenFetchText && window.__rykenFetchText($id, ${JSONObject.quote(txt)})")
        }.start()
    }

    /* ── 永硕云盘（ys168/ysepan）文件名列表（2026-10-12）──
       分享页是 JS 渲染的 SPA，fetchText 只能拿到 2KB 空壳；但协议可原生复现
       （参考开源 netdisk-fast-download 的 YsTool）：
         GET  https://<空间>.ysepan.com/            → Set-Cookie: jwttk_<dlmc>=<JWT>；HTML 内 window.htxx{qqdz,dlmc}
         POST {qqdz}ml/mldq   {}                    → {lb:[{bh,bt,sm}]} 全部一级目录
         POST {qqdz}wj/wjdq   {mlbh,kqmm,wjbh,ip1}  → {ml:{xzpz}, lb:[{wjm,dx,zml,wjlx}]}
       wj/wjdq 会把 zml（子目录分层）拍平返回 —— 每个目录一次调用即得整棵树的文件名，
       固件文件名自带版本号（RKX3V2.00.rar），网页侧直接喂 pickFwVersion。
       失败返回 "YS_ERROR <msg>"。结果经 __rykenFetchText(id, json) 回传（与 fetchTextAsync 同通道）。 */
    @JavascriptInterface
    fun ysListAsync(url: String, id: Int) {
        Thread {
            val result = try { ysList(url) }
                catch (e: Exception) { "YS_ERROR ${e.message ?: e.javaClass.simpleName}" }
            evalJs("window.__rykenFetchText && window.__rykenFetchText($id, ${JSONObject.quote(result)})")
        }.start()
    }

    /* ── 永硕域名的 TLS：根证书锁定（2026-10-12）──
       永硕的证书链是 Let's Encrypt 2025 代新 ECDSA 链（uupan.net ← E1 ← ISRG Root YE，
       YE 由 ISRG Root X2 交叉签名）—— Android 13 的系统证书库没有对应根，
       K20 握手必死（CertPathValidatorException: Trust anchor not found），
       Android 16 的一加没问题。解法：assets/ys_root.pem 打包了服务器自带的 Root YE，
       ys 域名的连接用它做根锁定校验（服务器证书链末端指纹必须等于锁定值），
       其它任何 CA —— 包括真中间人 —— 都过不去。官方源 fetchText 不走这里，照旧系统严格校验。 */
    private var ysSslFactory: javax.net.ssl.SSLSocketFactory? = null

    private fun ysSsl(): javax.net.ssl.SSLSocketFactory {
        ysSslFactory?.let { return it }
        val pem = ctx.assets.open("ys_root.pem").bufferedReader().use { it.readText() }
        val der = android.util.Base64.decode(
            pem.replace("-----BEGIN CERTIFICATE-----", "").replace("-----END CERTIFICATE-----", "")
                .replace(Regex("\\s"), ""), android.util.Base64.DEFAULT)
        val root = java.security.cert.CertificateFactory.getInstance("X.509")
            .generateCertificate(der.inputStream()) as java.security.cert.X509Certificate
        val pin = java.security.MessageDigest.getInstance("SHA-256").digest(root.encoded)
        val tm = object : javax.net.ssl.X509TrustManager {
            override fun checkServerTrusted(chain: Array<java.security.cert.X509Certificate>, authType: String) {
                if (chain.isEmpty()) throw java.security.cert.CertificateException("空证书链")
                val fp = java.security.MessageDigest.getInstance("SHA-256").digest(chain.last().encoded)
                if (!fp.contentEquals(pin)) throw java.security.cert.CertificateException("根证书不匹配（非永硕官方链）")
            }
            override fun checkClientTrusted(chain: Array<java.security.cert.X509Certificate>, authType: String) =
                throw java.security.cert.CertificateException("client 侧不应被调用")
            override fun getAcceptedIssuers(): Array<java.security.cert.X509Certificate> = arrayOf(root)
        }
        val sslCtx = javax.net.ssl.SSLContext.getInstance("TLS")
        sslCtx.init(null, arrayOf<javax.net.ssl.TrustManager>(tm), null)
        ysSslFactory = sslCtx.socketFactory
        return ysSslFactory!!
    }

    private fun ysVerifyHost(host: String): Boolean {
        val h = host.lowercase()
        return h == "ys168.com" || h == "ysepan.com" || h.endsWith(".ys168.com") || h.endsWith(".ysepan.com")
    }

    /** ys 域名专用 HttpsURLConnection：根锁定 + 域名白名单（ysList 的三处连接全走这里） */
    private fun ysOpen(url: String): javax.net.ssl.HttpsURLConnection {
        val c = java.net.URL(url).openConnection() as javax.net.ssl.HttpsURLConnection
        c.sslSocketFactory = ysSsl()
        c.hostnameVerifier = javax.net.ssl.HostnameVerifier { host, _ -> ysVerifyHost(host) }
        return c
    }

    private fun ysList(url: String): String {
        val u = java.net.URL(url)
        val host = u.host.lowercase()
        if (!(host.endsWith(".ysepan.com") || host.endsWith(".ys168.com") ||
              host == "ysepan.com" || host == "ys168.com")) throw Exception("不是永硕云盘链接")
        val origin = "https://" + host

        // 1. GET 分享页：取 jwttk cookie（JWT）+ window.htxx（qqdz/dlmc）
        val conn = ysOpen(origin + "/")
        conn.connectTimeout = 8000; conn.readTimeout = 8000
        conn.instanceFollowRedirects = true
        conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android) Ryken-Mobile")
        val allHeaders = conn.headerFields
        var jwt = ""
        for ((k, v) in allHeaders) {
            if (k.equals("Set-Cookie", ignoreCase = true) || k == null) {
                for (c in v) {
                    val m = Regex("jwttk_[^=]+=([^;\\s]+)").find(c)
                    if (m != null) { jwt = m.groupValues[1]; break }
                }
            }
            if (jwt.isNotEmpty()) break
        }
        val html = conn.inputStream.bufferedReader().use { it.readText() }
        conn.disconnect()
        if (jwt.isEmpty()) throw Exception("未取到会话令牌（空间可能需要访问密码，暂不支持）")
        val htxx = extractJsObject(html, "window.htxx")
        val qqdz = htxx?.optString("qqdz") ?: throw Exception("页面里没有 htxx 配置")
        val apiBase = if (qqdz.endsWith("/")) qqdz else "$qqdz/"
        val dlmc = htxx.optString("dlmc", host.split(".")[0])   // 空间名（直链第一段）

        // 2. 目录列表
        val dirs = apiPostJson(apiBase + "ml/mldq", "{}", jwt, origin).optJSONArray("lb") ?: org.json.JSONArray()
        val names = StringBuilder()
        for (i in 0 until dirs.length()) {
            names.append(dirs.getJSONObject(i).optString("bt")).append('\n')
        }
        // 3. 逐目录列文件（全量目录，根约 22 个 × 1 请求 ≈ 数秒；社区盘里 SE 固件目录排 21 位，
        //    之前的 12 上限把它挡在外面 —— X3 SE 检查不到更新的根因之一）。
        //    文件行带直链：名字 \t https://ys-<fwq>.ysepan.com/wap/<空间>/<xzpz>/<pz>/<文件名>
        //    （网页侧「最新版本」点击跳转用；⚠ xzpz 前不能加 "_"，加了 404 —— YsTool 实证）
        for (i in 0 until dirs.length()) {
            val bh = dirs.getJSONObject(i).optInt("bh", 0)
            if (bh == 0) continue
            val body = JSONObject().put("mlbh", bh).put("kqmm", "").put("wjbh", 0).put("ip1", "")
            val fr = apiPostJson(apiBase + "wj/wjdq", body.toString(), jwt, origin)
            val lb = fr.optJSONArray("lb") ?: continue
            val xzpz = fr.optJSONObject("ml")?.optString("xzpz") ?: ""
            for (j in 0 until lb.length()) {
                val it = lb.getJSONObject(j)
                val n = it.optString("wjm")
                if (n.isEmpty()) continue
                val fwq = it.optString("fwq"); val pz = it.optString("pz")
                if (xzpz.isNotEmpty() && fwq.isNotEmpty() && pz.isNotEmpty() && it.optString("wjlx") != "url") {
                    names.append(n).append('\t')
                        .append("https://ys-${fwq.lowercase()}.ysepan.com/wap/")
                        .append(segEnc(dlmc)).append('/').append(segEnc(xzpz)).append('/')
                        .append(segEnc(pz)).append('/').append(segEnc(n)).append('\n')
                } else {
                    names.append(n).append('\n')
                }
            }
        }
        return names.toString()
    }

    /** 直链路径段编码：保留永硕 token 常见的 . , _ -（URLEncoder 会全编码导致 404） */
    private fun segEnc(v: String): String =
        java.net.URLEncoder.encode(v, "UTF-8")
            .replace("+", "%20").replace("%2E", ".")
            .replace("%2C", ",").replace("%5F", "_").replace("%2D", "-")

    /** 从 HTML 里抠出 `window.<name> = {...};` 的 JSON 对象（花括号配平，htxx 里有嵌套对象） */
    private fun extractJsObject(html: String, decl: String): JSONObject? {
        val i = html.indexOf(decl)
        if (i < 0) return null
        val start = html.indexOf('{', i)
        if (start < 0) return null
        var depth = 0
        var inStr = false
        var esc = false
        for (k in start until html.length) {
            val ch = html[k]
            if (esc) { esc = false; continue }
            when {
                ch == '\\' && inStr -> esc = true
                ch == '"' -> inStr = !inStr
                !inStr && ch == '{' -> depth++
                !inStr && ch == '}' -> { depth--; if (depth == 0) {
                    return try { JSONObject(html.substring(start, k + 1)) } catch (e: Exception) { null }
                } }
            }
        }
        return null
    }

    /** 用系统浏览器/外部应用打开链接（检查更新「最新版本」跳转下载页用；WebView 内跳会离开 App） */
    @JavascriptInterface
    fun openExternal(url: String) {
        try {
            val i = Intent(Intent.ACTION_VIEW, Uri.parse(url))
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            ctx.startActivity(i)
        } catch (e: Exception) {
            Log.w("RykenBridge", "openExternal: $e")
        }
    }

    private fun apiPostJson(url: String, body: String, jwt: String, origin: String): JSONObject {
        val conn = if (ysVerifyHost(java.net.URL(url).host)) ysOpen(url)
                   else java.net.URL(url).openConnection() as java.net.HttpURLConnection
        conn.requestMethod = "POST"
        conn.connectTimeout = 8000; conn.readTimeout = 10000
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        conn.setRequestProperty("Authorization", "Bearer " + jwt)
        conn.setRequestProperty("Origin", origin)
        conn.setRequestProperty("Referer", origin + "/")
        conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android) Ryken-Mobile")
        conn.outputStream.use { it.write(body.toByteArray()) }
        val code = conn.responseCode
        val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
            ?.bufferedReader()?.use { it.readText() } ?: ""
        conn.disconnect()
        if (code !in 200..299) throw Exception("HTTP $code")
        return JSONObject(text)
    }

    /** 同步主题到原生层：窗口背景 + 状态栏/导航栏图标颜色（亮色主题时图标变深） */
    @JavascriptInterface
    fun setNativeTheme(light: Boolean) {
        ui.post {
            try {
                val act = ctx as? android.app.Activity ?: return@post
                val color = if (light) 0xFFF6F8FB.toInt() else 0xFF080A0F.toInt()
                act.window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(color))
                act.window.decorView.background = android.graphics.drawable.ColorDrawable(color)
                if (android.os.Build.VERSION.SDK_INT >= 30) {
                    act.window.insetsController?.setSystemBarsAppearance(
                        if (light) (android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                            or android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS) else 0,
                        android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                            or android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
                    )
                } else {
                    @Suppress("DEPRECATION")
                    val v = act.window.decorView
                    @Suppress("DEPRECATION")
                    val flags = (android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                        or android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR)
                    v.systemUiVisibility = if (light) v.systemUiVisibility or flags
                    else v.systemUiVisibility and flags.inv()
                }
            } catch (e: Exception) {
                Log.w("RykenBridge", "setNativeTheme: $e")
            }
        }
    }

    /** 复制文本到系统剪贴板（日志反馈用） */
    @JavascriptInterface
    fun copyText(text: String) {
        try {
            val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
            cm.setPrimaryClip(android.content.ClipData.newPlainText("ryken", text))
            ui.post { Toast.makeText(ctx, "已复制", Toast.LENGTH_SHORT).show() }
        } catch (e: Exception) {
            Log.w("RykenBridge", "copyText: $e")
        }
    }

    /** 调系统分享（日志反馈用） */
    @JavascriptInterface
    fun shareText(text: String) {
        try {
            val i = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, text)
            }
            ctx.startActivity(Intent.createChooser(i, "分享日志").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            Log.w("RykenBridge", "shareText: $e")
        }
    }

    /* ══════════ 文件导出（Beta20 追加，用户 2026-10-11）══════════
       WebView 不会处理 blob: 加 a.download（本工程没装 DownloadListener），
       导出 CSV / 图片必须走原生。分块写：JS 每块不超过 128KiB，
       避免一次性跨 JNI 传十几 MB 的 CSV（20 万行约 16MB）。

       落盘位置：
       - API 29+ → MediaStore 写公共 Download/RYKEN/：免权限，
         文件管理器 / USB-MTP / 微信都能直接拿到；
       - API 24-28 → 降级到 App 外部私有目录（同样免权限，完整路径由 toast 给出）。
       ⚠ 本段不能用 Kotlin 块注释写带斜杠星号的路径，注释会嵌套、编译报 Unclosed comment。

       生命周期：fileBegin → fileWrite/fileWriteB64 ×N → fileEnd（或 fileAbort 回滚）。 */
    private var outStream: OutputStream? = null
    private var outUri: Uri? = null
    private var outPath: String = ""

    @JavascriptInterface
    fun fileBegin(name: String, mime: String): String {
        fileAbort()
        return try {
            if (Build.VERSION.SDK_INT >= 29) {
                val cv = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                    put(MediaStore.MediaColumns.MIME_TYPE, mime)
                    put(MediaStore.MediaColumns.RELATIVE_PATH,
                        Environment.DIRECTORY_DOWNLOADS + "/RYKEN")
                }
                val uri = ctx.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv)
                    ?: return ""
                outUri = uri
                val os = ctx.contentResolver.openOutputStream(uri)
                if (os == null) { fileAbort(); return "" }
                outStream = os
                outPath = "Download/RYKEN/$name"
            } else {
                val dir = File(ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "RYKEN")
                dir.mkdirs()
                val f = File(dir, name)
                outStream = FileOutputStream(f)
                outPath = f.absolutePath
            }
            outPath
        } catch (e: Exception) {
            Log.w("RykenBridge", "fileBegin: $e")
            fileAbort()
            ""
        }
    }

    /** 写一段 UTF-8 文本（CSV 用） */
    @JavascriptInterface
    fun fileWrite(text: String): Boolean {
        val os = outStream ?: return false
        return try {
            os.write(text.toByteArray(Charsets.UTF_8))
            os.flush()
            true
        } catch (e: Exception) {
            Log.w("RykenBridge", "fileWrite: $e")
            false
        }
    }

    /** 写一段 base64 二进制（PNG 用）。⚠ 分片必须 4 字节对齐，否则解码失败 */
    @JavascriptInterface
    fun fileWriteB64(b64: String): Boolean {
        val os = outStream ?: return false
        return try {
            os.write(Base64.decode(b64, Base64.DEFAULT))
            os.flush()
            true
        } catch (e: Exception) {
            Log.w("RykenBridge", "fileWriteB64: $e")
            false
        }
    }

    /** 收尾：返回最终路径（空串 = 失败） */
    @JavascriptInterface
    fun fileEnd(): String {
        val path = outPath
        try {
            outStream?.flush()
            outStream?.close()
        } catch (e: Exception) {
            Log.w("RykenBridge", "fileEnd: $e")
            outStream = null
            outUri = null
            outPath = ""
            return ""
        }
        outStream = null
        outUri = null
        outPath = ""
        return path
    }

    /** 中断并把 MediaStore 里那条半成品记录删掉，不留垃圾 */
    @JavascriptInterface
    fun fileAbort() {
        try { outStream?.close() } catch (_: Exception) {}
        outStream = null
        try { outUri?.let { ctx.contentResolver.delete(it, null, null) } } catch (_: Exception) {}
        outUri = null
        outPath = ""
    }

    /* ══════════ U 盘固件刷写（2026-10-12 新增）══════════

       背景：功率表按住「返回」键插线后进入 IAP 模式，USB 重新枚举为大容量存储
       （VID 2409 / PID 0926，序列号 XXXXXXXXXXXX），Android 的 vold 会自动挂载
       RKX3IAP 卷（8.35MB FAT）—— 实测 K20 Pro(Android 13) 会挂、文件管理器里
       显示为「USB设备」。往该卷根目录写入 RKX3.bin 即触发设备升级：
       文件名由 Ready.TXT 变为 Success.TXT，升级完成后设备自动脱开 U 盘、
       重新枚举回 HID（2026-10-12 已在电脑端与手机端各跑通一次）。

       ⚠ 只挂载第一个 LUN：设备实际有两个卷（RKX3IAP 8.35MB 与 RKX3 3.3MB），
       Android 的 vold 只挂第一个。刷固件不受影响（RKX3IAP 就是第一个），
       但换 LOGO / 换主题（文件在第二个卷）在手机上做不到，得用电脑。

       为什么必须走 SAF、不能用 File 路径直写：
       本工程 targetSdk 34，Android 13 的 Scoped Storage 下可移动卷无法用 File API
       直接访问；而 /mnt/media_rw/<uuid> 属 vold 私有区，实测连 adb shell 都被
       SELinux 拒绝（Permission denied），run-as 也被 ROM 禁掉。
       SAF 拿到的 treeUri 经 takePersistableUriPermission 持久化后长期有效，
       用户只需授权一次，且完全不必申请 MANAGE_EXTERNAL_STORAGE。

       与上面 fileBegin / fileWriteB64 那套的区别：那套写 MediaStore 公共目录，
       这套写外部卷根目录 —— 流状态必须分开，绝不能共用变量。
       ⚠ 本段注释里不要出现「斜杠 + 星号」的组合，否则块注释会嵌套、编译报 Unclosed comment。 */

    private var iapStream: OutputStream? = null
    private var iapDocUri: Uri? = null
    private var iapName: String = ""

    private fun iapPrefs() = ctx.getSharedPreferences("ryken_iap", Context.MODE_PRIVATE)

    /** 已授权的 U 盘根目录（MainActivity 的 SAF 回调写进来）；null = 还没授权过 */
    private fun iapTree(): Uri? =
        iapPrefs().getString("iap_tree", null)?.let { Uri.parse(it) }

    /** 列出手机上的存储卷 —— 用来确认"U 盘到底挂上了没"，也方便远程排查 */
    @JavascriptInterface
    fun iapVolumes(): String {
        val arr = JSONArray()
        try {
            val sm = ctx.getSystemService(Context.STORAGE_SERVICE) as android.os.storage.StorageManager
            for (v in sm.storageVolumes) {
                val o = JSONObject()
                try { o.put("uuid", v.uuid ?: "") } catch (_: Exception) {}
                try { o.put("label", v.getDescription(ctx)) } catch (_: Exception) {}
                try { o.put("removable", v.isRemovable) } catch (_: Exception) {}
                try { o.put("emulated", v.isEmulated) } catch (_: Exception) {}
                try { o.put("primary", v.isPrimary) } catch (_: Exception) {}
                try { o.put("state", v.state) } catch (_: Exception) {}
                try { o.put("path", v.directory?.absolutePath ?: "") } catch (_: Exception) {}
                arr.put(o)
            }
        } catch (e: Exception) {
            Log.w("RykenBridge", "iapVolumes: $e")
        }
        return arr.toString()
    }

    /** 拉起系统目录选择器去挑 U 盘根目录；结果由 MainActivity.onActivityResult 落盘保存。
     *  @param lastUuid JS 侧记住的「上次成功授权的卷」uuid（可空）——
     *         SAF 会用 EXTRA_INITIAL_URI 直接定位到它，多 U 盘时省得用户翻列表找 */
    @JavascriptInterface
    fun iapPickFolder(lastUuid: String?): Boolean {
        return try {
            (ctx as? MainActivity)?.pickIapFolder(lastUuid) ?: false
        } catch (e: Exception) {
            Log.w("RykenBridge", "iapPickFolder: $e"); false
        }
    }

    /** 当前已授权的目录；空串 = 未授权 */
    @JavascriptInterface
    fun iapFolder(): String = iapTree()?.toString() ?: ""

    // ══════ 唤醒锁（一加黑屏根因的软件解法）════════
    // 一加 dmesg 实锤：mtu3 USB 控制器在 suspend/resume 间振荡（ROM 电源管理激进），
    // U 盘刷写期间若 CPU 休眠，控制器挂起会打断写入/枚举。
    // 刷写期间持 PARTIAL_WAKE_LOCK 让 CPU 不睡。普通权限（Manifest 已有 WAKE_LOCK）。

    private var wakeLock: android.os.PowerManager.WakeLock? = null

    /** 刷写期间持部分唤醒锁（防 USB 控制器挂起）。重复调用安全 */
    @JavascriptInterface
    fun wakeLockAcquire(): Boolean {
        return try {
            if (wakeLock == null) {
                val pm = ctx.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
                wakeLock = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "Ryken:IapFlash")
            }
            wakeLock?.acquire(5 * 60 * 1000L)   // 5 分钟上限，防泄漏（刷写流程会提前释放）
            true
        } catch (e: Exception) { Log.w("RykenBridge", "wakeLockAcquire: $e"); false }
    }

    /** 刷写结束释放唤醒锁 */
    @JavascriptInterface
    fun wakeLockRelease() {
        try { wakeLock?.let { if (it.isHeld) it.release() } } catch (_: Exception) {}
    }

    fun iapClearFolder() {
        try { iapPrefs().edit().remove("iap_tree").apply() } catch (_: Exception) {}
    }

    /** 列已授权目录里的文件 —— 靠它识别升级阶段（Ready.TXT / Success.TXT） */
    @JavascriptInterface
    fun iapList(): String {
        val arr = JSONArray()
        val tree = iapTree() ?: return arr.toString()
        try {
            val children = android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(
                tree, android.provider.DocumentsContract.getTreeDocumentId(tree))
            ctx.contentResolver.query(
                children,
                arrayOf(
                    android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    android.provider.DocumentsContract.Document.COLUMN_SIZE
                ), null, null, null
            )?.use { c ->
                while (c.moveToNext()) {
                    arr.put(JSONObject().apply {
                        put("name", c.getString(0) ?: "")
                        put("size", c.getLong(1))
                    })
                }
            }
        } catch (e: Exception) {
            Log.w("RykenBridge", "iapList: $e")
        }
        return arr.toString()
    }

    /**
     * 开始写固件。同名文件必须先删 —— SAF 的 createDocument 遇到重名会自作主张
     * 改成 "RKX3 (1).bin"，那样设备端根本不认，升级会静默失败（没有任何报错）。
     */
    @JavascriptInterface
    fun iapWriteBegin(name: String): String {
        iapWriteAbort()
        val tree = iapTree() ?: return "未授权 U 盘目录"
        return try {
            val r = ctx.contentResolver
            val dirId = android.provider.DocumentsContract.getTreeDocumentId(tree)
            try {
                val children = android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(tree, dirId)
                r.query(children, arrayOf(
                    android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME
                ), null, null, null)?.use { c ->
                    while (c.moveToNext()) {
                        if (c.getString(1) == name) {
                            val doc = android.provider.DocumentsContract.buildDocumentUriUsingTree(tree, c.getString(0))
                            android.provider.DocumentsContract.deleteDocument(r, doc)
                        }
                    }
                }
            } catch (e: Exception) {
                Log.w("RykenBridge", "iapWriteBegin/del: $e")
            }
            /* ⚠ parent 必须是 **document URI**，不能直接把 treeUri 传进来 ——
               传 treeUri 会抛 IllegalArgumentException: Invalid URI: .../tree/D366-1696%3A
               （2026-10-12 实测踩到；而且这个异常被吞成一句"无法创建文件（权限或空间不足）"，
               把排查方向完全带偏，所以本方法改成返回错误字符串而不是 Boolean）。 */
            val parent = android.provider.DocumentsContract.buildDocumentUriUsingTree(tree, dirId)
            val created = android.provider.DocumentsContract.createDocument(
                r, parent, "application/octet-stream", name)
                ?: return "createDocument 返回 null（U 盘可能已被拔出）"
            val os = r.openOutputStream(created)
                ?: return "openOutputStream 返回 null（没有写权限）"
            iapStream = os
            iapDocUri = created
            iapName = name
            ""
        } catch (e: Exception) {
            Log.w("RykenBridge", "iapWriteBegin: $e")
            iapWriteAbort()
            (e.javaClass.simpleName + ": " + (e.message ?: "")).take(180)
        }
    }

    /** 分块写 base64。JS 侧每块 <= 96KiB，且分片长度必须 4 字节对齐，否则解码失败 */
    @JavascriptInterface
    fun iapWriteB64(b64: String): Boolean {
        val os = iapStream ?: return false
        return try {
            os.write(Base64.decode(b64, Base64.DEFAULT))
            true
        } catch (e: Exception) {
            Log.w("RykenBridge", "iapWriteB64: $e")
            false
        }
    }

    /** 收尾并返回文件名（空串 = 失败）。close 即落盘，设备随后会自己开始升级 */
    @JavascriptInterface
    fun iapWriteEnd(): String {
        val name = iapName
        return try {
            iapStream?.flush()
            iapStream?.close()
            iapStream = null
            iapDocUri = null
            iapName = ""
            name
        } catch (e: Exception) {
            Log.w("RykenBridge", "iapWriteEnd: $e")
            iapWriteAbort()
            ""
        }
    }

    /** 中途放弃：删掉刚建的那个半成品，别让它把设备带进一次失败的升级 */
    @JavascriptInterface
    fun iapWriteAbort() {
        try { iapStream?.close() } catch (_: Exception) {}
        iapStream = null
        try {
            iapDocUri?.let {
                /* ⚠ 必须用 DocumentsContract.deleteDocument()。
                   ContentResolver.delete() 对 SAF 的 DocumentsProvider **不生效** ——
                   实测调用后文件仍在盘上（2026-10-12 踩到：0 字节的 RKX3.bin 残留，
                   而设备会把它当固件去烧，非常危险）。 */
                android.provider.DocumentsContract.deleteDocument(ctx.contentResolver, it)
            }
        } catch (e: Exception) {
            Log.w("RykenBridge", "iapWriteAbort/del: $e")
        }
        iapDocUri = null
        iapName = ""
    }

    /**
     * 按文件名删除 U 盘上的文件（清理半成品 / 残留用）。
     * 返回 "" = 成功（含"本来就不存在"），否则返回错误原因。
     */
    @JavascriptInterface
    fun iapDelete(name: String): String {
        val tree = iapTree() ?: return "未授权 U 盘目录"
        return try {
            val r = ctx.contentResolver
            val dirId = android.provider.DocumentsContract.getTreeDocumentId(tree)
            val children = android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(tree, dirId)
            var hit = 0
            r.query(children, arrayOf(
                android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME
            ), null, null, null)?.use { c ->
                while (c.moveToNext()) {
                    if (c.getString(1) == name) {
                        val doc = android.provider.DocumentsContract.buildDocumentUriUsingTree(tree, c.getString(0))
                        if (android.provider.DocumentsContract.deleteDocument(r, doc)) hit++
                    }
                }
            }
            if (hit > 0) "" else "没找到 $name"
        } catch (e: Exception) {
            Log.w("RykenBridge", "iapDelete: $e")
            (e.javaClass.simpleName + ": " + (e.message ?: "")).take(180)
        }
    }
}
