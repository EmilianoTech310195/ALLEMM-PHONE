plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.allemm.sip"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.allemm.sip"
        minSdk = 26          // Android 8.0
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
        ndk { abiFilters += listOf("arm64-v8a") }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug") // APK de pruebas (instalable por USB/descarga)
        }
    }

    sourceSets {
        getByName("main") {
            // La interfaz es la MISMA que la de escritorio (allemmsip/static): se empaqueta como assets.
            assets.srcDirs("../../allemmsip/static")
            // libpjsua2.so y las clases org.pjsip.pjsua2 las genera tools/build-pjsip-android.sh
            jniLibs.srcDirs("src/main/jniLibs")
        }
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    packaging { jniLibs.useLegacyPackaging = false }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
}
