// tests/helpers/extract-function.mjs
//
// public/app.js is a classic script that touches the DOM at load time, so it cannot be imported in
// Node. This helper pulls individual top-level functions out of its source by brace matching, which
// lets the tests exercise the real shipped code instead of a copy.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP_PATH = fileURLToPath(new URL('../../public/app.js', import.meta.url));

export function appSource() {
  return readFileSync(APP_PATH, 'utf8');
}

export function extractFunction(name) {
  const src = appSource();
  // Prefer the async declaration so `await` inside the body stays legal
  let start = src.indexOf(`async function ${name}(`);
  if (start === -1) start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in public/app.js`);

  let depth = 0;
  let i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) throw new Error(`unbalanced braces while extracting ${name}`);

  const body = src.slice(start, i + 1);
  // Return the callable itself, bound to the globals it expects (inject them by name)
  return new Function('return ' + body)();
}
