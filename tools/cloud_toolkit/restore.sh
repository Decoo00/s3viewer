#!/usr/bin/env bash
# 클라우드 컨테이너(Ubuntu 24.04 x64)에 변환·검증 도구를 복원한다.
# usage: bash restore.sh [설치 위치, 기본 $HOME/s3tools]
#        source <설치 위치>/env.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
dest=${1:-$HOME/s3tools}
mkdir -p "$(dirname "$dest")"
cat "$here"/s3tools.tar.xz.part* | tar -xJ -C "$(dirname "$dest")"
[ "$(basename "$dest")" = s3tools ] || mv "$(dirname "$dest")/s3tools" "$dest"

cat > "$dest/env.sh" <<EOF
export S3TOOLS=$dest
export DOTNET_ROOT=$dest/dotnet
export PATH=$dest/dotnet:\$PATH
export BFRASS=$dest/bin/bfrass
export FSKA_DUMP=$dest/fska_dump/fska_dump.dll
export THREE_DIR=$dest/three186
export PYTHONPATH=$dest/pyshim\${PYTHONPATH:+:\$PYTHONPATH}
EOF

source "$dest/env.sh"
dotnet --list-runtimes
"$BFRASS" 2>&1 | head -1 || true
echo "restored to $dest  →  source $dest/env.sh"
