package cn.ryken.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * 保活前台服务。
 *
 * 为什么必须有：ColorOS / MIUI / EMUI 这类 ROM 会把退到后台的进程
 * 判为 CACHED 并冻结（实测 8 分钟后 USB 读线程和命令通道全部停摆，
 * 用户切出去看个微信 App 就"死了"）。挂上前台服务后进程优先级提升，
 * 后台也能持续读表。
 */
class KeepAliveService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        // 部分唤醒锁：防止息屏后 CPU 休眠导致 USB 读线程断流
        wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ryken:usb")
            .apply { setReferenceCounted(false); acquire() }

        // 进程崩溃后 START_STICKY 会重启本服务：自动恢复 USB 流（无 UI 也能继续采集）
        if (RykenUsb.conn == null && !RykenUsb.running) {
            Thread {
                try {
                    if (RykenUsb.findDevice() != null && RykenUsb.connect(this)) {
                        RykenUsb.startStream()
                    }
                } catch (_: Exception) {}
            }.also { it.isDaemon = true; it.start() }
        }

        val chId = "ryken_link"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(chId) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(chId, "功率表连接", NotificationManager.IMPORTANCE_LOW)
                        .apply { description = "保持与 RK-X3 功率表的 USB 通信" }
                )
            }
        }

        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, chId) else
            @Suppress("DEPRECATION") Notification.Builder(this)

        val notif = b
            .setContentTitle("RYKEN 功率表")
            .setContentText("正在与功率表保持通信")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .build()

        // Android 14+ 对 connectedDevice 类型前台服务有额外校验
        // （FOREGROUND_SERVICE_CONNECTED_DEVICE + USB/蓝牙等任一附加条件）。
        // 条件不满足时带类型启动会抛 SecurityException，直接把 App 崩掉（一加 Android 16 实测）。
        // 策略：带类型尝试 → 失败降级为普通前台服务 → 再失败就静默退出，绝不冒泡崩溃。
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(1001, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
            } else {
                startForeground(1001, notif)
            }
        } catch (e: Exception) {
            try {
                startForeground(1001, notif)
            } catch (e2: Exception) {
                stopSelf()
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        try { wakeLock?.release() } catch (_: Exception) {}
        wakeLock = null
        super.onDestroy()
    }
}
