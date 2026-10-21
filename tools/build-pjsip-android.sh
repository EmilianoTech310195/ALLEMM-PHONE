#!/usr/bin/env bash
# Compila PJSIP 2.15.1 para Android (NDK) y deja listo el módulo pjsua2 para la app:
#   android/app/src/main/jniLibs/arm64-v8a/libpjsua2.so (+ libc++_shared.so)
#   android/app/src/main/java/org/pjsip/pjsua2/*.java   (envoltorio SWIG)
#
# Requisitos: Android NDK (ANDROID_NDK_ROOT o ANDROID_NDK_LATEST_HOME), SWIG, JDK 17, make.
# Lo ejecuta GitHub Actions (.github/workflows/build-android.yml). En una PC con
# Linux/macOS/WSL también funciona:  bash tools/build-pjsip-android.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PJ_VERSION="${PJ_VERSION:-2.15.1}"
export TARGET_ABI="${TARGET_ABI:-arm64-v8a}"
export APP_PLATFORM="${APP_PLATFORM:-android-26}"
export ANDROID_NDK_ROOT="${ANDROID_NDK_ROOT:-${ANDROID_NDK_LATEST_HOME:-${ANDROID_NDK_HOME:-}}}"
WORK="${PJ_ANDROID_WORK:-$ROOT/third_party/pjproject-android}"
OUT_JNI="$ROOT/android/app/src/main/jniLibs/$TARGET_ABI"
OUT_JAVA="$ROOT/android/app/src/main/java/org/pjsip/pjsua2"

step() { printf '\n==> %s\n' "$*"; }

[ -n "$ANDROID_NDK_ROOT" ] && [ -d "$ANDROID_NDK_ROOT" ] || { echo "Falta el Android NDK (ANDROID_NDK_ROOT)"; exit 1; }
command -v swig >/dev/null || { echo "Falta SWIG (apt install swig / brew install swig)"; exit 1; }
echo "NDK: $ANDROID_NDK_ROOT  ABI: $TARGET_ABI  API: $APP_PLATFORM"

step "pjproject $PJ_VERSION"
if [ ! -d "$WORK/.git" ]; then
  git clone --depth 1 --branch "$PJ_VERSION" https://github.com/pjsip/pjproject.git "$WORK"
fi
cd "$WORK"
cat > pjlib/include/pj/config_site.h <<'CFG'
/* Generado por tools/build-pjsip-android.sh */
#define PJ_CONFIG_ANDROID 1
#define PJMEDIA_HAS_VIDEO 0
#define PJ_HAS_IPV6 1
#define PJMEDIA_HAS_SRTP 1
#define PJSUA_MAX_CALLS 4
#include <pj/config_site_sample.h>
CFG

step "configure-android"
./configure-android --use-ndk-cflags --disable-video --disable-openh264 --disable-libyuv \
  --disable-ffmpeg --disable-v4l2 --disable-sdl --disable-vpx

step "make (PJSIP)"
make dep
make -j"$(nproc 2>/dev/null || echo 4)"

step "make (pjsua2 Java/JNI)"
# El objetivo "java" de PJSIP también compila sus ejemplos con javac; solo nos
# interesa la .so y los .java generados, así que se valida por los archivos.
make -C pjsip-apps/src/swig/java || echo "AVISO: make java terminó con error; se revisan los archivos generados"

SRC_JNI="pjsip-apps/src/swig/java/android/pjsua2/src/main/jniLibs/$TARGET_ABI"
SRC_JAVA="pjsip-apps/src/swig/java/android/pjsua2/src/main/java/org/pjsip/pjsua2"
[ -f "$SRC_JNI/libpjsua2.so" ] || { echo "No se generó $SRC_JNI/libpjsua2.so"; exit 1; }
[ -f "$SRC_JAVA/Endpoint.java" ] || { echo "No se generaron las clases Java de pjsua2"; exit 1; }

step "Copiando a la app"
mkdir -p "$OUT_JNI" "$OUT_JAVA"
cp -f "$SRC_JNI"/*.so "$OUT_JNI/"
rm -f "$OUT_JAVA"/*.java
cp -f "$SRC_JAVA"/*.java "$OUT_JAVA/"
ls -la "$OUT_JNI"
echo "Clases Java: $(ls "$OUT_JAVA" | wc -l)"
echo "Listo."
