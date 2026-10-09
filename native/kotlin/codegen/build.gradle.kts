plugins {
    id("java-library")
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.maven.publish)
}
java {
    sourceCompatibility = JavaVersion.VERSION_11
    targetCompatibility = JavaVersion.VERSION_11
}
kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_11
    }
}

dependencies {
    api(libs.kotlinpoet)
    implementation(libs.kotlinx.serialization.json)

    testImplementation(libs.kotest.runner.junit5)
    testImplementation(libs.kotest.assertions.core)
    testImplementation(libs.kotest.property)
}

// The cross-platform codegen fixtures (`spec.json` + goldens). `-PfixtureGoldensDir=<absolute dir>`
// points the golden check and the regenerate at another directory (scripts/regenerate-fixtures.test.sh),
// as it does `:fixture-goldens`.
val codegenFixturesDir: File = providers.gradleProperty("fixtureGoldensDir")
    .map { file(it) }
    .getOrElse(project.file("../../codegen-fixtures"))

tasks.withType<Test> {
    useJUnitPlatform()
    systemProperty("FIXTURES_DIR", codegenFixturesDir.absolutePath)
}

// The golden check reads the fixtures, so a changed spec or golden must rerun it (it isn't up to
// date from the last pass).
tasks.named<Test>("test") {
    // A file tree, not `inputs.dir`, so a checkout without the fixtures still configures the task.
    inputs.files(fileTree(codegenFixturesDir))
        .withPropertyName("codegenFixtures")
        .withPathSensitivity(PathSensitivity.RELATIVE)
}

tasks.register<Test>("regenerateFixtures") {
    description = "Regenerate golden files for cross-platform codegen fixtures"
    group = "verification"
    // It rewrites the goldens in place, so it must run every time: never up to date, never from the
    // build cache. Otherwise a second regenerate skips Kotlin, and a deleted or stale golden stays.
    doNotTrackState("Rewrites the codegen fixture goldens in place; a regenerate must always run")
    useJUnitPlatform()
    testClassesDirs = sourceSets["test"].output.classesDirs
    classpath = sourceSets["test"].runtimeClasspath
    filter {
        includeTestsMatching("com.aws.blocks.kotlin.CodegenFixturesTest")
    }
    systemProperty("REGENERATE_FIXTURES", "1")
}