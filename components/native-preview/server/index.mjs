import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startClaude} from './claude.mjs';
import {startCodex} from './codex.mjs';

// One helper serves each desktop host through the file access and UI surface
// that host actually provides. The plugin bundle selects the profile.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.env.HWPX_PREVIEW_HOST === 'claude') await startClaude(root);
else await startCodex(root);
