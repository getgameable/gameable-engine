/**
 * Local ESLint rules encoding gameable's hard rules.
 *
 * Keep these tiny and syntactic. Anything that needs type information belongs
 * in a typescript-eslint rule configured in `eslint.config.js`.
 */

/** Specifiers that are allowed instead of a bare `three` import. */
const ALLOWED = ['three/webgpu', 'three/tsl', 'three/addons/'];

/** @type {import('eslint').Rule.RuleModule} */
const noBareThreeImport = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Disallow importing from bare 'three'; use 'three/webgpu', 'three/tsl' or 'three/addons/...'.",
    },
    schema: [],
    messages: {
      bareThree:
        "Import from 'three/webgpu' (or 'three/tsl' / 'three/addons/...'), never bare 'three'. " +
        'The bare entry point pulls in the WebGL renderer and creates a second three singleton.',
    },
  },
  create(context) {
    /**
     * Report `node` when `value` is the bare three entry point.
     *
     * @param {import('estree').Node} node Node to attach the report to.
     * @param {unknown} value Module specifier being imported.
     * @returns {void}
     */
    function check(node, value) {
      if (typeof value !== 'string') return;
      if (value !== 'three') return;
      if (ALLOWED.some((a) => value.startsWith(a))) return;
      context.report({ node, messageId: 'bareThree' });
    }

    return {
      ImportDeclaration(node) {
        check(node.source, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node.source, node.source.value);
      },
      ExportAllDeclaration(node) {
        if (node.source) check(node.source, node.source.value);
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal') check(node.source, node.source.value);
      },
      TSImportType(node) {
        if (node.argument?.type === 'TSLiteralType') {
          check(node.argument, node.argument.literal?.value);
        } else if (node.argument?.type === 'Literal') {
          check(node.argument, node.argument.value);
        }
      },
    };
  },
};

/** @type {import('eslint').ESLint.Plugin} */
const plugin = {
  meta: { name: 'gameable-rules', version: '0.0.0' },
  rules: {
    'no-bare-three-import': noBareThreeImport,
  },
};

export default plugin;
