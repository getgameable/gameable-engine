/** Stable full-state message emitted by Convorcher after analysis and on join. */
export interface StorySnapshot {
  schemaVersion: 1;
  sessionId: string;
  storyId: string;
  revision: number;
  currentPhase: string;
  completedObjectives: string[];
  playerState: Record<string, string>;
  transitionCause: string;
}
/**
 * Narrow untrusted JSON before reading protocol fields.
 *
 * @param value Untrusted value.
 * @returns A plain record or an empty record.
 */
export function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
/**
 * Validate a bounded, versioned story snapshot.
 *
 * @param value Untrusted message data.
 * @returns Owned snapshot, or null for invalid data.
 */
export function parseStorySnapshot(value: unknown): StorySnapshot | null {
  const s = record(value);
  const strings = ['sessionId', 'storyId', 'currentPhase', 'transitionCause'];
  if (
    s.schemaVersion !== 1 ||
    !Number.isSafeInteger(s.revision) ||
    (s.revision as number) < 0 ||
    strings.some((k) => typeof s[k] !== 'string' || s[k].length > 8192)
  )
    return null;
  if (
    !Array.isArray(s.completedObjectives) ||
    s.completedObjectives.length > 256 ||
    !s.completedObjectives.every((v: unknown) => typeof v === 'string' && v.length <= 256)
  )
    return null;
  const player = record(s.playerState);
  if (
    s.playerState === null ||
    typeof s.playerState !== 'object' ||
    Array.isArray(s.playerState) ||
    Object.keys(player).length > 128 ||
    Object.entries(player).some(
      ([k, v]) => k.length > 256 || typeof v !== 'string' || v.length > 8192,
    )
  )
    return null;
  return {
    schemaVersion: 1,
    sessionId: s.sessionId as string,
    storyId: s.storyId as string,
    revision: s.revision as number,
    currentPhase: s.currentPhase as string,
    completedObjectives: Array.from(s.completedObjectives as string[]),
    playerState: { ...player } as Record<string, string>,
    transitionCause: s.transitionCause as string,
  };
}
/**
 * Idempotent reducer scoped to an expected session and story.
 *
 * @param current Last accepted snapshot.
 * @param next Candidate snapshot.
 * @param sessionId Expected session.
 * @param storyId Expected story.
 * @returns The accepted snapshot, or the previous state.
 */
export function acceptStorySnapshot(
  current: StorySnapshot | null,
  next: StorySnapshot,
  sessionId: string,
  storyId: string,
): StorySnapshot | null {
  if (
    next.sessionId !== sessionId ||
    next.storyId !== storyId ||
    (current !== null && current.revision >= next.revision)
  )
    return current;
  return next;
}
