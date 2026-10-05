import { describe, expect, it } from 'vitest';
import { FrameRate, keyboardInset } from '../src/presentation';

describe('render FPS', () => {
  it('measures rendered frames rather than fixed simulation steps', () => {
    const rate = new FrameRate();
    rate.sample(100);
    for (let i = 1; i < 30; i++) expect(rate.sample(100 + (i * 1000) / 60)).toBeNull();
    expect(rate.sample(600)).toBe(60);
  });
  it('does not report a paused tab as low rendering performance', () => {
    const rate = new FrameRate();
    rate.sample(100);
    expect(rate.sample(10000)).toBeNull();
    for (let i = 1; i < 15; i++) rate.sample(10000 + (i * 1000) / 30);
    expect(rate.sample(10500)).toBe(30);
  });
});

it('raises chat for the phone keyboard, ignoring browser chrome', () => {
  expect(keyboardInset(800, 500, 0)).toBe(300);
  expect(keyboardInset(800, 700, 0)).toBe(0);
  expect(keyboardInset(800, 500, 30)).toBe(270);
  expect(keyboardInset(800, 850, 0)).toBe(0);
});
