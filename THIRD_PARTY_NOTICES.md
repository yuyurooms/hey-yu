# Third-Party Open Source Notices & Attribution

**Coordinate of Code (`hey-yu`)** builds upon best-in-class open-source foundational libraries. Rather than reinventing parsers, module resolvers, search indices, graph structures, or schema validators with fragile custom heuristics, `hey-yu` orchestrates these battle-tested engines into a unified **Deterministic Spatial Coordinate System & Local-First MCP Control Plane**.

We gratefully acknowledge the authors and maintainers of the following open-source projects:

---

### 1. Web-Tree-Sitter (`web-tree-sitter`)
- **Role in `hey-yu`:** Official WebAssembly Concrete Syntax Tree (CST) parser runtime (`Parser`, `Language`, `Query`, `includedRanges`, `childForFieldName`).
- **License:** MIT License
- **Copyright:** Copyright (c) 2018-2025 Max Brunsfeld and Tree-sitter contributors
- **Repository:** https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web

### 2. Lumis & Lumis Full Tree-Sitter WASM Bundle (`@lumis-sh/lumis` & `@lumis-sh/wasm-bundle-full`)
- **Role in `hey-yu`:** Universal language detection (`guessLanguage`, `availableLanguages`) and 110+ pre-compiled Tree-sitter WebAssembly grammars with official `.scm` query bundles (`highlights.scm` and `injections.scm`).
- **License:** MIT License
- **Copyright:** Copyright (c) Lumis contributors
- **Packages:** https://www.npmjs.com/package/@lumis-sh/lumis | https://www.npmjs.com/package/@lumis-sh/wasm-bundle-full

### 3. Oxc Resolver (`oxc-resolver`)
- **Role in `hey-yu`:** Rust-compiled NAPI-RS module resolution engine (`ResolverFactory`) handling `tsconfig.json` (`paths`, `baseUrl`, `extends`), Node `package.json` (`exports`, `imports`, `main`, `module`), extension aliasing, and symlink resolution.
- **License:** MIT License
- **Copyright:** Copyright (c) 2023-2025 Boshen and Oxc contributors
- **Repository:** https://github.com/oxc-project/oxc-resolver

### 4. Orama (`@orama/orama`)
- **Role in `hey-yu`:** Sub-millisecond in-memory BM25 full-text search engine for resolving natural-language intents, identifiers, and UI text to exact AST coordinates.
- **License:** Apache License 2.0
- **Copyright:** Copyright (c) 2022-2025 OramaSearch Inc. (Michele Riva and contributors)
- **Repository:** https://github.com/askorama/orama

### 5. Graphology (`graphology` & `graphology-traversal`)
- **Role in `hey-yu`:** Directed in-memory property graph (`DirectedGraph`) and breadth-first traversal engine (`bfsFromNode`) powering `Import-Scoped Edge Filter` and `Coordinate Dispatcher Dependency Walk` (`IMPORTS_FILE`, `CALLS_COORD`, `USES_TYPE`).
- **License:** MIT License
- **Copyright:** Copyright (c) 2016-2025 Guillaume Plique (Yomguithereal) and contributors
- **Repository:** https://github.com/graphology/graphology

### 6. xxhash-wasm (`xxhash-wasm`)
- **Role in `hey-yu`:** Zero-dependency WebAssembly implementation of `xxHash` (`xxh64`), used to generate deterministic 64-bit cadastral IDs (`crd_...`) and structural CST Merkle skeleton hashes (`merkle_hash`).
- **License:** MIT License
- **Copyright:** Copyright (c) 2020-2025 Jungomi and contributors (based on xxHash by Yann Collet)
- **Repository:** https://github.com/jungomi/xxhash-wasm

### 7. Zod (`zod`)
- **Role in `hey-yu`:** Deterministic schema validation (`safeParse`) and automatic JSON Schema generation (`z.toJSONSchema`) for Model Context Protocol (MCP) tool inputs (`HeyYuArgsSchema`, `ProjectMapArgsSchema`).
- **License:** MIT License
- **Copyright:** Copyright (c) 2020-2025 Colin McDonnell
- **Repository:** https://github.com/colinhacks/zod

### 8. Ignore (`ignore`)
- **Role in `hey-yu`:** Gitignore specification-compliant file path filter (supporting cascading root and nested `.gitignore` files) ensuring build artifacts, `node_modules`, and ignored files never pollute the coordinate cadastre.
- **License:** MIT License
- **Copyright:** Copyright (c) 2013-2025 Kael Zhang
- **Repository:** https://github.com/kaelzhang/node-ignore

### 9. Pathe (`pathe`)
- **Role in `hey-yu`:** Universal POSIX path normalization ensuring deterministic file paths and cadastral coordinates across macOS, Linux, and Windows (`win32`).
- **License:** MIT License
- **Copyright:** Copyright (c) Pooya Parsa and UnJS contributors
- **Repository:** https://github.com/unjs/pathe

---

*All third-party libraries remain the property of their respective copyright holders under their original open-source licenses.*
