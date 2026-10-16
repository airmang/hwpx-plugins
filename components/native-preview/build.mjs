import {build} from 'esbuild';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {Script} from 'node:vm';
await mkdir('dist/assets', {recursive: true});
await mkdir('dist/server', {recursive: true});
const widget = await build({entryPoints: ['web/viewer.mjs'], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', minify: true, legalComments: 'inline'});
const template = await readFile('web/viewer.html', 'utf8');
const html = template.replace('/* WIDGET_BUNDLE */', () => widget.outputFiles[0].text.replace(/<\/script/gi, '<\\/script'));
// A replacement string interprets $&, $' and $` occurring inside bundled JS.
// Parse the actual embedded script, not only esbuild's pre-insertion output.
new Script(html.match(/<script>([\s\S]*)<\/script>/)[1], {filename: 'embedded-viewer.js'});
await writeFile('dist/assets/viewer.html', html);
// Claude's standard MCP Apps view (no OpenAI extensions), built the same way.
const claudeWidget = await build({entryPoints: ['web/claude-app.mjs'], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', minify: true, legalComments: 'inline'});
const claudeHtml = (await readFile('web/claude-app.html', 'utf8')).replace('/* WIDGET_BUNDLE */', () => claudeWidget.outputFiles[0].text.replace(/<\/script/gi, '<\\/script'));
new Script(claudeHtml.match(/<script>([\s\S]*)<\/script>/)[1], {filename: 'embedded-claude-app.js'});
await writeFile('dist/assets/claude-app.html', claudeHtml);
await build({entryPoints: ['server/index.mjs'], bundle: true, outfile: 'dist/server/index.mjs', format: 'esm', platform: 'node', target: 'node24', packages: 'bundle', loader: {'.html': 'text'},
  banner: {js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"}});
