// ARKit-52 -> MetaHuman-188 control mapping.
//
// Ported verbatim from D:/Projects/AvatarOS/aos-facerigmatcher/facerigmatcher/utils/arkit_mapper.py
// (function arkit_to_mh). Maps 52 ARKit blendshape weights to a 188-element
// MetaHuman control array — the same mapping used to generate rig2mesh's
// training data. Includes signed/unsigned splits, max() over left/right
// pairs, and the lipsTogether corrective clamp on indices 73, 74, 147, 148.
//
// This is the canonical reference implementation: `arkitToRig.ts` is the only
// consumer, and the 188-name ordering it writes into is `rigNamesMh.ts`.
//
// Ported from aos-threejs-poc/src/ogs/rig/arkitToMh.js @ cdd63b10

/** The MetaHuman control-vector width `arkitToMh` writes into. */
export const MH_LEN = 188;

/**
 * Map 52 ARKit blendshape weights onto the 188-element MetaHuman control array.
 *
 * @param arkit Live ARKit weights, length >= 52.
 * @param out Destination, length `MH_LEN`. ZEROED first — many indices are never
 *   written below and would otherwise carry over from the previous frame.
 * @returns `out`, filled with the 188 MetaHuman control weights.
 */
export function arkitToMh(arkit: ArrayLike<number>, out: Float32Array): Float32Array {
  const a = arkit;
  const r = out;
  // Zero everything first — many indices aren't written below and would
  // otherwise carry over from the previous frame.
  r.fill(0);

  r[42] = a[0] - a[6];
  r[39] = a[4] - a[1];
  r[38] = a[2] - a[3];
  r[116] = a[7] - a[13];
  r[113] = a[11] - a[8];
  r[112] = a[9] - a[10];
  r[5] = a[16] - a[15];
  r[6] = a[17];
  r[7] = a[14] * -1;
  r[49] = a[5];
  r[123] = a[12];
  r[133] = a[21];
  r[59] = a[22];
  r[84] = a[23];
  r[158] = a[24];
  r[132] = a[25];
  r[58] = a[26];
  r[62] = a[27];
  r[136] = a[28];
  r[89] = a[29];
  r[163] = a[30];
  r[10] = a[34];
  r[77] = a[37];
  r[151] = a[38];
  r[100] = a[39];
  r[174] = a[40];
  r[33] = a[41];
  r[107] = a[42];
  r[36] = a[44];
  r[110] = a[45];
  r[43] = a[47];
  r[117] = a[48];
  r[104] = a[49];
  r[178] = a[50];

  const val = a[17] > 0 ? Math.min(1.0, a[18] / a[17]) : a[18];
  r[73] = r[74] = r[147] = r[148] = val;
  r[63] = r[64] = r[137] = r[138] = a[19];
  r[80] = r[81] = r[154] = r[155] = a[20];
  r[71] = r[145] = a[31];
  r[72] = r[146] = a[32];
  r[75] = r[149] = a[33];
  r[78] = r[79] = a[35];
  r[152] = r[153] = a[36];
  r[35] = r[109] = a[43];
  r[91] = r[165] = a[46];

  return r;
}
