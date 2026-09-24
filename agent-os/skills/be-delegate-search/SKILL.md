---
name: be-delegate-search
description: Keep the main context small by delegating broad, read-heavy exploration to an isolated read-only subagent — the file reads happen in the subagent's context and only the conclusion returns. Use when answering a question means sweeping many files, directories, or naming conventions, or when you catch yourself about to read several whole files to find one thing.
indexNote: delegate broad multi-file searches to a read-only Explore subagent — only the conclusion returns to main context
---

# be-delegate-search — search wide without paying for it in context

The cheapest tokens are the ones that never enter your context. A broad search that reads ten
files to find one fact costs the same whether *you* read them or a **subagent** does — except the
subagent's reads land in *its* context, and only its short conclusion returns to yours.

## When to delegate (vs search inline)

- **Delegate** when the answer needs a *sweep*: "where is X used across the repo", "which files
  follow convention Y", "map the call sites of Z", "how does subsystem W fit together". Anything
  where you'd otherwise open several whole files or run a wide grep and skim.
- **Search inline** when you already know the file/symbol and need one exact fact — that's a single
  `codegraph_node` / `LSP` / ranged `Read`, cheaper done directly than delegated.

## How

1. **Try the index first.** `codegraph_search` / `callers` / `impact` often answers the sweep with
   no file reads at all (see [`be-token-efficient-navigation`](../../rules/be-token-efficient-navigation.mdc)).
2. **Otherwise spawn a read-only `Explore` subagent** with a precise question and the breadth
   ("medium" or "very thorough"). It reads excerpts, not whole files, and returns the conclusion —
   file paths + the answer — not the dumps.
3. **Keep the conclusion, not the corpus.** Record only what the subagent concluded; do not re-read
   the files it read. If you need exact bytes from one file it found, `Read` that one, ranged.

## Anti-patterns

- Reading 5+ whole files in the main context to answer one "where/how" question → delegate instead.
- Running an unscoped repo-wide `Grep` and skimming pages of hits → `codegraph` or a subagent.
- Delegating a single-fact lookup you could answer with one `codegraph_node` / ranged `Read`.

## Related

[[be-skill-index]] · rule [`be-token-efficient-navigation`](../../rules/be-token-efficient-navigation.mdc) ·
`headroom` compression for the output you do load.

---

**Related skills:** [be-ci-investigation](../be-ci-investigation/SKILL.md) · [be-structure-maintainer](../be-structure-maintainer/SKILL.md)
