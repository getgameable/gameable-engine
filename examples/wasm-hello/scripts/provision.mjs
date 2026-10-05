import { readFile } from 'node:fs/promises';

import { servicesFromEnv } from 'gameable/conversation/relay';

const services = servicesFromEnv(process.env);
if (services === undefined) throw new Error('Set GAMEABLE_API_KEY in .env.local first.');
const base = services.convorcherUrl.replace(/^ws/, 'http');
const body = await readFile(new URL('../stories/engine-hello.yaml', import.meta.url), 'utf8');
const response = await fetch(new URL('/api/stories/import', base), {
  method: 'POST',
  headers: { 'X-API-Key': services.convorcherKey, 'Content-Type': 'application/yaml' },
  body,
});
if (!response.ok) throw new Error(`Story import failed: HTTP ${response.status}`);
console.log('Provisioned the engine-hello guide.');
