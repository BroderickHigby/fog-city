#!/usr/bin/env bash
# Rebuild every Fog City hero asset from its script: public/models/*.glb.
#
#   assets/blender/build.sh             # all models
#   assets/blender/build.sh robotaxi    # one model (script name without .py)
#   assets/blender/build.sh --lookdev   # all models, then the look-dev renders (slow)
#
# Blender 4.5 LTS runs headless. Set BLENDER to its binary (default: blender on PATH).
set -euo pipefail
cd "$(dirname "$0")/../.."
BLENDER="${BLENDER:-blender}"
run() { "$BLENDER" -b --factory-startup -noaudio -P "$@" 2>&1 | grep -E '^\[fc\]|^\[lookdev\]|Error|error|Traceback|^  File' || true; }

MODELS=(ferry_building r_evolution player_car robotaxi errand_robot sidewalk_bot muni_bus)
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
  out=$(run "assets/blender/models/$m.py")
  echo "$out"
  if ! grep -q '^\[fc\] wrote' <<<"$out"; then
    echo "build.sh: $m failed" >&2
    exit 1
  fi
done

python3 assets/blender/tools/landmarks.py

if [ "$LOOKDEV" = 1 ]; then
  for s in assets/blender/lookdev/0*.py; do
    run "$s"
  done
fi
