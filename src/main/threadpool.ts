// ---------------------------------------------------------------------------
// threadpool.ts — sizes libuv's threadpool before anything uses it (#0039, C-2).
//
// A hung filesystem call (a dead network mount) holds a threadpool thread until the kernel gives up. The
// registry's availability probes and the Discover walker are bounded and cap their orphans, but the default
// pool (4 threads) is shared with git, file watching and every other fs call, so it gets headroom.
//
// This must be the FIRST import of `index.ts`: libuv reads `UV_THREADPOOL_SIZE` when the pool is first used,
// so it has to be set before any other module evaluates. An explicit value from the environment wins.
// ---------------------------------------------------------------------------

export const DEFAULT_THREADPOOL_SIZE = '8'

process.env.UV_THREADPOOL_SIZE ??= DEFAULT_THREADPOOL_SIZE
