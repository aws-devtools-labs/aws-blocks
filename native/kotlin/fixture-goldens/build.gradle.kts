// Compiles every codegen fixture's Kotlin golden against the in-repo runtime, and runs the
// round-trip tests of the fixtures that have them.
//
// The golden-file tests (`:codegen:test`) only compare text, so a golden that doesn't
// compile still passes them. This module gives each fixture's `kotlin/` directory its own
// source set, so each golden is a separate compilation unit with only the runtime (JVM
// variant) on its classpath. The goldens all use the same package and type names
// (`com.example.app.Api`, `Servers`, ...), so they can't share one source set.
//
// No opt-ins or compiler flags are added: a golden must compile the way a customer's
// generated client does. Warnings are advisory; only errors fail the build.
//
// Run through `scripts/compile-fixture-goldens.sh` (which summarizes per fixture), or
// directly: `./gradlew :fixture-goldens:compileFixtureGoldens --continue`.
// `-PfixtureGoldensDir=<dir>` points it at another fixtures directory (used by the
// script's test). settings.gradle.kts includes this module only when that directory
// exists, so a checkout without the fixtures still builds and publishes the SDK.
//
// A fixture `NN-name` may have round-trip tests in `round-trips/NN-name/`: a source set of its
// own, compiled against that fixture's golden only, that decodes and encodes real wire JSON
// through the generated types (text comparison can't show that a serializer reads the wire
// format). Run them with `./gradlew :fixture-goldens:roundTripFixtureGoldens`.
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlinx.serialization)
}

val fixturesDir: File = (findProperty("fixtureGoldensDir") as String?)
    ?.let { file(it) }
    ?: file("../../codegen-fixtures")

// One source set per fixture that has a Kotlin golden. `01-primitives` -> `fixture01Primitives`.
val fixtures: List<Pair<String, File>> = (fixturesDir.listFiles() ?: emptyArray())
    .filter { it.isDirectory && it.resolve("kotlin").isDirectory }
    .sortedBy { it.name }
    .map { dir ->
        val suffix = dir.name.split(Regex("[^A-Za-z0-9]+")).filter { it.isNotEmpty() }
            .joinToString("") { it.replaceFirstChar(Char::uppercaseChar) }
        "fixture$suffix" to dir.resolve("kotlin")
    }

val compileTasks = fixtures.map { (name, kotlinDir) ->
    val sourceSet = sourceSets.create(name) {
        java.setSrcDirs(emptyList<File>())
        kotlin.setSrcDirs(listOf(kotlinDir))
        resources.setSrcDirs(emptyList<File>())
    }
    dependencies.add(sourceSet.implementationConfigurationName, project(":runtime"))
    sourceSet.getCompileTaskName("kotlin")
}

tasks.register("compileFixtureGoldens") {
    description = "Compiles every codegen fixture's Kotlin golden against the runtime, one compilation per fixture"
    group = "verification"
    dependsOn(compileTasks)
    val count = fixtures.size
    val dir = fixturesDir.path
    doFirst {
        require(count > 0) { "no */kotlin/ goldens under $dir" }
    }
    doLast {
        println("Compiled $count Kotlin fixture golden(s) from $dir")
    }
}

// Round-trip tests: one source set and Test task per fixture with a `round-trips/<fixture>/` directory.
val roundTripsDir: File = file("round-trips")
val roundTripTasks = fixtures.mapNotNull { (name, kotlinDir) ->
    val testsDir = roundTripsDir.resolve(kotlinDir.parentFile.name)
    if (!testsDir.isDirectory) return@mapNotNull null
    val golden = sourceSets.getByName(name)
    val roundTrip = sourceSets.create("${name}RoundTrip") {
        java.setSrcDirs(emptyList<File>())
        kotlin.setSrcDirs(listOf(testsDir))
        resources.setSrcDirs(emptyList<File>())
        compileClasspath += golden.output
        runtimeClasspath += golden.output
    }
    dependencies.add(roundTrip.implementationConfigurationName, project(":runtime"))
    dependencies.add(roundTrip.implementationConfigurationName, libs.kotest.runner.junit5)
    dependencies.add(roundTrip.implementationConfigurationName, libs.kotest.assertions.core)
    dependencies.add(roundTrip.implementationConfigurationName, libs.kotlinx.coroutines.test)
    tasks.register<Test>("${name}RoundTrip") {
        description = "Round-trips wire JSON through the ${kotlinDir.parentFile.name} golden"
        group = "verification"
        testClassesDirs = roundTrip.output.classesDirs
        classpath = roundTrip.runtimeClasspath
        useJUnitPlatform()
    }
}

tasks.register("roundTripFixtureGoldens") {
    description = "Runs every fixture's round-trip tests against its Kotlin golden (JVM)"
    group = "verification"
    dependsOn(roundTripTasks)
}
