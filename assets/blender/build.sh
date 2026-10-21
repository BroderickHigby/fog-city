#!/usr/bin/env bash
# Rebuild every Fog City asset from its script: public/models/* and public/audio/*.
#
#   assets/blender/build.sh             # all models + content/landmarks.json + sounds, then GLB stats
#   assets/blender/build.sh robotaxi    # one model (script name without .py)
#   assets/blender/build.sh --lookdev   # all models, then the look-dev renders (slow)
#   FC_REVOLUTION_POSE=raised assets/blender/build.sh r_evolution
#                                       # R-Evolution with her arms raised (see README)
#
# Blender 4.5 LTS runs headless on 2 threads. Set BLENDER to its binary (default: blender on
# PATH) and FC_BLENDER_THREADS to change the thread count.
# Any failure stops the build with a non-zero status: Blender's own exit status (a Python
# exception exits 1 through --python-exit-code), a Traceback in its output, a model script
# that did not report its GLB, or a look-dev render that did not write its PNG.
set -euo pipefail
cd "$(dirname "$0")/../.."
BLENDER="${BLENDER:-blender}"
# Blender's thread count (the machine is shared; renders also read FC_RENDER_THREADS).
THREADS="${FC_BLENDER_THREADS:-2}"
# numpy's BLAS on one thread: OpenBLAS threads spin on a busy machine, and a fixed summation
# order keeps the humanoid bake byte-identical whatever the core count.
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
LOG="$(mktemp)"
STAMP="$(mktemp)"
trap 'rm -f "$LOG" "$STAMP"' EXIT

# run <script.py> [args after --]: run Blender headless, show the useful lines, fail on error.
run() {
  local script="$1"
  shift
  local status=0
  "$BLENDER" -b --factory-startup -noaudio -t "$THREADS" --python-exit-code 1 -P "$script" -- "$@" >"$LOG" 2>&1 || status=$?
  grep -E '^\[fc\]|^\[lookdev\]|Error|error|Traceback|^  File' "$LOG" || true
  if [ "$status" -ne 0 ]; then
    echo "build.sh: $script: Blender exited with status $status; last lines:" >&2
    tail -n 20 "$LOG" >&2
    return 1
  fi
  if grep -q 'Traceback' "$LOG"; then
    echo "build.sh: $script: Python traceback (see above)" >&2
    return 1
  fi
}

MODELS=(ferry_building r_evolution player_car robotaxi errand_robot sidewalk_bot muni_bus humanoid humanoid_impostor moat_van props water_blaster heaps animals)
LOOKDEV=0
ONLY=()
for a in "$@"; do
  case "$a" in
    --lookdev) LOOKDEV=1 ;;
    *) ONLY+=("$a") ;;
  esac
done
[ ${#ONLY[@]} -gt 0 ] && MODELS=("${ONLY[@]}")

for m in "${MODELS[@]}"; do
  if [ ! -f "assets/blender/models/$m.py" ]; then
    echo "build.sh: no model script assets/blender/models/$m.py" >&2
    exit 1
  fi
  run "assets/blender/models/$m.py"
  if ! grep -q '^\[fc\] wrote' "$LOG"; then
    echo "build.sh: $m did not write its GLB" >&2
    exit 1
  fi
done

python3 assets/blender/tools/landmarks.py

# Sound effects (numpy + ffmpeg, see assets/audio/README.md): on a full build only.
if [ ${#ONLY[@]} -eq 0 ]; then
  python3 assets/audio/generate.py
fi

# Triangle counts as exported (read back from the GLBs, not Blender's pre-export count).
if [ -d node_modules/@gltf-transform/core ]; then
  node assets/blender/tools/glb-stats.ts
else
  echo "build.sh: node_modules missing; run pnpm install to print the GLB stats" >&2
fi

if [ "$LOOKDEV" = 1 ]; then
  for s in assets/blender/lookdev/0*.py assets/blender/lookdev/humanoid_*.py; do
    png="assets/blender/lookdev/$(basename "$s" .py | tr '_' '-').png"
    touch "$STAMP"
    run "$s"
    if [ ! -s "$png" ] || [ ! "$png" -nt "$STAMP" ]; then
      echo "build.sh: $s did not write $png" >&2
      exit 1
    fi
  done
fi
