/**
 * Read a complete mono PCM16/16 kHz WAV utterance, rejecting other formats.
 *
 * @param wav Voxy's utterance WAV bytes.
 * @returns Owned little-endian PCM bytes suitable for Parlay.
 */
export function wavToPcm16(wav: ArrayBuffer): Uint8Array<ArrayBuffer> {
  const view = new DataView(wav);
  const tag = (offset: number): string => String.fromCharCode(...new Uint8Array(wav, offset, 4));
  if (
    wav.byteLength < 44 ||
    tag(0) !== 'RIFF' ||
    tag(8) !== 'WAVE' ||
    view.getUint32(4, true) + 8 !== wav.byteLength
  ) {
    throw new Error('Invalid WAV utterance');
  }
  let format = false;
  let pcm: Uint8Array<ArrayBuffer> | undefined;
  for (let offset = 12; offset + 8 <= wav.byteLength;) {
    const size = view.getUint32(offset + 4, true);
    const end = offset + 8 + size;
    if (end > wav.byteLength) throw new Error('Truncated WAV chunk');
    if (tag(offset) === 'fmt ') {
      if (
        size < 16 ||
        view.getUint16(offset + 8, true) !== 1 ||
        view.getUint16(offset + 10, true) !== 1 ||
        view.getUint32(offset + 12, true) !== 16000 ||
        view.getUint16(offset + 20, true) !== 2 ||
        view.getUint16(offset + 22, true) !== 16
      ) {
        throw new Error('Expected mono PCM16 at 16000 Hz');
      }
      format = true;
    }
    if (tag(offset) === 'data') {
      if (pcm !== undefined || size === 0 || size % 2 !== 0 || size > 16000 * 2 * 30)
        throw new Error('Invalid utterance length');
      pcm = new Uint8Array(wav.slice(offset + 8, end));
    }
    offset = end + (size & 1);
  }
  if (!format || pcm === undefined) throw new Error('Missing WAV format or samples');
  return pcm;
}
