---
"aws-blocks-kotlin": patch
---

Update the Kotlin SDK's dependency versions

The runtime now depends on `kotlinx-serialization-json` 1.9.0 (was 1.7.3), which also appears on your compile classpath, and on Ktor 3.3.3 (was 3.1.3) and, on Android, `androidx.browser` 1.10.0 (was 1.8.0); on JVM and Android, Ktor's OkHttp engine brings OkHttp 5.2.1 in place of 4.12.0, a major version. The resolved `kotlin-stdlib` moves from 2.2.10 to 2.2.21 while keeping the same Kotlin 2.2 binary format, so a project already building with Kotlin 2.2 needs no compiler change. The code generator now uses KotlinPoet 2.3.0 (was 2.2.0). Newer releases of these libraries are held back because they are built with Kotlin 2.3 or later, which the SDK's Kotlin 2.2 toolchain cannot consume.
