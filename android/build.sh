#!/usr/bin/env bash
# ============================================================
#  RYKEN 手机端上位机 — 一键编译 APK（Git Bash / Linux / macOS）
#  与 build.bat 等价。换机器/换目录只要设好 JAVA_HOME 和 ANDROID_HOME。
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

# 本机默认路径只作兜底；已设的环境变量优先
: "${JAVA_HOME:=D:/AndroidDev/jdk/jdk-17.0.20.1+1}"
: "${ANDROID_HOME:=D:/AndroidDev/sdk}"
export JAVA_HOME ANDROID_HOME

if [ ! -x "$JAVA_HOME/bin/javac" ] && [ ! -x "$JAVA_HOME/bin/javac.exe" ]; then
  echo "[X] 找不到 JDK: $JAVA_HOME（设 JAVA_HOME 覆盖）" >&2
  exit 1
fi
if [ ! -d "$ANDROID_HOME" ]; then
  echo "[X] 找不到 Android SDK: $ANDROID_HOME（设 ANDROID_HOME 覆盖）" >&2
  exit 1
fi
# local.properties 是机器本地文件、不该跟着工程走；缺了就按 ANDROID_HOME 生成
if [ ! -f local.properties ]; then
  printf 'sdk.dir=%s\n' "${ANDROID_HOME//\\//}" > local.properties
  echo "[i] 已生成 local.properties: sdk.dir=${ANDROID_HOME//\\//}"
fi

# 优先用本机已装的 Gradle（快、离线可用）；没有才回落到工程自带的 wrapper
GRADLE=""
if [ -n "${GRADLE_BIN:-}" ]; then
  GRADLE="$GRADLE_BIN"
elif [ -x "D:/AndroidDev/gradle/gradle-8.11.1/bin/gradle" ]; then
  GRADLE="D:/AndroidDev/gradle/gradle-8.11.1/bin/gradle"
elif [ -x ./gradlew ]; then
  GRADLE=./gradlew
fi
if [ -z "$GRADLE" ]; then
  echo "[X] 找不到 Gradle：本机没装、工程也没有 gradlew" >&2
  exit 1
fi

echo "[1/3] 同步网页资源到 APK"
mkdir -p app/src/main/assets/www/assets/js app/src/main/assets/www/assets/css
cp -f ../index.html                         app/src/main/assets/www/
cp -f ../assets/css/app.css                 app/src/main/assets/www/assets/css/
for f in app.js chart.js transport.js ryken-protocol.js demo.js; do
  cp -f "../assets/js/$f" app/src/main/assets/www/assets/js/
done

echo "[2/3] 编译（$GRADLE）"
"$GRADLE" --no-daemon assembleDebug

echo "[3/3] 完成"
echo
echo "   APK 目录: $(pwd)/app/build/outputs/apk/debug/"
ls -1 app/build/outputs/apk/debug/*.APK 2>/dev/null || echo "   (没找到 APK，编译可能没成功)"
