import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pathe from 'pathe';
import { create, insertMultiple, search } from '@orama/orama';
import { walkWorkspaceFiles } from './workspace_walker.js';
import { initCstRuntime, indexFileCst, createCadastralId } from './cst_indexer.js';
import { buildCoordinateGraph, extractCoordDependencies } from './coord_graph.js';

const ENGINE_ROOT = pathe.resolve(pathe.dirname(fileURLToPath(import.meta.url)), '..');
export const CENTRAL_COORD_ROOT = pathe.join(ENGINE_ROOT, '.coordinate');

function sanitizeProjectSlug(name) {
  const s = String(name || 'project');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const isSafe =
      (ch >= 'a' && ch <= 'z') ||
      (ch >= 'A' && ch <= 'Z') ||
      (ch >= '0' && ch <= '9') ||
      ch === '_' ||
      ch === '-';
    out += isSafe ? ch : '_';
  }
  return out || 'project';
}

export async function resolveProjectStorageDir(projectRoot) {
  await initCstRuntime();
  const canonicalRoot = pathe.normalize(pathe.resolve(projectRoot || process.cwd()));
  const hashHex = createCadastralId(canonicalRoot).slice(4);
  const slug = sanitizeProjectSlug(pathe.basename(canonicalRoot));
  return pathe.join(CENTRAL_COORD_ROOT, 'projects', `${slug}_${hashHex}`);
}

function splitIdentifierWords(text) {
  const s = String(text || '');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '_' || ch === '-' || ch === '.' || ch === '/' || ch === ':' || ch === '\\') {
      out += ' ';
      continue;
    }
    const isUpper = ch !== ch.toLowerCase() && ch === ch.toUpperCase();
    if (i > 0 && isUpper) {
      const prev = s[i - 1];
      const prevIsLowerOrDigit =
        (prev !== prev.toUpperCase() && prev === prev.toLowerCase()) ||
        (prev >= '0' && prev <= '9');
      if (prevIsLowerOrDigit) out += ' ';
    }
    out += ch;
  }
  return out.trim();
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
    this.projectRoot = pathe.normalize(pathe.resolve(projectRoot || process.cwd()));
    this.storageDir = null;
    this.cacheFilePath = null;
    this.cacheDiskMtimeMs = 0;
    this.indexedFileMap = new Map();
    this.graphState = null;
    this.oramaDb = null;
  }

  _loadDiskAstCache() {
    try {
      if (!this.cacheFilePath || !fs.existsSync(this.cacheFilePath)) return;
      const stat = fs.statSync(this.cacheFilePath);
      const raw = JSON.parse(fs.readFileSync(this.cacheFilePath, 'utf8'));
      if (raw?.version !== '0.1.0-alpha' || raw?.project_root !== this.projectRoot) return;
      const entries = raw?.entries || {};
      this.indexedFileMap.clear();
      for (const [relPath, item] of Object.entries(entries)) {
        if (item?.statKey && item?.parsed?.fileNode) {
          this.indexedFileMap.set(relPath, { statKey: item.statKey, parsed: item.parsed });
        }
      }
      this.cacheDiskMtimeMs = stat.mtimeMs;
    } catch (_) {}
  }

  _saveDiskAstCache() {
    try {
      if (!this.cacheFilePath) return;
      fs.mkdirSync(CENTRAL_COORD_ROOT, { recursive: true });
      const rootGitignore = pathe.join(CENTRAL_COORD_ROOT, '.gitignore');
      if (!fs.existsSync(rootGitignore)) {
        fs.writeFileSync(rootGitignore, '*\n', 'utf8');
      }
      const coordDir = pathe.dirname(this.cacheFilePath);
      fs.mkdirSync(coordDir, { recursive: true });
      const entries = {};
      for (const [relPath, item] of this.indexedFileMap.entries()) {
        entries[relPath] = item;
      }
      fs.writeFileSync(
        this.cacheFilePath,
        JSON.stringify({ version: '0.1.0-alpha', project_root: this.projectRoot, entries }),
        'utf8'
      );
      this.cacheDiskMtimeMs = fs.statSync(this.cacheFilePath).mtimeMs;
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
        referenced_types: 'string',
        combined_tokens: 'string'
      }
    });

    const docs = [];
    for (const node of this.graphState.nodesById.values()) {
      const parsedOrigin = pathe.parse(node.origin_file || '');
      const originWithoutExt = pathe.join(parsedOrigin.dir, parsedOrigin.name);
      const nameWords = splitIdentifierWords(node.name);
      const fileWords = splitIdentifierWords(originWithoutExt);
      const literalsStr = (node.literals || []).join(' ');
      const callsStr = (node.calls || []).join(' ');
      const refTypesStr = (node.referenced_types || []).join(' ');
      docs.push({
        cadastral_id: node.cadastral_id,
        name: node.name || '',
        name_words: nameWords,
        kind: node.kind || '',
        origin_file: node.origin_file || '',
        file_words: fileWords,
        language: node.language || '',
        literals: literalsStr,
        calls: callsStr,
        referenced_types: refTypesStr,
        combined_tokens: [nameWords, fileWords, literalsStr, callsStr, refTypesStr]
          .filter(Boolean)
          .join(' ')
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
    if (!this.cacheFilePath) {
      this.storageDir = await resolveProjectStorageDir(this.projectRoot);
      this.cacheFilePath = pathe.join(this.storageDir, 'ast_cache.json');
    }
    let changed = false;
    try {
      if (fs.existsSync(this.cacheFilePath)) {
        const diskMtime = fs.statSync(this.cacheFilePath).mtimeMs;
        if (diskMtime > this.cacheDiskMtimeMs) {
          this._loadDiskAstCache();
          changed = true;
        }
      }
    } catch (_) {}

    const files = await walkWorkspaceFiles(this.projectRoot);
    const seenRelPaths = new Set();

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
    this.storageDir = await resolveProjectStorageDir(this.projectRoot);
    this.cacheFilePath = pathe.join(this.storageDir, 'ast_cache.json');
    this._loadDiskAstCache();
    await this.sync();
    return this;
  }

  async resolve(params = {}) {
    await this.sync();
    const t0 = performance.now();

    const { file, line, query, semantic_tokens, expected_kind } = params;

    if (file) {
      const cleanRel = pathe.relative(this.projectRoot, pathe.resolve(this.projectRoot, file));
      let fileNode = this.graphState.fileByRelPath.get(cleanRel);
      if (!fileNode) {
        for (const [indexedRel, candidateNode] of this.graphState.fileByRelPath.entries()) {
          if (indexedRel === cleanRel || indexedRel.endsWith(`/${cleanRel}`)) {
            fileNode = candidateNode;
            break;
          }
        }
      }
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
    if (!rawQuery) {
      return { pass: true, resolution_status: 'PASS' };
    }

    const oramaProps = [
      'name',
      'name_words',
      'literals',
      'origin_file',
      'file_words',
      'referenced_types',
      'calls',
      'combined_tokens'
    ];
    const oramaBoost = {
      name: 8,
      name_words: 6,
      literals: 5,
      origin_file: 4,
      file_words: 3,
      referenced_types: 2,
      combined_tokens: 2,
      calls: 1
    };

    let searchResult = await search(this.oramaDb, {
      term: rawQuery,
      properties: oramaProps,
      boost: oramaBoost,
      threshold: 0,
      limit: 200
    });

    if (!searchResult.hits || searchResult.hits.length === 0) {
      const splitQuery = splitIdentifierWords(rawQuery);
      if (splitQuery && splitQuery !== rawQuery) {
        searchResult = await search(this.oramaDb, {
          term: splitQuery,
          properties: oramaProps,
          boost: oramaBoost,
          threshold: 0,
          limit: 200
        });
      }
    }

    const hitsById = new Map();
    for (const hit of searchResult.hits || []) {
      hitsById.set(hit.document.cadastral_id, { ...hit });
    }

    const semTerm = Array.isArray(semantic_tokens)
      ? semantic_tokens.filter(Boolean).join(' ').trim()
      : '';
    if (semTerm) {
      const semResult = await search(this.oramaDb, {
        term: semTerm,
        properties: oramaProps,
        boost: oramaBoost,
        threshold: hitsById.size === 0 ? 0 : 1,
        limit: 200
      });
      const hadPrimaryHits = hitsById.size > 0;
      for (const h of semResult.hits || []) {
        const cid = h.document.cadastral_id;
        const existing = hitsById.get(cid);
        if (existing) {
          existing.score += h.score * 0.35;
        } else {
          hitsById.set(cid, { ...h, score: hadPrimaryHits ? h.score * 0.15 : h.score });
        }
      }
    }

    const validHits = [...hitsById.values()];
    if (validHits.length === 0) {
      return { pass: true, resolution_status: 'PASS' };
    }

    const qLower = rawQuery.toLowerCase();
    const kindHint = expected_kind ? String(expected_kind).toLowerCase() : null;
    const rankHit = hit => {
      const doc = hit.document;
      const id = doc.cadastral_id;
      const degree = this.graphState.graph.hasNode(id) ? this.graphState.graph.degree(id) : 0;
      return (
        hit.score +
        (doc.name.toLowerCase() === qLower ? 150 : 0) +
        (kindHint && doc.kind === kindHint ? 20 : 0) +
        (doc.kind !== 'file' ? 5 : 0) +
        Math.min(degree, 10) * 0.5
      );
    };
    validHits.sort((a, b) => rankHit(b) - rankHit(a));

    const bestHit = validHits[0];
    const target = this.graphState.nodesById.get(bestHit.document.cadastral_id);
    if (!target) {
      return { pass: true, resolution_status: 'PASS' };
    }

    return this._buildFoundResponse(target, t0, validHits);
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
    const t0 = performance.now();
    await this.sync();
    const totalFiles = this.graphState.fileByRelPath.size;
    const totalCoords = this.graphState.graph.order;
    const totalEdges = this.graphState.graph.size;

    const langCounts = {};
    const layerBuckets = new Map();

    for (const fileNode of this.graphState.fileByRelPath.values()) {
      const lang = fileNode.language || 'unknown';
      langCounts[lang] = (langCounts[lang] || 0) + 1;

      const parts = String(fileNode.origin_file || '').split('/');
      const layerKey =
        parts.length >= 3
          ? `${parts[0]}/${parts[1]}`
          : parts.length === 2
            ? parts[0]
            : '.';
      if (!layerBuckets.has(layerKey)) {
        layerBuckets.set(layerKey, { files: 0, coords: 0, entries: [] });
      }
      const bucket = layerBuckets.get(layerKey);
      const childCount = fileNode.children ? fileNode.children.length : 0;
      const degree = this.graphState.graph.hasNode(fileNode.cadastral_id)
        ? this.graphState.graph.degree(fileNode.cadastral_id)
        : 0;
      const relToLayer =
        layerKey === '.'
          ? fileNode.origin_file
          : String(fileNode.origin_file || '').slice(layerKey.length + 1) ||
            pathe.basename(fileNode.origin_file);
      bucket.files += 1;
      bucket.coords += 1 + childCount;
      bucket.entries.push({ name: relToLayer, weight: degree * 2 + childCount });
    }

    const languages = Object.fromEntries(
      Object.entries(langCounts).sort((a, b) => b[1] - a[1])
    );

    const architecturalLayers = [...layerBuckets.entries()]
      .sort((a, b) => b[1].coords - a[1].coords)
      .slice(0, 10)
      .map(([dir, info]) => {
        const topFiles = info.entries
          .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))
          .slice(0, 15)
          .map(e => e.name);
        return `${dir} (${info.files} files, ${info.coords} coords) :: ${topFiles.join(', ')}`;
      });

    const rankedNodes = [];
    for (const node of this.graphState.nodesById.values()) {
      const degree = this.graphState.graph.hasNode(node.cadastral_id)
        ? this.graphState.graph.degree(node.cadastral_id)
        : 0;
      const childBonus = node.kind === 'file' && Array.isArray(node.children) ? node.children.length : 0;
      const score = degree * 2 + childBonus;
      if (score > 0 || totalCoords <= 15) {
        rankedNodes.push({ node, degree, score });
      }
    }
    rankedNodes.sort((a, b) => b.score - a.score);

    const seenHubFileCounts = new Map();
    const hubNodes = [];
    for (const item of rankedNodes) {
      if (hubNodes.length >= 12) break;
      const fileCount = seenHubFileCounts.get(item.node.origin_file) || 0;
      if (fileCount >= 2 && rankedNodes.length > 12) continue;
      seenHubFileCounts.set(item.node.origin_file, fileCount + 1);
      hubNodes.push(item);
    }

    const architecturalHubs = hubNodes.map(({ node, degree }) => {
      if (node.kind === 'file') {
        const topSyms = (node.children || [])
          .slice(0, 5)
          .map(id => this.graphState.nodesById.get(id)?.name)
          .filter(Boolean)
          .join(', ');
        return `${node.cadastral_id} | ${node.origin_file}:L${node.line_span.start}-${node.line_span.end} (file, ${degree} graph links)${topSyms ? ` :: ${topSyms}` : ''}`;
      }
      return `${node.cadastral_id} | ${node.origin_file}:L${node.line_span.start}-${node.line_span.end} (${node.kind} ${node.name}, ${degree} graph links)`;
    });

    const topHubsSummary = hubNodes
      .slice(0, 4)
      .map(({ node }) => `${node.name} (${node.origin_file}:${node.line_span.start}-${node.line_span.end})`)
      .join(', ');

    const elapsedMs = Number((performance.now() - t0).toFixed(2));
    const userStatusLine =
      `[hey-yu] Mapped workspace "${pathe.basename(this.projectRoot)}" -> ${totalFiles} files, ${totalCoords} coordinates, ${totalEdges} graph edges in ${elapsedMs.toFixed(1)}ms` +
      (topHubsSummary ? ` | Top Hubs: [${topHubsSummary}]` : '');

    return {
      resolution_status: 'MAP',
      project_root: this.projectRoot,
      total_files: totalFiles,
      total_coordinates: totalCoords,
      total_edges: totalEdges,
      languages,
      architectural_layers: architecturalLayers,
      architectural_hubs: architecturalHubs,
      resolution_time_ms: elapsedMs,
      user_status_line: userStatusLine,
      next_step_hint:
        'Call hey_yu({ query: "<symbol, route, table, or file>", project_root: "<project_root>" }) to dispatch exact coordinates, line_span, coordinate_dispatcher.required_file_spans, and impact_graph.'
    };
  }
}
