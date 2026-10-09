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

tasks.withType<Test> {
    useJUnitPlatform()
    val fixturesDir = project.file("../../codegen-fixtures")
    systemProperty("FIXTURES_DIR", fixturesDir.absolutePath)
    // The fixtures reach the test as a system property, so Gradle cannot infer them:
    // without this the golden guard is UP-TO-DATE after a fixture-only change.
    inputs.dir(fixturesDir).withPropertyName("codegenFixtures").withPathSensitivity(PathSensitivity.RELATIVE)
}

tasks.register<Test>("regenerateFixtures") {
    description = "Regenerate golden files for cross-platform codegen fixtures"
    group = "verification"
    useJUnitPlatform()
    testClassesDirs = sourceSets["test"].output.classesDirs
    classpath = sourceSets["test"].runtimeClasspath
    filter {
        includeTestsMatching("com.aws.blocks.kotlin.CodegenFixturesTest")
    }
    systemProperty("REGENERATE_FIXTURES", "1")
    // Regenerating identical goldens leaves the inputs unchanged, so the task
    // would be skipped and an explicit regeneration request would write nothing.
    outputs.upToDateWhen { false }
}
