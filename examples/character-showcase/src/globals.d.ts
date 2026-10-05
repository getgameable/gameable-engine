/** What the showcase publishes on `window` for the e2e suite to read. */
import type { BenchReport } from './bench';
import type { SelfTestReport } from './selftest';

declare global {
  interface Window {
    /** Set once the first frame has rendered, or once the app knows it cannot run. */
    __AOS_READY__?: {
      rig: string;
      pack: string;
      vertices: number;
      coefficients: number;
      backend: string;
      blocked?: string;
    };
    /** Set by `?selftest=1` when the GPU-vs-reference comparison finishes. */
    __AOS_SELFTEST__?: SelfTestReport;
    /** Set by `?bench=1` when the timed run finishes. */
    __AOS_BENCH__?: BenchReport;
    /** Uncaptured WebGPU validation errors seen on the interactive path. */
    __AOS_VALIDATION__?: string[];
    /** Everything that went wrong, so a failure is a message and not a blank canvas. */
    __AOS_ERROR__?: string;
  }
}

export {};
