import fs from 'node:fs';
import ignore from 'ignore';
import pathe from 'pathe';
import { guessLanguage } from '@lumis-sh/lumis';
import wasmBundle from '@lumis-sh/wasm-bundle-full';

const MAX_AST_FILE_BYTES = 1024 * 1024;
const languageCapabilityCache = new Map();

/**
 * Checks via @lumis-sh/wasm-bundle-full whether a language grammar defines
 * structural AST symbols (@function, @type, @constructor, or @tag) in its native queries.
 */
export async function resolveAstLanguagePackage(langId) {
  if (!langId || typeof wasmBundle[langId] !== 'function') return null;
  if (languageCapabilityCache.has(langId)) {
    return languageCapabilityCache.get(langId);
  }

  const pkg = await wasmBundle[langId]();
  const languages = pkg?.languagePackage?.languages || {};
  const langDef = languages[langId] || Object.values(languages)[0] || {};
  const highlights = langDef.highlights || '';

  const hasAstSymbols =
    highlights.includes('@function') ||
    highlights.includes('@type') ||
    highlights.includes('@constructor') ||
    highlights.includes('@tag');

  const resolved = hasAstSymbols ? pkg : null;
  languageCapabilityCache.set(langId, resolved);
  return resolved;
}

const DEFAULT_IGNORE_PATTERNS = [
  '.git/',
  'node_modules/',
  '.coordinate/',
  '.hey-yu/',
  '.agents/',
  '.claude/',
  '.cursor/',
  '.windsurf/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  '.turbo/',
  '.vercel/',
  'dist/',
  'build/',
  'out/',
  'coverage/',
  '__pycache__/',
  '.pytest_cache/',
  '.venv/',
  'venv/',
  'target/',
  '*.min.*'
];

/**
 * Creates a .gitignore-backed matcher using the `ignore` partner library.
 */
export function createWorkspaceIgnore(projectRoot) {
  const root = pathe.resolve(projectRoot);
  const ig = ignore().add(DEFAULT_IGNORE_PATTERNS);
  const gitignorePath = pathe.join(root, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, 'utf8'));
  }
  return ig;
}

/**
 * Walks a project workspace using `ignore`, `pathe`, `@lumis-sh/lumis`, and `@lumis-sh/wasm-bundle-full`.
 * Evaluates root and nested `.gitignore` files natively via `ignore` instances scoped to their directory.
 */
export async function walkWorkspaceFiles(projectRoot) {
  const root = pathe.resolve(projectRoot);
  const rootIg = createWorkspaceIgnore(root);
  const results = [];

  async function walk(currentDir, activeMatchers) {
    let matchers = activeMatchers;
    if (currentDir !== root) {
      const localGitignore = pathe.join(currentDir, '.gitignore');
      if (fs.existsSync(localGitignore)) {
        const subIg = ignore().add(fs.readFileSync(localGitignore, 'utf8'));
        matchers = [...activeMatchers, { baseDir: currentDir, ig: subIg }];
      }
    }

    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absPath = pathe.join(currentDir, entry.name);
      const relPath = pathe.relative(root, absPath);
      if (!relPath) continue;

      const isIgnored = matchers.some(({ baseDir, ig }) => {
        const subRel = pathe.relative(baseDir, absPath);
        if (!subRel) return false;
        return ig.ignores(entry.isDirectory() ? `${subRel}/` : subRel);
      });
      if (isIgnored) continue;

      if (entry.isDirectory()) {
        await walk(absPath, matchers);
        continue;
      }

      if (!entry.isFile()) continue;

      let stat;
      try {
        stat = fs.statSync(absPath);
      } catch (_) {
        continue;
      }
      if (stat.size === 0 || stat.size > MAX_AST_FILE_BYTES) continue;

      const langId = guessLanguage(relPath);
      const pkg = await resolveAstLanguagePackage(langId);
      if (pkg) {
        results.push({
          absPath,
          relPath,
          statKey: `${Math.trunc(stat.mtimeMs)}:${stat.size}`,
          langId: pkg.id || langId,
          wasmUrl: pkg.wasm,
          languagePackage: pkg.languagePackage
        });
      }
    }
  }

  await walk(root, [{ baseDir: root, ig: rootIg }]);
  return results;
}
