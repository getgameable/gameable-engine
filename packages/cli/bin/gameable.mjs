#!/usr/bin/env node
// The `gameable` executable. Two lines on purpose: the command lives in
// src/cli.ts and is built to dist/bin.js by `npm run build -w packages/cli`.
// If this fails with ERR_MODULE_NOT_FOUND, the package has not been built.
import './../dist/bin.js';
