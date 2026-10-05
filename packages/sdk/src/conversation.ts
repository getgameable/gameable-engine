import { requireRuntime } from './state';
import type { ConversationCmd } from './types';

/**
 * Structural interview controls; all streams remain in optional host modules.
 *
 * @example
 * ```ts
 * import { conversation } from 'gameable';
 * conversation.command(npc, 'start', 'steward');
 * conversation.command(npc, 'ask', 'steward', 'Who had the study key?');
 * ```
 */
export const conversation = {
  /**
   * Queue one control using the reusable command pool.
   *
   * @param entity Interview entity.
   * @param action Lifecycle or question action.
   * @param character Host-configured id.
   * @param text Question, if any.
   */
  command(entity: number, action: ConversationCmd['action'], character = '', text = ''): void {
    requireRuntime().commands.conversation(entity, action, character, text);
  },
};
