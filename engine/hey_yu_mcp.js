#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pathe from 'pathe';
import { z } from 'zod';
import { availableLanguages } from '@lumis-sh/lumis';
import { CoordinateResolver, CENTRAL_COORD_ROOT, resolveProjectStorageDir } from './coord_resolver.js';

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
    .describe('Absolute path to the target project/workspace root directory currently being worked on.')
});

const ProjectMapArgsSchema = z.object({
  project_root: z
    .string()
    .describe('Absolute path to the target project/workspace root directory currently being worked on.')
});

const TOOLS = [
  {
    name: 'hey_yu',
    description:
      'Instant 1-step AST spatial coordinate dispatcher (<15ms). Returns cadastral_id, kind, name, line_span, coordinate_dispatcher (required_file_spans), impact_graph, and related_coordinates, or pass: true.',
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
    kind: { type: 'string', short: 'k' },
    file: { type: 'string', short: 'f' },
    line: { type: 'string', short: 'l' },
    tokens: { type: 'string', short: 't' },
    event: { type: 'string', short: 'e' },
    local: { type: 'boolean' },
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

const LUMIS_ROOT_GLOBS = [
  ...new Set([
    ...Object.values(availableLanguages())
      .flatMap(l => l.globs || [])
      .filter(g => !g.includes('*') && !g.startsWith('.')),
    '.git'
  ])
];

function findWorkspaceRootFromPath(startPath) {
  if (!startPath) return null;
  try {
    const home = pathe.resolve(os.homedir());
    let curr = pathe.resolve(startPath);
    if (fs.existsSync(curr) && !fs.statSync(curr).isDirectory()) {
      curr = pathe.dirname(curr);
    }
    let fallbackRoot = null;
    while (curr && curr !== '/' && curr !== home) {
      if (
        !fallbackRoot &&
        LUMIS_ROOT_GLOBS.some(marker => fs.existsSync(pathe.join(curr, marker)))
      ) {
        fallbackRoot = curr;
      }
      const parent = pathe.dirname(curr);
      if (parent === curr) break;
      curr = parent;
    }
    return fallbackRoot;
  } catch (_) {
    return null;
  }
}

function resolveEffectiveProjectRoot(rawArgs = {}) {
  if (typeof rawArgs?.project_root === 'string' && rawArgs.project_root.trim()) {
    const explicitRoot = pathe.normalize(pathe.resolve(rawArgs.project_root.trim()));
    if (fs.existsSync(explicitRoot)) {
      return explicitRoot;
    }
  }
  if (typeof rawArgs?.file === 'string' && pathe.isAbsolute(rawArgs.file.trim())) {
    const inferredFromFile = findWorkspaceRootFromPath(rawArgs.file.trim());
    if (inferredFromFile && fs.existsSync(inferredFromFile)) {
      return pathe.normalize(pathe.resolve(inferredFromFile));
    }
  }
  return pathe.normalize(pathe.resolve(defaultProjectRoot));
}

const resolversByRoot = new Map();

async function getResolver(rootOverride) {
  const root = pathe.normalize(pathe.resolve(rootOverride || defaultProjectRoot));
  if (!resolversByRoot.has(root)) {
    const resolver = new CoordinateResolver(root);
    await resolver.init();
    resolversByRoot.set(root, resolver);
  }
  return resolversByRoot.get(root);
}

async function recordTelemetry(projectRoot, toolName, payload, result) {
  try {
    fs.mkdirSync(CENTRAL_COORD_ROOT, { recursive: true });
    const rootGitignore = pathe.join(CENTRAL_COORD_ROOT, '.gitignore');
    if (!fs.existsSync(rootGitignore)) {
      fs.writeFileSync(rootGitignore, '*\n', 'utf8');
    }
    const coordDir = await resolveProjectStorageDir(projectRoot);
    fs.mkdirSync(coordDir, { recursive: true });
    const ts = new Date().toISOString();
    const logPath = pathe.join(coordDir, 'mcp_telemetry.jsonl');
    const liveLogPath = pathe.join(coordDir, 'live_audit.log');

    const entry = {
      timestamp: ts,
      project_root: pathe.normalize(pathe.resolve(projectRoot)),
      tool: toolName,
      query: payload?.query || payload?.file || null,
      origin_file: result?.origin_file || null,
      resolution_status: result?.resolution_status || 'MAP',
      cadastral_id: result?.cadastral_id || null,
      resolution_time_ms: result?.resolution_time_ms ?? null,
      user_status_line: result?.user_status_line || null
    };
    fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');

    if (
      (result?.resolution_status === 'EXISTING_FOUND' || result?.resolution_status === 'MAP') &&
      result?.user_status_line
    ) {
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
  const { method, params } = msg;

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
      await recordTelemetry(resolver.projectRoot, 'hey_yu', parsed.data, result);
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
      await recordTelemetry(resolver.projectRoot, 'yu_get_project_map', parsed.data, mapResult);
      return {
        content: [{ type: 'text', text: JSON.stringify(mapResult, null, 2) }]
      };
    }

    throw new Error(`Unknown tool: ${toolName}`);
  }

  return {};
}

function buildAgentProtocolMarkdown(title, frontmatter = '', targetRoot = null) {
  const prefix = frontmatter ? `${frontmatter.trim()}\n\n` : '';
  const resolvedRoot = targetRoot
    ? pathe.normalize(pathe.resolve(targetRoot))
    : '<absolute_path_to_current_project>';
  return `${prefix}${MARKER_START}
# ${title}

This environment is equipped with **hey-yu (Coordinate of Code v0.1.0-alpha)** — a pure AST Coordinate Dispatcher (\`coordinate_dispatcher\`). Every function, method, class, struct, interface, type/schema, and SQL table across 110+ languages has a deterministic AST coordinate (\`crd_...\`) and compiler-accurate dependency graph, with per-project AST caches isolated in \`${CENTRAL_COORD_ROOT}/projects/\`.

## Core Principles

1. **Dispatch AST coordinates & dependencies before reading or editing code.**
   Whenever the user asks to locate, update, refactor, debug, or audit/analyze existing code in any project (or mentions \`hey-yu\` phonetically/colloquially in any human language), query \`hey-yu\` (for targeted symbols) or \`yu_get_project_map\` (for project-wide audits/architecture) first. Always pass the absolute path of the workspace/project you are currently working on as \`project_root\`. If the user's prompt is in a non-English language, translate their intent into the target code symbol \`query\` and English \`semantic_tokens\`.
2. **Pure Coordinate Dispatcher (\`coordinate_dispatcher\`):**
   \`hey-yu\` does not dump raw file text; it dispatches exact block names, kinds, files, \`line_span\` (\`start-end\`), \`coordinate_dispatcher.required_file_spans\`, and \`impact_graph\` (\`incoming_callers\`, \`imported_callees\`, \`shared_types\`). When you need to inspect or edit code, pass the exact \`StartLine\` and \`EndLine\` from \`required_file_spans\` to \`read_file\` instead of reading whole files or running blind \`grep\`/\`find\` commands.
3. **Two universal ways to call \`hey-yu\` (MCP Tool or CLI Fallback):**
   Use the MCP tool if loaded in your editor, or run the CLI command directly in your terminal tool (\`run_command\` / \`Bash\`). Both use the same centralized per-project AST index (\`<15ms\`).
4. **Honest Silent Pass (\`pass: true\`):**
   When \`hey-yu\` returns \`pass: true\` (or when working on non-code tasks like \`git\`, deployments, or Markdown/JSON docs), continue normally with standard tools with zero status banners.

## How to Call \`hey-yu\` (MCP Tool & CLI Fallback)

### Method 1: MCP Tool (Preferred when MCP server \`hey-yu\` is active)
- **Cursor / Claude Code / Windsurf / Codex:** call \`hey_yu\` or \`yu_get_project_map\` directly, always passing \`project_root\`.
- **Google Antigravity:** call \`call_mcp_tool\` with \`ServerName: "hey-yu"\`, \`ToolName: "hey_yu"\` (or \`"yu_get_project_map"\`), and \`Arguments\`:
\`\`\`json
{
  "query": "<symbol name, natural-language concept, error code, or UI string>",
  "semantic_tokens": ["<optional domain tokens>"],
  "expected_kind": "function",
  "project_root": "${resolvedRoot}"
}
\`\`\`
Supported \`expected_kind\` values: \`"function" | "method" | "type" | "file"\`.

### Method 2: CLI Command Fallback (Works in 100% of editors, terminals & sandboxes)
If MCP tools are not loaded in the current session, execute \`hey_yu_mcp.js\` directly via terminal, passing the target project's directory path:
\`\`\`bash
# Resolve a function, class, type, error literal, or natural-language query:
node "${__filename}" resolve "<query>" "${resolvedRoot}"

# Filter by kind ("function" | "method" | "type" | "file") or file:line:
node "${__filename}" resolve "<query>" "${resolvedRoot}" --kind function
node "${__filename}" resolve "" "${resolvedRoot}" --file "src/path/file.ts" --line 42

# Get the architectural coordinate map of the workspace:
node "${__filename}" map "${resolvedRoot}"
\`\`\`

## Using the Dispatcher Output (\`EXISTING_FOUND\`)

1. **Target Coordinate (\`kind\` + \`name\` + \`absolute_file_path\` + \`line_span\`):**
   Read only the exact \`line_span\` (\`StartLine\`..\`EndLine\`) via \`read_file\` when you need to view or edit the block's implementation.
2. **Connected Dependencies (\`coordinate_dispatcher.required_file_spans\` + \`impact_graph\`):**
   Check \`incoming_callers\`, \`imported_callees\`, and \`shared_types\` before changing signatures or return contracts so callers never break.
3. **Single-Line Status in Chat:**
   When \`resolution_status === "EXISTING_FOUND"\`, include the exact \`user_status_line\` once in your response:
   \`[hey-yu] Resolved <kind> "<name>" (crd_...) -> path/to/file:start-end in X.Xms | Dependencies: ...\`
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

function buildSkillMarkdown(targetRoot = null) {
  const resolvedRoot = targetRoot
    ? pathe.normalize(pathe.resolve(targetRoot))
    : '<absolute_path_to_current_project>';
  return `---
name: hey-yu
description: "Use when doing ANY task involving hey-yu (Coordinate of Code, including phonetic or multilingual mentions) or when locating, modifying, refactoring, debugging, or auditing/analyzing existing functions, methods, classes, types, routes, SQL tables, or project architecture. Triggers: hey-yu, hey_yu, yu_get_project_map, coordinate of code, AST coordinates, impact graph, callers, callees, blast radius, audit, architecture analysis, or finding where a feature/symbol lives."
---

# hey-yu (Coordinate of Code — Pure AST Coordinate Dispatcher)

## Core Principles

1. **Pure Coordinate Dispatcher in 1 step (\`<15ms\`):**
   Instead of running multiple blind \`grep\`/\`find\` searches and reading full files, query \`hey-yu\` (for targeted symbols) or \`yu_get_project_map\` (for project-wide audits) to get the exact block \`name\`, \`kind\`, AST \`line_span\` (\`start-end\`), \`coordinate_dispatcher.required_file_spans\`, and full dependency chain (\`incoming_callers\`, \`imported_callees\`, \`shared_types\`, \`related_coordinates\`). Always pass the absolute path of the workspace/project you are currently working on as \`project_root\`. When the user writes in any human language, translate their intent into the target code symbol \`query\` and English \`semantic_tokens\`.
2. **Always available via MCP or CLI:**
   Prefer the MCP tool (\`hey_yu\` / \`yu_get_project_map\`) when available; if MCP is not active in the current editor session, run the CLI command directly via terminal (\`node "${__filename}" resolve "<query>" "${resolvedRoot}"\`).
3. **Honest Silent Pass (\`pass: true\`):**
   If a symbol does not exist yet (\`pass: true\`) or the task is outside source code (\`git\`, deployments, Markdown/JSON docs), proceed normally with standard tools without printing any \`[hey-yu]\` status line.

## Calling \`hey-yu\`

### 1. MCP Server Tools (Preferred)
- **Cursor / Claude Code / Windsurf / Codex:** call \`hey_yu\` or \`yu_get_project_map\`, always passing \`project_root\`.
- **Google Antigravity:** call \`call_mcp_tool\` with \`ServerName: "hey-yu"\`, \`ToolName: "hey_yu"\` (or \`"yu_get_project_map"\`):
\`\`\`json
{
  "query": "calculateTaxCents",
  "semantic_tokens": ["tax", "invoice"],
  "expected_kind": "function",
  "project_root": "${resolvedRoot}"
}
\`\`\`

### 2. CLI Commands (Universal Fallback)
Run directly in your terminal tool whenever MCP is unavailable or not yet reloaded:
\`\`\`bash
node "${__filename}" resolve "<symbol or natural-language query>" "${resolvedRoot}"
node "${__filename}" resolve "<symbol>" "${resolvedRoot}" --kind function
node "${__filename}" map "${resolvedRoot}"
\`\`\`

## Acting on Dispatcher Results (\`EXISTING_FOUND\`)

1. Use \`line_span\` (\`start..end\`) and \`coordinate_dispatcher.required_file_spans\` to read (\`read_file\` with \`StartLine\`/\`EndLine\`) or edit only the exact line spans needed — never read entire large files blindly.
2. Review \`impact_graph\` (\`incoming_callers\`, \`imported_callees\`, \`shared_types\`) so connected callers and types are updated in the same pass.
3. Output the single-line \`user_status_line\` (\`[hey-yu] Resolved ...\`) in your response when \`resolution_status === "EXISTING_FOUND"\`.
`;
}

function findAncestorAgentWorkspaces(targetRoot) {
  const ancestors = [];
  const home = pathe.resolve(os.homedir());
  let curr = pathe.resolve(targetRoot);
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

function cleanHooksFile(hooksPath, cleanedPaths = []) {
  if (!fs.existsSync(hooksPath)) return;
  try {
    const agyHooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    if (agyHooks && (agyHooks['hey-yu'] || agyHooks['hey-yu-interceptor'] || agyHooks['hey-yu-lifecycle'])) {
      delete agyHooks['hey-yu'];
      delete agyHooks['hey-yu-interceptor'];
      delete agyHooks['hey-yu-lifecycle'];
      if (Object.keys(agyHooks).length === 0) {
        fs.rmSync(hooksPath, { force: true });
      } else {
        fs.writeFileSync(hooksPath, `${JSON.stringify(agyHooks, null, 2)}\n`, 'utf8');
      }
      cleanedPaths.push(hooksPath);
    }
  } catch (_) {}
}

function cleanClaudeSettingsHooks(claudeSettingsPath, cleanedPaths = []) {
  if (!fs.existsSync(claudeSettingsPath)) return;
  try {
    const claudeSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
    if (claudeSettings?.hooks && typeof claudeSettings.hooks === 'object') {
      for (const eventKey of Object.keys(claudeSettings.hooks)) {
        if (Array.isArray(claudeSettings.hooks[eventKey])) {
          claudeSettings.hooks[eventKey] = claudeSettings.hooks[eventKey].filter(entry => {
            const str = JSON.stringify(entry);
            return !str.includes('hey_yu_mcp.js') && !str.includes('hey-yu');
          });
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

export function provisionWorkspace(targetRoot = defaultProjectRoot, options = {}) {
  const root = pathe.resolve(targetRoot);
  const includeLocal = options.local === true || cliOpts.local === true;
  const nodeBin = process.execPath || 'node';
  const pathDelimiter = process.platform === 'win32' ? ';' : ':';
  const inheritedPath = (process.env.PATH || '').split(pathDelimiter).filter(Boolean);
  const globalServerEntry = {
    command: nodeBin,
    args: [__filename],
    env: {
      PATH: [...new Set([pathe.dirname(nodeBin), ...inheritedPath])].join(pathDelimiter)
    }
  };
  const localServerEntry = {
    command: nodeBin,
    args: [__filename, '--project', root],
    env: globalServerEntry.env
  };

  // Ensure any legacy interceptor hooks are removed so no editor hooks interfere with agent tools
  cleanHooksFile(pathe.join(root, '.agents', 'hooks.json'));
  cleanClaudeSettingsHooks(pathe.join(root, '.claude', 'settings.json'));

  const updatedFiles = [];

  if (includeLocal) {
    const mcpTargets = [
      pathe.join(root, '.mcp.json'),
      pathe.join(root, '.cursor', 'mcp.json'),
      pathe.join(root, '.claude', 'config.json'),
      pathe.join(root, '.windsurf', 'mcp_config.json')
    ];

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
      existing.mcpServers['coordinate-of-code'] = localServerEntry;
      existing.mcpServers['hey-yu'] = localServerEntry;
      fs.mkdirSync(pathe.dirname(mcpPath), { recursive: true });
      fs.writeFileSync(mcpPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
      updatedFiles.push(mcpPath);
    }

    const docTargets = [
      { path: pathe.join(root, 'AGENTS.md'), title: 'AGENTS.md — Coordinate of Code (hey-yu) Protocol' },
      { path: pathe.join(root, 'CLAUDE.md'), title: 'CLAUDE.md — Coordinate of Code (hey-yu) Integration Guide' },
      { path: pathe.join(root, 'GEMINI.md'), title: 'GEMINI.md — Coordinate of Code (hey-yu) Guide for Gemini & Antigravity' },
      { path: pathe.join(root, '.cursorrules'), title: '.cursorrules — Coordinate of Code (hey-yu) Rules' }
    ];

    for (const doc of docTargets) {
      upsertMarkdownSection(doc.path, buildAgentProtocolMarkdown(doc.title, '', root));
      updatedFiles.push(doc.path);
    }

    const localAgyRuleContent = buildAgentProtocolMarkdown(
      'hey-yu (Coordinate of Code) — AST Navigation & Dependency Graph',
      '---\ntrigger: always_on\ndescription: Coordinate of Code (hey-yu v0.1.0-alpha) deterministic AST spatial resolution and dependency graph protocol\n---',
      root
    );
    const agyRulePath = pathe.join(root, '.agents', 'rules', 'hey-yu-rule.md');
    fs.mkdirSync(pathe.dirname(agyRulePath), { recursive: true });
    fs.writeFileSync(agyRulePath, localAgyRuleContent, 'utf8');
    updatedFiles.push(agyRulePath);

    const cursorMdcPath = pathe.join(root, '.cursor', 'rules', 'hey-yu.mdc');
    fs.mkdirSync(pathe.dirname(cursorMdcPath), { recursive: true });
    fs.writeFileSync(
      cursorMdcPath,
      buildAgentProtocolMarkdown(
        'Coordinate of Code (hey-yu v0.1.0-alpha) Rule',
        '---\ndescription: Coordinate of Code (hey-yu v0.1.0-alpha) deterministic AST spatial resolution and dependency graph protocol\nglobs: \nalwaysApply: true\n---',
        root
      ),
      'utf8'
    );
    updatedFiles.push(cursorMdcPath);

    const localSkillContent = buildSkillMarkdown(root);
    const skillPath = pathe.join(root, '.agents', 'skills', 'hey-yu', 'SKILL.md');
    fs.mkdirSync(pathe.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, localSkillContent, 'utf8');
    updatedFiles.push(skillPath);
  }

  const globalAgyRuleContent = buildAgentProtocolMarkdown(
    'hey-yu (Coordinate of Code) — AST Navigation & Dependency Graph',
    '---\ntrigger: always_on\ndescription: Coordinate of Code (hey-yu v0.1.0-alpha) deterministic AST spatial resolution and dependency graph protocol\n---',
    null
  );
  const globalSkillContent = buildSkillMarkdown(null);

  let globalMcpStatus = 'SKIPPED';
  if (process.env.HEY_YU_SKIP_GLOBAL_MCP !== '1') {
    const geminiHome = pathe.join(os.homedir(), '.gemini');
    const globalConfigDir = pathe.join(geminiHome, 'config');
    let wroteAnyGlobal = false;
    let hitPermissionError = false;
    if (fs.existsSync(geminiHome)) {
      try {
        fs.mkdirSync(globalConfigDir, { recursive: true });
        cleanHooksFile(pathe.join(globalConfigDir, 'hooks.json'));
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
            globalMcp.mcpServers['coordinate-of-code'] = globalServerEntry;
            globalMcp.mcpServers['hey-yu'] = globalServerEntry;
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
        fs.writeFileSync(globalRulePath, globalAgyRuleContent, 'utf8');
        updatedFiles.push(globalRulePath);

        const globalSkillPath = pathe.join(globalConfigDir, 'skills', 'hey-yu', 'SKILL.md');
        fs.mkdirSync(pathe.dirname(globalSkillPath), { recursive: true });
        fs.writeFileSync(globalSkillPath, globalSkillContent, 'utf8');
        updatedFiles.push(globalSkillPath);

        const globalGeminiMd = pathe.join(geminiHome, 'GEMINI.md');
        upsertMarkdownSection(
          globalGeminiMd,
          buildAgentProtocolMarkdown('Coordinate of Code (hey-yu) Global Protocol', '', null)
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
          for (const srv of ['hey-yu', 'coordinate-of-code']) {
            const srvDir = pathe.join(baseDir, srv);
            fs.mkdirSync(srvDir, { recursive: true });
            fs.writeFileSync(pathe.join(srvDir, 'hey_yu.json'), `${JSON.stringify(heyYuSchema, null, 2)}\n`, 'utf8');
            fs.writeFileSync(
              pathe.join(srvDir, 'yu_get_project_map.json'),
              `${JSON.stringify(projectMapSchema, null, 2)}\n`,
              'utf8'
            );
            fs.writeFileSync(pathe.join(srvDir, 'instructions.md'), globalSkillContent, 'utf8');
          }
        }
      } catch (err) {
        if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
          hitPermissionError = true;
        }
      }
    }
    globalMcpStatus = hitPermissionError
      ? 'LOCAL_MCP_AND_CLI_READY'
      : wroteAnyGlobal
        ? 'REGISTERED_GLOBAL_MCP'
        : 'LOCAL_MCP_AND_CLI_READY';

    for (const ancestorRoot of findAncestorAgentWorkspaces(root)) {
      if (!includeLocal && ancestorRoot === root) continue;
      try {
        cleanHooksFile(pathe.join(ancestorRoot, '.agents', 'hooks.json'));
        const ancRulePath = pathe.join(ancestorRoot, '.agents', 'rules', 'hey-yu-rule.md');
        fs.mkdirSync(pathe.dirname(ancRulePath), { recursive: true });
        fs.writeFileSync(ancRulePath, globalAgyRuleContent, 'utf8');
        updatedFiles.push(ancRulePath);

        const ancSkillPath = pathe.join(ancestorRoot, '.agents', 'skills', 'hey-yu', 'SKILL.md');
        fs.mkdirSync(pathe.dirname(ancSkillPath), { recursive: true });
        fs.writeFileSync(ancSkillPath, globalSkillContent, 'utf8');
        updatedFiles.push(ancSkillPath);
      } catch (_) {}
    }
  }

  return { root, updatedFiles, globalMcpStatus };
}

export async function unprovisionWorkspace(targetRoot = defaultProjectRoot) {
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

  const projectStorageDir = await resolveProjectStorageDir(root);
  const removePaths = [
    pathe.join(root, '.agents', 'rules', 'hey-yu-rule.md'),
    pathe.join(root, '.agents', 'scripts', 'hey-yu-lifecycle-hook.js'),
    pathe.join(root, '.cursor', 'rules', 'hey-yu.mdc'),
    pathe.join(root, '.agents', 'skills', 'hey-yu'),
    pathe.join(root, '.coordinate'),
    projectStorageDir
  ];

  for (const p of removePaths) {
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
      cleanedPaths.push(p);
    }
  }

  cleanHooksFile(pathe.join(root, '.agents', 'hooks.json'), cleanedPaths);
  cleanClaudeSettingsHooks(pathe.join(root, '.claude', 'settings.json'), cleanedPaths);

  for (const dirName of [
    '.agents/rules',
    '.agents/skills',
    '.agents/scripts',
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
          delete globalMcp.mcpServers['hey-yu'];
          fs.writeFileSync(globalAgyMcpPath, `${JSON.stringify(globalMcp, null, 2)}\n`, 'utf8');
          cleanedPaths.push(globalAgyMcpPath);
        }
      } catch (_) {}
    }

    cleanHooksFile(pathe.join(globalConfigDir, 'hooks.json'), cleanedPaths);
    stripMarkersFromFile(pathe.join(geminiHome, 'GEMINI.md'), false);

    const mcpSchemaBases = [
      pathe.join(globalConfigDir, 'mcp'),
      pathe.join(geminiHome, 'antigravity-cli', 'mcp'),
      pathe.join(geminiHome, 'antigravity', 'mcp'),
      pathe.join(geminiHome, 'antigravity-ide', 'mcp')
    ];
    const mcpServerNames = ['hey-yu', 'coordinate-of-code'];
    const globalRemovePaths = [
      pathe.join(geminiHome, 'hey-yu-active-workspace.json'),
      pathe.join(globalConfigDir, 'rules', 'hey-yu-rule.md'),
      pathe.join(globalConfigDir, 'skills', 'hey-yu'),
      CENTRAL_COORD_ROOT,
      ...mcpSchemaBases.flatMap(base => mcpServerNames.map(srv => pathe.join(base, srv)))
    ];
    for (const p of globalRemovePaths) {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
        cleanedPaths.push(p);
      }
    }

    for (const ancestorRoot of findAncestorAgentWorkspaces(root)) {
      cleanHooksFile(pathe.join(ancestorRoot, '.agents', 'hooks.json'), cleanedPaths);
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
  }

  return { root, cleanedPaths };
}

async function runSelfTest() {
  const tmpDir = fs.mkdtempSync(pathe.join(os.tmpdir(), 'hey-yu-selftest-a-'));
  const tmpDirB = fs.mkdtempSync(pathe.join(os.tmpdir(), 'hey-yu-selftest-b-'));
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

    // Second completely separate project to verify 30+ project isolation
    fs.mkdirSync(pathe.join(tmpDirB, 'src'), { recursive: true });
    fs.writeFileSync(
      pathe.join(tmpDirB, 'src', 'shipping.ts'),
      'export function dispatchShipmentOrder(orderId: string): string {\n  return `SHIPPED_${orderId}`;\n}\n',
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

    const prevSkipGlobal = process.env.HEY_YU_SKIP_GLOBAL_MCP;
    process.env.HEY_YU_SKIP_GLOBAL_MCP = '1';
    let roundtripClean = false;
    let zeroHooksProvisioned = false;
    let mcpRpcWorks = false;
    let cliResolveWorks = false;
    let multiProjectIsolationWorks = false;
    try {
      const rpcList = await handleRpcMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const rpcCallA = await handleRpcMessage({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'hey_yu',
          arguments: { query: 'settleInvoice', expected_kind: 'function', project_root: tmpDir }
        }
      });
      const rpcCallB = await handleRpcMessage({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'hey_yu',
          arguments: { query: 'dispatchShipmentOrder', expected_kind: 'function', project_root: tmpDirB }
        }
      });
      const rpcCrossCheckPass = await handleRpcMessage({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'hey_yu',
          arguments: { query: 'dispatchShipmentOrder', expected_kind: 'function', project_root: tmpDir }
        }
      });
      const rpcMap = await handleRpcMessage({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'yu_get_project_map',
          arguments: { project_root: tmpDir }
        }
      });
      const rpcCallAParsed = JSON.parse(rpcCallA.content[0].text);
      const rpcCallBParsed = JSON.parse(rpcCallB.content[0].text);
      const rpcCrossParsed = JSON.parse(rpcCrossCheckPass.content[0].text);
      const rpcMapParsed = JSON.parse(rpcMap.content[0].text);
      mcpRpcWorks =
        Array.isArray(rpcList.tools) &&
        rpcList.tools.length === 2 &&
        rpcCallAParsed.resolution_status === 'EXISTING_FOUND' &&
        rpcCallAParsed.name === 'settleInvoice' &&
        rpcMapParsed.total_files === 4;

      const storageDirA = await resolveProjectStorageDir(tmpDir);
      const storageDirB = await resolveProjectStorageDir(tmpDirB);
      multiProjectIsolationWorks =
        storageDirA !== storageDirB &&
        rpcCallBParsed.resolution_status === 'EXISTING_FOUND' &&
        rpcCallBParsed.name === 'dispatchShipmentOrder' &&
        rpcCrossParsed.pass === true &&
        fs.existsSync(pathe.join(storageDirA, 'ast_cache.json')) &&
        fs.existsSync(pathe.join(storageDirB, 'ast_cache.json')) &&
        !fs.existsSync(pathe.join(tmpDir, '.coordinate')) &&
        !fs.existsSync(pathe.join(tmpDirB, '.coordinate'));

      const cliOutRaw = execFileSync(
        process.execPath,
        [__filename, 'resolve', 'calculateTaxCents', tmpDir, '--kind', 'function'],
        { encoding: 'utf8' }
      );
      const cliOut = JSON.parse(cliOutRaw.trim());
      cliResolveWorks =
        cliOut.resolution_status === 'EXISTING_FOUND' &&
        cliOut.name === 'calculateTaxCents' &&
        fs.existsSync(pathe.join(storageDirA, 'live_audit.log')) &&
        !fs.existsSync(pathe.join(tmpDir, '.coordinate'));

      // Verify default global-only provision does NOT touch project folder
      provisionWorkspace(tmpDir, { local: false });
      const defaultLeavesProjectUntouched =
        !fs.existsSync(pathe.join(tmpDir, '.agents')) &&
        !fs.existsSync(pathe.join(tmpDir, '.mcp.json')) &&
        !fs.existsSync(pathe.join(tmpDir, 'CLAUDE.md'));

      // Verify --local provision + unprovision roundtrip
      fs.writeFileSync(pathe.join(tmpDir, 'AGENTS.md'), '# Existing Team Rules\nKeep this section intact.\n', 'utf8');
      provisionWorkspace(tmpDir, { local: true });
      const provisionedAgents = fs.readFileSync(pathe.join(tmpDir, 'AGENTS.md'), 'utf8');
      const provisionedSkill = fs.readFileSync(pathe.join(tmpDir, '.agents', 'skills', 'hey-yu', 'SKILL.md'), 'utf8');
      zeroHooksProvisioned =
        defaultLeavesProjectUntouched &&
        !fs.existsSync(pathe.join(tmpDir, '.agents', 'hooks.json')) &&
        !fs.existsSync(pathe.join(tmpDir, '.claude', 'settings.json')) &&
        provisionedSkill.includes('resolve') &&
        provisionedAgents.includes('hey_yu');

      const hadMarkers =
        provisionedAgents.includes('<!-- hey-yu-COORDINATE-OF-CODE:START -->') &&
        provisionedAgents.includes('# Existing Team Rules');
      await unprovisionWorkspace(tmpDir);
      await unprovisionWorkspace(tmpDirB);
      const restoredAgents = fs.readFileSync(pathe.join(tmpDir, 'AGENTS.md'), 'utf8');
      roundtripClean =
        hadMarkers &&
        restoredAgents.trim() === '# Existing Team Rules\nKeep this section intact.' &&
        !fs.existsSync(pathe.join(tmpDir, '.mcp.json')) &&
        !fs.existsSync(pathe.join(tmpDir, 'CLAUDE.md')) &&
        !fs.existsSync(pathe.join(tmpDir, '.coordinate')) &&
        !fs.existsSync(storageDirA) &&
        !fs.existsSync(storageDirB);
    } finally {
      if (prevSkipGlobal === undefined) delete process.env.HEY_YU_SKIP_GLOBAL_MCP;
      else process.env.HEY_YU_SKIP_GLOBAL_MCP = prevSkipGlobal;
    }

    const checks = {
      symbol_resolved: hit.resolution_status === 'EXISTING_FOUND' && hit.name === 'calculateTaxCents',
      pure_dispatcher_spans:
        hit.code_preview === undefined &&
        Array.isArray(hit.coordinate_dispatcher?.required_file_spans) &&
        hit.coordinate_dispatcher.required_file_spans.some(s => s.role === 'target' && s.name === 'calculateTaxCents'),
      has_caller: hit.impact_graph.incoming_callers.some(c => c.name === 'settleInvoice'),
      has_shared_type: hit.impact_graph.outgoing_contracts.shared_types.some(t => t.name === 'InvoiceRequest'),
      cross_file_sql_related:
        literalHit.resolution_status === 'EXISTING_FOUND' &&
        literalHit.related_coordinates.some(r => r.file.endsWith('schema.sql')),
      silent_pass_works: passHit.pass === true && passHit.resolution_status === 'PASS',
      mcp_rpc_resolve_and_map: mcpRpcWorks,
      multi_project_isolation: multiProjectIsolationWorks,
      cli_resolve_and_telemetry: cliResolveWorks,
      zero_hooks_provisioned: zeroHooksProvisioned,
      init_and_uninstall_roundtrip: roundtripClean
    };

    const allPassed = Object.values(checks).every(Boolean);
    process.stdout.write(`${hit.user_status_line}\n`);
    process.stdout.write(`${literalHit.user_status_line}\n`);
    process.stdout.write(`${JSON.stringify({ self_test: allPassed ? 'PASSED' : 'FAILED', checks }, null, 2)}\n`);
    if (!allPassed) process.exit(1);
  } finally {
    const storageDirA = await resolveProjectStorageDir(tmpDir);
    const storageDirB = await resolveProjectStorageDir(tmpDirB);
    fs.rmSync(storageDirA, { recursive: true, force: true });
    fs.rmSync(storageDirB, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpDirB, { recursive: true, force: true });
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
    const res = provisionWorkspace(targetDir, { local: cliOpts.local === true });
    let indexedFiles = 0;
    let indexedCoordinates = 0;
    if (positionals[1] || cliOpts.local === true) {
      const r = await getResolver(res.root);
      const mapSummary = await r.getProjectMap();
      indexedFiles = mapSummary.total_files;
      indexedCoordinates = mapSummary.total_coordinates;
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          status: 'PROVISIONED',
          mode: cliOpts.local === true ? 'LOCAL_AND_GLOBAL' : 'GLOBAL_CENTRALIZED',
          central_coord_root: CENTRAL_COORD_ROOT,
          updated_files: res.updatedFiles.length,
          ...(indexedFiles > 0
            ? { indexed_project: res.root, indexed_files: indexedFiles, indexed_coordinates: indexedCoordinates }
            : {}),
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
    const res = await unprovisionWorkspace(targetDir);
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
    const fileOpt = typeof cliOpts.file === 'string' ? cliOpts.file.trim() : undefined;
    const lineOpt = typeof cliOpts.line === 'string' && cliOpts.line ? Number(cliOpts.line) : undefined;
    const kindOpt = typeof cliOpts.kind === 'string' ? cliOpts.kind.trim() : undefined;
    const tokensOpt =
      typeof cliOpts.tokens === 'string' && cliOpts.tokens.trim()
        ? cliOpts.tokens
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
        : undefined;

    if (!queryStr && !fileOpt) {
      process.stderr.write(
        'Usage: node engine/hey_yu_mcp.js resolve "<query>" [projectRoot] [--kind function|method|type|file] [--file path] [--line N]\n'
      );
      process.exit(1);
    }
    const r = await getResolver(targetDir);
    const resolvePayload = {
      ...(queryStr ? { query: queryStr } : {}),
      ...(fileOpt ? { file: fileOpt } : {}),
      ...(lineOpt ? { line: lineOpt } : {}),
      ...(kindOpt ? { expected_kind: kindOpt } : {}),
      ...(tokensOpt ? { semantic_tokens: tokensOpt } : {})
    };
    const out = await r.resolve(resolvePayload);
    await recordTelemetry(r.projectRoot, 'cli_resolve', resolvePayload, out);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(0);
  }

  if (subcommand === 'map') {
    const targetDir = positionals[1] ? pathe.resolve(positionals[1]) : defaultProjectRoot;
    const r = await getResolver(targetDir);
    const out = await r.getProjectMap();
    await recordTelemetry(r.projectRoot, 'cli_map', {}, out);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(0);
  }

  if (subcommand === 'hook') {
    // Backwards-compatible no-op for any active editor session holding a legacy hook in memory
    const fallbackOut = String(cliOpts.event || '') === 'PreToolUse' ? { decision: 'allow' } : {};
    process.stdout.write(`${JSON.stringify(fallbackOut)}\n`);
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
