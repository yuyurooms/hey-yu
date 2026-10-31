import fs from 'node:fs';
import pathe from 'pathe';
import { create, insertMultiple, search } from '@orama/orama';
import { walkWorkspaceFiles } from './workspace_walker.js';
import { indexFileCst } from './cst_indexer.js';
import { buildCoordinateGraph, extractCoordDependencies } from './coord_graph.js';

const STOP_FRAGMENTS = new Set([
  'get', 'set', 'log', 'run', 'use', 'on', 'to', 'in', 'of', 'by', 'is', 'do', 'fn', 'id',
  'app', 'src', 'mvp', 'lib', 'pkg', 'cmd', 'api', 'the', 'for', 'and', 'with', 'from'
]);

function splitIdentifierWords(text) {
  return String(text || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-./:\\]+/g, ' ')
    .trim();
}

function extractWholeWordSet(text) {
  const words = splitIdentifierWords(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return new Set(words);
}

function doesDocumentMatchQuery(doc, rawQuery, projectRoot) {
  const qClean = String(rawQuery || '').trim();
  if (!qClean) return false;
  const qLower = qClean.toLowerCase();

  const rootBase = pathe.basename(projectRoot || '').toLowerCase();
  if (rootBase.length >= 3 && qLower.includes(rootBase)) {
    return true;
  }

  const docNameLower = String(doc.name || '').toLowerCase();
  const docFileLower = String(doc.origin_file || '').toLowerCase();
  const docLiteralsLower = String(doc.literals || '').toLowerCase();
  const docCallsLower = String(doc.calls || '').toLowerCase();
  const docTypesLower = String(doc.referenced_types || '').toLowerCase();

  if (
    docNameLower.includes(qLower) ||
    docFileLower.includes(qLower) ||
    docLiteralsLower.includes(qLower) ||
    docCallsLower.includes(qLower) ||
    docTypesLower.includes(qLower)
  ) {
    return true;
  }

  const queryWords = splitIdentifierWords(qClean)
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length >= 2 && !/^\d+$/.test(w));

  if (queryWords.length === 0) return false;

  const docWords = extractWholeWordSet(
    `${doc.name || ''} ${doc.name_words || ''} ${doc.origin_file || ''} ${doc.file_words || ''} ${doc.literals || ''} ${doc.calls || ''} ${doc.referenced_types || ''}`
  );

  const wordMatchesDoc = qw => {
    if (docWords.has(qw)) return true;
    if (qw.length >= 4) {
      for (const dw of docWords) {
        if (dw.startsWith(qw) || qw.startsWith(dw) && dw.length >= 4) return true;
      }
    }
    return false;
  };

  let matchedCount = 0;
  let matchedStrongCount = 0;
  for (const qw of queryWords) {
    if (wordMatchesDoc(qw)) {
      matchedCount++;
      if (!STOP_FRAGMENTS.has(qw)) {
        matchedStrongCount++;
      }
    }
  }

  if (matchedStrongCount === 0) return false;
  if (queryWords.length === 1) return matchedStrongCount >= 1;
  if (queryWords.length === 2) {
    const strongWords = queryWords.filter(w => !STOP_FRAGMENTS.has(w));
    return matchedCount >= 2 || (strongWords.length === 1 && matchedStrongCount === 1 && !qClean.includes('_'));
  }
  return matchedCount >= Math.ceil(queryWords.length * 0.6);
}

function formatStatusLine(target, deps, relatedCoords, elapsedMs) {
  const s = deps.dependency_summary;
  const parts = [];

  if (deps.impact_graph.incoming_callers.length > 0) {
    const callersList = deps.impact_graph.incoming_callers
      .map(c => `${c.name} (${c.file}:${c.line_span.start}-${c.line_span.end})`)
      .join(', ');
    parts.push(`${s.callers_count} Callers [${callersList}]`);
  }

  if (deps.impact_graph.imported_callees.length > 0) {
    const calleesList = deps.impact_graph.imported_callees
      .map(c => `${c.name} (${c.file}:${c.line_span.start}-${c.line_span.end})`)
      .join(', ');
    parts.push(`${s.imported_callees_count} Imported Callees [${calleesList}]`);
  }

  if (deps.impact_graph.outgoing_contracts.shared_types.length > 0) {
    const typesList = deps.impact_graph.outgoing_contracts.shared_types
      .map(t => `${t.name} (${t.file}:${t.line_span.start}-${t.line_span.end})`)
      .join(', ');
    parts.push(`${s.shared_types_count} Shared Types [${typesList}]`);
  }

  const depsSummary = parts.length > 0 ? parts.join(', ') : 'standalone (0 external links)';
  const relatedList =
    relatedCoords && relatedCoords.length > 0
      ? ` | Related Coordinates: [${relatedCoords.map(r => `${r.name} (${r.file}:${r.line_span.start}-${r.line_span.end})`).join(', ')}]`
      : '';

  return (
    `[hey-yu] Resolved ${target.kind} "${target.name}" (${target.cadastral_id}) -> ${target.origin_file}:${target.line_span.start}-${target.line_span.end} in ${Number(elapsedMs).toFixed(1)}ms | ` +
    `Dependencies: ${depsSummary} | ` +
    `Reading Plan: ${s.connected_file_spans_count} exact spans across ${s.reading_plan_files_count} files${relatedList}`
  );
}

export class CoordinateResolver {
  constructor(projectRoot) {
    this.projectRoot = pathe.resolve(projectRoot || process.cwd());
    this.cacheFilePath = pathe.join(this.projectRoot, '.coordinate', 'ast_cache.json');
    this.indexedFileMap = new Map();
    this.graphState = null;
    this.oramaDb = null;
  }

  _loadDiskAstCache() {
    try {
      if (!fs.existsSync(this.cacheFilePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.cacheFilePath, 'utf8'));
      const entries = raw?.entries || {};
      for (const [relPath, item] of Object.entries(entries)) {
        if (item?.statKey && item?.parsed?.fileNode) {
          this.indexedFileMap.set(relPath, { statKey: item.statKey, parsed: item.parsed });
        }
      }
    } catch (_) {}
  }

  _saveDiskAstCache() {
    try {
      const coordDir = pathe.dirname(this.cacheFilePath);
      fs.mkdirSync(coordDir, { recursive: true });
      const coordGitignore = pathe.join(coordDir, '.gitignore');
      if (!fs.existsSync(coordGitignore)) {
        fs.writeFileSync(coordGitignore, '*\n', 'utf8');
      }
      const entries = {};
      for (const [relPath, item] of this.indexedFileMap.entries()) {
        entries[relPath] = item;
      }
      fs.writeFileSync(this.cacheFilePath, JSON.stringify({ version: '0.1.0-alpha', entries }), 'utf8');
    } catch (_) {}
  }

  async _rebuildIndexFromMap() {
    const indexedFiles = [];
    for (const item of this.indexedFileMap.values()) {
      if (item?.parsed) indexedFiles.push(item.parsed);
    }

    this.graphState = buildCoordinateGraph(this.projectRoot, indexedFiles);
    this.oramaDb = await create({
      schema: {
        cadastral_id: 'string',
        name: 'string',
        name_words: 'string',
        kind: 'string',
        origin_file: 'string',
        file_words: 'string',
        language: 'string',
        literals: 'string',
        calls: 'string',
        referenced_types: 'string'
      }
    });

    const docs = [];
    for (const node of this.graphState.nodesById.values()) {
      docs.push({
        cadastral_id: node.cadastral_id,
        name: node.name || '',
        name_words: splitIdentifierWords(node.name),
        kind: node.kind || '',
        origin_file: node.origin_file || '',
        file_words: splitIdentifierWords(node.origin_file),
        language: node.language || '',
        literals: (node.literals || []).join(' '),
        calls: (node.calls || []).join(' '),
        referenced_types: (node.referenced_types || []).join(' ')
      });
    }

    if (docs.length > 0) {
      await insertMultiple(this.oramaDb, docs);
    }
  }

  /**
   * Incrementally synchronizes the in-memory CST cadastre and dependency graph
   * with live filesystem changes via `statKey` (`mtimeMs:size`).
   */
  async sync() {
    const files = await walkWorkspaceFiles(this.projectRoot);
    const seenRelPaths = new Set();
    let changed = false;

    for (const fileEntry of files) {
      seenRelPaths.add(fileEntry.relPath);
      const existing = this.indexedFileMap.get(fileEntry.relPath);
      if (existing && existing.statKey === fileEntry.statKey) {
        continue;
      }
      const parsed = await indexFileCst(fileEntry);
      if (parsed) {
        this.indexedFileMap.set(fileEntry.relPath, {
          statKey: fileEntry.statKey,
          parsed
        });
        changed = true;
      }
    }

    for (const relPath of [...this.indexedFileMap.keys()]) {
      if (!seenRelPaths.has(relPath)) {
        this.indexedFileMap.delete(relPath);
        changed = true;
      }
    }

    if (changed || !this.graphState || !this.oramaDb) {
      await this._rebuildIndexFromMap();
      if (changed) {
        this._saveDiskAstCache();
      }
    }
    return this;
  }

  async init() {
    this._loadDiskAstCache();
    await this.sync();
    return this;
  }

  async resolve(params = {}) {
    await this.sync();
    const t0 = performance.now();

    const { file, line, query, semantic_tokens, expected_kind } = params;

    if (file) {
      const relFile = pathe.isAbsolute(file) ? pathe.relative(this.projectRoot, file) : pathe.normalize(file);
      const fileNode = this.graphState.fileByRelPath.get(relFile);
      if (!fileNode) {
        return { pass: true, resolution_status: 'PASS' };
      }

      let target = fileNode;
      if (typeof line === 'number') {
        let bestSpanLen = Infinity;
        for (const childId of fileNode.children || []) {
          const sym = this.graphState.nodesById.get(childId);
          if (sym && line >= sym.line_span.start && line <= sym.line_span.end) {
            const len = sym.line_span.end - sym.line_span.start;
            if (len < bestSpanLen) {
              bestSpanLen = len;
              target = sym;
            }
          }
        }
      }
      return this._buildFoundResponse(target, t0);
    }

    const rawQuery = String(query || '').trim();
    const extraTokens = Array.isArray(semantic_tokens) ? semantic_tokens.join(' ') : '';
    const allInput = `${rawQuery} ${extraTokens}`.trim();
    const uniqueWords = [
      ...new Set(
        `${allInput} ${splitIdentifierWords(allInput)}`
          .split(/\s+/)
          .filter(w => w && (w.length >= 2 || !/^\d+$/.test(w)) && !/^\d+$/.test(w))
      )
    ];
    const combinedTerm = uniqueWords.join(' ');
    if (!combinedTerm || !rawQuery) {
      return { pass: true, resolution_status: 'PASS' };
    }

    const buildPassResult = () => {
      const qLower = rawQuery.toLowerCase();
      const matchingUnresolved = (this.graphState?.unresolvedImports || []).filter(u =>
        u.toLowerCase().includes(qLower)
      );
      return matchingUnresolved.length > 0
        ? { pass: true, resolution_status: 'PASS', unresolved_imports: matchingUnresolved }
        : { pass: true, resolution_status: 'PASS' };
    };

    const searchResult = await search(this.oramaDb, {
      term: combinedTerm,
      properties: [
        'name',
        'name_words',
        'literals',
        'origin_file',
        'file_words',
        'referenced_types',
        'calls'
      ],
      boost: {
        name: 8,
        name_words: 6,
        literals: 5,
        origin_file: 4,
        file_words: 3,
        referenced_types: 2,
        calls: 1
      }
    });

    if (!searchResult.hits || searchResult.hits.length === 0) {
      return buildPassResult();
    }

    const validHits = searchResult.hits.filter(hit =>
      doesDocumentMatchQuery(hit.document, rawQuery, this.projectRoot)
    );
    if (validHits.length === 0) {
      return buildPassResult();
    }

    const qLower = rawQuery.toLowerCase();
    const kindHint = expected_kind ? String(expected_kind).toLowerCase() : null;
    const bestHit =
      validHits.find(hit => hit.document.name.toLowerCase() === qLower && hit.document.kind !== 'file') ||
      (kindHint && validHits.find(hit => hit.document.kind === kindHint)) ||
      validHits.find(hit => hit.document.kind !== 'file') ||
      validHits[0];

    const target = this.graphState.nodesById.get(bestHit.document.cadastral_id);
    if (!target) {
      return buildPassResult();
    }

    return this._buildFoundResponse(target, t0, validHits);
  }

  _extractCodePreview(relFile, lineSpan, maxLines = 35) {
    try {
      const absPath = pathe.join(this.projectRoot, relFile);
      if (!fs.existsSync(absPath)) return undefined;
      const lines = fs.readFileSync(absPath, 'utf8').split(/\r?\n/);
      const startIdx = Math.max(0, (lineSpan?.start || 1) - 1);
      const endIdx = Math.min(lines.length, startIdx + maxLines, lineSpan?.end || lines.length);
      return lines
        .slice(startIdx, endIdx)
        .map((text, idx) => `${startIdx + idx + 1}: ${text}`)
        .join('\n');
    } catch (_) {
      return undefined;
    }
  }

  _buildFoundResponse(target, t0, hits = []) {
    const deps = extractCoordDependencies(this.graphState, target.cadastral_id);
    const coveredFiles = new Set(deps.coordinate_dispatcher.required_file_spans.map(s => s.file));
    const relatedCoords = [];

    for (const hit of hits) {
      if (relatedCoords.length >= 4) break;
      const node = this.graphState.nodesById.get(hit.document.cadastral_id);
      if (!node || node.cadastral_id === target.cadastral_id) continue;
      if (coveredFiles.has(node.origin_file)) continue;
      coveredFiles.add(node.origin_file);
      relatedCoords.push({
        cadastral_id: node.cadastral_id,
        name: node.name,
        kind: node.kind,
        file: node.origin_file,
        line_span: node.line_span
      });
    }

    const compactNode = n => ({
      name: n.name,
      file: n.file,
      span: `${n.line_span.start}-${n.line_span.end}`
    });

    const elapsedMs = Number((performance.now() - t0).toFixed(2));
    const codePreview = target.kind !== 'file' ? this._extractCodePreview(target.origin_file, target.line_span) : undefined;
    const fileSymbols =
      target.kind === 'file' && Array.isArray(target.children)
        ? target.children
            .map(cid => this.graphState.nodesById.get(cid))
            .filter(Boolean)
            .slice(0, 12)
            .map(s => ({
              cadastral_id: s.cadastral_id,
              name: s.name,
              kind: s.kind,
              span: `${s.line_span.start}-${s.line_span.end}`
            }))
        : undefined;

    const compactChain = [
      `${target.cadastral_id}:${target.origin_file}:${target.line_span.start}-${target.line_span.end}(${target.name})`,
      ...deps.coordinate_dispatcher.required_file_spans
        .filter(s => s.cadastral_id !== target.cadastral_id)
        .slice(0, 10)
        .map(s => `${s.cadastral_id}:${s.file}:${s.line_span.start}-${s.line_span.end}(${s.name})`),
      ...relatedCoords.map(r => `${r.cadastral_id}:${r.file}:${r.line_span.start}-${r.line_span.end}(${r.name})`)
    ].join(', ');

    const fileUnresolved = (this.graphState.unresolvedImports || []).filter(u =>
      u.startsWith(`${target.origin_file}:`)
    );

    return {
      pass: false,
      resolution_status: 'EXISTING_FOUND',
      cadastral_id: target.cadastral_id,
      kind: target.kind,
      name: target.name,
      language: target.language,
      origin_file: target.origin_file,
      absolute_file_path: pathe.join(this.projectRoot, target.origin_file),
      line_span: target.line_span,
      compact_chain: compactChain,
      ...(fileUnresolved.length > 0 ? { unresolved_imports: fileUnresolved } : {}),
      ...(codePreview ? { code_preview: codePreview } : {}),
      ...(fileSymbols && fileSymbols.length > 0 ? { file_symbols: fileSymbols } : {}),
      coordinate_dispatcher: {
        required_file_spans: deps.coordinate_dispatcher.required_file_spans.slice(0, 10).map(s => ({
          role: s.role,
          name: s.name,
          file: s.file,
          span: `${s.line_span.start}-${s.line_span.end}`
        }))
      },
      impact_graph: {
        incoming_callers: deps.impact_graph.incoming_callers.slice(0, 8).map(compactNode),
        imported_callees: deps.impact_graph.imported_callees.slice(0, 8).map(compactNode),
        outgoing_contracts: {
          shared_types: deps.impact_graph.outgoing_contracts.shared_types.slice(0, 8).map(compactNode)
        }
      },
      related_coordinates: relatedCoords.map(compactNode),
      resolution_time_ms: elapsedMs,
      user_status_line: formatStatusLine(target, deps, relatedCoords, elapsedMs)
    };
  }

  async getProjectMap() {
    await this.sync();
    const files = [];
    for (const fileNode of this.graphState.fileByRelPath.values()) {
      const symbols = (fileNode.children || [])
        .map(id => this.graphState.nodesById.get(id))
        .filter(Boolean)
        .map(s => `${s.cadastral_id}:${s.kind} ${s.name}(L${s.line_span.start}-${s.line_span.end})`);
      const header = `${fileNode.cadastral_id} | ${fileNode.origin_file}:L${fileNode.line_span.start}-${fileNode.line_span.end}`;
      files.push(symbols.length > 0 ? `${header} :: ${symbols.join(', ')}` : header);
    }
    const unresolved = this.graphState.unresolvedImports || [];
    return {
      project_root: this.projectRoot,
      total_files: files.length,
      total_coordinates: this.graphState.graph.order,
      total_edges: this.graphState.graph.size,
      ...(unresolved.length > 0 ? { unresolved_imports: unresolved } : {}),
      files
    };
  }
}
