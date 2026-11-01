import fs from 'node:fs';
import pathe from 'pathe';
import DirectedGraph from 'graphology';
import { ResolverFactory } from 'oxc-resolver';
import { availableLanguages } from '@lumis-sh/lumis';

const KNOWN_EXTENSIONS = [
  ...new Set(
    Object.values(availableLanguages())
      .flatMap(lang => lang.extensions || [])
      .filter(ext => ext.startsWith('*.'))
      .map(ext => ext.slice(1).toLowerCase())
  )
];
const KNOWN_EXTENSION_SET = new Set(KNOWN_EXTENSIONS);

function createModuleResolverPool(projectRoot) {
  const root = pathe.resolve(projectRoot);
  const cache = new Map();

  function getResolverForConfig(tsconfigPath) {
    const key = tsconfigPath || '__default__';
    if (!cache.has(key)) {
      const options = { extensions: KNOWN_EXTENSIONS };
      if (tsconfigPath && fs.existsSync(tsconfigPath)) {
        options.tsconfig = { configFile: tsconfigPath, references: 'auto' };
      }
      cache.set(key, new ResolverFactory(options));
    }
    return cache.get(key);
  }

  return function getResolverForFile(fromRelPath) {
    let curr = pathe.dirname(pathe.join(root, fromRelPath || ''));
    while (curr && (curr === root || curr.startsWith(`${root}/`))) {
      const candidateTs = pathe.join(curr, 'tsconfig.json');
      if (fs.existsSync(candidateTs)) {
        return getResolverForConfig(candidateTs);
      }
      const parent = pathe.dirname(curr);
      if (parent === curr) break;
      curr = parent;
    }
    const rootTs = pathe.join(root, 'tsconfig.json');
    return getResolverForConfig(fs.existsSync(rootTs) ? rootTs : null);
  };
}

function stripExt(relPath) {
  const ext = pathe.extname(relPath);
  return ext && KNOWN_EXTENSION_SET.has(ext.toLowerCase())
    ? relPath.slice(0, -ext.length)
    : relPath;
}

function resolveImportTargetRelPaths(
  resolver,
  projectRoot,
  fromRelPath,
  rawSpecifier,
  fileByRelPath,
  filesByStemSuffix,
  filesByDirSuffix
) {
  if (!rawSpecifier) return [];
  const root = pathe.resolve(projectRoot);
  const fromAbsPath = pathe.join(root, fromRelPath);
  const fromDir = pathe.dirname(fromAbsPath);

  // 1. Primary resolution via oxc-resolver
  try {
    const res = resolver.resolveFileSync(fromAbsPath, rawSpecifier);
    if (res?.path) {
      const rel = pathe.relative(root, res.path);
      if (fileByRelPath.has(rel)) return [rel];
    }
  } catch (_) {}

  try {
    const resRoot = resolver.sync(fromDir, rawSpecifier);
    if (resRoot?.path) {
      const rel = pathe.relative(root, resRoot.path);
      if (fileByRelPath.has(rel)) return [rel];
    }
  } catch (_) {}

  // 2. Universal pathe stem & suffix resolution across all indexed languages
  const withoutScheme =
    rawSpecifier.includes(':') && !rawSpecifier.includes('::')
      ? rawSpecifier.slice(rawSpecifier.indexOf(':') + 1)
      : rawSpecifier;
  const cleanSpec = stripExt(withoutScheme);
  if (cleanSpec.startsWith('.')) {
    const relStem = pathe.join(pathe.dirname(fromRelPath), cleanSpec);
    const relMatches = (filesByStemSuffix.get(relStem) || []).filter(f => f !== fromRelPath);
    if (relMatches.length > 0) return relMatches;
  }

  const slashSpec = pathe.normalize(cleanSpec.replaceAll('::', '/'));
  const normPath = slashSpec.includes('/') ? slashSpec : pathe.normalize(slashSpec.replaceAll('.', '/'));
  const segments = normPath.split('/').filter(s => s && s !== '.' && s !== '..');
  if (segments.length === 0) return [];

  for (let start = 0; start < segments.length; start++) {
    const candidate = segments.slice(start).join('/');
    const stemMatches = (filesByStemSuffix.get(candidate) || []).filter(f => f !== fromRelPath);
    if (stemMatches.length > 0) return stemMatches;

    const dirMatches = (filesByDirSuffix.get(candidate) || []).filter(f => f !== fromRelPath);
    if (dirMatches.length > 0) return dirMatches;

    if (segments.length - start >= 2) {
      const candidateParent = segments.slice(start, -1).join('/');
      const parentStemMatches = (filesByStemSuffix.get(candidateParent) || []).filter(f => f !== fromRelPath);
      if (parentStemMatches.length > 0) return parentStemMatches;
    }
  }

  return [];
}

/**
 * Builds a DirectedGraph (graphology) of all file and symbol coordinates,
 * resolving cross-file imports via oxc-resolver + pathe, and linking
 * Import-Scoped Calls, Types, and AST SQL Table References.
 */
export function buildCoordinateGraph(projectRoot, indexedFiles) {
  const root = pathe.resolve(projectRoot);
  const graph = new DirectedGraph({ multi: true });
  const getResolverForFile = createModuleResolverPool(root);

  const nodesById = new Map();
  const fileByRelPath = new Map();
  const symbolsByFile = new Map();
  const symbolsByName = new Map();
  const filesByDir = new Map();
  const filesByStemSuffix = new Map();
  const filesByDirSuffix = new Map();

  for (const entry of indexedFiles) {
    if (!entry?.fileNode) continue;
    const { fileNode, symbolNodes } = entry;
    fileByRelPath.set(fileNode.origin_file, fileNode);
    nodesById.set(fileNode.cadastral_id, fileNode);
    graph.mergeNode(fileNode.cadastral_id, fileNode);

    const dir = pathe.dirname(fileNode.origin_file);
    if (!filesByDir.has(dir)) filesByDir.set(dir, []);
    filesByDir.get(dir).push(fileNode.origin_file);

    if (dir && dir !== '.') {
      const dirParts = dir.split('/').filter(Boolean);
      for (let i = 0; i < dirParts.length; i++) {
        const dSuffix = dirParts.slice(i).join('/');
        if (!filesByDirSuffix.has(dSuffix)) filesByDirSuffix.set(dSuffix, []);
        filesByDirSuffix.get(dSuffix).push(fileNode.origin_file);
      }
    }

    const stem = stripExt(fileNode.origin_file);
    const parts = stem.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join('/');
      if (!filesByStemSuffix.has(suffix)) filesByStemSuffix.set(suffix, []);
      filesByStemSuffix.get(suffix).push(fileNode.origin_file);
    }

    const fileMap = new Map();
    for (const sym of symbolNodes) {
      nodesById.set(sym.cadastral_id, sym);
      graph.mergeNode(sym.cadastral_id, sym);
      graph.mergeEdge(fileNode.cadastral_id, sym.cadastral_id, { relation: 'CONTAINS' });
      const prevSym = fileMap.get(sym.name);
      if (!prevSym || sym.kind === 'type') {
        fileMap.set(sym.name, sym);
      }

      if (!symbolsByName.has(sym.name)) symbolsByName.set(sym.name, []);
      symbolsByName.get(sym.name).push(sym);
    }
    symbolsByFile.set(fileNode.origin_file, fileMap);
  }

  for (const entry of indexedFiles) {
    if (!entry?.fileNode) continue;
    const { fileNode, symbolNodes } = entry;
    const localSymbols = symbolsByFile.get(fileNode.origin_file) || new Map();
    const importedTargetFiles = new Set();
    const sameDirFiles = filesByDir.get(pathe.dirname(fileNode.origin_file)) || [];

    const fileResolver = getResolverForFile(fileNode.origin_file);
    for (const imp of fileNode.imports || []) {
      const targetRels = resolveImportTargetRelPaths(
        fileResolver,
        root,
        fileNode.origin_file,
        imp.from,
        fileByRelPath,
        filesByStemSuffix,
        filesByDirSuffix
      );
      for (const targetRel of targetRels) {
        const targetFileNode = fileByRelPath.get(targetRel);
        if (!targetFileNode) continue;

        importedTargetFiles.add(targetRel);
        graph.addEdge(fileNode.cadastral_id, targetFileNode.cadastral_id, {
          relation: 'IMPORTS_FILE',
          line: imp.line,
          end_line: imp.end_line,
          symbols: imp.symbols
        });
      }
    }

    const linkSymbolReference = (sym, refName, relation) => {
      let linked = false;
      // 1. Explicitly imported files (highest precision)
      for (const targetRel of importedTargetFiles) {
        const targetSym = symbolsByFile.get(targetRel)?.get(refName);
        if (targetSym && targetSym.cadastral_id !== sym.cadastral_id) {
          graph.addEdge(sym.cadastral_id, targetSym.cadastral_id, { relation });
          linked = true;
        }
      }
      if (linked) return;

      // 2. Same file symbol
      const sameFileSym = localSymbols.get(refName);
      if (sameFileSym && sameFileSym.cadastral_id !== sym.cadastral_id) {
        graph.addEdge(sym.cadastral_id, sameFileSym.cadastral_id, { relation });
        return;
      }

      // 3. Same directory / package scope (Go, Java, C#, C/C++)
      for (const peerRel of sameDirFiles) {
        if (peerRel === fileNode.origin_file) continue;
        const peerSym = symbolsByFile.get(peerRel)?.get(refName);
        if (peerSym && peerSym.cadastral_id !== sym.cadastral_id) {
          graph.addEdge(sym.cadastral_id, peerSym.cadastral_id, { relation });
          linked = true;
        }
      }
      if (linked) return;

      // 4. Unique project-wide symbol (zero homonym collision risk)
      const globalMatches = symbolsByName.get(refName);
      if (globalMatches?.length === 1 && globalMatches[0].cadastral_id !== sym.cadastral_id) {
        graph.addEdge(sym.cadastral_id, globalMatches[0].cadastral_id, { relation });
      }
    };

    for (const sym of symbolNodes) {
      for (const callName of sym.calls || []) {
        linkSymbolReference(sym, callName, 'CALLS_COORD');
      }
      for (const typeName of sym.referenced_types || []) {
        linkSymbolReference(sym, typeName, 'USES_TYPE');
      }
    }
  }

  return { graph, nodesById, fileByRelPath };
}

/**
 * Extracts direct 1-hop Coordinate Dispatcher hints (incoming callers, imported callees, shared types).
 */
export function extractCoordDependencies(graphState, coordId) {
  const { graph, nodesById, fileByRelPath } = graphState;
  const target = nodesById.get(coordId);
  if (!target || !graph.hasNode(coordId)) return null;

  const callers = [];
  const callees = [];
  const sharedTypes = [];
  const requiredSpans = [];
  const seenSpans = new Set();

  const addSpan = (file, line_span, cadastral_id, role, name) => {
    if (!file || !line_span) return;
    const key = `${file}:${line_span.start}-${line_span.end}`;
    if (seenSpans.has(key)) return;
    seenSpans.add(key);
    requiredSpans.push({ file, line_span, cadastral_id, role, name });
  };

  addSpan(target.origin_file, target.line_span, target.cadastral_id, 'target', target.name);

  const ownerFile = fileByRelPath.get(target.origin_file);
  if (ownerFile?.imports_line_span && target.kind !== 'file') {
    addSpan(ownerFile.origin_file, ownerFile.imports_line_span, ownerFile.cadastral_id, 'target_imports', ownerFile.name);
  }

  const startIds = [coordId];
  if (target.kind === 'file' && Array.isArray(target.children)) {
    startIds.push(...target.children);
  }

  // 1. Direct Incoming Callers (1-hop)
  for (const id of startIds) {
    if (!graph.hasNode(id)) continue;
    graph.forEachInEdge(id, (edge, edgeAttr, sourceId) => {
      if (edgeAttr.relation !== 'CALLS_COORD' && edgeAttr.relation !== 'USES_TYPE') return;
      const src = nodesById.get(sourceId);
      if (!src || src.kind === 'file' || src.cadastral_id === target.cadastral_id) return;
      if (!callers.some(c => c.cadastral_id === src.cadastral_id)) {
        callers.push({
          cadastral_id: src.cadastral_id,
          name: src.name,
          kind: src.kind,
          file: src.origin_file,
          line_span: src.line_span
        });
        addSpan(src.origin_file, src.line_span, src.cadastral_id, 'caller', src.name);
      }
    });
  }

  if (ownerFile && target.kind !== 'file' && graph.hasNode(ownerFile.cadastral_id)) {
    graph.forEachInEdge(ownerFile.cadastral_id, (edge, attr, sourceFileId) => {
      if (attr.relation !== 'IMPORTS_FILE') return;
      const srcFile = nodesById.get(sourceFileId);
      if (!srcFile || callers.some(c => c.file === srcFile.origin_file)) return;
      const span = attr.line ? { start: attr.line, end: attr.end_line || attr.line } : srcFile.line_span;
      callers.push({
        cadastral_id: srcFile.cadastral_id,
        name: srcFile.name,
        kind: srcFile.kind,
        file: srcFile.origin_file,
        line_span: span
      });
      addSpan(srcFile.origin_file, span, srcFile.cadastral_id, 'caller', srcFile.name);
    });
  }

  // 2. Direct Outbound Callees & Shared Types (1-hop)
  for (const startId of startIds) {
    if (!graph.hasNode(startId)) continue;
    graph.forEachOutEdge(startId, (edge, edgeAttr, fromId, targetId) => {
      const rel = edgeAttr.relation;
      if (rel !== 'CALLS_COORD' && rel !== 'USES_TYPE') return;
      const dst = nodesById.get(targetId);
      if (!dst || dst.kind === 'file' || dst.cadastral_id === target.cadastral_id) return;
      if (rel === 'USES_TYPE' || dst.kind === 'type') {
        if (!sharedTypes.some(t => t.cadastral_id === dst.cadastral_id)) {
          sharedTypes.push({
            cadastral_id: dst.cadastral_id,
            name: dst.name,
            kind: dst.kind,
            file: dst.origin_file,
            line_span: dst.line_span
          });
          addSpan(dst.origin_file, dst.line_span, dst.cadastral_id, 'type', dst.name);
        }
      } else if (!callees.some(c => c.cadastral_id === dst.cadastral_id)) {
        callees.push({
          cadastral_id: dst.cadastral_id,
          name: dst.name,
          kind: dst.kind,
          file: dst.origin_file,
          line_span: dst.line_span
        });
        addSpan(dst.origin_file, dst.line_span, dst.cadastral_id, 'callee', dst.name);
      }
    });
  }

  const uniqueFilesCount = new Set(requiredSpans.map(s => s.file)).size;

  return {
    impact_graph: {
      incoming_callers: callers,
      imported_callees: callees,
      outgoing_contracts: {
        shared_types: sharedTypes
      }
    },
    coordinate_dispatcher: {
      required_file_spans: requiredSpans
    },
    dependency_summary: {
      callers_count: callers.length,
      imported_callees_count: callees.length,
      shared_types_count: sharedTypes.length,
      connected_file_spans_count: requiredSpans.length,
      reading_plan_files_count: uniqueFilesCount
    }
  };
}
