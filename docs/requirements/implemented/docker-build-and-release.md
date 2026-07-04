# Requirement: Docker Image Versioning, Multi-Arch Build, and Release Publishing

## Status
Implemented — documented here from the current behavior of `ci/version.sh`,
`ci/build-docker.sh`, `.github/workflows/docker-publish.yml`, and the legacy `build.sh`.

## Scope
Tooling that computes the image version, builds the multi-arch `mini-scraper` image locally,
and publishes it to Docker Hub. Does not cover the image's runtime contents (see
`requirements/core-scraping-engine.md`, `requirements/network-readiness.md`,
`requirements/logging-and-diagnostics.md`).

## 1. Version computation (`ci/version.sh`)
- Version format: `vMAJOR.MINOR.PATCH`, derived from the nearest reachable git tag matching
  `v[0-9]*.[0-9]*.[0-9]*`.
  - Clean tree, `HEAD` exactly on a matching tag: version is that tag, unchanged.
  - Clean tree, `HEAD` ahead of a matching tag: `PATCH` is replaced by
    `PATCH + <commits since tag>`.
  - Dirty tree (staged or unstaged changes to tracked files — untracked files do not count):
    same computation as above, but rendered as `vMAJOR.MINOR.dev<N>`, where `N` is the
    computed revision **plus one**.
  - No matching tag reachable at all: baseline `v0.1.0`, with the revision counted from the
    total commit count on `HEAD` (so effectively `v0.1.<total commits>`, or `v0.1.dev<N>` if
    dirty).
- Always attempts `git fetch --tags --force` first (best-effort — failure is ignored) so the
  version is computed against up-to-date tag data.

## 2. Local multi-arch build (`ci/build-docker.sh`)
- Builds `linux/amd64` and `linux/arm64` images for `mini-scraper`, tagged with both the
  computed version (§1) and `latest`. Build only — never pushes to a registry.
- Container engine: explicit via `-e`/`--engine docker|podman`, or auto-detected (`podman`
  preferred if present, else `docker`). Errors out if the requested/detected engine binary is
  not found in `PATH`.
- Base Playwright image tag (`IMAGE_TAG` build arg): `-b`/`--base-image-tag`, default `vx.x.x`.
  - An exact tag (no `x` segments) is used as-is, no network call.
  - A pattern with `x` wildcard segments in major/minor/patch is resolved by querying
    `https://mcr.microsoft.com/v2/playwright/tags/list` and selecting the highest matching
    version (a network call, and the same has/hasn't-`-suffix` from the pattern is matched
    literally — `-noble` in the pattern only matches `-noble` tags, no suffix in the pattern
    only matches suffix-less tags).
- Registry prefix: `-r`/`--registry`, default `docker.io/jnitecki`. Every locally-produced
  tag is additionally tagged as `REGISTRY/mini-scraper:TAG`; passing an empty string skips
  the extra tags entirely.
- Manifest assembly differs by engine:
  - **podman**: a true multi-arch manifest list is always assembled purely in local storage.
  - **docker**: first attempts a single combined `buildx build` for both platforms with
    `--load`; this only produces a loadable multi-platform manifest if Docker's containerd
    image store is enabled. On failure, falls back to separate per-arch tags
    (`mini-scraper:TAG-amd64` / `-arm64`) with no combined manifest — and if the host's own
    architecture matches one of the built platforms, that native-arch image is additionally
    tagged as the plain version tag so `mini-scraper:TAG` is still runnable locally without a
    real manifest.

## 3. Automated build & publish (`.github/workflows/docker-publish.yml`)
- Trigger: manual only (`workflow_dispatch`), with an optional `base_image_tag` input
  (default `v1.61.0-noble`). There is no automatic trigger on push or tag creation.
- Runs on a clean GitHub Actions checkout, so `ci/version.sh`'s dirty/dev-build branch never
  applies here — every workflow run produces a clean release-style version tag.
- Builds and pushes `linux/amd64,linux/arm64` in a single `docker/build-push-action` step
  directly to `docker.io/jnitecki/mini-scraper`, tagged with both the computed version and
  `latest`.
- Requires `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` repository secrets for the Docker Hub
  login step.

## 4. Legacy build script (`build.sh`)
- Superseded by `ci/build-docker.sh` (§2) but kept as-is for reference/compatibility.
- Hardcodes `IMAGE_TAG=v1.61.0-noble` (no dynamic version computation or CLI options),
  builds per-arch images with `podman` only (no `docker`/buildx path), and always pushes the
  resulting manifest to `docker.io/jnitecki/mini-scraper:$IMAGE_TAG` and `:latest` — it has no
  build-only mode.

## Out of scope
- Pushing from the local build script (`ci/build-docker.sh` is build-only by design).
- Automatic triggering of the publish workflow on git tag push.
- Signing or provenance attestation of published images.
