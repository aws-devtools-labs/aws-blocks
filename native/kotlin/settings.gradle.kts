pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

enableFeaturePreview("TYPESAFE_PROJECT_ACCESSORS")

rootProject.name = "aws-blocks-kotlin"
include(":runtime")
include(":plugin")
include(":codegen")
// `:fixture-goldens` compiles the codegen fixtures' Kotlin goldens (scripts/compile-fixture-goldens.sh).
// It's included only when that fixtures directory exists, so a checkout without
// native/codegen-fixtures still configures, builds and publishes the SDK.
// `-PfixtureGoldensDir=<absolute dir>` points it, and `:codegen`'s golden tests, at another directory.
val fixtureGoldensDir: File = providers.gradleProperty("fixtureGoldensDir")
    .map { file(it) }
    .getOrElse(file("../codegen-fixtures"))
if (fixtureGoldensDir.isDirectory) {
    include(":fixture-goldens")
}
