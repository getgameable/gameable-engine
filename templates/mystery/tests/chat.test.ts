/**
 * Chat: a line from one player, echoed to everyone with the sender's name,
 * capped, and shown as plain text.
 */
import { createDomHud, type HudDocument, type HudElement } from 'gameable/host';
import { describe, expect, it } from 'vitest';

import { CHAT_MAX_CHARS } from '../src/chat';
import { PHASE_OVER, round } from '../src/round';
import { huds, joined, left, message, sends, type Room } from './room';
import { lobby, voting } from './rounds';

/**
 * @param player The sender.
 * @param text What they typed.
 * @returns The `chat` message, as the page sends it.
 */
const chat = (player: number, text: unknown): ReturnType<typeof message> =>
  message(player, 'chat', { text });

describe('chat', () => {
  it('echoes a line to everyone with the sender name and seat', () => {
    const room = lobby(3);
    const out = room.step([chat(1, 'hello')]);
    expect(sends(out.commands, 'chat')).toEqual([
      { to: undefined, payload: { player: 1, name: 'p1', text: 'hello' } },
    ]);
    const rows = huds(out.commands);
    expect(rows.map((h) => h.player).sort()).toEqual([0, 1, 2]);
    for (const h of rows) expect(h.model.text?.['chat 3']).toBe('#2 p1: hello');
  });

  it(`cuts a long line to ${String(CHAT_MAX_CHARS)} characters`, () => {
    const room = lobby(3);
    const out = room.step([chat(0, 'x'.repeat(300))]);
    const [line] = sends(out.commands, 'chat');
    expect(line.payload.text).toBe('x'.repeat(CHAT_MAX_CHARS));
  });

  it('drops a payload over its byte cap, or not a line of text, and echoes nothing', () => {
    const room = lobby(3);
    const out = room.step([
      chat(0, 'x'.repeat(4000)),
      chat(0, 42),
      message(0, 'chat', 'bare'),
      chat(0, ' \n\t '),
    ]);
    expect(sends(out.commands, 'chat')).toEqual([]);
  });

  it('keeps markup as text and strips control and direction characters', () => {
    const room = lobby(3);
    const out = room.step([chat(2, '<img src=x onerror=alert(1)>\n‮evil\u0000')]);
    const [line] = sends(out.commands, 'chat');
    expect(line.payload.text).toBe('<img src=x onerror=alert(1)> evil');
  });

  it('strips the Arabic letter mark, the Mongolian vowel separator, fillers and lone surrogates', () => {
    const room = lobby(3);
    const raw = 'a؜b᠎cㅤdﾠeᅟf￹g\udc00h\ud800i 😀';
    const out = room.step([chat(0, raw)]);
    const [line] = sends(out.commands, 'chat');
    expect(line.payload.text).toBe('a b c d e f g h i 😀');
  });

  it('keeps no lone surrogate, so the echo of a legal line always fits its cap', () => {
    const room = lobby(3);
    const blank = room.step([chat(0, '\udc00'.repeat(83))]);
    expect(sends(blank.commands, 'chat')).toEqual([]); // all blank: nothing to say
    const out = room.step([chat(0, `x${'\udc00'.repeat(80)}y`)]);
    expect(sends(out.commands, 'chat').map((l) => l.payload.text)).toEqual(['x y']);
  });

  it('keeps the last three lines in the HUD, oldest first', () => {
    const room = lobby(3);
    room.step([chat(0, 'one'), chat(1, 'two')]);
    room.step([chat(2, 'three')]);
    const out = room.step([chat(0, 'four')]);
    const text = huds(out.commands).find((h) => h.player === 1)?.model.text;
    expect([text?.['chat 1'], text?.['chat 2'], text?.['chat 3']]).toEqual([
      '#2 p1: two',
      '#3 p2: three',
      '#1 p0: four',
    ]);
  });

  it("is drawn as text by the page's HUD, never as HTML", () => {
    const room = lobby(3);
    const out = room.step([chat(1, '<b onclick=x>hi</b>')]);
    const hud = out.commands.find((c) => c.tag === 'set-player-hud' && c.val.player === 0);
    const written: string[] = [];
    /** @returns A fake element that refuses `innerHTML`. */
    const element = (): HudElement => {
      let text: string | null = '';
      const el = {
        className: '',
        style: { setProperty: (): void => undefined },
        append: (): void => undefined,
        remove: (): void => undefined,
        get textContent(): string | null {
          return text;
        },
        set textContent(value: string | null) {
          text = value;
          if (value !== null) written.push(value);
        },
      };
      Object.defineProperty(el, 'innerHTML', {
        set: () => {
          throw new Error('the HUD wrote innerHTML');
        },
      });
      return el;
    };
    const document: HudDocument = { createElement: element };
    const renderer = createDomHud({ document, container: element() });
    expect(hud?.tag).toBe('set-player-hud');
    renderer.set(hud?.tag === 'set-player-hud' ? hud.val.hud : undefined);
    expect(written).toContain('#2 p1: <b onclick=x>hi</b>');
  });
});

describe('ghost chat', () => {
  /**
   * @param out A step's output.
   * @param id A player.
   * @returns The chat rows on that player's HUD.
   */
  const rows = (out: ReturnType<Room['step']>, id: number): string[] => {
    const text = huds(out.commands).find((h) => h.player === id)?.model.text ?? {};
    return ['chat 1', 'chat 2', 'chat 3'].map((k) => text[k] ?? '');
  };

  it("keeps a tagged-out player's line from every living player while the round runs", () => {
    const { room, tagged, crew } = voting(4);
    const out = room.step([chat(tagged, `${String(round.it + 1)} did it`)]);
    const echoes = sends(out.commands, 'chat');
    expect(echoes.length).toBeGreaterThan(0);
    for (const e of echoes) expect(e.to).toBe(tagged);
    for (const id of [round.it, ...crew]) {
      expect(rows(out, id).join('|')).not.toContain('did it');
    }
    expect(rows(out, tagged)[2]).toContain('did it');
  });

  it('reaches the other ghosts: a spectator who joined mid-round and a tagged player', () => {
    const { room, tagged, crew } = voting(4);
    room.step([joined(4)]);
    const out = room.step([chat(4, 'hi ghosts')]);
    expect(
      sends(out.commands, 'chat')
        .map((e) => e.to)
        .sort(),
    ).toEqual([tagged, 4].sort());
    expect(rows(out, tagged)[2]).toContain('hi ghosts');
    for (const id of [round.it, ...crew]) {
      expect(rows(out, id).join('|')).not.toContain('hi ghosts');
    }
  });

  it("sends a living player's line to everyone, ghosts included", () => {
    const { room, tagged, crew } = voting(4);
    const out = room.step([chat(crew[0], 'who was it')]);
    expect(sends(out.commands, 'chat').map((e) => e.to)).toEqual([undefined]);
    expect(rows(out, tagged)[2]).toContain('who was it');
    expect(rows(out, round.it)[2]).toContain('who was it');
  });

  it('lets everyone hear everyone again once the round is over', () => {
    const { room, tagged } = voting(4);
    room.step([left(round.it)]);
    expect(round.phase).toBe(PHASE_OVER);
    const out = room.step([chat(tagged, 'gg')]);
    expect(sends(out.commands, 'chat').map((e) => e.to)).toEqual([undefined]);
    for (const h of huds(out.commands)) expect(h.model.text?.['chat 3']).toContain('gg');
  });
});
