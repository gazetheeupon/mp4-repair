# Building `untrunc.js` / `untrunc.wasm`

GPL-2.0 corresponding source for this repo's compiled repair engine: the
pinned upstream commit, the patch applied to it, and the exact build
commands, so the binary can be reproduced from scratch.

## Upstream

- Repo: https://github.com/anthwlock/untrunc (GPL-2.0)
- Pinned commit: `9d86ec9ef2ffed1bf8131abe80742c0574db52b6`
- Patch: `patches/0001-wasm-build-support.patch` (applies with `git apply`
  from the repo root after cloning the pinned commit above). Adds an
  `UNTRUNC_WASM_BUILD`-guarded WASM entry point and replaces `FileRead`/
  `FileWrite`'s I/O with JS bridges for Blob-based input and OPFS-backed
  output; the native (non-WASM) build path is untouched by the patch.

## Toolchain

Built with Emscripten 3.1.6 (via `apt-get install emscripten` on Ubuntu
24.04 "noble" — the upstream emsdk installer's own download host,
`storage.googleapis.com`, was unreachable in the environment this was
built in; any Emscripten 3.1.x toolchain providing `em++`/`emconfigure`/
`emmake` should work).

## Step 1: pinned static FFmpeg 3.3.9 (LGPL, unmodified)

```sh
git clone --depth 1 --branch n3.3.9 https://github.com/FFmpeg/FFmpeg.git ffmpeg-3.3.9
cd ffmpeg-3.3.9
emconfigure ./configure \
  --disable-doc --disable-everything --enable-decoders \
  --disable-vdpau --enable-demuxers --enable-protocol=file --disable-avdevice \
  --disable-swresample --disable-swscale --disable-avfilter --disable-xlib \
  --disable-vaapi --disable-zlib --disable-bzlib --disable-lzma \
  --disable-audiotoolbox --disable-videotoolbox --disable-vda --disable-postproc \
  --disable-asm --disable-inline-asm --cc=emcc --ranlib=emranlib --ar=emar \
  --enable-cross-compile --target-os=none --arch=x86_32 --disable-programs --disable-network
emmake make -j4
```

No `--enable-gpl` is passed, so this FFmpeg build is LGPL-2.1+, not GPL —
compatible with static linking into the GPL-2.0 `untrunc` binary. It is
stock, unmodified upstream FFmpeg at the `n3.3.9` tag; nothing about our
patch touches it.

## Step 2: patched untrunc, compiled against that FFmpeg, targeting a Worker

```sh
git clone https://github.com/anthwlock/untrunc.git
cd untrunc
git checkout 9d86ec9ef2ffed1bf8131abe80742c0574db52b6
git apply /path/to/patches/0001-wasm-build-support.patch

FF=/path/to/ffmpeg-3.3.9
em++ -D_FILE_OFFSET_BITS=64 -DUNTRUNC_WASM_BUILD -std=c++17 -O2 -isystem "$FF" \
  src/*.cpp src/avc1/*.cpp src/hvc1/*.cpp \
  -L"$FF/libavformat" -lavformat -L"$FF/libavcodec" -lavcodec -L"$FF/libavutil" -lavutil \
  -s MODULARIZE=1 -s EXPORT_NAME=UntruncModule \
  -s ENVIRONMENT=worker \
  -s FORCE_FILESYSTEM=1 -lworkerfs.js \
  -s EXPORTED_RUNTIME_METHODS=ccall,cwrap,FS \
  -s EXPORTED_FUNCTIONS=_wasm_entry,_malloc,_free \
  -s ALLOW_MEMORY_GROWTH=1 \
  -o untrunc.js
```

Deliberately **not** passed: `-pthread`, `SharedArrayBuffer`, or anything
requiring `crossOriginIsolated`/COOP-COEP (this project's ad slot requires
their absence). `src/gui/` (the libui desktop GUI) is excluded — it isn't
compiled at all, native or WASM.

`src/gui/` aside, note that `-s ENVIRONMENT=worker` targets this build at
running inside a dedicated Web Worker specifically (see `worker.js`), not
the page's main thread or a plain Node script.

## Reproducing the native oracle binary (for testing, not shipped)

```sh
cd untrunc   # same checkout, patch applied, but UNTRUNC_WASM_BUILD unset
sudo apt-get install -y libavformat-dev libavcodec-dev libavutil-dev
ln -sf /usr/include/x86_64-linux-gnu /usr/include/ffmpeg   # this Makefile hardcodes that path
make
```

This produces a native `untrunc` binary from the *same* patched source tree
(the patch's `#ifdef UNTRUNC_WASM_BUILD` guards mean the native build path
is byte-for-byte the same as unpatched upstream) linked against the
system's FFmpeg instead of the pinned wasm one — useful as a correctness
oracle (see `tests/`), not part of what ships on this page.
