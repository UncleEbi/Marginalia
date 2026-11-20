// tests/imports-resolve.test.js
//
// api/ and lib/ never get bundled: Vercel runs them as they are, so a mistyped package
// ('@supabase-supabase-js') or a name that is not actually exported ('deductAiOp') is a runtime
// failure in production, not a build error. Two such typos already shipped and were only caught by
// hand. These tests put every server module through Node's own resolver instead, which fails the same
// way the deploy would: no dependencies, no network, no bundler.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER_DIRS = ['api', 'lib'];

function serverModules() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.m?js$/.test(entry)) files.push(full);
    }
  };
  for (const dir of SERVER_DIRS) walk(path.join(ROOT, dir));
  return files.sort();
}

// Every module-level specifier: `import {a} from 'x'`, default imports, side-effect imports, `export
// {a} from 'x'`, dynamic import() and require(). Object destructuring and strings are not matched.
function importsIn(src) {
  const found = [];

  for (const m of src.matchAll(/(?:import|export)\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const names = m[1]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => part.split(/\s+as\s+/)[0].trim())
      .filter((name) => name && name !== 'default');
    found.push({ spec: m[2], names });
  }

  for (const m of src.matchAll(/(?:^|\n)\s*import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\}\s*)?from\s*['"]([^'"]+)['"]/g)) {
    found.push({ spec: m[2], defaultName: m[1] });
  }

  for (const m of src.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) found.push({ spec: m[1] });
  for (const m of src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push({ spec: m[1] });
  for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push({ spec: m[1] });

  return found;
}

function modulePath(file, spec) {
  return spec.startsWith('.') || spec.startsWith('/')
    ? path.resolve(path.dirname(file), spec)
    : null;
}

function declaredPackages() {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]);
}

function packageName(spec) {
  return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
}

test('the scan finds the server modules it is meant to check', () => {
  const files = serverModules().map((file) => path.relative(ROOT, file));
  assert.ok(files.length >= 10, `expected the api/ and lib/ modules, found ${files.join(', ')}`);
  assert.ok(files.includes(path.join('api', 'ocr.js')), 'a known route is in the scan');
});

test('every import in api/ and lib/ resolves, and every package is declared in package.json', () => {
  const declared = declaredPackages();
  const problems = [];

  for (const file of serverModules()) {
    const rel = path.relative(ROOT, file);
    const resolveFrom = createRequire(file);

    for (const { spec } of importsIn(readFileSync(file, 'utf8'))) {
      if (isBuiltin(spec) || spec.startsWith('node:')) continue;

      const local = modulePath(file, spec);
      if (local) {
        if (!existsSync(local)) problems.push(`${rel}: '${spec}' does not exist on disk`);
        continue;
      }

      try {
        resolveFrom.resolve(spec);
      } catch (e) {
        problems.push(`${rel}: '${spec}' is not an installed package (${e.code})`);
        continue;
      }

      // Resolving through a hoisted transitive dependency would pass here and fail on a clean Vercel
      // install, so the package has to be one this project actually declares.
      if (!declared.has(packageName(spec))) {
        problems.push(`${rel}: '${packageName(spec)}' resolves but is not declared in package.json`);
      }
    }
  }

  assert.deepEqual(problems, [], `unresolved imports:\n${problems.join('\n')}`);
});

test('every named and default import exists in the module it comes from', async () => {
  const problems = [];

  for (const file of serverModules()) {
    const rel = path.relative(ROOT, file);
    const resolveFrom = createRequire(file);

    for (const { spec, names, defaultName } of importsIn(readFileSync(file, 'utf8'))) {
      if (!names?.length && !defaultName) continue;
      if (isBuiltin(spec) || spec.startsWith('node:')) continue;

      const local = modulePath(file, spec);
      let target = local;
      if (!target) {
        try {
          target = resolveFrom.resolve(spec);
        } catch (e) {
          continue; // already reported by the resolution test
        }
      }

      const mod = await import(pathToFileURL(target).href);
      for (const name of names || []) {
        if (!(name in mod)) problems.push(`${rel}: '${spec}' has no export named '${name}'`);
      }
      if (defaultName && !('default' in mod)) {
        problems.push(`${rel}: '${spec}' has no default export (imported as ${defaultName})`);
      }
    }
  }

  assert.deepEqual(problems, [], `missing exports:\n${problems.join('\n')}`);
});

test('every server module loads', async () => {
  const failed = [];

  for (const file of serverModules()) {
    try {
      await import(pathToFileURL(file).href);
    } catch (e) {
      failed.push(`${path.relative(ROOT, file)}: ${e.message}`);
    }
  }

  assert.deepEqual(failed, [], `modules that do not load:\n${failed.join('\n')}`);
});
