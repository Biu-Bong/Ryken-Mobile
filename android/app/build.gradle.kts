import com.android.build.gradle.internal.api.BaseVariantOutputImpl

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}


/* 每次构建前把根目录网页同步进 assets/www（防止 www 旧拷贝导致 UI 版本不更新） */
tasks.register<Copy>("syncWeb") {
    from(files("../../index.html"))
    from(files("../../assets")) { into("assets") }
    into("src/main/assets/www")
}
tasks.named("preBuild") { dependsOn("syncWeb") }

android {
    namespace = "cn.ryken.mobile"
    compileSdk = 34

    defaultConfig {
        applicationId = "cn.ryken.mobile"
        minSdk = 24
        targetSdk = 34
        versionCode = 100
        versionName = "1.0.0"
    }

    // 产物命名：RYKEN-mobile-<版本>.APK（后缀一律大写，跨项目规则）
    applicationVariants.all {
        outputs.all {
            (this as BaseVariantOutputImpl).outputFileName = "Ryken-Mobile-$versionName.APK"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // 用 debug 签名，方便直接安装
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module")
    }
}

// 不引 AndroidX，减少依赖下载。WebView 用系统框架的实现。
dependencies {
}
