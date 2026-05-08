// Patch WebAssembly.instantiate to block large WASM allocations.
// Next.js 15 uses xxhash via WASM for content hashing — on VPS kernels
// with restricted virtual memory this OOMs. Blocking it forces fallback to md4.
const _orig = WebAssembly.instantiate;
WebAssembly.instantiate = function(source, imports) {
  const buf = source instanceof ArrayBuffer ? source
    : source instanceof Uint8Array ? source.buffer
    : null;
  if (buf && buf.byteLength > 1024) {
    throw new RangeError("WebAssembly disabled (disable-wasm.js): falling back to md4");
  }
  return _orig.apply(this, arguments);
};
const _origSync = WebAssembly.Instance;
// Also patch compile
const _origCompile = WebAssembly.compile;
WebAssembly.compile = function(source) {
  const buf = source instanceof ArrayBuffer ? source
    : source instanceof Uint8Array ? source.buffer
    : null;
  if (buf && buf.byteLength > 1024) {
    throw new RangeError("WebAssembly disabled (disable-wasm.js): falling back to md4");
  }
  return _origCompile.apply(this, arguments);
};
