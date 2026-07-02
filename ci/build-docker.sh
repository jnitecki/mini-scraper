#!/usr/bin/env bash
# Builds the mini-scraper image locally for linux/amd64 and linux/arm64.
# Build only - does not push anywhere. Requires cross-architecture emulation
# to be set up (e.g. `docker run --privileged --rm tonistiigi/binfmt --install all`)
# and, for docker, a buildx builder (`docker buildx create --use`).
set -euo pipefail

MCR_REPOSITORY="playwright"
MCR_TAGS_URL="https://mcr.microsoft.com/v2/${MCR_REPOSITORY}/tags/list?n=10000"

print_help() {
  cat <<EOF
Usage: $(basename "$0") [-e|--engine docker|podman] [-b|--base-image-tag TAG] [-r|--registry REGISTRY] [-h|--help]

Builds the mini-scraper image locally for linux/amd64 and linux/arm64, and
combines them into a single multi-arch manifest under mini-scraper:TAG when
possible. Build only - does not push anywhere.

With podman, the manifest is always created purely in local storage. With
docker, a merged local manifest is only possible if Docker's containerd
image store is enabled; otherwise this falls back to separate per-arch tags
(mini-scraper:TAG-amd64 / mini-scraper:TAG-arm64) with no combined manifest.

Options:
  -e, --engine docker|podman   Container engine to use. If omitted, podman is
                                used when present, otherwise docker. Errors out
                                if the requested (or detected) engine is not
                                found in PATH.
  -b, --base-image-tag TAG     Playwright base image tag (IMAGE_TAG build arg).
                                Segments can be "x" to mean "newest available":
                                  v1.61.0-noble   exact tag, used as-is
                                  v1.x.x-noble    newest v1.*.* tag with -noble
                                  vx.x.x          newest tag with no OS suffix
                                Wildcard patterns are resolved against the
                                mcr.microsoft.com/playwright tag list (network
                                required); exact tags are used as-is.
                                Defaults to vx.x.x.
  -r, --registry REGISTRY      Additional registry/namespace prefix. Every
                                mini-scraper:TAG produced locally is also
                                tagged as REGISTRY/mini-scraper:TAG. Pass an
                                empty string to skip the extra tags.
                                Defaults to docker.io/jnitecki.
  -h, --help                   Show this help and exit.
EOF
}

ENGINE=""
BASE_IMAGE_PATTERN="vx.x.x"
REGISTRY="docker.io/jnitecki"
while [ $# -gt 0 ]; do
  case "$1" in
    -e|--engine)
      ENGINE="${2:-}"
      shift 2
      ;;
    --engine=*)
      ENGINE="${1#*=}"
      shift
      ;;
    -b|--base-image-tag)
      BASE_IMAGE_PATTERN="${2:-}"
      shift 2
      ;;
    --base-image-tag=*)
      BASE_IMAGE_PATTERN="${1#*=}"
      shift
      ;;
    -r|--registry)
      REGISTRY="${2:-}"
      shift 2
      ;;
    --registry=*)
      REGISTRY="${1#*=}"
      shift
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      print_help >&2
      exit 1
      ;;
  esac
done

if [ -n "$ENGINE" ]; then
  case "$ENGINE" in
    docker|podman) ;;
    *)
      echo "Error: --engine must be 'docker' or 'podman', got '$ENGINE'" >&2
      exit 1
      ;;
  esac
  if ! command -v "$ENGINE" >/dev/null 2>&1; then
    echo "Error: requested engine '$ENGINE' not found in PATH" >&2
    exit 1
  fi
else
  if command -v podman >/dev/null 2>&1; then
    ENGINE=podman
  elif command -v docker >/dev/null 2>&1; then
    ENGINE=docker
  else
    echo "Error: neither podman nor docker found in PATH" >&2
    exit 1
  fi
fi

# Resolves a base image tag pattern to a concrete tag.
# Segments (major/minor/patch) may be "x" as a wildcard; the presence or
# absence of a "-suffix" in the pattern is matched literally (no suffix in
# the pattern means only suffix-less tags are considered). Patterns without
# any wildcard segment are returned unchanged, with no registry lookup.
resolve_base_image_tag() {
  local pattern="$1"
  if [[ ! "$pattern" =~ ^v(x|[0-9]+)\.(x|[0-9]+)\.(x|[0-9]+)(-(.+))?$ ]]; then
    echo "$pattern"
    return
  fi

  local maj="${BASH_REMATCH[1]}" min="${BASH_REMATCH[2]}" pat="${BASH_REMATCH[3]}" suffix="${BASH_REMATCH[5]}"
  if [ "$maj" != "x" ] && [ "$min" != "x" ] && [ "$pat" != "x" ]; then
    echo "$pattern"
    return
  fi

  local maj_re min_re pat_re
  maj_re=$([ "$maj" = "x" ] && echo '[0-9]+' || echo "$maj")
  min_re=$([ "$min" = "x" ] && echo '[0-9]+' || echo "$min")
  pat_re=$([ "$pat" = "x" ] && echo '[0-9]+' || echo "$pat")

  local tag_regex
  if [ -n "$suffix" ]; then
    tag_regex="^v${maj_re}\\.${min_re}\\.${pat_re}-${suffix}\$"
  else
    tag_regex="^v${maj_re}\\.${min_re}\\.${pat_re}\$"
  fi

  local body
  body=$(curl -fsS "$MCR_TAGS_URL") || {
    echo "Error: failed to fetch tag list from $MCR_TAGS_URL" >&2
    exit 1
  }

  local tags
  tags=$(echo "$body" | tr -d '\n' | sed -E 's/.*"tags":\[([^]]*)\].*/\1/' | tr ',' '\n' | sed -E 's/^[[:space:]]*"//; s/"[[:space:]]*$//')

  local best="" best_key=""
  while IFS= read -r tag; do
    [ -n "$tag" ] || continue
    [[ "$tag" =~ $tag_regex ]] || continue
    [[ "$tag" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+) ]] || continue
    local key
    key=$(printf '%08d.%08d.%08d' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}")
    if [ -z "$best_key" ] || [[ "$key" > "$best_key" ]]; then
      best_key="$key"
      best="$tag"
    fi
  done <<< "$tags"

  if [ -z "$best" ]; then
    echo "Error: no tag in ${MCR_REPOSITORY} matches pattern '$pattern'" >&2
    exit 1
  fi
  echo "$best"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

BASE_IMAGE_TAG=$(resolve_base_image_tag "$BASE_IMAGE_PATTERN")
VERSION=$("$SCRIPT_DIR/version.sh")

echo "Using engine: $ENGINE"
echo "Building mini-scraper:$VERSION (base image $BASE_IMAGE_TAG) for linux/amd64 and linux/arm64"

FINAL_TAGS=("mini-scraper:$VERSION" "mini-scraper:latest")
if [ -n "$REGISTRY" ]; then
  FINAL_TAGS+=("$REGISTRY/mini-scraper:$VERSION" "$REGISTRY/mini-scraper:latest")
fi

build_per_arch_image() {
  local platform="$1" tag="$2"
  case "$ENGINE" in
    docker)
      docker buildx build \
        --platform "$platform" \
        --build-arg "IMAGE_TAG=$BASE_IMAGE_TAG" \
        -f "$REPO_ROOT/Docker/dockerfile" \
        -t "$tag" \
        --load \
        "$REPO_ROOT/Docker/Files"
      ;;
    podman)
      podman build \
        --platform "$platform" \
        --build-arg "IMAGE_TAG=$BASE_IMAGE_TAG" \
        -f "$REPO_ROOT/Docker/dockerfile" \
        -t "$tag" \
        "$REPO_ROOT/Docker/Files"
      ;;
  esac
}

MANIFEST_CREATED=false

# podman keeps manifest lists purely in local storage, so a real multi-arch
# manifest can be built without a registry. docker's manifest tooling only
# works against images already in a registry - the one local-only path is a
# single buildx build with both platforms, which only produces a loadable
# multi-platform image if the containerd image store is enabled.
if [ "$ENGINE" = "docker" ]; then
  echo "--- Attempting combined multi-platform build (requires Docker's containerd image store) ---"
  BUILDX_TAG_ARGS=()
  for t in "${FINAL_TAGS[@]}"; do
    BUILDX_TAG_ARGS+=(-t "$t")
  done
  if docker buildx build \
      --platform linux/amd64,linux/arm64 \
      --build-arg "IMAGE_TAG=$BASE_IMAGE_TAG" \
      -f "$REPO_ROOT/Docker/dockerfile" \
      "${BUILDX_TAG_ARGS[@]}" \
      --load \
      "$REPO_ROOT/Docker/Files"; then
    MANIFEST_CREATED=true
    echo "Loaded multi-platform manifest locally as: ${FINAL_TAGS[*]}"
  else
    echo "Warning: combined multi-platform --load failed (commonly because Docker's containerd image store is not enabled)." >&2
    echo "Falling back to separate per-arch builds without a merged manifest." >&2
  fi
fi

if [ "$MANIFEST_CREATED" = false ]; then
  for PLATFORM in linux/amd64 linux/arm64; do
    ARCH="${PLATFORM#linux/}"
    echo "--- Building $PLATFORM ---"
    build_per_arch_image "$PLATFORM" "mini-scraper:$VERSION-$ARCH"
  done

  if [ "$ENGINE" = "podman" ]; then
    echo "--- Creating local manifest mini-scraper:$VERSION ---"
    podman manifest rm "mini-scraper:$VERSION" >/dev/null 2>&1 || true
    podman manifest create "mini-scraper:$VERSION"
    podman manifest add "mini-scraper:$VERSION" "mini-scraper:$VERSION-amd64"
    podman manifest add "mini-scraper:$VERSION" "mini-scraper:$VERSION-arm64"
    for t in "${FINAL_TAGS[@]}"; do
      [ "$t" = "mini-scraper:$VERSION" ] && continue
      podman tag "mini-scraper:$VERSION" "$t"
    done
    MANIFEST_CREATED=true
    echo "Created local manifest: ${FINAL_TAGS[*]}"
  else
    HOST_ARCH="$(uname -m)"
    case "$HOST_ARCH" in
      x86_64) NATIVE_ARCH=amd64 ;;
      arm64|aarch64) NATIVE_ARCH=arm64 ;;
      *) NATIVE_ARCH="" ;;
    esac
    if [ -n "$NATIVE_ARCH" ]; then
      "$ENGINE" tag "mini-scraper:$VERSION-$NATIVE_ARCH" "mini-scraper:$VERSION"
      for t in "${FINAL_TAGS[@]}"; do
        [ "$t" = "mini-scraper:$VERSION" ] && continue
        "$ENGINE" tag "mini-scraper:$VERSION" "$t"
      done
      echo "No merged manifest created. Tagged ${FINAL_TAGS[*]} for host architecture ($NATIVE_ARCH) only."
    fi
  fi
fi

echo "Done. Local images:"
"$ENGINE" images "mini-scraper" --format '  {{.Repository}}:{{.Tag}}  {{.ID}}  {{.Size}}'
if [ -n "$REGISTRY" ]; then
  "$ENGINE" images "$REGISTRY/mini-scraper" --format '  {{.Repository}}:{{.Tag}}  {{.ID}}  {{.Size}}'
fi
