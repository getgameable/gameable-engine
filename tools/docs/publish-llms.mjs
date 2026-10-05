/** Publish the repository's LLM bundles when VitePress starts or builds. */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// One list of bundles: a bundle the generator writes and lints is a bundle the site publishes.
import { OUTPUTS } from './llms/budgets.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Copy the committed bundles into public/ and adapt the index to the website.
 * Repository-only references are published as plain text; documentation and
 * package links resolve to the site's existing pages. Repository outputs stay
 * unchanged, so the same index also works in a local checkout.
 *
 * @param {string} publicDir VitePress's public directory.
 * @returns {void}
 */
export function publishLlms(publicDir) {
  mkdirSync(publicDir, { recursive: true });
  for (const name of OUTPUTS) {
    copyFileSync(join(ROOT, name), join(publicDir, name));
  }
  const index = readFileSync(join(ROOT, 'llms.txt'), 'utf8').replace(
    /\]\(([^)]+)\)/g,
    (_match, target) => {
      if (OUTPUTS.includes(target)) return `](/${target})`;
      if (target === 'docs/api/') return '](/api/)';
      if (target.startsWith('docs/') && target.endsWith('.md')) {
        const page = target
          .slice(5)
          .replace(/(^|\/)index\.md$/, '$1')
          .replace(/\.md$/, '');
        return `](/${page})`;
      }
      const pkg = /^packages\/([^/]+)\/README\.md$/.exec(target);
      if (pkg) return `](/api/@gameable.${pkg[1]})`;
      // These links come from our generated index, never from a request URL.
      if (
        !/^(AGENTS\.md|templates\/[^/]+\/src\/game\.ts|docs\/schemas\/[^/]+\.json)$/.test(target)
      ) {
        throw new Error(`Unmapped LLM index link: ${target}`);
      }
      const published = `llms/${target}.txt`;
      const destination = join(publicDir, published);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(ROOT, target), destination);
      return `](/${published})`;
    },
  );
  writeFileSync(join(publicDir, 'llms.txt'), index);
}
