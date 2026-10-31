# Coordinate of Code (`hey-yu`) — Architectural & Engineering Manifesto (v0.1.0-alpha)

This manifesto defines the core product philosophy, engineering principles, and open-source guarantees of **Coordinate of Code (`hey-yu`)**. Every section is written first **In Plain English** (so anyone can immediately understand *why* it matters) and then as a **Technical Deep Dive** (for engineers and contributors).

---

## 1. Two Core Pillars: Precision & Speed (The Chessboard Principle)

### In Plain English (For Everyone)
Why do AI coding agents waste so much time and break working features?
1. **They search blindfolded:** Without exact coordinates, an AI agent has to run 5 to 10 text searches (`grep`) and read whole files just to find a single function.
2. **They forget connected files (The Domino Effect):** When you ask an AI to change how a feature works, it edits one file and forgets the connected validator, the shared data structure, or the database table in another folder.

`hey-yu` solves both problems using the **Chessboard Principle**:
- **Precision in 1 Step:** Every function, class, method, struct, interface, and schema in your project has a unique coordinate (`crd_...`), like squares on a chessboard (`e4`, `Nf3`), plus a map of every piece connected to it. When the AI asks `hey-yu`, it gets the exact file, exact lines, and the connected dependency chain in **one single step**.
- **Speed (`~1.5ms`):** `hey-yu` answers in a couple of milliseconds from memory and automatically updates when you edit files.

### Technical Deep Dive (For Engineers)
1. **1-Step Deterministic Spatial & Dependency Resolution:**
   - Every symbol across 110+ languages is assigned a deterministic spatial coordinate (`crd_<xxh64>`) and a structural CST **Merkle Skeleton Hash** (`mrk_<xxh64>`) computed via `xxhash-wasm` over official `web-tree-sitter` Concrete Syntax Trees.
   - A single `hey_yu` MCP call returns `absolute_file_path`, exact `line_span` (`{ start, end }`), `internal_landmarks`, `coordinate_dispatcher` (`required_file_spans` across up to 3 hops), `impact_graph` (`incoming_callers`, `imported_callees`, `shared_types`), and `related_coordinates`.
2. **Sub-15ms Hot Path & Incremental Live Sync:**
   - Queries resolve in **`<2ms` hot (`<15ms` cold)** from the in-memory `graphology` `DirectedGraph` and `@orama/orama` search index.
   - Before every query, `CoordinateResolver.sync()` compares `statKey` (`mtimeMs:size`) across workspace files (`<1ms`), re-parsing in WASM only the files that changed since the last turn and persisting the cache to `.coordinate/ast_cache.json`.

---

## 2. The 5 Non-Negotiable Engineering Principles

Every line of code in `hey-yu` must follow these 5 rules without exception:

### Principle I: Speed & Precision Without Redundant Walks
- **In Plain English:** Never waste the user's time or computer memory. Find the exact start and end lines of code in milliseconds and clean up memory immediately after scanning each file.
- **Technical Deep Dive:** Maintain `<15ms` resolution latency, exact CST declaration boundaries (`line_span`), and deterministic WebAssembly heap cleanup (`tree.delete()`, `subTree.delete()`, `parser.delete()` in `finally` blocks).

### Principle II: Zero Hardcode, Zero Crutches & Zero Single-Framework Word Lists
- **In Plain English:** Never write "band-aid" hacks that only work for one framework (like a hardcoded list of React or Express words) or chop off results with arbitrary limits. Everything must work by understanding the real structure of the code.
- **Technical Deep Dive:** Strictly forbid arbitrary truncations (`.slice(0, N)`), fake line padding (`+25`), regex source parsers, or static `new Set([...])` identifier dictionaries tied to a single language or framework. All classification must derive from official Tree-sitter CST grammar node types, `.scm` queries (`highlights.scm`, `injections.scm`), CST field names (`childForFieldName`), and `graphology` graph topology.

### Principle III: Universal Scale (Millions of Polyglot Projects)
- **In Plain English:** Developers build backends in Go, Rust, Python, Java, C#, and PHP; systems in C/C++; mobile apps in Swift and Kotlin; databases in SQL; and frontends in TypeScript, React, Vue, and Svelte. `hey-yu` must work equally well for all of them.
- **Technical Deep Dive:** Scale across 110+ languages via `@lumis-sh/wasm-bundle-full` and `@lumis-sh/lumis`, handling single-file module imports, `tsconfig.json` path aliases (`oxc-resolver`), and multi-file package directories (`filesByDirSuffix` for Go, Java, C#).

### Principle IV: Partner-Library Only Architecture
- **In Plain English:** Instead of reinventing the wheel with fragile custom code, `hey-yu` uses the best open-source libraries in the world for each job — and uses their full power.
- **Technical Deep Dive:**
  - **CST Parsing & Multi-Language Injections:** `web-tree-sitter` (`Parser`, `Language`, `Query`, `includedRanges`, `childForFieldName`) + `@lumis-sh/wasm-bundle-full` + `@lumis-sh/lumis`.
  - **Cross-File Module Resolution:** `oxc-resolver` (`ResolverFactory`) + `pathe`.
  - **Dependency Graph & Multi-Hop Traversal:** `graphology` (`DirectedGraph`) + `graphology-traversal` (`bfsFromNode`).
  - **In-Memory Search & Ranking:** `@orama/orama` (`create`, `insertMultiple`, `search` with field `boost`).
  - **Deterministic Hashing:** `xxhash-wasm` (`h64ToString`).
  - **Gitignore Filtering & Schema Validation:** `ignore` and `zod` (`safeParse`, `z.toJSONSchema`).

### Principle V: Honest Silent Pass (`pass: true`) & Pure Coordinate Dispatcher Role
- **In Plain English:** `hey-yu` is a pure Coordinate Dispatcher — it finds the exact coordinates and connected dependency chain (`Callers`, `Imported Callees`, `Shared Types`, `Related Coordinates`) and leaves deep code reasoning to the AI agent. If a user asks the AI to run a `git` command, edit a Dockerfile, or do something where code coordinates aren't needed, `hey-yu` immediately steps aside silently (`pass: true`) so the AI can work normally.
- **Technical Deep Dive:** When a query is outside AST competence or yields no match in the Orama index, return `{ pass: true, resolution_status: "PASS" }` in `<1ms` with zero chat banners or retries.

---

## 3. Product & Privacy Invariants

1. **Local-First MIT Engine & MCP Server (Never a GitHub App or PR Bot):**
   `hey-yu` runs locally inside the developer's editor (Cursor, Claude Code, Antigravity, Windsurf). It is **never** a GitHub App, PR bot, or diff gatekeeper.
2. **100% Local Code Privacy:**
   Your source code, `.coordinate/ast_cache.json`, and `.coordinate/live_audit.log` stay entirely on your machine.
3. **Human-Readable Live Reporting (`user_status_line`):**
   Whenever `hey-yu` resolves a coordinate (`EXISTING_FOUND`), it provides a clean, human-readable 1-line summary showing the resolved symbol, its exact file and lines, connected dependencies (`Callers`, `Imported Callees`, `Shared Types`), the `Reading Plan`, and `Related Coordinates`.
