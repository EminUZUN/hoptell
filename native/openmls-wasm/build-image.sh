#!/bin/sh
# The reproducible build of the binding bundle (amendment A11), on the build host (the remote Linux
# x64 machine, Docker). Two steps:
#
#   sh build-image.sh image TAG
#       build the final image from this directory (Dockerfile) and print its image id. Network is
#       used here only: pulling the pinned bases, installing wasm-bindgen-cli, cargo fetch --locked.
#   sh build-image.sh build IMAGE_ID OUT_DIR
#       one clean build in a new container from that image, removed afterwards (--rm): no network,
#       no published port, one bind mount (OUT_DIR, which must not exist yet), the container limits
#       below, started under nice/ionice (which lower the docker client's priority; the container's
#       own CPU and I/O are bounded by --cpus and --blkio-weight). Writes the outputs and
#       OUT_DIR/attestation.json: the image id, the container's start and end time (UTC, taken
#       on the host around `docker run`) and each output's SHA-256.
#
# Two builds from the same image id must give byte-identical outputs; scripts/build-mapping.mjs
# records both attestations in the build mapping and refuses them otherwise.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
case "${1:-}" in
image)
  tag=${2:?usage: sh build-image.sh image TAG}
  docker build --file "$here/Dockerfile" --tag "$tag" "$here" >&2
  docker image inspect --format '{{.Id}}' "$tag"
  ;;
build)
  image=${2:?usage: sh build-image.sh build IMAGE_ID OUT_DIR}
  out=${3:?usage: sh build-image.sh build IMAGE_ID OUT_DIR}
  case "$image" in sha256:*) ;; *) echo "build-image.sh: give the image id (sha256:...), not a tag" >&2; exit 2 ;; esac
  # OUT_DIR is taken relative to the caller's directory.
  if [ -e "$out" ]; then echo "build-image.sh: $out exists; every build writes to a new directory" >&2; exit 2; fi
  mkdir -p "$out"
  out=$(cd "$out" && pwd)
  started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  nice -n 19 ionice -c3 docker run --rm --cpus 2 --memory 3g --pids-limit 512 --blkio-weight 100 \
    --network none --mount "type=bind,src=$out,dst=/out" -e "OUT_OWNER=$(id -u):$(id -g)" "$image" sh build.sh /out
  finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  sum() { sha256sum "$out/$1" | cut -d' ' -f1; }
  printf '{\n  "finished": "%s",\n  "format": "hoptell-build-attestation-1",\n  "image": "%s",\n  "outputs": {\n    "glue": "%s",\n    "glueUnwrapped": "%s",\n    "wasm": "%s"\n  },\n  "started": "%s"\n}\n' \
    "$finished" "$image" "$(sum openmls_wasm.js)" "$(sum unwrapped/openmls_wasm.js)" "$(sum openmls_wasm_bg.wasm)" "$started" > "$out/attestation.json"
  cat "$out/attestation.json"
  ;;
*)
  echo "usage: sh build-image.sh image TAG | build IMAGE_ID OUT_DIR" >&2
  exit 2
  ;;
esac
