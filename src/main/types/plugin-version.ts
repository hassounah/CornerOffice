/** Minimum plugin version that supports the channels protocol. Kept in its own
 *  zod-free module so the agent descriptors can import it without pulling
 *  channels.ts's schemas into the renderer's entry chunk. */
export const MINIMUM_PLUGIN_VERSION = '1.31.0'
