import { createServer } from 'node:http';
import { createConversationRelay, servicesFromEnv } from 'gameable/conversation/relay';

// Credentials stay in this process. Never use VITE_ names for service keys.
// GAMEABLE_API_KEY (your Gameable account's API key) opens the hosted services.
const services = servicesFromEnv(process.env);
const configured = services !== undefined;
const server = configured
  ? createConversationRelay({
      ...services,
      origins: (
        process.env.HELLO_ORIGINS ||
        'https://engine.gameable.com,http://localhost:5180,http://127.0.0.1:5180,http://localhost:4180,http://127.0.0.1:4180,http://localhost:5188,http://127.0.0.1:5188,http://localhost:4188,http://127.0.0.1:4188'
      )
        .split(',')
        .map((s) => s.trim()),
      characters: { greeter: { character: 'engine-hello', story: 'engine-hello' } },
    })
  : createServer((_request, response) => {
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Conversation is not configured on this server.' }));
    });
server.listen(Number(process.env.HELLO_RELAY_PORT || 8788), '127.0.0.1', () => {
  console.log(
    configured
      ? 'Hello conversation relay ready.'
      : 'Hello conversation relay needs GAMEABLE_API_KEY (the API key from your Gameable account).',
  );
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.close(() => process.exit(0)));
