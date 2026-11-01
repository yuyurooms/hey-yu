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
  let locQuery = null;
  let injQuery = null;
  try {
    if (langDef.highlights) hlQuery = new Query(lang, langDef.highlights);
  } catch (_) {}
  try {
    if (langDef.locals) locQuery = new Query(lang, langDef.locals);
  } catch (_) {}
  try {
    if (langDef.injections) injQuery = new Query(lang, langDef.injections);
  } catch (_) {}

  const queries = { hlQuery, locQuery, injQuery };
  languageCache.set(langId, lang);
  queryCache.set(langId, queries);
  return { lang, queries };
}

function unquoteLiteral(raw) {
  const t = (raw || '').trim();
  if (
    t.length >= 2 &&
    ((t[0] === '"' && t.endsWith('"')) ||
      (t[0] === "'" && t.endsWith("'")) ||
      (t[0] === '`' && t.endsWith('`')) ||
      (t[0] === '<' && t.endsWith('>')))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Pure Tree-sitter CST + native .scm (`highlights.scm` & `locals.scm`) declaration resolver:
 * 1. Excludes nodes inside import statements or import/export specifiers.
 * 2. Supports macro-style declarations (e.g. Elixir `def` / `defmodule`) tagged by `@keyword.function` / `@_definition`.
 * 3. Climbs declarator/reference wrappers (e.g. C++ `function_declarator` / `class_specifier`, Go `type_spec`,
 *    SQL `object_reference` -> `create_table`, JS `export_statement` -> `lexical_declaration`).
 * 4. Excludes expression literals (e.g. Rust `struct_expression` `Session { id: 1 }`).
 */
function findEnclosingDeclarationNode(idNode, rootNode, declCallNodes) {
  let curr = idNode.parent;
  if (!curr || curr.id === rootNode.id) return null;

  // Handle macro-based declarations (e.g. Elixir `defmodule MyApp.Auth do` / `def login(user) do`)
  // where `highlights.scm` tags the macro target with `@keyword.function` or `@_definition`.
  let anc = curr;
  while (anc && anc.id !== rootNode.id) {
    if (declCallNodes.has(anc.id)) {
      return anc;
    }
    if (anc.type === 'do_block' || anc.type === 'block') break;
    anc = anc.parent;
  }

  // Handle qualified function declarations (e.g. Lua `function M.foo()`, C++ `void Foo::bar()`)
  if (
    (curr.type.includes('index_expression') || curr.type.includes('field_expression')) &&
    curr.parent
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
        curr.type.startsWith('create_');
      if (!isDirectDeclParent) return null;
      const firstIdChild = curr.namedChildren.find(
        c => c.type.includes('identifier') || c.type === 'name' || c.type.endsWith('_name')
      );
      if (firstIdChild && firstIdChild.id !== idNode.id) return null;
    }
  }

  // 1. Climb inner declarator / signature / type_spec / object_reference wrappers to the declaration node
  while (curr.parent && curr.parent.id !== rootNode.id) {
    const p = curr.parent;
    if (curr.type === 'object_reference' && p.type.startsWith('create_')) {
      curr = p;
      continue;
    }
    if (
      (curr.type.includes('signature') || curr.type.includes('binding') || curr.type === 'type_spec') &&
      (p.type.includes('definition') || p.type.includes('declaration'))
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

  // Reject expression literals (e.g. Rust `struct_expression` `Session { id: 1 }`)
  if (curr.type.includes('expression') && !curr.type.includes('function')) {
    return null;
  }

  // 2. Verify the declaration node itself has a structural body/value/declaration rule
  const hasStructure =
    Boolean(curr.childForFieldName('body')) ||
    Boolean(curr.childForFieldName('value')) ||
    curr.type.includes('declaration') ||
    curr.type.includes('definition') ||
    curr.type.includes('item') ||
    curr.type.startsWith('create_');
  if (!hasStructure) return null;

  // 3. Expand to outer export / decorated definition wrapper via CST field (`declaration` / `definition`)
  while (curr.parent && curr.parent.id !== rootNode.id) {
    const p = curr.parent;
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

/**
 * Extracts imports across 100+ languages using `@lumis-sh/wasm-bundle-full` native
 * `highlights.scm` (`@keyword.import`, `@include`, `@module`, `@string`) and
 * `locals.scm` (`@local.definition.import`) captures.
 */
function extractNativeImports(rootNode, hlCaps, locCaps) {
  const capsByNodeId = new Map();
  for (const c of hlCaps) {
    let set = capsByNodeId.get(c.node.id);
    if (!set) {
      set = new Set();
      capsByNodeId.set(c.node.id, set);
    }
    set.add(c.name);
  }

  const importTriggerNodes = [];
  const keywordTriggerIds = new Set();
  for (const c of hlCaps) {
    if (c.name.includes('import') || c.name.includes('include')) {
      importTriggerNodes.push(c.node);
      if (c.name.startsWith('keyword') || c.name === 'include' || c.name === '_include') {
        keywordTriggerIds.add(c.node.id);
      }
    } else if (c.name === 'function.builtin' && c.node.parent?.type?.includes('call')) {
      const hasStringArg = hlCaps.some(
        s =>
          (s.name === 'string' || s.name === 'string.special.path') &&
          s.node.startIndex > c.node.endIndex &&
          s.node.endIndex <= c.node.parent.endIndex
      );
      if (hasStringArg) {
        importTriggerNodes.push(c.node);
        keywordTriggerIds.add(c.node.id);
      }
    } else if (c.name === 'keyword' && c.node.parent?.type === 'call') {
      const nodeCaps = capsByNodeId.get(c.node.id);
      const isMacroDirective =
        nodeCaps?.has('function.call') &&
        !nodeCaps?.has('keyword.function') &&
        !nodeCaps?.has('_definition');
      const hasModuleArg = hlCaps.some(
        m =>
          m.name === 'module' &&
          m.node.startIndex > c.node.endIndex &&
          m.node.endIndex <= c.node.parent.endIndex
      );
      if (isMacroDirective && hasModuleArg) {
        importTriggerNodes.push(c.node);
        keywordTriggerIds.add(c.node.id);
      }
    }
  }
  for (const c of locCaps) {
    if (c.name.includes('import')) {
      importTriggerNodes.push(c.node);
    }
  }

  const stmtMap = new Map();
  for (const trig of importTriggerNodes) {
    let curr = trig;
    while (curr.parent && curr.parent.id !== rootNode.id) {
      const p = curr.parent;
      if (p.type.includes('package')) {
        curr = null;
        break;
      }
      if (p.type.includes('export') && !p.childForFieldName('source')) {
        curr = null;
        break;
      }
      if (
        p.id === rootNode.id ||
        p.type === 'declaration_list' ||
        p.type === 'do_block' ||
        p.type === 'block' ||
        p.type === 'body_statement' ||
        p.type === 'program' ||
        p.type === 'source_file' ||
        p.type === 'module' ||
        p.type === 'chunk' ||
        p.type === 'translation_unit'
      ) {
        break;
      }
      curr = p;
    }
    if (curr && !curr.type.includes('package')) {
      stmtMap.set(curr.id, curr);
    }
  }

  const results = [];
  const importSpans = [];

  for (const stmt of stmtMap.values()) {
    importSpans.push({ startIndex: stmt.startIndex, endIndex: stmt.endIndex });
    const subHl = hlCaps.filter(
      c => c.node.startIndex >= stmt.startIndex && c.node.endIndex <= stmt.endIndex
    );
    const subLoc = locCaps.filter(
      c => c.node.startIndex >= stmt.startIndex && c.node.endIndex <= stmt.endIndex
    );

    const stringNodes = [];
    for (const c of subHl) {
      if (c.name === 'string' || c.name === 'string.special.path') {
        const val = unquoteLiteral(c.node.text);
        if (
          val &&
          val !== '"' &&
          val !== "'" &&
          !stringNodes.some(s => s.val === val && s.line === c.node.startPosition.row + 1)
        ) {
          stringNodes.push({
            val,
            node: c.node,
            line: c.node.startPosition.row + 1,
            end_line: c.node.endPosition.row + 1
          });
        }
      }
    }

    const defImports = [
      ...new Set(
        subLoc
          .filter(c => c.name === 'local.definition.import' || c.name === 'local.definition.var')
          .map(c => c.node.text.trim())
          .filter(Boolean)
      )
    ];

    if (stringNodes.length > 1) {
      for (const sn of stringNodes) {
        results.push({ from: sn.val, symbols: [], line: sn.line, end_line: sn.end_line });
      }
      continue;
    }

    let from = stringNodes[0]?.val || null;
    const srcField =
      stmt.childForFieldName('module_name') ||
      stmt.childForFieldName('source') ||
      stmt.childForFieldName('path') ||
      stmt.childForFieldName('name');

    if (!from && srcField) {
      from = unquoteLiteral(srcField.text);
    }

    if (!from) {
      const modCaps = subHl.filter(
        c =>
          !keywordTriggerIds.has(c.node.id) &&
          (c.name === 'module' || c.name === 'namespace' || c.name === 'type' || c.name === '_import')
      );
      if (modCaps.length > 0) {
        let best = modCaps[0].node;
        while (
          best.parent &&
          best.parent.id !== stmt.id &&
          !best.parent.type.includes('argument') &&
          !best.parent.type.includes('header') &&
          !best.parent.children.some(ch => keywordTriggerIds.has(ch.id))
        ) {
          best = best.parent;
        }
        from = unquoteLiteral(best.text).trim();
      } else if (defImports.length > 0) {
        from = defImports[0];
      }
    }

    if (from) {
      const syms = [...defImports];
      for (const c of subHl) {
        if (keywordTriggerIds.has(c.node.id)) continue;
        if (c.name === 'type' || c.name === 'module' || c.name === 'variable') {
          const t = c.node.text.trim();
          if (
            t &&
            t !== from &&
            (!stringNodes[0] ||
              c.node.startIndex < stringNodes[0].node.startIndex ||
              c.node.endIndex > stringNodes[0].node.endIndex) &&
            (!srcField ||
              c.node.startIndex < srcField.startIndex ||
              c.node.endIndex > srcField.endIndex)
          ) {
            if (!syms.includes(t)) syms.push(t);
          }
        }
      }
      if (!stringNodes[0]) {
        const tailSeg = pathe.basename(
          from.replaceAll('::', '/').replaceAll('.', '/').replaceAll('\\', '/')
        );
        if (tailSeg && tailSeg !== from && tailSeg !== '*' && !syms.includes(tailSeg)) {
          syms.push(tailSeg);
        }
      }
      results.push({
        from,
        symbols: syms.filter(s => s !== from),
        line: stmt.startPosition.row + 1,
        end_line: stmt.endPosition.row + 1
      });
    }
  }

  return { imports: results, importSpans };
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
        parseUnits.push({ tree: subTree, rootNode: subTree.rootNode, queries: injLoaded.queries, unitLangId: injLang });
      }
    }

    const symbolsByKey = new Map();
    const calls = [];
    const referencedTypes = [];
    const literals = [];

    for (const unit of parseUnits) {
      const hlCaps = unit.queries.hlQuery ? unit.queries.hlQuery.captures(unit.rootNode) : [];
      const locCaps = unit.queries.locQuery ? unit.queries.locQuery.captures(unit.rootNode) : [];

      const { imports: unitImports, importSpans } = extractNativeImports(unit.rootNode, hlCaps, locCaps);
      for (const imp of unitImports) {
        imports.push(imp);
        if (imp.line < minImportLine) minImportLine = imp.line;
        if (imp.end_line > maxImportLine) maxImportLine = imp.end_line;
      }

      const declCallNodes = new Set();
      const declMacroKeywordNodes = new Set();
      for (const cap of hlCaps) {
        if (
          (cap.name === '_definition' || cap.name === 'keyword.function') &&
          cap.node.parent?.type === 'call'
        ) {
          declCallNodes.add(cap.node.parent.id);
          declMacroKeywordNodes.add(cap.node.id);
        }
      }

      for (const cap of hlCaps) {
        const { name: capName, node } = cap;
        if (declMacroKeywordNodes.has(node.id)) continue;
        const isInImport = importSpans.some(
          s => node.startIndex >= s.startIndex && node.endIndex <= s.endIndex
        );
        if (isInImport) continue;

        const line = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;
        const isMacroModuleDef =
          capName === 'module' && node.parent && declCallNodes.has(node.parent.parent?.id);

        if (
          capName === 'function' ||
          capName === 'function.method' ||
          capName === 'function.macro' ||
          capName === 'constructor' ||
          capName === 'type' ||
          capName === 'type.definition' ||
          capName === 'class' ||
          isMacroModuleDef
        ) {
          const declNode = findEnclosingDeclarationNode(node, unit.rootNode, declCallNodes);
          const symName = node.text.trim();
          const isSingleToken = Boolean(symName && !symName.includes(' ') && !symName.includes('\n') && !symName.includes('\t'));
          if (declNode && isSingleToken) {
            const sLine = declNode.startPosition.row + 1;
            const eLine = declNode.endPosition.row + 1;
            const key = `${symName}:${sLine}:${eLine}`;
            const kind =
              capName === 'function.method'
                ? 'method'
                : capName.startsWith('type') ||
                    capName === 'class' ||
                    capName === 'constructor' ||
                    isMacroModuleDef ||
                    declNode.type.includes('table')
                  ? 'type'
                  : 'function';
            if (!symbolsByKey.has(key) || kind === 'function') {
              symbolsByKey.set(key, { name: symName, kind, declNode, startLine: sLine, endLine: eLine });
            }
          } else if (isSingleToken) {
            if (capName.startsWith('type') || capName === 'class' || node.parent?.type === 'object_reference') {
              referencedTypes.push({ name: symName, line });
            } else {
              calls.push({ name: symName, line });
            }
          }
        } else if (capName === 'function.call' || capName === 'function.method.call') {
          const callName = node.text.trim();
          if (callName && !callName.includes(' ') && !callName.includes('\n') && !callName.includes('\t')) {
            calls.push({ name: callName, line });
          }
        } else if (capName === 'string') {
          const text = unquoteLiteral(node.text);
          if (text) literals.push({ text, line, endLine });
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
        literals: symStrings
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
      literals: [...new Set(literals.map(l => l.text))]
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
