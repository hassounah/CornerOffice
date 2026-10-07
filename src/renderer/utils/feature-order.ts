import type { Feature } from '@main/types/workspace'

/** Newest first by numeric feature id (always 4 digits). Does not mutate the input. */
export function newestFirst(features: Feature[]): Feature[] {
  return [...features].sort((a, b) => Number(b.id) - Number(a.id))
}
