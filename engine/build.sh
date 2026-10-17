#!/bin/sh
# Builds the game for each platform into bin/, with zig (https://ziglang.org, 0.13):
#   sh engine/build.sh [path to zig]
set -e
ZIG="${1:-zig}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/doomgeneric"
OUT="$HERE/../bin"
FILES=$(grep "^SRC_DOOM" "$SRC/Makefile" | sed 's/SRC_DOOM = //; s/doomgeneric_xlib.o/doomgeneric_claude.o/; s/\.o/.c/g')
FLAGS="-O2 -g0 -s -DDOOMGENERIC_RESX=320 -DDOOMGENERIC_RESY=200 -w"
build() {
  mkdir -p "$OUT/$1"
  (cd "$SRC" && "$ZIG" cc $FLAGS -target "$2" $4 $FILES -o "$OUT/$1/$3")
  rm -f "$OUT/$1/"*.pdb
  echo "built bin/$1/$3"
}
build windows-x64 x86_64-windows-gnu doom-claude.exe "-D_CRT_SECURE_NO_WARNINGS"
build linux-x64 x86_64-linux-musl doom-claude "-DNORMALUNIX -DLINUX -D_DEFAULT_SOURCE -static"
build macos-arm64 aarch64-macos doom-claude "-DNORMALUNIX -D_DEFAULT_SOURCE"
build macos-x64 x86_64-macos doom-claude "-DNORMALUNIX -D_DEFAULT_SOURCE"
