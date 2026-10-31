import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pathe from 'pathe';
import { Parser, Language, Query } from 'web-tree-sitter';
import wasmBundle from '@lumis-sh/wasm-bundle-full';
import xxhash from 'xxhash-wasm';

let parserReady = false;
let xxHasher = null;
const languageCache = new Map();
const queryCache = new Map();

export async function initCstRuntime() {
  if (!parserReady) {
    await Parser.init();
    parserReady = true;
  }
  if (!xxHasher) {
    xxHasher = await xxhash();
  }
  return { xxHasher };
}

export function createCadastralId(seed) {
  return `crd_${xxHasher.h32ToString(String(seed))}`;
}

export function computeMerkleHash(node) {
  const childHashes = [];
  for (const child of node.namedChildren) {
    childHashes.push(computeMerkleHash(child));
  }
  return xxHasher.h32ToString(`${node.type}(${childHashes.join(',')})`);
}

async function loadGrammarAndQueries(langId, wasmUrl, languagePackage) {
  if (languageCache.has(langId)) {
    return { lang: languageCache.get(langId), queries: queryCache.get(langId) };
  }
  let resolvedUrl = wasmUrl;
  let resolvedPkg = languagePackage;
  if (!resolvedUrl && typeof wasmBundle[langId] === 'function') {
    const mod = await wasmBundle[langId]();
    resolvedUrl = mod.wasm;
    resolvedPkg = mod.languagePackage;
  }
  if (!resolvedUrl) return { lang: null, queries: null };

  const wasmPath = resolvedUrl instanceof URL ? fileURLToPath(resolvedUrl) : String(resolvedUrl);
  const lang = await Language.load(wasmPath);
  const languages = resolvedPkg?.languages || {};
  const langDef = languages[langId] || Object.values(languages)[0] || {};

  let hlQuery = null;
  let injQuery = null;
  try {
    if (langDef.highlights) hlQuery = new Query(lang, langDef.highlights);
  } catch (_) {}
  try {
    if (langDef.injections) injQuery = new Query(lang, langDef.injections);
  } catch (_) {}

  const queries = { hlQuery, injQuery };
  languageCache.set(langId, lang);
  queryCache.set(langId, queries);
  return { lang, queries };
}

function unquoteLiteral(raw) {
  const t = (raw || '').trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'" || t[0] === '`') && t[t.length - 1] === t[0]) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Pure Tree-sitter CST structural declaration resolver:
 * 1. Verifies that `idNode` is the `name` or `declarator` field of its parent CST node.
 * 2. Climbs enclosing declarator/reference wrappers (e.g. C++ function_declarator, Go type_spec,
 *    SQL object_reference -> create_table, JS export_statement -> lexical_declaration).
 * 3. Confirms the outer node is a structural declaration/definition with a body, value, or declaration grammar rule.
 */
function findEnclosingDeclarationNode(idNode, rootNode) {
  let curr = idNode.parent;
  if (!curr || curr.id === rootNode.id) return null;
  if (curr.type.includes('import') || curr.type.includes('include') || curr.type.includes('specifier')) {
    return null;
  }

  // Handle qualified function declarations (e.g. Lua `function M.foo()` where idNode is inside dot_index_expression)
  if (
    (curr.type.includes('index_expression') || curr.type.includes('field_expression')) &&
    curr.parent &&
    (curr.parent.childForFieldName('name')?.id === curr.id ||
      curr.parent.childForFieldName('declarator')?.id === curr.id)
  ) {
    curr = curr.parent;
  } else {
    const nameOrDecl = curr.childForFieldName('name') || curr.childForFieldName('declarator');
    if (nameOrDecl) {
      if (nameOrDecl.id !== idNode.id) return null;
    } else {
      const isDirectDeclParent =
        curr.type.includes('declaration') ||
        curr.type.includes('definition') ||
        curr.type.includes('signature') ||
        curr.type === 'object_reference' ||
        curr.type.startsWith('create_');
      if (!isDirectDeclParent) return null;
      // Ensure idNode is the primary identifier of this declaration (not a return type after parameters)
      const firstIdChild = curr.namedChildren.find(
        c => c.type.includes('identifier') || c.type === 'name'
      );
      if (firstIdChild && firstIdChild.id !== idNode.id) return null;
    }
  }

  // 1. Climb inner declarator / signature / object_reference / spec wrappers to the declaration node
  while (curr.parent && curr.parent.id !== rootNode.id) {
    const p = curr.parent;
    if (p.type.includes('import') || p.type.includes('include') || p.type.includes('specifier')) return null;
    if (curr.type === 'object_reference' && p.type.startsWith('create_')) {
      curr = p;
      continue;
    }
    if (
      curr.type.includes('signature') &&
      (p.type.includes('signature') || p.type.includes('definition') || p.type.includes('declaration'))
    ) {
      curr = p;
      continue;
    }
    const declField = p.childForFieldName('declarator') || p.childForFieldName('name');
    if (declField && (declField.id === curr.id || declField.id === idNode.id)) {
      curr = p;
      continue;
    }
    break;
  }

  // 2. Verify the declaration node itself has a structural body/value/declaration rule
  const hasStructure =
    Boolean(curr.childForFieldName('body')) ||
    Boolean(curr.childForFieldName('value')) ||
    curr.type.includes('declaration') ||
    curr.type.includes('definition') ||
    curr.type.includes('item') ||
    (curr.type.includes('spec') && !curr.type.includes('specifier')) ||
    curr.type.startsWith('create_');
  if (!hasStructure) return null;

  // 3. Expand to outer export / decorated definition wrapper via CST field (`declaration` / `definition`)
  while (curr.parent && curr.parent.id !== rootNode.id) {
    const p = curr.parent;
    if (p.type.includes('import') || p.type.includes('include') || p.type.includes('specifier')) return null;
    if (p.type.includes('export') && p.childForFieldName('source')) return null;
    const outerField = p.childForFieldName('declaration') || p.childForFieldName('definition');
    if (outerField && outerField.id === curr.id) {
      curr = p;
      continue;
    }
    break;
  }

  return curr;
}

function extractTopLevelImports(stmt) {
  const argNode = stmt.childForFieldName('argument');
  const srcNode =
    stmt.childForFieldName('source') ||
    stmt.childForFieldName('module_name') ||
    stmt.childForFieldName('path') ||
    argNode?.childForFieldName('path') ||
    argNode;

  const isImport =
    Boolean(srcNode) ||
    stmt.type.includes('import') ||
    stmt.type.includes('include');
  if (!isImport) return [];

  // Handle grouped import declarations (e.g. Go `import ( "a"; "b" )`) where children carry `path` fields
  if (!srcNode) {
    const multi = [];
    function collectSpecs(n) {
      const pNode = n.childForFieldName('path');
      if (pNode) {
        const from = unquoteLiteral(pNode.text);
        if (from) {
          multi.push({
            from,
            symbols: [],
            line: n.startPosition.row + 1,
            end_line: n.endPosition.row + 1
          });
        }
        return;
      }
      for (const c of n.namedChildren) collectSpecs(c);
    }
    collectSpecs(stmt);
    if (multi.length > 0) return multi;
  }

  let from = srcNode ? unquoteLiteral(srcNode.text) : null;
  const symbols = [];

  function visit(n) {
    if (!from && (n.type.includes('string') || n.type.includes('identifier') || n.type.includes('name'))) {
      from = unquoteLiteral(n.text);
      return;
    }
    if (
      n.namedChildCount === 0 &&
      (n.type.includes('identifier') || n.type.includes('name')) &&
      (!srcNode || n.startIndex < srcNode.startIndex || n.endIndex > srcNode.endIndex)
    ) {
      const sym = n.text.trim();
      if (sym && !symbols.includes(sym)) symbols.push(sym);
    }
    for (const c of n.namedChildren) visit(c);
  }

  visit(stmt);
  if (!from) return [];
  return [
    {
      from,
      symbols,
      line: stmt.startPosition.row + 1,
      end_line: stmt.endPosition.row + 1
    }
  ];
}

/**
 * Indexes a single source file into CST coordinates using web-tree-sitter,
 * @lumis-sh/wasm-bundle-full native .scm queries, and xxhash-wasm.
 * Deterministically frees all C++ WASM Parser and Tree allocations in `finally`.
 */
export async function indexFileCst(fileEntry) {
  await initCstRuntime();
  const { absPath, relPath, langId, wasmUrl, languagePackage } = fileEntry;
  const sourceCode = fs.readFileSync(absPath, 'utf8');
  const lineCount = sourceCode.split('\n').length;

  const { lang, queries } = await loadGrammarAndQueries(langId, wasmUrl, languagePackage);
  if (!lang || !queries?.hlQuery) return null;

  const allocatedParsers = [];
  const allocatedTrees = [];

  try {
    const parser = new Parser();
    allocatedParsers.push(parser);
    parser.setLanguage(lang);
    const tree = parser.parse(sourceCode);
    allocatedTrees.push(tree);
    const rootNode = tree.rootNode;

    const fileCoordId = createCadastralId(`file:${relPath}`);
    const imports = [];
    let minImportLine = Infinity;
    let maxImportLine = 0;

    for (const child of rootNode.namedChildren) {
      for (const imp of extractTopLevelImports(child)) {
        imports.push(imp);
        if (imp.line < minImportLine) minImportLine = imp.line;
        if (imp.end_line > maxImportLine) maxImportLine = imp.end_line;
      }
    }

    const parseUnits = [{ tree, rootNode, queries, unitLangId: langId }];

    if (queries.injQuery) {
      for (const match of queries.injQuery.matches(rootNode)) {
        const injLang =
          match.setProperties?.['injection.language'] ||
          match.captures.find(c => c.name === 'injection.language')?.node.text?.toLowerCase();
        const contentNode = match.captures.find(c => c.name === 'injection.content')?.node;
        if (!injLang || !contentNode || typeof wasmBundle[injLang] !== 'function') continue;

        const injLoaded = await loadGrammarAndQueries(injLang, null, null);
        if (!injLoaded.lang || !injLoaded.queries?.hlQuery) continue;

        const injParser = new Parser();
        allocatedParsers.push(injParser);
        injParser.setLanguage(injLoaded.lang);
        const subTree = injParser.parse(sourceCode, null, {
          includedRanges: [
            {
              startIndex: contentNode.startIndex,
              endIndex: contentNode.endIndex,
              startPosition: contentNode.startPosition,
              endPosition: contentNode.endPosition
            }
          ]
        });
        allocatedTrees.push(subTree);
        for (const child of subTree.rootNode.namedChildren) {
          for (const imp of extractTopLevelImports(child)) {
            imports.push(imp);
            if (imp.line < minImportLine) minImportLine = imp.line;
            if (imp.end_line > maxImportLine) maxImportLine = imp.end_line;
          }
        }
        parseUnits.push({ tree: subTree, rootNode: subTree.rootNode, queries: injLoaded.queries, unitLangId: injLang });
      }
    }

    const symbolsByKey = new Map();
    const calls = [];
    const referencedTypes = [];
    const literals = [];
    const landmarks = [];

    for (const unit of parseUnits) {
      for (const cap of unit.queries.hlQuery.captures(unit.rootNode)) {
        const { name: capName, node } = cap;
        const line = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;

        if (
          capName === 'function' ||
          capName === 'function.method' ||
          capName === 'constructor' ||
          capName === 'type' ||
          capName === 'type.definition'
        ) {
          const declNode = findEnclosingDeclarationNode(node, unit.rootNode);
          if (declNode) {
            const symName = node.text.trim();
            const sLine = declNode.startPosition.row + 1;
            const eLine = declNode.endPosition.row + 1;
            const key = `${symName}:${sLine}:${eLine}`;
            const kind =
              capName === 'function.method'
                ? 'method'
                : capName.startsWith('type') || capName === 'constructor' || declNode.type.includes('table')
                  ? 'type'
                  : 'function';
            if (!symbolsByKey.has(key) || kind === 'function') {
              symbolsByKey.set(key, { name: symName, kind, declNode, startLine: sLine, endLine: eLine });
            }
          } else if (capName.startsWith('type') || node.parent?.type === 'object_reference') {
            referencedTypes.push({ name: node.text.trim(), line });
          } else {
            calls.push({ name: node.text.trim(), line });
          }
        } else if (capName === 'function.call' || capName === 'function.method.call') {
          calls.push({ name: node.text.trim(), line });
        } else if (capName === 'string') {
          const text = unquoteLiteral(node.text);
          if (text) literals.push({ text, line, endLine });
        } else if (capName.startsWith('markup.heading') || (capName === 'none' && node.parent?.type?.includes('element'))) {
          const text = node.text.trim();
          if (text) {
            literals.push({ text, line, endLine });
            landmarks.push({
              kind: capName.startsWith('markup.heading') ? 'heading' : node.parent.type,
              label: text,
              line_span: { start: line, end: endLine }
            });
          }
        } else if (capName === 'tag' || capName === 'tag.builtin') {
          const elem = node.parent?.parent || node.parent;
          if (elem) {
            for (const child of elem.children || []) {
              if (child.type.includes('text')) {
                const txt = child.text.trim();
                if (txt) {
                  literals.push({
                    text: txt,
                    line: child.startPosition.row + 1,
                    endLine: child.endPosition.row + 1
                  });
                }
              }
            }
          }
        }
      }
    }

    const symbolNodes = [];
    const childIds = [];
    const allSyms = [...symbolsByKey.values()];

    for (const sym of allSyms) {
      const coordId = createCadastralId(`${relPath}:${sym.kind}:${sym.name}:${sym.startLine}`);
      childIds.push(coordId);

      const nestedSyms = allSyms.filter(
        other =>
          other !== sym &&
          other.startLine >= sym.startLine &&
          other.endLine <= sym.endLine &&
          (other.startLine > sym.startLine || other.endLine < sym.endLine)
      );
      const isDirectLine = line =>
        line >= sym.startLine &&
        line <= sym.endLine &&
        !nestedSyms.some(ns => line >= ns.startLine && line <= ns.endLine);

      const symCalls = [...new Set(calls.filter(c => isDirectLine(c.line)).map(c => c.name))];
      const symTypes = [
        ...new Set(
          referencedTypes
            .filter(t => isDirectLine(t.line) && t.name !== sym.name)
            .map(t => t.name)
        )
      ];
      const symStrings = [
        ...new Set(literals.filter(l => isDirectLine(l.line) && l.endLine <= sym.endLine).map(l => l.text))
      ];
      const symLandmarks = landmarks.filter(
        lm => isDirectLine(lm.line_span.start) && lm.line_span.end <= sym.endLine
      );

      symbolNodes.push({
        cadastral_id: coordId,
        kind: sym.kind,
        name: sym.name,
        origin_file: relPath,
        language: langId,
        coverage: 'full',
        line_span: { start: sym.startLine, end: sym.endLine },
        merkle_hash: computeMerkleHash(sym.declNode),
        parent_id: fileCoordId,
        calls: symCalls,
        referenced_types: symTypes,
        literals: symStrings,
        internal_landmarks: symLandmarks
      });
    }

    const fileNode = {
      cadastral_id: fileCoordId,
      kind: 'file',
      name: pathe.basename(relPath),
      origin_file: relPath,
      language: langId,
      coverage: 'full',
      line_span: { start: 1, end: lineCount },
      merkle_hash: computeMerkleHash(rootNode),
      children: childIds,
      imports,
      imports_line_span: imports.length > 0 ? { start: minImportLine, end: maxImportLine } : null,
      calls: [...new Set(calls.map(c => c.name))],
      referenced_types: [...new Set(referencedTypes.map(t => t.name))],
      literals: [...new Set(literals.map(l => l.text))],
      internal_landmarks: landmarks
    };

    return { fileNode, symbolNodes };
  } finally {
    for (const t of allocatedTrees) {
      try {
        t.delete();
      } catch (_) {}
    }
    for (const p of allocatedParsers) {
      try {
        p.delete();
      } catch (_) {}
    }
  }
}
