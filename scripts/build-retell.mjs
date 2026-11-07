import { build } from 'esbuild';

await build({ stdin: { contents: "export { RetellWebClient } from 'retell-client-js-sdk';",
  resolveDir: new URL('..', import.meta.url).pathname },
  outfile: new URL('../public/vendor/retell-client.js', import.meta.url).pathname,
  bundle: true, format: 'esm', platform: 'browser', minify: true,
  banner: { js: '// Retell browser SDK 3.0.2. Rebuild with: node scripts/build-retell.mjs' } });
