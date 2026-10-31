import fs from 'node:fs';
import pathe from 'pathe';
import DirectedGraph from 'graphology';
import { bfsFromNode } from 'graphology-traversal';
import { ResolverFactory } from 'oxc-resolver';
import { availableLanguages } from '@lumis-sh/lumis';

function createModuleResolver(projectRoot) {
  const root = pathe.resolve(projectRoot);
  const extensions = [
    ...new Set(
      Object.values(availableLanguages())
        .flatMap(lang => lang.extensions || [])
        .filter(ext => ext.startsWith('*.'))
        .map(ext => ext.slice(1))
    )
  ];

  const options = { extensions };
  const tsconfigPath = pathe.join(root, 'tsconfig.json');
  if (fs.existsSync(tsconfigPath)) {
    options.tsconfig = { configFile: tsconfigPath, references: 'auto' };
  }
  return new ResolverFactory(options);
}

function stripExt(relPath) {
  const ext = pathe.extname(relPath);
  return ext ? relPath.slice(0, -ext.length) : relPath;
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

  // 2. Universal pathe suffix resolution across indexed workspace files (Go, Rust, Python, Java, C/C++)
  const slashSpec = rawSpecifier.replaceAll('::', '/');
  const normPath = slashSpec.includes('/') ? pathe.normalize(slashSpec) : pathe.normalize(slashSpec.replaceAll('.', '/'));
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

function isLocalOrAliasImport(spec) {
  if (!spec || typeof spec !== 'string') return false;
  return (
    spec.startsWith('./') ||
    spec.startsWith('../') ||
    spec.startsWith('@/') ||
    spec.startsWith('~/')
  );
}

function doesRawImportExistOnDisk(resolver, projectRoot, fromRelPath, rawSpecifier) {
  try {
    const root = pathe.resolve(projectRoot);
    const fromAbsPath = pathe.join(root, fromRelPath);
    const fromDir = pathe.dirname(fromAbsPath);
    const res1 = resolver.resolveFileSync(fromAbsPath, rawSpecifier);
    if (res1?.path && fs.existsSync(res1.path)) return true;
    const res2 = resolver.sync(fromDir, rawSpecifier);
    if (res2?.path && fs.existsSync(res2.path)) return true;
  } catch (_) {}
  return false;
}

/**
 * Builds a DirectedGraph (graphology) of all file and symbol coordinates,
 * resolving cross-file imports via oxc-resolver + pathe, and linking
 * Import-Scoped Calls, Types, and AST SQL Table References.
 */
export function buildCoordinateGraph(projectRoot, indexedFiles) {
  const root = pathe.resolve(projectRoot);
  const graph = new DirectedGraph({ multi: true });
  const resolver = createModuleResolver(root);

  const nodesById = new Map();
  const fileByRelPath = new Map();
  const symbolsByFile = new Map();
  const symbolsByName = new Map();
  const filesByDir = new Map();
  const filesByStemSuffix = new Map();
  const filesByDirSuffix = new Map();
  const unresolvedImports = [];
  const seenUnresolved = new Set();

  for (const entry of indexedFiles) {
    if (!entry?.fileNode) continue;
    const { fileNode, symbolNodes } = entry;
    fileByRelPath.set(fileNode.origin_file, fileNode);
    nodesById.set(fileNode.cadastral_id, fileNode);
    graph.addNode(fileNode.cadastral_id, fileNode);

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
      graph.addNode(sym.cadastral_id, sym);
      graph.addEdge(fileNode.cadastral_id, sym.cadastral_id, { relation: 'CONTAINS' });
      fileMap.set(sym.name, sym);

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

    for (const imp of fileNode.imports || []) {
      const targetRels = resolveImportTargetRelPaths(
        resolver,
        root,
        fileNode.origin_file,
        imp.from,
        fileByRelPath,
        filesByStemSuffix,
        filesByDirSuffix
      );
      if (
        targetRels.length === 0 &&
        isLocalOrAliasImport(imp.from) &&
        !doesRawImportExistOnDisk(resolver, root, fileNode.origin_file, imp.from)
      ) {
        const symPart = imp.symbols && imp.symbols.length > 0 ? ` (${imp.symbols.join(', ')})` : '';
        const entryStr = `${fileNode.origin_file}:${imp.line} -> ${imp.from}${symPart}`;
        if (!seenUnresolved.has(entryStr)) {
          seenUnresolved.add(entryStr);
          unresolvedImports.push(entryStr);
        }
      }
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

  return { graph, nodesById, fileByRelPath, symbolsByFile, filesByDir, unresolvedImports };
}

/**
 * Extracts the Coordinate Dispatcher dependency chain (incoming callers, imported callees, shared types).
 */
export function extractCoordDependencies(graphState, coordId) {
  const { graph, nodesById, fileByRelPath } = graphState;
  const target = nodesById.get(coordId);
  if (!target || !graph.hasNode(coordId)) return null;

  const callers = [];
  const callees = [];
  const sharedTypes = [];
  const dispatcherEdges = [];
  const requiredSpans = [];
  const seenSpans = new Set();
  const seenEdgeKeys = new Set();

  const addSpan = (file, line_span, cadastral_id, role, name) => {
    if (!file || !line_span) return;
    const key = `${file}:${line_span.start}-${line_span.end}`;
    if (seenSpans.has(key)) return;
    seenSpans.add(key);
    requiredSpans.push({ file, line_span, cadastral_id, role, name });
  };

  const addDispatcherEdge = (from, to, relation, dstNode) => {
    const key = `${from}->${to}:${relation}`;
    if (seenEdgeKeys.has(key)) return;
    seenEdgeKeys.add(key);
    dispatcherEdges.push({
      from,
      to,
      relation,
      target_file: dstNode.origin_file,
      target_line_span: dstNode.line_span
    });
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

  // 1. Incoming Callers (up to 2 hops upstream)
  for (const id of startIds) {
    if (!graph.hasNode(id)) continue;
    bfsFromNode(
      graph,
      id,
      (visitedId, attr, depth) => {
        if (depth === 0 || depth > 2) return depth > 2;
        const src = nodesById.get(visitedId);
        if (!src || src.kind === 'file' || src.origin_file === target.origin_file) return;

        graph.forEachOutEdge(visitedId, (edge, edgeAttr, fromId, toId) => {
          if (edgeAttr.relation !== 'CALLS_COORD' && edgeAttr.relation !== 'USES_TYPE') {
            return;
          }
          if (!callers.some(c => c.cadastral_id === src.cadastral_id)) {
            callers.push({
              cadastral_id: src.cadastral_id,
              name: src.name,
              kind: src.kind,
              file: src.origin_file,
              line_span: src.line_span
            });
            addDispatcherEdge(src.cadastral_id, toId, edgeAttr.relation, src);
            addSpan(src.origin_file, src.line_span, src.cadastral_id, 'caller', src.name);
          }
        });
      },
      { mode: 'inbound' }
    );
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

  // 2. Outbound Dependency Chain (up to 3 hops)
  for (const startId of startIds) {
    if (!graph.hasNode(startId)) continue;
    const spineReached = new Set([startId]);

    bfsFromNode(
      graph,
      startId,
      (visitedId, attr, depth) => {
        if (depth === 0 || depth > 3) return depth > 3;
        const dst = nodesById.get(visitedId);
        if (!dst || dst.kind === 'file') return;

        graph.forEachInEdge(visitedId, (edge, edgeAttr, fromId) => {
          if (!spineReached.has(fromId)) return;
          const rel = edgeAttr.relation;
          if (rel !== 'CALLS_COORD' && rel !== 'USES_TYPE') {
            return;
          }
          if (rel === 'USES_TYPE' || dst.kind === 'type') {
            if (!sharedTypes.some(t => t.cadastral_id === dst.cadastral_id)) {
              sharedTypes.push({
                cadastral_id: dst.cadastral_id,
                name: dst.name,
                kind: dst.kind,
                file: dst.origin_file,
                line_span: dst.line_span
              });
              addDispatcherEdge(fromId, dst.cadastral_id, 'USES_TYPE', dst);
              addSpan(dst.origin_file, dst.line_span, dst.cadastral_id, 'type', dst.name);
            }
          } else {
            spineReached.add(visitedId);
            if (!callees.some(c => c.cadastral_id === dst.cadastral_id)) {
              callees.push({
                cadastral_id: dst.cadastral_id,
                name: dst.name,
                kind: dst.kind,
                file: dst.origin_file,
                line_span: dst.line_span
              });
              addDispatcherEdge(fromId, dst.cadastral_id, rel, dst);
              addSpan(dst.origin_file, dst.line_span, dst.cadastral_id, 'callee', dst.name);
            }
          }
        });
      },
      { mode: 'outbound' }
    );
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
      primary_coordinate: {
        cadastral_id: target.cadastral_id,
        file: target.origin_file,
        line_span: target.line_span,
        merkle_hash: target.merkle_hash
      },
      edges: dispatcherEdges,
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
