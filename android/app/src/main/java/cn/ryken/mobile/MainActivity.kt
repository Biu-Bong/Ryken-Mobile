package cn.ryken.mobile

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout

/**
 * 主界面：WebView 壳 + USB 桥
 * 网页资源在 assets/www 下，与桌面/浏览器版共用同一套 UI 代码。
 */
private const val ASSET_HOST = "ryken.local"

private val MIME = mapOf(
    "html" to "text/html",
    "js" to "application/javascript",
    "mjs" to "application/javascript",
    "css" to "text/css",
    "json" to "application/json",
    "png" to "image/png",
    "jpg" to "image/jpeg",
    "jpeg" to "image/jpeg",
    "gif" to "image/gif",
    "svg" to "image/svg+xml",
    "ico" to "image/x-icon",
    "woff" to "font/woff",
    "woff2" to "font/woff2",
    "ttf" to "font/ttf",
    "map" to "application/json",
)

class MainActivity : Activity() {

    companion object {
        /** 当前系统栏 inset（CSS px，物理 px ÷ density），供 RykenBridge.sysbars() 补发 */
        @Volatile var sysTop = 0
        @Volatile var sysNav = 0
        /** 左右挖孔/刘海 inset（横屏时挖孔在左或右，必须让内容避开） */
        @Volatile var sysLeft = 0
        @Volatile var sysRight = 0
        /** 沉浸：网页设置里「隐藏状态栏」开关（横竖屏都藏；顶部下滑可临时唤出） */
        @Volatile var immersiveStatus = false
    }

    /** <input type=file> 请求码 */
    private val FILE_CHOOSER_REQ = 4001
    /** SAF 选 U 盘根目录的请求码（固件刷写用） */
    private val IAP_TREE_REQ = 4002

    private lateinit var web: WebView
    private lateinit var bridge: RykenBridge
    /** <input type=file> 回调（固件页「选择固件」）—— 不实现 onShowFileChooser 它就点不动 */
    private var filePathCallback: android.webkit.ValueCallback<Array<Uri>>? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        RykenUsb.init(this)
        RykenUsb.onStateChanged = {
            runOnUiThread { notifyWeb() }
        }
        bridge = RykenBridge(this)

        // 挂前台服务保活，否则退到后台会被 ColorOS 冻结
        try {
            val si = Intent(this, KeepAliveService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(si)
            else startService(si)
        } catch (e: Exception) {
            Log.w("Ryken", "启动保活服务失败: $e")
        }

        val root = FrameLayout(this)
        // 系统栏沉浸：WebView 铺满全屏，状态栏/导航栏直接压在网页背景上（任何主题/背景图都成立）。
        // 系统栏高度通过 __ryken_sysbars(top, nav) 传给网页，由页面自己垫高顶栏/底栏；
        // 原生只负责键盘（IME）弹出时把内容顶到键盘上方。
        root.setOnApplyWindowInsetsListener { v, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val ime = insets.getInsets(WindowInsets.Type.ime()).bottom
                val navI = insets.getInsets(WindowInsets.Type.navigationBars())
                val nav = navI.bottom
                // 挖孔/刘海：横屏时在左或右；三大金刚导航条在横屏也可能挂在左/右——
                // 两者每侧取 max（并集）作为左右让位宽度，否则导航条会把左侧数据挡住。
                // 背景延伸仍由页面自己控制：顶栏/底栏铺满，只有内容 padding 让位。
                val cut = insets.getInsets(WindowInsets.Type.displayCutout())
                // 顶部 = 状态栏与挖孔的并集；但「隐藏状态栏」开启时只算挖孔 ——
                // 顶栏要贴紧屏幕上缘（用户 2026-10-10），不能被已隐藏的状态栏高度垫住
                val stTop = insets.getInsets(WindowInsets.Type.statusBars()).top
                val top = if (immersiveStatus) cut.top else maxOf(stTop, cut.top)
                // 键盘弹出才原生垫底；键盘盖住导航条时网页侧 nav 记 0，避免双重空隙
                val bottom = if (ime > 0) ime else 0
                v.setPadding(0, 0, 0, bottom)
                // ⚠ 网页用 CSS 像素：物理 px 必须除以 density，否则垫高被放大 density 倍
                val dm = v.resources.displayMetrics.density
                val topCss = Math.round(top / dm)
                val navCss = Math.round(nav / dm)
                val lCss = Math.round(maxOf(cut.left, navI.left) / dm)
                val rCss = Math.round(maxOf(cut.right, navI.right) / dm)
                if (topCss != sysTop || navCss != sysNav || lCss != sysLeft || rCss != sysRight) {
                    sysTop = topCss
                    sysNav = if (ime > 0) 0 else navCss
                    sysLeft = lCss
                    sysRight = rCss
                    web.evaluateJavascript(
                        "window.__ryken_sysbars && window.__ryken_sysbars($topCss,$sysNav,$lCss,$rCss)", null)
                }
                try { insets.inset(android.graphics.Insets.of(0, 0, 0, bottom)) } catch (_: Exception) { insets }
            } else insets
        }
        web = WebView(this)
        root.addView(web, FrameLayout.LayoutParams(-1, -1))
        setContentView(root)

        /* WebView 远程调试：**恒开**（beta22 改）。原来用 FLAG_DEBUGGABLE 门控，
           但 release 包（即使 debug 签名）该 flag 恒为 false —— 真机上出了问题
           完全没法 CDP 远程排查（2026-10-12 查「检查更新失败」时就卡在这）。
           本 APK 是 debug 签名个人分发，CDP 只有 adb 转发后才能碰到，风险可控。 */
        WebView.setWebContentsDebuggingEnabled(true)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowContentAccess = true
            // 页面恒从 https://ryken.local 虚拟主机加载（见 loadUrl），file:// 相关开关已删——
            // 旧代码里的 allowFileAccess*/...FromFileURLs 是 file:// 时代的遗留，纯扩大攻击面
            cacheMode = WebSettings.LOAD_DEFAULT
            useWideViewPort = true
            loadWithOverviewMode = false
            builtInZoomControls = false
            displayZoomControls = false
            textZoom = 100
            mediaPlaybackRequiresUserGesture = false
            if (Build.VERSION.SDK_INT >= 26) safeBrowsingEnabled = false
        }
        web.setBackgroundColor(0xFF080A0F.toInt())
        web.isVerticalScrollBarEnabled = false
        web.isHorizontalScrollBarEnabled = false
        bridge.bindWebView(web)              // fetchTextAsync 回传结果用（evaluateJavascript）
        web.addJavascriptInterface(bridge, "Ryken")

        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(v: WebView, url: String?) {
                // insets 回调早于网页 JS 就绪，这里补发一次系统栏高度
                web.evaluateJavascript(
                    "window.__ryken_sysbars && window.__ryken_sysbars($sysTop,$sysNav,$sysLeft,$sysRight)", null)
                // 补发一次系统深色模式状态（WebView 的 prefers-color-scheme 不可靠，
                // 深浅切换由原生 onConfigurationChanged 主动推送）
                notifyNightMode(resources.configuration)
            }

            override fun shouldOverrideUrlLoading(v: WebView, req: WebResourceRequest): Boolean {
                val u = req.url
                if (u.host == ASSET_HOST) return false
                if (u.scheme == "file" || u.scheme == "about") return false
                try { startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (_: Exception) {}
                return true
            }

            override fun shouldInterceptRequest(v: WebView, req: WebResourceRequest): WebResourceResponse? {
                val u = req.url
                if (u.host != ASSET_HOST) return null
                return serveAsset(u.path ?: "/")
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                Log.i("RykenWeb", "${m.message()} @${m.lineNumber()}")
                return true
            }


            /** 网页 <input type=file>（固件页「选择固件」）→ 拉起系统文件选择器 */
            override fun onShowFileChooser(
                wv: WebView,
                cb: android.webkit.ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = cb
                return try {
                    startActivityForResult(params.createIntent(), FILE_CHOOSER_REQ)
                    true
                } catch (e: Exception) {
                    Log.w("Ryken", "onShowFileChooser: $e")
                    filePathCallback = null
                    false
                }
            }
        }

        web.loadUrl("https://$ASSET_HOST/index.html")
        // 沉浸：系统栏透明，透出网页背景（主题默认黑条在亮色主题下会穿帮）
        @Suppress("DEPRECATION")
        window.statusBarColor = android.graphics.Color.TRANSPARENT
        @Suppress("DEPRECATION")
        window.navigationBarColor = android.graphics.Color.TRANSPARENT
        hideSystemBars()
        // 导航模式切换（手势 ↔ 三大金刚键）时重新应用系统栏策略
        contentResolver.registerContentObserver(
            Settings.Secure.getUriFor("navigation_mode"), true,
            object : android.database.ContentObserver(Handler(Looper.getMainLooper())) {
                override fun onChange(selfChange: Boolean) {
                    runOnUiThread { hideSystemBars() }
                }
            })
        handleIntent(intent)
        requestIgnoreBatteryOpt()
    }

    /** 0 = 三大金刚键，2 = 全屏手势（AOSP 标准 key，MIUI 等同样使用） */
    private fun navMode(): Int = try {
        Settings.Secure.getInt(contentResolver, "navigation_mode", 2)
    } catch (_: Exception) { 2 }

    /** 引导用户关闭电池优化（ColorOS 冻结后台进程是断流主因；授权后此弹窗不再出现） */
    private fun requestIgnoreBatteryOpt() {
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            if (!pm.isIgnoringBatteryOptimizations(packageName)) {
                startActivity(
                    Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        Uri.parse("package:$packageName"))
                )
            }
        } catch (_: Exception) {}
    }

    /** 自定义源 -> assets/www 映射，绕开 file:// 的模块与 CORS 限制 */
    private fun serveAsset(path: String): WebResourceResponse? {
        var p = path.trimStart('/').split('?')[0].split('#')[0]
        if (p.isEmpty()) p = "index.html"
        // 显式拒绝路径穿越：AssetManager 对 ".." 的处理各版本不一致，不依赖它的默认行为
        if (p.contains("..")) {
            Log.w("Ryken", "asset 路径被拒绝: $p")
            return WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), null)
        }
        return try {
            val stream = assets.open("www/$p")
            val ext = p.substringAfterLast('.', "").lowercase()
            val resp = WebResourceResponse(MIME[ext] ?: "application/octet-stream", "utf-8", stream)
            /* 资源打进 APK、随版本更新——绝不缓存：否则覆盖安装后 WebView 还拿旧页面
               （MuMu 实测：覆盖装 beta19 后顶栏仍显示 beta16，就是缓存了旧 index.html） */
            resp.responseHeaders = mapOf("Cache-Control" to "no-store")
            resp
        } catch (e: Exception) {
            Log.w("Ryken", "asset 缺失: $p")
            WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), null)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(i: Intent?) {
        if (i == null) return
        if (i.action == UsbManager.ACTION_USB_DEVICE_ATTACHED) {
            val d = usbDeviceFrom(i)
            Log.i("Ryken", "USB 插入: ${d?.deviceName}")
            if (d != null) {
                autoConnect(d)
                /* ★ 设备重新枚举时（刷完固件重启，U 盘挂载→卸载→HID 回来），
                   一加/部分 ROM 会自动弹文件管理器抢前台（2026-10-12 一加实测），
                   把自己拉回前台，用户刷完直接看到结果而不用手动返回。 */
                try {
                    packageManager.getLaunchIntentForPackage(packageName)?.let {
                        it.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
                        startActivity(it)
                    }
                } catch (_: Exception) {}
            }
        } else {
            // 冷启动时若设备已插着，直接尝试连接
            if (RykenUsb.findDevice() != null) autoConnect(null)
        }
    }

    @Suppress("DEPRECATION")
    private fun usbDeviceFrom(i: Intent): UsbDevice? =
        if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
        else i.getParcelableExtra(UsbManager.EXTRA_DEVICE)

    private fun autoConnect(d: UsbDevice?) {
        /* ⚠ 防抖 + 并发保护（2026-10-12 踩坑）：
           半死自愈和插拔事件都会调到这里，而 autoConnect 是异步线程 + 700ms 延迟。
           没有保护时会出现"重连风暴"—— 实测日志里 startStream 被调到 #13、
           同一毫秒出现两条 START 补发（两个读循环并发），把设备搅得更乱。
           规则：正在重连中、或距上次不足 5 秒 → 直接跳过。 */
        val now = System.currentTimeMillis()
        if (reconnecting || now - lastAutoConnect < 5000L) {
            Log.i("Ryken", "autoConnect 跳过（防抖：reconnecting=$reconnecting 间隔=${now - lastAutoConnect}ms）")
            return
        }
        lastAutoConnect = now
        reconnecting = true
        Thread {
            // 等 WebView 把 JS 环境建起来
            try {
                Thread.sleep(700)
                RykenUsb.connect(this, d)
                if (RykenUsb.isOpen) {
                    RykenUsb.startStream()
                    Thread.sleep(1200)
                    RykenUsb.probe()        // 顺便探一次，方便远程诊断
                }
            } catch (e: Exception) {
                Log.w("Ryken", "autoConnect: $e")
            } finally {
                reconnecting = false
            }
            runOnUiThread { notifyWeb() }
        }.also { it.isDaemon = true; it.start() }
    }

    /** 正在重连中（防止并发重连开多个读循环） */
    @Volatile private var reconnecting = false
    /** 上次自动重连的时刻（5 秒防抖窗口） */
    @Volatile private var lastAutoConnect = 0L

    private fun notifyWeb() {
        web.evaluateJavascript(
            "window.__ryken_state && window.__ryken_state(${RykenUsb.isOpen}, ${RykenUsb.running});",
            null
        )
    }

    /**
     * 系统深色模式变化 → 推送给网页。
     * ⚠ Android WebView 的 `prefers-color-scheme` 不跟随系统深浅切换（matchMedia 收不到
     * change 事件），网页自己的监听形同虚设 —— 必须由原生读 uiMode 后主动推。
     * Manifest 已声明 uiMode configChanges，主题切换不会重建 Activity，这里能稳定收到。
     */
    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        notifyNightMode(newConfig)
    }

    private fun notifyNightMode(cfg: android.content.res.Configuration) {
        val night = (cfg.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==
            android.content.res.Configuration.UI_MODE_NIGHT_YES
        sysNight = night
        web.evaluateJavascript(
            "window.__ryken_nightmode && window.__ryken_nightmode($night)", null)
    }

    /** 系统夜间模式当前状态（onConfigurationChanged 推送，网页初始同步用） */
    @Volatile var sysNight = false

    /**
     * 屏幕方向：auto（跟随手机朝向）/ portrait / landscape。
     *
     * auto 用 SCREEN_ORIENTATION_SENSOR 而不是 UNSPECIFIED：后者只在系统
     * 「自动旋转」开着时才跟随传感器，关掉就等于锁死当前方向 —— 那样用户
     * 在设置里选「自动」却毫无反应。这里要的是「不看系统开关，App 自己跟随
     * 手机朝向」。
     *
     * 锁定横屏/竖屏用 SENSOR_LANDSCAPE / SENSOR_PORTRAIT 而不是
     * LANDSCAPE / PORTRAIT：锁定后仍允许在左右两个横置（或两个竖置）
     * 方向之间随传感器切换，左手右手握持都能用。
     */
    fun setOrientationMode(mode: String?) {
        val target = when (mode) {
            "portrait" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
            "landscape" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            else -> ActivityInfo.SCREEN_ORIENTATION_SENSOR
        }
        runOnUiThread {
            try {
                requestedOrientation = target
            } catch (e: Exception) {
                Log.w("Ryken", "setOrientation($mode): $e")
            }
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == FILE_CHOOSER_REQ) {
            val cb = filePathCallback
            filePathCallback = null
            cb?.onReceiveValue(
                android.webkit.WebChromeClient.FileChooserParams.parseResult(resultCode, data)
            )
        } else if (requestCode == IAP_TREE_REQ) {
            /* U 盘根目录授权结果。
               持久化授权（takePersistableUriPermission）必须做：不做的话本次进程内能用，
               App 一重启 treeUri 就失效，用户每次刷机都要重选一遍目录。
               treeUri 存 SharedPreferences，RykenBridge.iapTree() 读它。 */
            val uri = if (resultCode == RESULT_OK) data?.data else null
            if (uri != null) {
                try {
                    contentResolver.takePersistableUriPermission(
                        uri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    )
                } catch (e: Exception) {
                    Log.w("Ryken", "takePersistableUriPermission: $e")
                }
                getSharedPreferences("ryken_iap", MODE_PRIVATE)
                    .edit().putString("iap_tree", uri.toString()).apply()
                Log.i("Ryken", "IAP 目录已授权: $uri")
            }
            // 回网页：给个 Uri 字符串（空串 = 用户取消）；Uri 里不含单引号，直接内插安全
            web.evaluateJavascript(
                "window.__ryken_iap && window.__ryken_iap('${uri ?: ""}')", null)
        } else super.onActivityResult(requestCode, resultCode, data)
    }

    /**
     * 拉起系统目录选择器去挑 U 盘根目录（固件刷写用）。
     *
     * ⚠ 必须用 StorageVolume.createOpenDocumentTreeIntent() 直接把选择器定位到可移动卷：
     *   早期版本用的是裸 ACTION_OPEN_DOCUMENT_TREE，系统默认停在「内部存储」，
     *   用户在列表里很容易点错成 primary —— 结果授权到手机上，查不到 Ready.TXT，
     *   表现为「明明插着 U 盘却提示未开启 U 盘模式」（2026-10-12 实测踩到）。
     *   createOpenDocumentTreeIntent() 会带上 EXTRA_INITIAL_URI 指向该卷，用户只需确认。
     *   该方法 API 29+；低版本回落到裸 Intent（小米等 ROM 上仍能手动找到）。
     *
     * 为什么用 SAF 而不是 MANAGE_EXTERNAL_STORAGE：本工程 targetSdk 34，Android 13 的
     * Scoped Storage 不允许用 File 路径直接访问可移动卷；而 /mnt/media_rw/<uuid> 是
     * vold 私有区，实测连 adb shell 都被 SELinux 拒绝。SAF 只需授权一次、
     * 不申请任何敏感权限，是官方给可移动存储指定的路径。
     */
    fun pickIapFolder(lastUuid: String?): Boolean {
        return try {
            val sm = getSystemService(Context.STORAGE_SERVICE) as android.os.storage.StorageManager
            val vol = sm.storageVolumes.firstOrNull {
                it.isRemovable && !it.isEmulated && it.state == android.os.Environment.MEDIA_MOUNTED
            }
            Log.i("Ryken", "pickIapFolder: lastUuid=$lastUuid 可移动卷=${vol?.getDescription(this)} uuid=${vol?.uuid}")
            val i: Intent = if (Build.VERSION.SDK_INT >= 29 && vol != null) {
                vol.createOpenDocumentTreeIntent()
            } else {
                Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
            }
            /* ★ 上次成功授权的卷 → EXTRA_INITIAL_URI 直接定位过去。
               ⚠ createOpenDocumentTreeIntent() 定位的是 storageVolumes 里**第一个** removable ——
               多 U 盘时可能是另一块（一加实测：定位到 B8FB-9237，而功率表是 D366-1696），
               SAF 列表里两个卷显示得还不一样（K20 显示卷标 RKX3IAP，一加只显示序列号），
               用户根本不知道该换到哪个。用 JS 记住的 uuid 覆盖它，一次到位。 */
            if (!lastUuid.isNullOrEmpty()) {
                try {
                    val treeUri = android.provider.DocumentsContract.buildTreeDocumentUri(
                        "com.android.externalstorage.documents", "$lastUuid:")
                    i.putExtra(android.provider.DocumentsContract.EXTRA_INITIAL_URI, treeUri)
                } catch (e: Exception) {
                    Log.w("Ryken", "initialUri: $e")
                }
            }
            i.addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
            )
            startActivityForResult(i, IAP_TREE_REQ)
            true
        } catch (e: Exception) {
            Log.w("Ryken", "pickIapFolder: $e")
            false
        }
    }

    override fun onDestroy() {
        RykenUsb.onStateChanged = null       // 解除对 Activity 的引用，防泄漏（回调捕获了 this）
        RykenUsb.release(this)
        super.onDestroy()
    }

    override fun onResume() {
        super.onResume()
        hideSystemBars()
        // 回前台自愈：设备还插着但流停了（后台曾被冻结）→ 立即重连拉流
        if (RykenUsb.findDevice() != null && !RykenUsb.running) autoConnect(null)
        /* ⚠ 另一种自愈（2026-10-12 用户点出问题所在）：
           "连着、也在跑，但一个字节都没收到" —— 运行标志是 true，上面那条判断不到，
           于是 App 会永远挂着一条已经失效的连接，既不重连、也就不重新握手，
           表现就是"显示已连接，但读不到 SN / 固件号 / 测量值"。
           用户的疑问"它是不是每次连接新设备时才校验"完全正确 —— 握手（INFO 帧，
           SN 和固件号就是从那儿来的）只在建立新连接时做一次。
           所以这里要主动把旧连接拆掉重建。
           ⚠ 自愈本身有 60 秒间隔限制：半死时每次回前台都重连会变成"重连风暴"
           （实测 startStream 被调到 #13、两个读循环并发），
           而半死是**设备端**问题，App 重连治不好它，重试得太勤只会搅乱设备。 */
        else if (RykenUsb.isHalfDead() &&
                 System.currentTimeMillis() - lastHalfDeadHeal > 60000L) {
            lastHalfDeadHeal = System.currentTimeMillis()
            Log.i("Ryken", "检测到半死连接，尝试重建（60 秒内只做一次）")
            autoConnect(null)
        }
    }

    /** 上次"半死自愈"的时刻（60 秒间隔，防止重连风暴） */
    @Volatile private var lastHalfDeadHeal = 0L

    /** 网页设置 → 隐藏/恢复状态栏（RykenBridge.setImmersive 调用） */
    fun setImmersiveMode(hidden: Boolean) {
        immersiveStatus = hidden
        runOnUiThread { hideSystemBars() }
    }

    private fun hideSystemBars() {
        // 挖孔/刘海屏：「短边」模式（API 28+）—— 让窗口铺满物理屏幕，
        // 横屏时挖孔在左/右也不会把整块内容挤成带黑边的小窗。
        // 内容避让交给页面的 --sys-l / --sys-r（insets 监听会传过去）。
        if (Build.VERSION.SDK_INT >= 28) {
            try {
                window.attributes = window.attributes.apply {
                    layoutInDisplayCutoutMode =
                        android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
                }
            } catch (_: Exception) {}
        }
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.let {
                // 三大金刚键模式不隐藏导航条：部分 ROM 对 hide() 免疫，强藏会遮挡底栏；
                // 改为显示导航条，由 insets 监听按实际高度垫底让位。
                // 手势模式保持沉浸隐藏。
                if (navMode() != 0) it.hide(WindowInsets.Type.navigationBars())
                else it.show(WindowInsets.Type.navigationBars())
                // 网页「隐藏状态栏」开关：开启后横竖屏都藏状态栏，顶栏贴屏幕上缘
                if (immersiveStatus) it.hide(WindowInsets.Type.statusBars())
                else it.show(WindowInsets.Type.statusBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            if (navMode() != 0) {
                window.decorView.systemUiVisibility =
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                    View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            } else {
                window.decorView.systemUiVisibility =
                    (if (immersiveStatus) View.SYSTEM_UI_FLAG_FULLSCREEN else 0) or
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            }
        }
    }
}
