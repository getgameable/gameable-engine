#!/usr/bin/env node
// The `create-gameable` executable, which `npm create gameable` runs. Two
// lines on purpose: the command lives in src/create.ts and is built to
// dist/bin.js by `npm run build -w packages/create-gameable`.
import './../dist/bin.js';
