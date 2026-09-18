plugins {
    alias(libs.plugins.android.application)
}

fun buildConfigString(value: String): String =
    "\"${value.replace("\\", "\\\\").replace("\"", "\\\"")}\""

val turnUrl = providers.gradleProperty("turn.url").orNull
    ?: "turn:10.174.96.95:3478?transport=udp"
val turnUsername = providers.gradleProperty("turn.username").orNull ?: "user"
val turnPassword = providers.gradleProperty("turn.password").orNull ?: "pass"
val relayUrl = providers.gradleProperty("relay.url").orNull
    ?: "https://10.174.96.95:39002"

android {
    namespace = "com.example.webrtccamera"
    compileSdk {
        version = release(37)
    }

    defaultConfig {
        applicationId = "com.example.webrtccamera"
        minSdk = 24
        targetSdk = 37
        versionCode = 1
        versionName = "1.0"

        buildConfigField("String", "DEFAULT_SERVER_URL", buildConfigString(relayUrl))
        buildConfigField("String", "TURN_URL", buildConfigString(turnUrl))
        buildConfigField("String", "TURN_USERNAME", buildConfigString(turnUsername))
        buildConfigField("String", "TURN_PASSWORD", buildConfigString(turnPassword))
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            optimization {
                enable = false
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

dependencies {
    implementation(libs.androidx.activity.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.constraintlayout)
    implementation(libs.androidx.core.ktx)
    implementation(libs.material)
    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.webrtc.android)
    implementation(libs.okhttp)
    implementation(libs.mlkit.barcode.scanning)
    implementation(libs.androidx.documentfile)

    testImplementation(libs.junit)
    // Overrides the SDK's mockable-jar stub for org.json, which throws "not mocked" at
    // runtime; a real implementation is needed for TelemetryBatch's JSON serialization tests.
    testImplementation(libs.json)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(libs.androidx.junit)
}
