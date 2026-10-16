import { defineConfig, type UserConfig } from 'tsdown';

// `tsdown` builds for development (source maps); `tsdown --minify` is the production build used by vsce.
export default defineConfig((cli) => {
  const production = Boolean(cli.minify);
  const shared: UserConfig = {
    outDir: 'dist',
    // Both builds write to dist/, so neither may wipe it while the other is running.
    clean: false,
    minify: production,
    sourcemap: !production,
    dts: false,
    hash: false,
  };

  return [
    {
      ...shared,
      name: 'extension',
      entry: { extension: 'src/extension.ts' },
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      outputOptions: { entryFileNames: '[name].js' },
      deps: { neverBundle: ['vscode'] },
    },
    {
      ...shared,
      name: 'webview',
      entry: { webview: 'src/webview/main.ts' },
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
      outputOptions: { entryFileNames: '[name].js' },
      css: { fileName: 'webview.css', minify: production },
    },
  ];
});
