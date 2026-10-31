#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pathe from 'pathe';
import { z } from 'zod';
import { guessLanguage } from '@lumis-sh/lumis';
import { CoordinateResolver } from './coord_resolver.js';
import { createWorkspaceIgnore, resolveAstLanguagePackage } from './workspace_walker.js';

const __filename = pathe.normalize(fileURLToPath(import.meta.url));
const ENGINE_DIR = pathe.dirname(__filename);
const ENGINE_FILES = [
  'hey_yu_mcp.js',
  'coord_resolver.js',
  'coord_graph.js',
  'cst_indexer.js',
  'workspace_walker.js'
];

function getEngineSignature() {
  let sig = '';
  for (const f of ENGINE_FILES) {
    try {
      const st = fs.statSync(pathe.join(ENGINE_DIR, f));
      sig += `${f}:${Math.floor(st.mtimeMs)};`;
    } catch (_) {}
  }
  return sig;
}

const BOOT_ENGINE_SIGNATURE = getEngineSignature();
const MARKER_START = '<!-- hey-yu-COORDINATE-OF-CODE:START -->';
const MARKER_END = '<!-- hey-yu-COORDINATE-OF-CODE:END -->';

const HeyYuArgsSchema = z.object({
  query: z
    .string()
    .optional()
    .describe('Natural-language intent, symbol name (function/class/method/type), error message, or UI string to locate.'),
  semantic_tokens: z
    .array(z.string())
    .optional()
    .describe('Optional English or domain identifier tokens inferred by the LLM to boost AST matching.'),
  expected_kind: z
    .string()
    .optional()
    .describe('Optional symbol kind filter: "function" | "method" | "type" | "file".'),
  file: z
    .string()
    .optional()
    .describe('Optional file path (absolute or workspace-relative) for direct file/line coordinate lookup.'),
  line: z
    .number()
    .optional()
    .describe('Optional 1-based line number within `file` to resolve the enclosing AST symbol.'),
  project_root: z
    .string()
    .optional()
    .describe('Optional absolute path to the target project/workspace root directory. Auto-discovered if omitted.')
});

const ProjectMapArgsSchema = z.object({
  project_root: z
    .string()
    .optional()
    .describe('Optional absolute path to the target project/workspace root directory. Auto-discovered if omitted.')
});

const TOOLS = [
  {
    name: 'hey_yu',
    description:
      'Instant 1-step AST spatial coordinate resolver (<15ms). Returns cadastral_id, line_span, code_preview, coordinate_dispatcher, impact_graph, and related_coordinates, or pass: true.',
    inputSchema: z.toJSONSchema(HeyYuArgsSchema)
  },
  {
    name: 'yu_get_project_map',
    description: 'Returns the complete architectural coordinate map of the project.',
    inputSchema: z.toJSONSchema(ProjectMapArgsSchema)
  }
];

const { values: cliOpts, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    project: { type: 'string', short: 'p' },
    dir: { type: 'string' },
    event: { type: 'string', short: 'e' },
    'rpc-json': { type: 'string' }
  },
  strict: false,
  allowPositionals: true
});

const defaultProjectRoot = pathe.resolve(
  (typeof cliOpts.project === 'string' && cliOpts.project) ||
    (typeof cliOpts.dir === 'string' && cliOpts.dir) ||
    process.env.COORD_PROJECT_ROOT ||
    process.env.HEY_YU_PROJECT_ROOT ||
    process.cwd()
);

const ACTIVE_WORKSPACE_STATE_PATH = pathe.join(os.homedir(), '.gemini', 'hey-yu-active-workspace.json');

function recordActiveWorkspace(rootPath) {
  if (!rootPath || process.env.HEY_YU_SKIP_GLOBAL_MCP === '1') return;
  try {
    const resolved = pathe.resolve(rootPath);
    if (resolved.startsWith(os.tmpdir()) || resolved.startsWith('/tmp/') || resolved.startsWith('/private/var/folders/')) {
      return;
    }
    fs.mkdirSync(pathe.dirname(ACTIVE_WORKSPACE_STATE_PATH), { recursive: true });
    fs.writeFileSync(
      ACTIVE_WORKSPACE_STATE_PATH,
      `${JSON.stringify({ active_project_root: resolved, updated_at: new Date().toISOString() }, null, 2)}\n`,
      'utf8'
    );
  } catch (_) {}
}

function findWorkspaceRootFromPath(startPath) {
  if (!startPath) return null;
  try {
    const home = pathe.resolve(os.homedir());
    let curr = pathe.resolve(startPath);
    if (fs.existsSync(curr) && !fs.statSync(curr).isDirectory()) {
      curr = pathe.dirname(curr);
    }
    let fallbackPkgRoot = null;
    let depth = 0;
    while (curr && curr !== '/' && curr !== home) {
      if (
        fs.existsSync(pathe.join(curr, '.hey-yu')) ||
        fs.existsSync(pathe.join(curr, '.coordinate', 'ast_cache.json')) ||
        (depth <= 1 && fs.existsSync(pathe.join(curr, '.coordinate')))
      ) {
        return curr;
      }
      if (
        !fallbackPkgRoot &&
        (fs.existsSync(pathe.join(curr, 'package.json')) ||
          fs.existsSync(pathe.join(curr, 'Cargo.toml')) ||
          fs.existsSync(pathe.join(curr, 'go.mod')) ||
          fs.existsSync(pathe.join(curr, 'pyproject.toml')))
      ) {
        fallbackPkgRoot = curr;
      }
      const parent = pathe.dirname(curr);
      if (parent === curr) break;
      curr = parent;
      depth++;
    }
    return fallbackPkgRoot;
  } catch (_) {
    return null;
  }
}

function resolveEffectiveProjectRoot(rawArgs = {}) {
  if (typeof rawArgs?.project_root === 'string' && rawArgs.project_root.trim()) {
    const explicitRoot = pathe.resolve(rawArgs.project_root.trim());
    if (fs.existsSync(explicitRoot)) {
      const parentRoot = pathe.dirname(explicitRoot);
      const effectiveRoot =
        !fs.existsSync(pathe.join(explicitRoot, '.hey-yu')) &&
        !fs.existsSync(pathe.join(explicitRoot, '.coordinate', 'ast_cache.json')) &&
        (fs.existsSync(pathe.join(parentRoot, '.hey-yu')) ||
          fs.existsSync(pathe.join(parentRoot, '.coordinate', 'ast_cache.json')))
          ? parentRoot
          : explicitRoot;
      recordActiveWorkspace(effectiveRoot);
      return effectiveRoot;
    }
  }
  if (typeof rawArgs?.file === 'string' && pathe.isAbsolute(rawArgs.file.trim())) {
    const inferredFromFile = findWorkspaceRootFromPath(rawArgs.file.trim());
    if (inferredFromFile && fs.existsSync(inferredFromFile)) {
      return inferredFromFile;
    }
  }
  try {
    if (fs.existsSync(ACTIVE_WORKSPACE_STATE_PATH)) {
      const state = JSON.parse(fs.readFileSync(ACTIVE_WORKSPACE_STATE_PATH, 'utf8'));
      if (state?.active_project_root && fs.existsSync(state.active_project_root)) {
        return pathe.resolve(state.active_project_root);
      }
    }
  } catch (_) {}
  return defaultProjectRoot;
}

const resolversByRoot = new Map();

async function getResolver(rootOverride) {
  const root = pathe.resolve(rootOverride || defaultProjectRoot);
  if (!resolversByRoot.has(root)) {
    const resolver = new CoordinateResolver(root);
    await resolver.init();
    resolversByRoot.set(root, resolver);
  }
  return resolversByRoot.get(root);
}

function recordTelemetry(projectRoot, toolName, payload, result) {
  try {
    const coordDir = pathe.join(projectRoot, '.coordinate');
    fs.mkdirSync(coordDir, { recursive: true });
    const coordGitignore = pathe.join(coordDir, '.gitignore');
    if (!fs.existsSync(coordGitignore)) {
      fs.writeFileSync(coordGitignore, '*\n', 'utf8');
    }
    const ts = new Date().toISOString();
    const logPath = pathe.join(coordDir, 'mcp_telemetry.jsonl');
    const liveLogPath = pathe.join(coordDir, 'live_audit.log');
    const pendingStatusPath = pathe.join(coordDir, 'pending_status_line.txt');

    const entry = {
      timestamp: ts,
      tool: toolName,
      query: payload?.query || payload?.file || null,
      origin_file: result?.origin_file || null,
      resolution_status: result?.resolution_status || 'MAP',
      cadastral_id: result?.cadastral_id || null,
      resolution_time_ms: result?.resolution_time_ms ?? null,
      user_status_line: result?.user_status_line || null
    };
    if (toolName !== 'cli_resolve') {
      fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
    }

    if (
      (result?.resolution_status === 'EXISTING_FOUND' || result?.resolution_status === 'MAP') &&
      result?.user_status_line
    ) {
      if (toolName !== 'cli_resolve') {
        fs.writeFileSync(pendingStatusPath, result.user_status_line, 'utf8');
      }
      fs.appendFileSync(liveLogPath, `[${ts}] ${result.user_status_line}\n`, 'utf8');
    } else if (result?.resolution_status === 'PASS') {
      fs.appendFileSync(
        liveLogPath,
        `[${ts}] [hey-yu] Honest Silent Pass (pass: true) for query="${payload?.query || payload?.file || ''}" — outside AST match threshold, agent continues with standard tools.\n`,
        'utf8'
      );
    }
  } catch (_) {}
}

function sendResponse(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function sendError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

export async function handleRpcMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'hey-yu', version: '0.1.0-alpha' }
    };
  }

  if (method === 'tools/list') {
    return {
      tools: TOOLS
    };
  }

  if (method === 'tools/call') {
    if (!cliOpts['rpc-json'] && getEngineSignature() !== BOOT_ENGINE_SIGNATURE) {
      const freshOut = execFileSync(
        process.execPath,
        [__filename, '--project', defaultProjectRoot, '--rpc-json', JSON.stringify(msg)],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
      );
      return JSON.parse(freshOut.trim());
    }

    const toolName = params?.name;
    const rawArgs = params?.arguments || {};

    if (toolName === 'hey_yu') {
      const parsed = HeyYuArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        throw new Error(`Invalid hey_yu arguments: ${parsed.error.message}`);
      }
      const effectiveRoot = resolveEffectiveProjectRoot(parsed.data);
      const resolver = await getResolver(effectiveRoot);
      const result = await resolver.resolve(parsed.data);
      recordTelemetry(resolver.projectRoot, 'hey_yu', parsed.data, result);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      };
    }

    if (toolName === 'yu_get_project_map') {
      const parsed = ProjectMapArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        throw new Error(`Invalid yu_get_project_map arguments: ${parsed.error.message}`);
      }
      const effectiveRoot = resolveEffectiveProjectRoot(parsed.data);
      const resolver = await getResolver(effectiveRoot);
      const mapResult = await resolver.getProjectMap();
      recordTelemetry(resolver.projectRoot, 'yu_get_project_map', parsed.data, mapResult);
      return {
        content: [{ type: 'text', text: JSON.stringify(mapResult, null, 2) }]
      };
    }

    throw new Error(`Unknown tool: ${toolName}`);
  }

  return {};
}

function buildAgentProtocolMarkdown(title, frontmatter = '') {
  const prefix = frontmatter ? `${frontmatter.trim()}\n\n` : '';
  return `${prefix}${MARKER_START}
# ${title}

This repository is indexed with **hey-yu (Coordinate of Code v0.1.0-alpha)**. Every function, method, class, struct, interface, type/schema, and module across 100+ languages has a deterministic spatial coordinate (\`crd_...\`).

---

## 1. Two Pillars: Precision & Speed

1. **Precision (1-Step Spatial Resolution + Coordinate Dispatcher):** Never guess file locations or wander across dozens of files with blind \`grep\`. Call \`hey_yu\` to receive the exact file, AST \`line_span\`, \`coordinate_dispatcher\`, \`impact_graph\`, and \`related_coordinates\` in one step.
2. **Speed (<15ms In-Memory CST Resolution):** Resolve exact coordinates and dependency spans directly from the in-memory CST and Graphology index without full-file context bloat.
3. **Honest Silent Pass (\`pass: true\`):** We only help where deterministic CST + graph resolution is certain. When \`hey_yu\` returns \`pass: true\`, silently continue with standard agent tools (\`read_file\`, \`grep\`, etc.) without retries or warnings.

---

## 2. Universal Polyglot Workflow (DO vs. SKIP Protocol)

### WHEN TO CALL \`hey_yu\` (DO):
1. **Locating or Modifying Existing Code (Any Language or Stack):**
   Call \`hey_yu\` FIRST before blind \`grep\`, \`find_by_name\`, or multi-file \`read_file\` when locating, inspecting, or editing any existing function, method, class/struct/type, or file:
   - **Cursor / Claude Code / Windsurf:** call MCP tool \`hey_yu\` directly.
   - **Antigravity:** call \`call_mcp_tool\` directly with \`ServerName: "hey-yu"\`, \`ToolName: "hey_yu"\`, and \`Arguments\`:
   \`\`\`json
   {
     "query": "<natural-language intent, symbol name, error string, or UI label>",
     "semantic_tokens": ["<optional English/code domain tokens inferred by LLM>"],
     "expected_kind": "function",
     "project_root": "<optional absolute path to current workspace root; auto-discovered if omitted>"
   }
   \`\`\`
   Supported \`expected_kind\` values: \`"function" | "method" | "type" | "file"\`.
   *(Note: \`call_mcp_tool\` with \`ServerName: "hey-yu"\` is active immediately via \`mcp_config.json\` across all chats and folders; passing \`project_root\` or an absolute \`file\` path targets any workspace on the machine.)*
   Or spatial lookup by file and line:
   \`\`\`json
   { "file": "src/billing/invoice.rs", "line": 42 }
   \`\`\`

2. **How to Use \`EXISTING_FOUND\` (3 Mandatory Actions):**
   - **Action A — Entry Point (\`absolute_file_path\` + \`line_span\` + \`code_preview\`):** \`hey_yu\` returns \`code_preview\` with the exact lines of the target symbol! If \`code_preview\` already shows the complete symbol you need to edit, you can call \`edit_file\` directly without calling \`read_file\` on that span again.
   - **Action B — Dependency Chain (\`coordinate_dispatcher.required_file_spans\` + \`impact_graph\`):** When modifying behavior, inspect the connected \`incoming_callers\`, \`imported_callees\`, and \`shared_types\` listed in \`required_file_spans\` so you never forget to update a companion caller or contract.
   - **Action C — Related Coordinates (\`related_coordinates\`):** Check additional relevant coordinates across the workspace (such as external SQL migrations, DI implementations, or companion modules) surfaced by \`hey_yu\`.

3. **Whole-Project Overview (\`yu_get_project_map\`):**
   Call \`yu_get_project_map\` (in Antigravity: \`call_mcp_tool\` with \`ServerName: "hey-yu"\`, \`ToolName: "yu_get_project_map"\`, \`Arguments: {}\`) once when you need a high-level architectural map of all files and symbols.

### WHEN TO SKIP \`hey_yu\` (SKIP — Outside Tree-sitter AST Competence):
- **Non-AST Tasks:** NEVER call \`hey_yu\` for cloud deployments (\`Cloud Run\`, \`gcloud\`, \`Docker\`, \`Kubernetes\`), \`git\` operations, terminal commands (\`run_command\`), reading plain Markdown/JSON docs, or external MCP calls.
- **Known Coordinates in Current Turn:** Once you already have the \`absolute_file_path\` and \`line_span\`, edit directly without re-querying the same symbol.

---

## 3. Coordinate Hit Logging (Zero Noise on Pass / Non-Code Tasks)

- **1-Line Hit Status ONLY on \`EXISTING_FOUND\`:** Output the exact \`user_status_line\` returned by \`hey_yu\` in chat ONLY when \`hey_yu\` returns \`EXISTING_FOUND\`:
  \`[hey-yu] Resolved <kind> "<name>" (crd_...) -> path/to/file:start-end in X.Xms | Dependencies: N Callers [...], M Imported Callees [...], T Shared Types [...] | Reading Plan: S exact spans across F files | Related Coordinates: [...]\`
- **100% Silence on \`pass: true\` and Non-Code Tasks:** Never output \`[hey-yu ...]\` status banners when \`pass: true\` or when running terminal/git/deployment commands, and never output telemetry summary blocks at the end of your response.
${MARKER_END}
`;
}

function upsertMarkdownSection(filePath, sectionBlock) {
  fs.mkdirSync(pathe.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, sectionBlock, 'utf8');
    return;
  }
  const existing = fs.readFileSync(filePath, 'utf8');
  const startIdx = existing.indexOf(MARKER_START);
  const endIdx = existing.indexOf(MARKER_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + MARKER_END.length);
    fs.writeFileSync(filePath, `${before}${sectionBlock.trim()}${after}`, 'utf8');
    return;
  }
  const trimmed = existing.trimEnd();
  fs.writeFileSync(filePath, `${trimmed}\n\n${sectionBlock}`, 'utf8');
}

function buildSkillMarkdown() {
  return `---
name: hey-yu
description: Universal polyglot AST spatial coordinate dispatcher (Coordinate of Code / hey-yu v0.1.0-alpha). Use when locating, analyzing, extending, or editing source code across 100+ languages. Replaces blind grep/find loops with 1-step sub-15ms AST coordinate resolution, dependency chains, and related coordinates (hey_yu, yu_get_project_map).
---

# hey-yu — Coordinate of Code Skill (v0.1.0-alpha)

## Overview
\`hey-yu\` resolves natural-language intent, symbol names, error/UI strings, or \`file:line\` cursors into deterministic AST coordinates (\`crd_...\`), exact \`line_span\` boundaries, \`coordinate_dispatcher\` (\`required_file_spans\`), \`impact_graph\` (\`incoming_callers\`, \`imported_callees\`, \`shared_types\`), and \`related_coordinates\` in \`< 15ms\` across 100+ Tree-sitter languages.

## Universal Workflow (DO vs. SKIP)
1. **Call \`hey_yu\` First on Code Tasks:**
   - **Cursor / Claude Code / Windsurf:** call MCP tool \`hey_yu\` directly.
   - **Antigravity:** call \`call_mcp_tool\` directly with \`ServerName: "hey-yu"\`, \`ToolName: "hey_yu"\`, and \`Arguments\`:
   \`\`\`json
   {
     "query": "<intent, symbol name, error message, or UI string>",
     "semantic_tokens": ["<optional English/code domain tokens>"],
     "expected_kind": "function",
     "project_root": "<optional absolute path to current workspace root; auto-discovered if omitted>"
   }
   \`\`\`
   Supported \`expected_kind\`: \`"function" | "method" | "type" | "file"\`.
2. **When \`resolution_status === "EXISTING_FOUND"\`:**
   - Read/edit \`absolute_file_path\` at \`line_span\`.
   - Follow \`coordinate_dispatcher.required_file_spans\`, \`impact_graph\` (\`incoming_callers\`, \`imported_callees\`, \`shared_types\`), and \`related_coordinates\` so every connected contract is updated together.
   - Print the single-line \`user_status_line\` in chat.
3. **When \`pass === true\` (\`resolution_status === "PASS"\`):**
   - Continue silently with standard agent tools (\`read_file\`, \`grep\`, etc.) with zero status banners.
4. **Skip Outside AST Competence:**
   - Never call \`hey_yu\` for \`git\`, \`run_command\`, cloud deployments, or plain non-code documentation.
`;
}

function parseShellSearchCommand(cmdText, root = defaultProjectRoot, cwd = root) {
  const raw = String(cmdText || '').trim();
  if (!raw) return null;

  let effectiveCwd = pathe.resolve(cwd || root);
  const cdMatch = raw.match(/^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)\s*/i);
  if (cdMatch) {
    const cdTarget = cdMatch[1] || cdMatch[2] || cdMatch[3];
    if (cdTarget) {
      effectiveCwd = pathe.resolve(effectiveCwd, cdTarget);
    }
  }

  const stripped = raw.replace(/^(?:cd\s+(?:"[^"]+"|'[^']+'|\S+)\s*(?:&&|;)\s*)+/i, '').trim();
  const cmdMatch = stripped.match(/^(grep|egrep|fgrep|rg|ripgrep|ag|ack|find|fd|ls|tree)\b\s*(.*)$/i);
  if (!cmdMatch) return null;

  const bin = cmdMatch[1].toLowerCase();
  const rest = cmdMatch[2] || '';
  const tokens = (rest.match(/(?:"[^"]*"|'[^']*'|[^\s]+)/g) || []).map(t =>
    t.replace(/^['"]|['"]$/g, '')
  );

  if (bin === 'find' || bin === 'fd' || bin === 'ls' || bin === 'tree') {
    const pathTokens = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (!tok || tok === '|' || tok === '>' || tok === '2>' || tok === '&&' || tok === ';') break;
      if (tok.startsWith('-')) {
        if (bin === 'find') break;
        continue;
      }
      pathTokens.push(tok);
    }
    const targetPaths = pathTokens.length > 0 ? pathTokens : ['.'];
    for (const pt of targetPaths) {
      const absTarget = pathe.resolve(effectiveCwd, pt);
      const isInsideRoot = absTarget === root || absTarget.startsWith(`${root}/`);
      if (!isInsideRoot) return null;
      const relTarget = pathe.relative(root, absTarget);
      if (relTarget && isInfraOrIgnoredRelPath(root, relTarget)) return null;
    }
    return { kind: 'map' };
  }

  const flagsWithArg = new Set([
    '-e', '-f', '-m', '-A', '-B', '-C', '-g', '-t', '-T',
    '--regexp', '--file', '--max-count', '--after-context', '--before-context', '--context', '--glob', '--type'
  ]);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok || tok === '|' || tok === '>' || tok === '2>' || tok === '&&' || tok === ';') break;
    if (tok === '-e' || tok === '--regexp') {
      if (tokens[i + 1]) return { kind: 'query', query: tokens[i + 1] };
      continue;
    }
    if (flagsWithArg.has(tok)) {
      i++;
      continue;
    }
    if (tok.startsWith('-')) continue;
    const cleaned = tok.replace(/^[\^.*]+|[\$.*]+$/g, '').trim();
    if (cleaned.length >= 2) {
      return { kind: 'query', query: cleaned };
    }
  }
  return null;
}

function isInfraOrIgnoredRelPath(root, relPath) {
  if (!relPath || relPath.startsWith('..') || pathe.isAbsolute(relPath)) return true;
  if (
    relPath.startsWith('.agents/') ||
    relPath.startsWith('.claude/') ||
    relPath.startsWith('.cursor/') ||
    relPath.startsWith('.windsurf/') ||
    relPath.startsWith('.coordinate/') ||
    relPath.startsWith('.hey-yu/') ||
    relPath.startsWith('.gemini/') ||
    relPath === '.mcp.json' ||
    relPath === '.cursorrules'
  ) {
    return true;
  }
  try {
    const ig = createWorkspaceIgnore(root);
    return ig.ignores(relPath);
  } catch (_) {
    return false;
  }
}

function formatAutoDispatchContext(result, triggerTool) {
  if (
    result.project_root &&
    (Array.isArray(result.architectural_hubs) || Array.isArray(result.files))
  ) {
    const layers = (result.architectural_layers || [])
      .slice(0, 10)
      .map(l => `- ${l}`)
      .join('\n');
    const hubs = (result.architectural_hubs || result.files || [])
      .slice(0, 8)
      .map(h => `- ${typeof h === 'string' ? h : h.file}`)
      .join('\n');
    const unresolvedLine =
      Array.isArray(result.unresolved_imports) && result.unresolved_imports.length > 0
        ? `\nUnresolved Local Imports: ${result.unresolved_imports.join(' | ')}`
        : '';
    const statusHeader = result.user_status_line ? `${result.user_status_line}\n` : '';
    return (
      `${statusHeader}[hey-yu AUTO-DISPATCH on ${triggerTool}] Workspace AST Coordinate Map (${result.total_files} code files, ${result.total_coordinates} coordinates, ${result.total_edges || 0} edges):\n` +
      (layers ? `Architectural Layers:\n${layers}\n` : '') +
      `Top Architectural Hubs:\n${hubs}${unresolvedLine}\n` +
      `Use hey_yu (or call_mcp_tool ServerName="hey-yu", ToolName="hey_yu") for 1-step symbol & dependency resolution.`
    );
  }

  const spans = (result.coordinate_dispatcher?.required_file_spans || [])
    .map(s => `${s.role}: ${s.name} (${s.file}:${s.span})`)
    .join(', ');
  const related = (result.related_coordinates || [])
    .map(r => `${r.name} (${r.file}:${r.span})`)
    .join(', ');
  const fileSyms = (result.file_symbols || [])
    .map(s => `${s.kind} ${s.name} (${s.cadastral_id}, L${s.span})`)
    .join(', ');
  const previewBlock = result.code_preview
    ? `\nCode Preview (${result.origin_file}:${result.line_span.start}-${result.line_span.end}):\n${result.code_preview}`
    : '';

  return (
    `${result.user_status_line}\n` +
    `[hey-yu AUTO-DISPATCH on ${triggerTool}] Target Coordinate: ${result.cadastral_id} (${result.kind} "${result.name}") -> ${result.absolute_file_path} (lines ${result.line_span.start}-${result.line_span.end})` +
    (fileSyms ? `\nFile AST Symbols: ${fileSyms}` : '') +
    (spans ? `\nRequired Dependency Spans: ${spans}` : '') +
    (related ? `\nRelated Coordinates: ${related}` : '') +
    previewBlock +
    `\nDisplay the single-line [hey-yu] Resolved ... status line above in your response.`
  );
}

export async function evaluateLifecycleHook(payload = {}, eventName = '', projectRoot = defaultProjectRoot, options = {}) {
  const root = pathe.resolve(
    projectRoot || (Array.isArray(payload?.workspacePaths) && payload.workspacePaths[0]) || defaultProjectRoot
  );
  recordActiveWorkspace(root);
  const coordDir = pathe.join(root, '.coordinate');
  const telemetryPath = pathe.join(coordDir, 'mcp_telemetry.jsonl');
  const hookTelemetryPath = pathe.join(coordDir, 'hook_telemetry.jsonl');
  const liveLogPath = pathe.join(coordDir, 'live_audit.log');
  const pendingStatusPath = pathe.join(coordDir, 'pending_status_line.txt');
  const pendingDispatchPath = pathe.join(coordDir, 'pending_dispatch.txt');

  const toolArgs = payload?.toolCall?.args || payload?.tool_input || payload?.args || {};
  const toolName = String(payload?.toolCall?.name || payload?.tool_name || '').toLowerCase();
  const cmdText = String(toolArgs.CommandLine || toolArgs.command || payload?.command || '');
  const targetFileArg = String(
    toolArgs.Path ||
      toolArgs.file_path ||
      toolArgs.SearchPath ||
      toolArgs.SearchDirectory ||
      toolArgs.Directory ||
      toolArgs.path ||
      toolArgs.directory ||
      ''
  );
  const isClaudeCode = Boolean(payload?.hook_event_name || payload?.tool_name);
  const effectiveEvent =
    eventName ||
    payload?.hook_event_name ||
    (toolName ? 'PreToolUse' : payload?.invocationNum !== undefined ? 'PreInvocation' : 'SessionStart');

  let recentHeyYuCall = false;
  try {
    if (fs.existsSync(telemetryPath)) {
      const stat = fs.statSync(telemetryPath);
      if (Date.now() - stat.mtimeMs < 60000) {
        recentHeyYuCall = true;
      }
    }
  } catch (_) {}

  const dedupStepPath = pathe.join(coordDir, 'last_hook_step.json');
  if (payload?.conversationId) {
    const stepSignature = `${payload.conversationId}:${effectiveEvent}:${payload.stepIdx ?? ''}:${payload.invocationNum ?? ''}:${toolName}:${targetFileArg}:${cmdText}`;
    try {
      if (fs.existsSync(dedupStepPath)) {
        const lastDedup = JSON.parse(fs.readFileSync(dedupStepPath, 'utf8'));
        if (lastDedup.sig === stepSignature && Date.now() - Number(lastDedup.ts || 0) < 1500) {
          return effectiveEvent === 'PreToolUse' ? { decision: 'allow' } : {};
        }
      }
      fs.mkdirSync(coordDir, { recursive: true });
      fs.writeFileSync(dedupStepPath, JSON.stringify({ sig: stepSignature, ts: Date.now() }), 'utf8');
    } catch (_) {}
  }

  const wasFileRecentlyResolved = (relPath) => {
    try {
      for (const tPath of [telemetryPath, hookTelemetryPath]) {
        if (!fs.existsSync(tPath)) continue;
        const lines = fs.readFileSync(tPath, 'utf8').trim().split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= Math.max(0, lines.length - 12); i--) {
          const entry = JSON.parse(lines[i]);
          if (
            entry.origin_file === relPath &&
            Date.now() - new Date(entry.timestamp).getTime() < 60000
          ) {
            return true;
          }
        }
      }
    } catch (_) {}
    return false;
  };

  const recordHookEvent = (action, intercepted = false, resolvedId = null, originFile = null) => {
    try {
      fs.mkdirSync(coordDir, { recursive: true });
      fs.appendFileSync(
        hookTelemetryPath,
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          event: effectiveEvent,
          tool: toolName || null,
          intercepted,
          resolved_cadastral_id: resolvedId,
          origin_file: originFile,
          recent_hey_yu_call: recentHeyYuCall,
          action
        })}\n`,
        'utf8'
      );
    } catch (_) {}
  };

  if (effectiveEvent === 'PreToolUse') {
    const cwd = pathe.resolve(payload?.cwd || root);

    // Gate 1: Workspace boundary check via pathe + ignore
    if (targetFileArg) {
      const absTarget = pathe.resolve(cwd, targetFileArg);
      const isInsideRoot = absTarget === root || absTarget.startsWith(`${root}/`);
      if (!isInsideRoot) {
        return { decision: 'allow' };
      }
      const relTarget = pathe.relative(root, absTarget);
      if (relTarget && isInfraOrIgnoredRelPath(root, relTarget)) {
        return { decision: 'allow' };
      }
    }

    let autoDispatchMsg = null;
    let resolvedId = null;
    let resolvedOriginFile = null;

    // Gate 2: File read competence check via @lumis-sh/lumis + @lumis-sh/wasm-bundle-full + web-tree-sitter
    if (/^(read_file|read|view_file)$/.test(toolName) && targetFileArg) {
      const absTarget = pathe.resolve(cwd, targetFileArg);
      const relPath = pathe.relative(root, absTarget);
      if (wasFileRecentlyResolved(relPath)) {
        return { decision: 'allow' };
      }
      const startLine = Number(toolArgs.StartLine || toolArgs.offset || 0) || undefined;
      const langId = guessLanguage(relPath);
      const pkg = await resolveAstLanguagePackage(langId);
      if (!pkg) {
        // Outside Tree-sitter AST competence (.md, .json, .jsonl, .txt, .env, etc.) -> 100% silent pass
        return { decision: 'allow' };
      }
      const resolver = await getResolver(root);
      const result = await resolver.resolve({ file: relPath, line: startLine });
      const hasAstSymbols =
        result?.resolution_status === 'EXISTING_FOUND' &&
        (result.kind !== 'file' || (Array.isArray(result.file_symbols) && result.file_symbols.length > 0));
      if (hasAstSymbols) {
        autoDispatchMsg = formatAutoDispatchContext(result, toolName);
        resolvedId = result.cadastral_id;
        resolvedOriginFile = result.origin_file || relPath;
      }
    }

    // Gate 3: Search query auto-resolution via @orama/orama + web-tree-sitter + graphology
    if (!autoDispatchMsg && /^(grep_search|grep|find_by_name|glob)$/.test(toolName)) {
      const rawQuery = String(
        toolArgs.Query || toolArgs.query || toolArgs.Pattern || toolArgs.pattern || ''
      )
        .replace(/^[*?.\/^$]+|[*?.\/^$]+$/g, '')
        .replace(/\.[a-z0-9]+$/i, '')
        .trim();

      if (rawQuery.length >= 2) {
        const resolver = await getResolver(root);
        const result = await resolver.resolve({ query: rawQuery });
        if (result?.resolution_status === 'EXISTING_FOUND') {
          autoDispatchMsg = formatAutoDispatchContext(result, toolName);
          resolvedId = result.cadastral_id;
          resolvedOriginFile = result.origin_file || null;
        }
      }
    }

    const wasMapRecentlyDispatched = () => {
      try {
        if (!fs.existsSync(hookTelemetryPath)) return false;
        const lines = fs.readFileSync(hookTelemetryPath, 'utf8').trim().split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
          const entry = JSON.parse(lines[i]);
          if (entry.action === 'auto_dispatch_coordinates' && !entry.resolved_cadastral_id) {
            if (Date.now() - new Date(entry.timestamp).getTime() < 60000) {
              return true;
            }
          }
        }
      } catch (_) {}
      return false;
    };

    // Gate 4: Directory listing or shell search auto-resolution
    if (!autoDispatchMsg && toolName === 'list_dir' && !wasMapRecentlyDispatched()) {
      const resolver = await getResolver(root);
      const mapResult = await resolver.getProjectMap();
      if (mapResult.total_coordinates > 0) {
        autoDispatchMsg = formatAutoDispatchContext(mapResult, toolName);
      }
    }

    if (!autoDispatchMsg && /^(run_command|bash|execute_command)$/.test(toolName)) {
      const parsedShell = parseShellSearchCommand(cmdText, root, cwd);
      if (parsedShell?.kind === 'query') {
        const resolver = await getResolver(root);
        const result = await resolver.resolve({ query: parsedShell.query });
        if (result?.resolution_status === 'EXISTING_FOUND') {
          autoDispatchMsg = formatAutoDispatchContext(result, toolName);
          resolvedId = result.cadastral_id;
          resolvedOriginFile = result.origin_file || null;
        }
      } else if (parsedShell?.kind === 'map' && !wasMapRecentlyDispatched()) {
        const resolver = await getResolver(root);
        const mapResult = await resolver.getProjectMap();
        if (mapResult.total_coordinates > 0) {
          autoDispatchMsg = formatAutoDispatchContext(mapResult, toolName);
        }
      }
    }

    if (autoDispatchMsg) {
      try {
        fs.mkdirSync(coordDir, { recursive: true });
        fs.writeFileSync(pendingDispatchPath, autoDispatchMsg, 'utf8');
        fs.appendFileSync(
          liveLogPath,
          `[${new Date().toISOString()}] [hey-yu AUTO-DISPATCH] Tool "${toolName}" auto-resolved via Tree-sitter + Orama + Graphology (${resolvedId || 'PROJECT_MAP'}).\n`,
          'utf8'
        );
      } catch (_) {}
      recordHookEvent('auto_dispatch_coordinates', true, resolvedId, resolvedOriginFile);
      if (isClaudeCode) {
        return {
          decision: 'allow',
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: autoDispatchMsg
          }
        };
      }
      return {
        decision: 'allow',
        reason: autoDispatchMsg
      };
    }

    // Honest Silent Pass: outside Tree-sitter AST competence or pass: true -> zero noise
    return { decision: 'allow' };
  }

  // Step 1 (SessionStart, UserPromptSubmit, or PreInvocation invocationNum === 0):
  // NEVER intercept the user's raw prompt! Let the agent process the user's intent freely.
  if (
    effectiveEvent === 'SessionStart' ||
    effectiveEvent === 'UserPromptSubmit' ||
    (effectiveEvent === 'PreInvocation' && Number(payload?.invocationNum || 0) === 0)
  ) {
    try {
      fs.rmSync(pendingStatusPath, { force: true });
      fs.rmSync(pendingDispatchPath, { force: true });
    } catch (_) {}
    return {};
  }

  if (effectiveEvent === 'PreInvocation' && Number(payload?.invocationNum || 0) > 0) {
    try {
      if (fs.existsSync(pendingDispatchPath)) {
        const stat = fs.statSync(pendingDispatchPath);
        const isFresh = Date.now() - stat.mtimeMs < 15000;
        const dispatchText = isFresh ? fs.readFileSync(pendingDispatchPath, 'utf8').trim() : '';
        fs.rmSync(pendingDispatchPath, { force: true });
        fs.rmSync(pendingStatusPath, { force: true });
        if (dispatchText) {
          recordHookEvent('inject_auto_dispatch_mid_turn', true);
          return {
            injectSteps: [
              {
                systemMessage: {
                  systemMessage: dispatchText
                }
              }
            ]
          };
        }
      }

      if (fs.existsSync(pendingStatusPath)) {
        const stat = fs.statSync(pendingStatusPath);
        const isFresh = Date.now() - stat.mtimeMs < 15000;
        const pendingStatusLine = isFresh ? fs.readFileSync(pendingStatusPath, 'utf8').trim() : '';
        fs.rmSync(pendingStatusPath, { force: true });
        if (pendingStatusLine) {
          recordHookEvent('inject_pending_status_line', true);
          const msg = `[hey-yu v0.1.0-alpha] Coordinate and dependency chain resolved! You MUST display this exact single-line report to the user in your response:\n${pendingStatusLine}`;
          return {
            injectSteps: [
              {
                systemMessage: {
                  systemMessage: msg
                }
              }
            ]
          };
        }
      }
    } catch (_) {}
    return {};
  }

  return {};
}

function findAncestorAgentWorkspaces(targetRoot) {
  const ancestors = [];
  const home = pathe.resolve(os.homedir());
  let curr = pathe.dirname(pathe.resolve(targetRoot));
  while (curr && curr !== '/' && curr !== home && curr.startsWith(home)) {
    if (fs.existsSync(pathe.join(curr, '.agents'))) {
      ancestors.push(curr);
    }
    const parent = pathe.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return ancestors;
}

export function provisionWorkspace(targetRoot = defaultProjectRoot) {
  const root = pathe.resolve(targetRoot);
  recordActiveWorkspace(root);
  const nodeBin = process.execPath || 'node';
  const serverEntry = {
    command: nodeBin,
    args: [__filename, '--project', root],
    env: {
      PATH: `${pathe.dirname(nodeBin)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`
    }
  };

  const mcpTargets = [
    pathe.join(root, '.mcp.json'),
    pathe.join(root, '.cursor', 'mcp.json'),
    pathe.join(root, '.claude', 'config.json'),
    pathe.join(root, '.windsurf', 'mcp_config.json')
  ];

  const updatedFiles = [];
  for (const mcpPath of mcpTargets) {
    let existing = {};
    if (fs.existsSync(mcpPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      } catch (_) {
        existing = {};
      }
    }
    if (!existing.mcpServers || typeof existing.mcpServers !== 'object') {
      existing.mcpServers = {};
    }
    existing.mcpServers['coordinate-of-code'] = serverEntry;
    existing.mcpServers['hey-yu'] = serverEntry;
    fs.mkdirSync(pathe.dirname(mcpPath), { recursive: true });
    fs.writeFileSync(mcpPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
    updatedFiles.push(mcpPath);
  }

  // Remove legacy local plugin MCP config so Antigravity does not create mangled hey-yu_hey-yu server names
  const legacyPluginDir = pathe.join(root, '.agents', 'plugins', 'hey-yu');
  if (fs.existsSync(legacyPluginDir)) {
    try {
      fs.rmSync(legacyPluginDir, { recursive: true, force: true });
    } catch (_) {}
  }

  const docTargets = [
    { path: pathe.join(root, 'AGENTS.md'), title: 'AGENTS.md — Coordinate of Code (hey-yu) Protocol' },
    { path: pathe.join(root, 'CLAUDE.md'), title: 'CLAUDE.md — Coordinate of Code (hey-yu) Integration Guide' },
    { path: pathe.join(root, 'GEMINI.md'), title: 'GEMINI.md — Coordinate of Code (hey-yu) Guide for Gemini & Antigravity' },
    { path: pathe.join(root, '.cursorrules'), title: '.cursorrules — Coordinate of Code (hey-yu) Rules' }
  ];

  for (const doc of docTargets) {
    upsertMarkdownSection(doc.path, buildAgentProtocolMarkdown(doc.title));
    updatedFiles.push(doc.path);
  }

  const agyRuleContent = buildAgentProtocolMarkdown(
    'CRITICAL RULE — hey-yu (COORDINATE OF CODE): PRECISION & SPEED',
    '---\ntrigger: always_on\ndescription: Coordinate of Code (hey-yu v0.1.0-alpha) deterministic AST spatial resolution and architectural spine protocol\n---'
  );
  const agyRulePath = pathe.join(root, '.agents', 'rules', 'hey-yu-rule.md');
  fs.mkdirSync(pathe.dirname(agyRulePath), { recursive: true });
  fs.writeFileSync(agyRulePath, agyRuleContent, 'utf8');
  updatedFiles.push(agyRulePath);

  const cursorMdcPath = pathe.join(root, '.cursor', 'rules', 'hey-yu.mdc');
  fs.mkdirSync(pathe.dirname(cursorMdcPath), { recursive: true });
  fs.writeFileSync(
    cursorMdcPath,
    buildAgentProtocolMarkdown(
      'Coordinate of Code (hey-yu v0.1.0-alpha) Rule',
      '---\ndescription: Coordinate of Code (hey-yu v0.1.0-alpha) deterministic AST spatial resolution and architectural spine protocol\nglobs: \nalwaysApply: true\n---'
    ),
    'utf8'
  );
  updatedFiles.push(cursorMdcPath);

  const skillContent = buildSkillMarkdown();
  const skillPath = pathe.join(root, '.agents', 'skills', 'hey-yu', 'SKILL.md');
  fs.mkdirSync(pathe.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, skillContent, 'utf8');
  updatedFiles.push(skillPath);

  const safeHookCmd = event =>
    `[ -f "${__filename}" ] && "${nodeBin}" "${__filename}" hook --project "${root}" --event ${event} 2>/dev/null || true`;

  const interceptorHookConfig = {
    enabled: true,
    PreInvocation: [{ type: 'command', command: safeHookCmd('PreInvocation'), timeout: 5 }],
    PreToolUse: [
      {
        matcher: 'grep_search|find_by_name|run_command|read_file|view_file|list_dir',
        hooks: [{ type: 'command', command: safeHookCmd('PreToolUse'), timeout: 5 }]
      }
    ]
  };

  const upsertHooksFile = (hooksPath) => {
    let hooksObj = {};
    if (fs.existsSync(hooksPath)) {
      try {
        hooksObj = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
      } catch (_) {
        hooksObj = {};
      }
    }
    hooksObj['hey-yu-interceptor'] = interceptorHookConfig;
    fs.mkdirSync(pathe.dirname(hooksPath), { recursive: true });
    fs.writeFileSync(hooksPath, `${JSON.stringify(hooksObj, null, 2)}\n`, 'utf8');
    updatedFiles.push(hooksPath);
  };

  upsertHooksFile(pathe.join(root, '.agents', 'hooks.json'));

  let globalMcpStatus = 'SKIPPED';
  if (process.env.HEY_YU_SKIP_GLOBAL_MCP !== '1') {
    const geminiHome = pathe.join(os.homedir(), '.gemini');
    const globalConfigDir = pathe.join(geminiHome, 'config');
    let wroteAnyGlobal = false;
    let hitPermissionError = false;
    if (fs.existsSync(geminiHome)) {
      try {
        fs.mkdirSync(globalConfigDir, { recursive: true });
        const globalMcpTargets = [
          pathe.join(globalConfigDir, 'mcp_config.json'),
          pathe.join(geminiHome, 'antigravity', 'mcp_config.json'),
          pathe.join(geminiHome, 'antigravity-cli', 'mcp_config.json'),
          pathe.join(geminiHome, 'antigravity-ide', 'mcp_config.json')
        ];
        for (const globalAgyMcpPath of globalMcpTargets) {
          if (!fs.existsSync(pathe.dirname(globalAgyMcpPath))) continue;
          try {
            let globalMcp = {};
            if (fs.existsSync(globalAgyMcpPath)) {
              try {
                globalMcp = JSON.parse(fs.readFileSync(globalAgyMcpPath, 'utf8'));
              } catch (_) {
                globalMcp = {};
              }
            }
            if (!globalMcp.mcpServers || typeof globalMcp.mcpServers !== 'object') {
              globalMcp.mcpServers = {};
            }
            globalMcp.mcpServers['coordinate-of-code'] = serverEntry;
            globalMcp.mcpServers['hey-yu'] = serverEntry;
            fs.writeFileSync(globalAgyMcpPath, `${JSON.stringify(globalMcp, null, 2)}\n`, 'utf8');
            updatedFiles.push(globalAgyMcpPath);
            wroteAnyGlobal = true;
          } catch (err) {
            if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
              hitPermissionError = true;
            }
          }
        }

        const globalRulePath = pathe.join(globalConfigDir, 'rules', 'hey-yu-rule.md');
        fs.mkdirSync(pathe.dirname(globalRulePath), { recursive: true });
        fs.writeFileSync(globalRulePath, agyRuleContent, 'utf8');
        updatedFiles.push(globalRulePath);

        const globalSkillPath = pathe.join(globalConfigDir, 'skills', 'hey-yu', 'SKILL.md');
        fs.mkdirSync(pathe.dirname(globalSkillPath), { recursive: true });
        fs.writeFileSync(globalSkillPath, skillContent, 'utf8');
        updatedFiles.push(globalSkillPath);

        const globalGeminiMd = pathe.join(geminiHome, 'GEMINI.md');
        upsertMarkdownSection(
          globalGeminiMd,
          buildAgentProtocolMarkdown('Coordinate of Code (hey-yu) Global Protocol')
        );
        updatedFiles.push(globalGeminiMd);

        const mcpSchemaBases = [
          pathe.join(globalConfigDir, 'mcp'),
          pathe.join(geminiHome, 'antigravity-cli', 'mcp'),
          pathe.join(geminiHome, 'antigravity', 'mcp'),
          pathe.join(geminiHome, 'antigravity-ide', 'mcp')
        ];
        const heyYuSchema = {
          name: 'hey_yu',
          description: TOOLS[0].description,
          parameters: TOOLS[0].inputSchema
        };
        const projectMapSchema = {
          name: 'yu_get_project_map',
          description: TOOLS[1].description,
          parameters: TOOLS[1].inputSchema
        };
        for (const baseDir of mcpSchemaBases) {
          if (!fs.existsSync(pathe.dirname(baseDir))) continue;
          for (const legacyMangled of ['hey-yu_hey-yu', 'hey-yu_coordinate-of-code']) {
            const mangledDir = pathe.join(baseDir, legacyMangled);
            if (fs.existsSync(mangledDir)) {
              try {
                fs.rmSync(mangledDir, { recursive: true, force: true });
              } catch (_) {}
            }
          }
          for (const srv of ['hey-yu', 'coordinate-of-code']) {
            const srvDir = pathe.join(baseDir, srv);
            fs.mkdirSync(srvDir, { recursive: true });
            fs.writeFileSync(pathe.join(srvDir, 'hey_yu.json'), `${JSON.stringify(heyYuSchema, null, 2)}\n`, 'utf8');
            fs.writeFileSync(
              pathe.join(srvDir, 'yu_get_project_map.json'),
              `${JSON.stringify(projectMapSchema, null, 2)}\n`,
              'utf8'
            );
            fs.writeFileSync(pathe.join(srvDir, 'instructions.md'), skillContent, 'utf8');
          }
        }
      } catch (err) {
        if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
          hitPermissionError = true;
        }
      }
    }
    globalMcpStatus = hitPermissionError
      ? 'SANDBOX_BLOCKED_RUN_WITH_BYPASS_SANDBOX'
      : wroteAnyGlobal
        ? 'REGISTERED_GLOBAL_MCP'
        : 'NO_GEMINI_DIR';

    for (const ancestorRoot of findAncestorAgentWorkspaces(root)) {
      try {
        upsertHooksFile(pathe.join(ancestorRoot, '.agents', 'hooks.json'));
        const ancRulePath = pathe.join(ancestorRoot, '.agents', 'rules', 'hey-yu-rule.md');
        fs.mkdirSync(pathe.dirname(ancRulePath), { recursive: true });
        fs.writeFileSync(ancRulePath, agyRuleContent, 'utf8');
        updatedFiles.push(ancRulePath);

        const ancSkillPath = pathe.join(ancestorRoot, '.agents', 'skills', 'hey-yu', 'SKILL.md');
        fs.mkdirSync(pathe.dirname(ancSkillPath), { recursive: true });
        fs.writeFileSync(ancSkillPath, skillContent, 'utf8');
        updatedFiles.push(ancSkillPath);
      } catch (_) {}
    }
  }

  const claudeSettingsPath = pathe.join(root, '.claude', 'settings.json');
  let claudeSettings = {};
  if (fs.existsSync(claudeSettingsPath)) {
    try {
      claudeSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
    } catch (_) {
      claudeSettings = {};
    }
  }
  if (!claudeSettings.hooks || typeof claudeSettings.hooks !== 'object') {
    claudeSettings.hooks = {};
  }
  delete claudeSettings.hooks.UserPromptSubmit;
  claudeSettings.hooks.PreToolUse = [
    {
      matcher: 'Grep|Glob|Bash|Read',
      hooks: [{ type: 'command', command: safeHookCmd('PreToolUse') }]
    }
  ];
  fs.mkdirSync(pathe.dirname(claudeSettingsPath), { recursive: true });
  fs.writeFileSync(claudeSettingsPath, `${JSON.stringify(claudeSettings, null, 2)}\n`, 'utf8');
  updatedFiles.push(claudeSettingsPath);

  if (process.env.HEY_YU_SKIP_GLOBAL_MCP !== '1') {
    recycleRunningMcpDaemons();
  }

  return { root, updatedFiles, globalMcpStatus };
}

function recycleRunningMcpDaemons() {
  if (process.platform === 'win32') return;
  try {
    const out = execFileSync('pgrep', ['-f', 'hey_yu_mcp\\.js|mcp_server\\.js'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    for (const line of out.split('\n')) {
      const pid = Number(line.trim());
      if (pid && pid !== process.pid && pid !== process.ppid) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch (_) {}
      }
    }
  } catch (_) {}
}

export function unprovisionWorkspace(targetRoot = defaultProjectRoot) {
  const root = pathe.resolve(targetRoot);
  const cleanedPaths = [];

  const mcpTargets = [
    pathe.join(root, '.mcp.json'),
    pathe.join(root, '.cursor', 'mcp.json'),
    pathe.join(root, '.claude', 'config.json'),
    pathe.join(root, '.windsurf', 'mcp_config.json')
  ];

  for (const mcpPath of mcpTargets) {
    if (!fs.existsSync(mcpPath)) continue;
    try {
      const existing = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      if (existing?.mcpServers) {
        delete existing.mcpServers['coordinate-of-code'];
        delete existing.mcpServers['hey-yu'];
        delete existing.mcpServers['yu'];
        delete existing.mcpServers['hey-yu-mcp-server'];
        if (Object.keys(existing.mcpServers).length === 0) {
          delete existing.mcpServers;
        }
        if (Object.keys(existing).length === 0) {
          fs.rmSync(mcpPath, { force: true });
        } else {
          fs.writeFileSync(mcpPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
        }
        cleanedPaths.push(mcpPath);
      }
    } catch (_) {}
  }

  const stripMarkersFromFile = (docPath, deleteIfEmpty = true) => {
    if (!fs.existsSync(docPath)) return;
    try {
      const existing = fs.readFileSync(docPath, 'utf8');
      const startIdx = existing.indexOf(MARKER_START);
      const endIdx = existing.indexOf(MARKER_END);
      if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        const nextText = `${existing.slice(0, startIdx).trimEnd()}\n${existing.slice(endIdx + MARKER_END.length).trimStart()}`.trim();
        if (!nextText && deleteIfEmpty) {
          fs.rmSync(docPath, { force: true });
        } else {
          fs.writeFileSync(docPath, nextText ? `${nextText}\n` : '', 'utf8');
        }
        cleanedPaths.push(docPath);
      } else if (existing.startsWith('<!-- hey-yu-COORDINATE-OF-CODE -->') && deleteIfEmpty) {
        fs.rmSync(docPath, { force: true });
        cleanedPaths.push(docPath);
      }
    } catch (_) {}
  };

  const docTargets = [
    pathe.join(root, 'AGENTS.md'),
    pathe.join(root, 'CLAUDE.md'),
    pathe.join(root, 'GEMINI.md'),
    pathe.join(root, '.cursorrules')
  ];

  for (const docPath of docTargets) {
    stripMarkersFromFile(docPath, true);
  }

  const removePaths = [
    pathe.join(root, '.agents', 'rules', 'hey-yu-rule.md'),
    pathe.join(root, '.cursor', 'rules', 'hey-yu.mdc'),
    pathe.join(root, '.agents', 'skills', 'hey-yu'),
    pathe.join(root, '.agents', 'plugins', 'hey-yu'),
    pathe.join(root, '.coordinate')
  ];

  for (const p of removePaths) {
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
      cleanedPaths.push(p);
    }
  }

  const cleanHooksFile = (hooksPath) => {
    if (!fs.existsSync(hooksPath)) return;
    try {
      const agyHooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
      if (agyHooks && agyHooks['hey-yu-interceptor']) {
        delete agyHooks['hey-yu-interceptor'];
        if (Object.keys(agyHooks).length === 0) {
          fs.rmSync(hooksPath, { force: true });
        } else {
          fs.writeFileSync(hooksPath, `${JSON.stringify(agyHooks, null, 2)}\n`, 'utf8');
        }
        cleanedPaths.push(hooksPath);
      }
    } catch (_) {}
  };

  cleanHooksFile(pathe.join(root, '.agents', 'hooks.json'));

  const claudeSettingsPath = pathe.join(root, '.claude', 'settings.json');
  if (fs.existsSync(claudeSettingsPath)) {
    try {
      const claudeSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
      if (claudeSettings?.hooks && typeof claudeSettings.hooks === 'object') {
        for (const eventKey of Object.keys(claudeSettings.hooks)) {
          if (Array.isArray(claudeSettings.hooks[eventKey])) {
            claudeSettings.hooks[eventKey] = claudeSettings.hooks[eventKey].filter(
              entry => {
                const str = JSON.stringify(entry);
                return !str.includes('hey_yu_mcp.js') && !str.includes('hey-yu');
              }
            );
            if (claudeSettings.hooks[eventKey].length === 0) {
              delete claudeSettings.hooks[eventKey];
            }
          }
        }
        if (Object.keys(claudeSettings.hooks).length === 0) {
          delete claudeSettings.hooks;
        }
        if (Object.keys(claudeSettings).length === 0) {
          fs.rmSync(claudeSettingsPath, { force: true });
        } else {
          fs.writeFileSync(claudeSettingsPath, `${JSON.stringify(claudeSettings, null, 2)}\n`, 'utf8');
        }
        cleanedPaths.push(claudeSettingsPath);
      }
    } catch (_) {}
  }

  for (const dirName of [
    '.agents/rules',
    '.agents/skills',
    '.agents/plugins',
    '.agents',
    '.cursor/rules',
    '.cursor',
    '.claude',
    '.windsurf',
    '.vscode'
  ]) {
    const dirPath = pathe.join(root, dirName);
    try {
      if (fs.existsSync(dirPath) && fs.readdirSync(dirPath).length === 0) {
        fs.rmdirSync(dirPath);
      }
    } catch (_) {}
  }

  if (process.env.HEY_YU_SKIP_GLOBAL_MCP !== '1') {
    const geminiHome = pathe.join(os.homedir(), '.gemini');
    const globalConfigDir = pathe.join(geminiHome, 'config');
    const globalMcpTargets = [
      pathe.join(globalConfigDir, 'mcp_config.json'),
      pathe.join(geminiHome, 'antigravity', 'mcp_config.json'),
      pathe.join(geminiHome, 'antigravity-cli', 'mcp_config.json'),
      pathe.join(geminiHome, 'antigravity-ide', 'mcp_config.json')
    ];
    for (const globalAgyMcpPath of globalMcpTargets) {
      if (!fs.existsSync(globalAgyMcpPath)) continue;
      try {
        const globalMcp = JSON.parse(fs.readFileSync(globalAgyMcpPath, 'utf8'));
        if (globalMcp?.mcpServers) {
          delete globalMcp.mcpServers['coordinate-of-code'];
          delete globalMcp.mcpServers['coordinate-cloud'];
          delete globalMcp.mcpServers['hey-yu'];
          delete globalMcp.mcpServers['yu'];
          delete globalMcp.mcpServers['hey-yu-mcp-server'];
          fs.writeFileSync(globalAgyMcpPath, `${JSON.stringify(globalMcp, null, 2)}\n`, 'utf8');
          cleanedPaths.push(globalAgyMcpPath);
        }
      } catch (_) {}
    }

    cleanHooksFile(pathe.join(globalConfigDir, 'hooks.json'));
    stripMarkersFromFile(pathe.join(geminiHome, 'GEMINI.md'), false);

    const globalRemovePaths = [
      ACTIVE_WORKSPACE_STATE_PATH,
      pathe.join(globalConfigDir, 'rules', 'hey-yu-rule.md'),
      pathe.join(globalConfigDir, 'skills', 'hey-yu'),
      pathe.join(globalConfigDir, 'mcp', 'hey-yu'),
      pathe.join(globalConfigDir, 'mcp', 'coordinate-of-code'),
      pathe.join(globalConfigDir, 'mcp', 'hey-yu_hey-yu'),
      pathe.join(globalConfigDir, 'mcp', 'hey-yu_coordinate-of-code'),
      pathe.join(globalConfigDir, 'mcp', 'yu'),
      pathe.join(globalConfigDir, 'mcp', 'hey-yu-mcp-server'),
      pathe.join(geminiHome, 'antigravity-cli', 'mcp', 'hey-yu'),
      pathe.join(geminiHome, 'antigravity-cli', 'mcp', 'coordinate-of-code'),
      pathe.join(geminiHome, 'antigravity-cli', 'mcp', 'hey-yu_hey-yu'),
      pathe.join(geminiHome, 'antigravity-cli', 'mcp', 'hey-yu_coordinate-of-code'),
      pathe.join(geminiHome, 'antigravity-cli', 'mcp', 'yu'),
      pathe.join(geminiHome, 'antigravity-cli', 'mcp', 'hey-yu-mcp-server'),
      pathe.join(geminiHome, 'antigravity', 'mcp', 'hey-yu'),
      pathe.join(geminiHome, 'antigravity', 'mcp', 'coordinate-of-code'),
      pathe.join(geminiHome, 'antigravity', 'mcp', 'hey-yu_hey-yu'),
      pathe.join(geminiHome, 'antigravity', 'mcp', 'hey-yu_coordinate-of-code'),
      pathe.join(geminiHome, 'antigravity', 'mcp', 'yu'),
      pathe.join(geminiHome, 'antigravity', 'mcp', 'hey-yu-mcp-server'),
      pathe.join(geminiHome, 'antigravity-ide', 'mcp', 'hey-yu'),
      pathe.join(geminiHome, 'antigravity-ide', 'mcp', 'coordinate-of-code'),
      pathe.join(geminiHome, 'antigravity-ide', 'mcp', 'hey-yu_hey-yu'),
      pathe.join(geminiHome, 'antigravity-ide', 'mcp', 'hey-yu_coordinate-of-code'),
      pathe.join(geminiHome, 'antigravity-ide', 'mcp', 'yu'),
      pathe.join(geminiHome, 'antigravity-ide', 'mcp', 'hey-yu-mcp-server')
    ];
    for (const p of globalRemovePaths) {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
        cleanedPaths.push(p);
      }
    }

    for (const ancestorRoot of findAncestorAgentWorkspaces(root)) {
      cleanHooksFile(pathe.join(ancestorRoot, '.agents', 'hooks.json'));
      for (const p of [
        pathe.join(ancestorRoot, '.agents', 'rules', 'hey-yu-rule.md'),
        pathe.join(ancestorRoot, '.agents', 'skills', 'hey-yu'),
        pathe.join(ancestorRoot, '.coordinate')
      ]) {
        if (fs.existsSync(p)) {
          fs.rmSync(p, { recursive: true, force: true });
          cleanedPaths.push(p);
        }
      }
    }

    recycleRunningMcpDaemons();
  }

  return { root, cleanedPaths };
}

async function runSelfTest() {
  const tmpDir = fs.mkdtempSync(pathe.join(os.tmpdir(), 'hey-yu-selftest-'));
  try {
    fs.mkdirSync(pathe.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(pathe.join(tmpDir, 'db'), { recursive: true });

    fs.writeFileSync(
      pathe.join(tmpDir, 'src', 'types.ts'),
      'export interface InvoiceRequest {\n  invoiceId: string;\n  tenantId: string;\n  amountCents: number;\n}\n',
      'utf8'
    );
    fs.writeFileSync(
      pathe.join(tmpDir, 'src', 'tax.ts'),
      'import { InvoiceRequest } from "./types.js";\nexport function calculateTaxCents(req: InvoiceRequest): number {\n  return Math.round(req.amountCents * 0.1);\n}\n',
      'utf8'
    );
    fs.writeFileSync(
      pathe.join(tmpDir, 'src', 'billing.ts'),
      'import { InvoiceRequest } from "./types.js";\nimport { calculateTaxCents } from "./tax.js";\nexport function settleInvoice(req: InvoiceRequest): number {\n  const tax = calculateTaxCents(req);\n  const status = "INVOICE_SETTLED_OK";\n  return req.amountCents + tax;\n}\n',
      'utf8'
    );
    fs.writeFileSync(
      pathe.join(tmpDir, 'db', 'schema.sql'),
      'CREATE TABLE tenant_invoices (\n  invoice_id VARCHAR(64) PRIMARY KEY,\n  status VARCHAR(32) DEFAULT \'INVOICE_SETTLED_OK\'\n);\n',
      'utf8'
    );

    const resolver = new CoordinateResolver(tmpDir);
    await resolver.init();

    const hit = await resolver.resolve({
      query: 'calculateTaxCents',
      semantic_tokens: ['tax', 'invoice'],
      expected_kind: 'function'
    });
    const literalHit = await resolver.resolve({
      query: 'INVOICE_SETTLED_OK'
    });
    const passHit = await resolver.resolve({
      query: 'nonexistent_quantum_hyperdrive_symbol_xyz'
    });

    const hookStep1Prompt = await evaluateLifecycleHook({ invocationNum: 0 }, 'PreInvocation', tmpDir);
    const hookNonCodeRead = await evaluateLifecycleHook(
      { toolCall: { name: 'read_file', args: { Path: pathe.join(tmpDir, 'README.md') } } },
      'PreToolUse',
      tmpDir
    );
    const hookOutsideRootRead = await evaluateLifecycleHook(
      { toolCall: { name: 'read_file', args: { Path: '/tmp/outside_transcript.jsonl' } } },
      'PreToolUse',
      tmpDir
    );
    const hookPassSearch = await evaluateLifecycleHook(
      { toolCall: { name: 'grep_search', args: { Query: 'nonexistent_quantum_hyperdrive_symbol_xyz' } } },
      'PreToolUse',
      tmpDir
    );
    const hookPreToolGrep = await evaluateLifecycleHook(
      { toolCall: { name: 'grep_search', args: { Query: 'calculateTaxCents' } } },
      'PreToolUse',
      tmpDir
    );
    const hookPreToolShell = await evaluateLifecycleHook(
      { toolCall: { name: 'run_command', args: { CommandLine: 'find . -maxdepth 2' } } },
      'PreToolUse',
      tmpDir
    );
    const hookPreInvokeAfterAutoDispatch = await evaluateLifecycleHook(
      { invocationNum: 1 },
      'PreInvocation',
      tmpDir
    );
    const hookTelemetryLines = fs
      .readFileSync(pathe.join(tmpDir, '.coordinate', 'hook_telemetry.jsonl'), 'utf8')
      .trim()
      .split('\n');

    const prevSkipGlobal = process.env.HEY_YU_SKIP_GLOBAL_MCP;
    process.env.HEY_YU_SKIP_GLOBAL_MCP = '1';
    let roundtripClean = false;
    try {
      fs.writeFileSync(pathe.join(tmpDir, 'AGENTS.md'), '# Existing Team Rules\nKeep this section intact.\n', 'utf8');
      provisionWorkspace(tmpDir);
      const provisionedAgents = fs.readFileSync(pathe.join(tmpDir, 'AGENTS.md'), 'utf8');
      const hadMarkers = provisionedAgents.includes('<!-- hey-yu-COORDINATE-OF-CODE:START -->') &&
        provisionedAgents.includes('# Existing Team Rules');
      unprovisionWorkspace(tmpDir);
      const restoredAgents = fs.readFileSync(pathe.join(tmpDir, 'AGENTS.md'), 'utf8');
      roundtripClean =
        hadMarkers &&
        restoredAgents.trim() === '# Existing Team Rules\nKeep this section intact.' &&
        !fs.existsSync(pathe.join(tmpDir, '.mcp.json')) &&
        !fs.existsSync(pathe.join(tmpDir, 'CLAUDE.md')) &&
        !fs.existsSync(pathe.join(tmpDir, '.coordinate'));
    } finally {
      if (prevSkipGlobal === undefined) delete process.env.HEY_YU_SKIP_GLOBAL_MCP;
      else process.env.HEY_YU_SKIP_GLOBAL_MCP = prevSkipGlobal;
    }

    const checks = {
      symbol_resolved: hit.resolution_status === 'EXISTING_FOUND' && hit.name === 'calculateTaxCents',
      has_code_preview: typeof hit.code_preview === 'string' && hit.code_preview.includes('calculateTaxCents'),
      has_caller: hit.impact_graph.incoming_callers.some(c => c.name === 'settleInvoice'),
      has_shared_type: hit.impact_graph.outgoing_contracts.shared_types.some(t => t.name === 'InvoiceRequest'),
      cross_file_sql_related:
        literalHit.resolution_status === 'EXISTING_FOUND' &&
        literalHit.related_coordinates.some(r => r.file.endsWith('schema.sql')),
      silent_pass_works: passHit.pass === true && passHit.resolution_status === 'PASS',
      step1_prompt_silent: Object.keys(hookStep1Prompt).length === 0,
      non_code_and_outside_silent:
        !hookNonCodeRead.reason &&
        !hookOutsideRootRead.reason &&
        !hookPassSearch.reason,
      hooks_auto_dispatch_and_log:
        Boolean(hookPreToolGrep.reason && hookPreToolGrep.reason.includes('calculateTaxCents')) &&
        Boolean(hookPreToolShell.reason && hookPreToolShell.reason.includes('Workspace AST Coordinate Map')) &&
        Array.isArray(hookPreInvokeAfterAutoDispatch.injectSteps) &&
        hookTelemetryLines.length === 3,
      init_and_uninstall_roundtrip: roundtripClean
    };

    const allPassed = Object.values(checks).every(Boolean);
    process.stdout.write(`${hit.user_status_line}\n`);
    process.stdout.write(`${literalHit.user_status_line}\n`);
    process.stdout.write(`${JSON.stringify({ self_test: allPassed ? 'PASSED' : 'FAILED', checks }, null, 2)}\n`);
    if (!allPassed) process.exit(1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const invokedScriptPath = (() => {
  if (!process.argv[1]) return '';
  try {
    return pathe.normalize(fs.realpathSync(process.argv[1]));
  } catch (_) {
    return pathe.normalize(pathe.resolve(process.argv[1]));
  }
})();

if (invokedScriptPath === __filename) {
  if (typeof cliOpts['rpc-json'] === 'string' && cliOpts['rpc-json']) {
    const msg = JSON.parse(cliOpts['rpc-json']);
    const res = await handleRpcMessage(msg);
    process.stdout.write(`${JSON.stringify(res)}\n`);
    process.exit(0);
  }

  const subcommand = positionals[0];
  if (subcommand === 'init' || subcommand === 'setup') {
    const targetDir = positionals[1] ? pathe.resolve(positionals[1]) : defaultProjectRoot;
    const res = provisionWorkspace(targetDir);
    const r = await getResolver(res.root);
    const mapSummary = await r.getProjectMap();
    process.stdout.write(
      `${JSON.stringify(
        {
          status: 'PROVISIONED',
          root: res.root,
          updated_files: res.updatedFiles.length,
          indexed_files: mapSummary.total_files,
          indexed_coordinates: mapSummary.total_coordinates,
          global_mcp_status: res.globalMcpStatus
        },
        null,
        2
      )}\n`
    );
    process.exit(0);
  }

  if (subcommand === 'uninstall' || subcommand === 'remove' || subcommand === 'clean') {
    const targetDir = positionals[1] ? pathe.resolve(positionals[1]) : defaultProjectRoot;
    const res = unprovisionWorkspace(targetDir);
    process.stdout.write(
      `${JSON.stringify({ status: 'UNPROVISIONED', root: res.root, cleaned_paths: res.cleanedPaths.length }, null, 2)}\n`
    );
    process.exit(0);
  }

  if (subcommand === 'self-test' || subcommand === 'test' || cliOpts['self-test']) {
    await runSelfTest();
    process.exit(0);
  }

  if (subcommand === 'resolve' || subcommand === 'query') {
    const queryStr = String(positionals[1] || '').trim();
    const targetDir = positionals[2] ? pathe.resolve(positionals[2]) : defaultProjectRoot;
    if (!queryStr) {
      process.stderr.write('Usage: node engine/hey_yu_mcp.js resolve "<query>" [projectRoot]\n');
      process.exit(1);
    }
    const r = await getResolver(targetDir);
    const out = await r.resolve({ query: queryStr });
    recordTelemetry(targetDir, 'cli_resolve', { query: queryStr }, out);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(0);
  }

  if (subcommand === 'map') {
    const targetDir = positionals[1] ? pathe.resolve(positionals[1]) : defaultProjectRoot;
    const r = await getResolver(targetDir);
    const out = await r.getProjectMap();
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(0);
  }

  if (subcommand === 'hook') {
    const ruleFile = pathe.join(defaultProjectRoot, '.agents', 'rules', 'hey-yu-rule.md');
    if (!fs.existsSync(ruleFile)) {
      process.exit(0);
    }
    let payload = {};
    try {
      const raw = process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8').trim();
      if (raw) payload = JSON.parse(raw);
    } catch (_) {}
    const out = await evaluateLifecycleHook(payload, String(cliOpts.event || ''), defaultProjectRoot);
    if (out && Object.keys(out).length > 0) {
      process.stdout.write(`${JSON.stringify(out)}\n`);
    }
    process.exit(0);
  } else {
    const orphanTimer = setInterval(() => {
      if (process.ppid === 1) {
        process.exit(0);
      }
    }, 10000);
    orphanTimer.unref();

    process.stdin.on('end', () => process.exit(0));
    process.stdin.on('close', () => process.exit(0));

    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('close', () => process.exit(0));
    rl.on('line', async line => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch (_) {
        return;
      }
      if (msg.id === undefined) return;
      try {
        const res = await handleRpcMessage(msg);
        sendResponse(msg.id, res);
      } catch (err) {
        sendError(msg.id, -32603, err.message || 'Internal MCP error');
      }
    });
  }
}
