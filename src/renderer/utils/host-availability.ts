// ---------------------------------------------------------------------------
// host-availability — reads the values of `agents:getHostAvailability`: 'found',
// 'not-found', or 'found-in-writable-root:<real path>' (found, but inside a
// directory the sandbox can write: SEC-M3). The last counts as found.
// ---------------------------------------------------------------------------

const WRITABLE_ROOT_PREFIX = 'found-in-writable-root:'

/** Is the binary on the host? `undefined` (not looked up, or no entry) is not a claim either way. */
export function isFoundOnHost(value: string | undefined): boolean {
  return value !== undefined && value !== 'not-found'
}

/** The binary's real path when it lies inside a sandbox-writable directory, else `null`. */
export function writableRootPath(value: string | undefined): string | null {
  return value !== undefined && value.startsWith(WRITABLE_ROOT_PREFIX) ? value.slice(WRITABLE_ROOT_PREFIX.length) : null
}
