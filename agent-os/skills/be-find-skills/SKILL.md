---
name: be-find-skills
description: Discover and install agent skills — first search this project's own skill catalog for one that fits the task, then fall back to the open agent-skills ecosystem (npx skills) when none exists. Manual invoke only; use when the user asks "is there a skill for X", wants to browse the available skills, or wants to add a new one.
indexNote: user-invoked; discover/install skills — search the project catalog first, then the open ecosystem (no file trigger)
---

# be-find-skills — discover or install a skill

Use this skill when the user is looking for a capability that might already exist
as a skill, or wants to extend the agent's toolbox. Typical triggers:

- "How do I do X?" where X might be a common task with an existing skill
- "Is there a skill for X?" / "find a skill for X"
- "Can you do X?" where X is a specialized capability
- They want to browse the available skills or add a new one

## Step 1 — Search THIS project's catalog first

Before reaching for the open ecosystem, check the skills already vendored in this
repo. The full catalog and its trigger map live in
[be-skill-index](../be-skill-index/SKILL.md) — consult it first. The project ships skills
covering routes, schema, workers, testing, docs, security-hardening, seeds, and
workflow, and the file-pattern → skill map in
[agent-os/docs/skill-triggers.md](../../docs/skill-triggers.md) shows which one owns
which surface. Most backend tasks already have a matching skill, and running the
right existing skill beats installing a new one.

If a project skill fits, stop here and invoke it — do not install anything.

## Step 2 — The Skills CLI (open ecosystem)

If nothing in the project catalog fits, the Skills CLI (`npx skills`) is the package
manager for the open agent-skills ecosystem. Key commands:

- `npx skills find [query]` — search for skills interactively or by keyword
- `npx skills add <package>` — install a skill from GitHub or another source
- `npx skills check` — check for skill updates
- `npx skills update` — update installed skills

An installed skill keeps its upstream name, with no `be-` prefix. Record its GitHub source by
adding it to `KNOWN_EXTERNAL_SOURCES` in `tooling/agent-os/skills-lock.ts`, then run
`pnpm agent-os:lock`. A skill locked as `local` must carry the `be-` prefix, so
`agent-os:check` (Check 17) would fail it.

Browse skills at https://skills.sh/. Check the leaderboard there first — it ranks by
total installs, surfacing the most popular and battle-tested options — then run
`npx skills find [query]` if the leaderboard does not cover the need. For example:

- "How do I harden outbound HTTP calls?" → `npx skills find http resilience`
- "Can you help with PR reviews?" → `npx skills find pr review`
- "I need to generate a changelog" → `npx skills find changelog`

## Step 3 — Verify quality before recommending

Do not recommend a skill on search results alone. Always verify:

1. **Install count** — prefer 1K+ installs; be cautious below 100.
2. **Source reputation** — official sources (`anthropics`, `vercel-labs`, `microsoft`)
   are more trustworthy than unknown authors.
3. **GitHub stars** — a skill from a repo with <100 stars deserves skepticism.

Also sanity-check fit for THIS stack: this is a Node/Fastify/Drizzle/BullMQ backend,
so a frontend-flavoured skill (React, Tailwind, PWA) is usually the wrong tool even
when it ranks highly.

## Step 4 — Present options and offer to install

When you find a relevant skill, present the name and what it does, the install count
and source, the install command, and a link. If the user wants to proceed:

```bash
npx skills add <owner/repo@skill> -g -y
```

The `-g` flag installs globally (user-level) and `-y` skips confirmation prompts.

## When no skill is found

1. Say plainly that no existing skill (project or ecosystem) matched.
2. Offer to do the task directly with general capabilities.
3. If it is something the user does often, suggest scaffolding one: `npx skills init`.
   A project-specific skill lives in its own folder under `agent-os/skills/` and must
   be registered per the **be-structure-maintainer** skill (be-skill-index, groups.json, lock).
