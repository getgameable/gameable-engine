import { cpSync, mkdirSync } from 'node:fs';
const out = new URL('../dist/wit/', import.meta.url);
mkdirSync(out, { recursive: true });
cpSync(new URL('../../../wit/', import.meta.url), out, { recursive: true });
