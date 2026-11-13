# memcore

[中文](README.md) | English

**A local long-term memory layer — retrieval, clarifying questions, and self-correction for any model.**
Zero dependencies, no server, data stays on your machine. Chinese-first; the engine is language-agnostic.

```bash
node examples/demo.mjs      # 30 seconds, no data written
```

```
Q: why does the window keep flickering
  [7.26] user  2026-11-04 02:54:11  the window flickers every few seconds, what's wrong?…
  [7.33] user  2026-11-06 02:54:11  change the deploy script to absolute paths, don't rely on PATH…
```

## What it solves

Most "AI memory" either stuffs everything into the context (expensive, slower and slower) or reaches for a vector database (100+ MB, cold start, Chinese short messages collapse together).
memcore takes a third road: **tokenization + scoring + structured writes** — effort goes into "making the answer enter the corpus", not "tuning the score".

| Capability | What it does |
| --- | --- |
| Verbatim recall | Who said what, when. BM25 with Chinese word/character-bigram segmentation, 14-day half-life |
| Fact layer | `facts.jsonl` maps canonical names to aliases — "the rotating plugin" → `context-rotate` |
| Decision log | `decisions.jsonl` stores decision + reason + evidence; "why did we decide this" hits directly, no scrolling |
| Dossiers | `memory/*.md` are human-readable and also searchable |
| Asks back | Returns `confidence` (coverage / margin); when weak gives `weak: true` and three directions to disambiguate instead of guessing |
| Self-correction | Your own restatement of the question is capped and ranked below the record that actually answers it |
| Provable | Evaluation scaffold + numbers + a list of known weaknesses; not "it feels better" |

## Install

Node **≥ 20**, no third-party dependencies (the `dependencies` field is empty; only Node built-ins).

```bash
git clone https://github.com/yoooice/memcore && cd memcore
node packages/core/cli.mjs stats
```

Data lives in `~/.memcore` by default; override with `--dir` or `MEMCORE_DIR`. Dossiers use `--docs` / `MEMCORE_DOCS` (default `<dir>/memory`).

## Pairing with context compression (optional, recommended for long sessions)

memcore handles "remembering". It does not handle "fitting". The longer a single session runs, the sooner you hit the context window and the bill — that is a different job, handled by a context-compression plugin such as [billion-context](https://github.com/ranxianglei/billion-context) (MIT). The two do not overlap:

| | Owns | Where the data lives |
| --- | --- | --- |
| memcore | What was said in the past (verbatim / facts / decisions / dossiers) | Local `episodes.jsonl`, `memory/*.md` |
| billion-context | How much the model can see this turn (folds old context) | Only the request sent to the model; it never touches memory files |

One measurement from the author's DSH (single machine, single session, n=1 — not a general claim): a 288-request session reached 21.2M input tokens cumulatively, with a 97.1% cache hit rate and 11 folds netting 30.4M tokens saved. Folded passages could still be recalled verbatim — **it compresses the context, not the archive**.

### When you do not need it

- One-off short tasks, sessions under ~100K tokens: skip it. An extra plugin and an extra patch layer buy you nothing.
- Multi-day sessions, hundreds of thousands of tokens per session, hitting the context ceiling: worth it.

### Install (DSH)

From the profile directory:

```bash
dsh plugin --profile desktop add dsh-memcore
dsh plugin --profile desktop add billion-context@0.1.213
```

The pinned version on the second line is the **tested combination**. Without a version you get the latest upstream build — usually fine, but when something breaks, suspect the version first.

No `dsh` command? Add `dsh-memcore` and `billion-context` to `dsh.profile.bundles` in the profile's `package.json`, then run `pnpm install` in the profile directory. Skip that and the packages sit in `node_modules` without ever being loaded — `doctor` flags this half-installed state as a failure.

### Self-check after install

```bash
node packages/core/cli.mjs doctor
```

Read-only checks: is the data directory right, did the plugin actually enter `dsh.profile.bundles` (installed but absent from bundles = never loaded — the most common "I installed it and nothing happened"), is the billion-context version within the tested matrix, was the opening card injected recently. Every failure prints a copy-pasteable fix; **it writes nothing**.

### Known limits

- billion-context's DSH integration is a **loader patch layer** (rewrites preset injection, disables `compaction-basic`, adds retry codes to `llm-deepseek`) and is tightly coupled to the DSH version. Tested matrix: DSH `0.2.2-rc.1` × billion-context `0.1.212` / `0.1.213`.
- If `agent-preset/invalid` or session creation failures appear after a DSH upgrade, remove billion-context from the bundles first — its patch layer is suspect number one.
- Responsibility boundary: compression behavior, tools and the patch layer belong to the billion-context upstream; memory, retrieval and the opening card belong to memcore. File compression bugs upstream rather than guessing across two repositories.

## Three ways to connect

### 1. MCP (Claude Desktop / Cursor / Windsurf / any MCP client)

```json
{
  "mcpServers": {
    "memcore": {
      "command": "node",
      "args": ["D:/path/to/memcore/packages/core/mcp.mjs"],
      "env": { "MEMCORE_DIR": "C:/Users/you/.memcore", "MEMCORE_DOCS": "C:/Users/you/notes" }
    }
  }
}
```

Tools: `recall`, `trace`, `remember`, `fact_write`, `decide`, `stats`. Full example in `examples/mcp-config.json`.

### 2. HTTP (any language, any model, any agent)

```bash
node packages/core/server.mjs --port 7474
```

```bash
curl "http://127.0.0.1:7474/api/recall?q=flickering&limit=5"
curl -X POST http://127.0.0.1:7474/api/fact -H 'content-type: application/json' \
  -d '{"subject":"dsh-context-rotate","aliases":["rotating plugin"],"note":"context rotation plugin"}'
```

Open `http://127.0.0.1:7474/` for the UI: search, confidence banner, fact chips, decision log, dossier browser.
If you are wiring memcore into your own model calls, splice the `recall` result into the system prompt:

```js
const mem = await (await fetch('http://127.0.0.1:7474/api/recall?q=' + encodeURIComponent(question))).json()
if (mem.confidence?.weak) return askBack(mem.confidence.ask)   // ask first, don't guess
const context = mem.items.map((it) => `[${it.at}] ${it.role}: ${it.text}`).join('\n')
```

### 3. CLI

```bash
node packages/core/cli.mjs recall "that zstd thing from before"
node packages/core/cli.mjs trace "archive"
node packages/core/cli.mjs fact --subject dsh-workbench --aliases "workbench" --note "client dashboard plugin"
node packages/core/cli.mjs decide --decision "ask back when retrieval is weak" --reason "one guess costs more than one question"
node packages/core/cli.mjs doctor
node packages/core/cli.mjs serve
```

### 4. DSH client panel (optional)

`packages/dsh-panel/` is a sidebar panel for DSH (DeepSeek Harness): same in-process kernel, no extra port, a "Memory core" entry in the left rail with four pages — search / facts / decisions / dossiers. Install instructions in `packages/dsh-panel/README.md`. The panel is only a shell; deleting it does not affect the three connections above.

## Layout

```
lib/bm25.mjs    tokenization and scoring (usable standalone)
lib/core.mjs    kernel: recall / trace / remember / factWrite / decide / stats / listMemory
packages/core/lib/doctor.mjs  read-only health check (cli.mjs doctor)
packages/core/mcp.mjs  MCP stdio server (6 tools)
packages/core/server.mjs  HTTP server + static UI
packages/core/cli.mjs  command line
ui/index.html   web UI (tabbed)
ui/sidebar.html web UI (sidebar)
examples/       demo.mjs / mcp-config.json / curl.sh
tests/          unit tests (node --test, no deps)
eval/           evaluation scaffold run.mjs + synthetic sample
packages/dsh-panel/   DSH client panel (optional)
```

Data (all under `--dir`):

```
episodes.jsonl  verbatim messages (t time / r role / x text / s session)
facts.jsonl     fact layer (subject + aliases + note + optional validity window)
decisions.jsonl decision log (decision + reason + evidence + alternatives)
memory/*.md     dossier text (human-readable, also searchable)
```

## Evaluation (reproducible)

```bash
node --test tests/*.test.mjs                    # functional + three regressions (cache, cross-session, expired facts)
node eval/run.mjs --verbose                     # synthetic sample: format and flow demo
node eval/run.mjs --corpus your-corpus.json --queries your-questions.json
```

**Note**: the numbers below come from the author's private corpus (real conversations and dossiers with personal information; cannot be published). The questions and gold labels are not in the repository. The repo ships the scaffold `eval/run.mjs` and a **synthetic sample** (10 documents, 8 questions, Top1 6/8) to prove the format and flow run; validate with your own corpus.

| Set | Questions | Result |
| --- | --- | --- |
| Session verbatim | 20 (15 near-verbatim / 5 paraphrased) | strict Top1 **18/20**, loose 18/20 |
| Dossiers | 23 ("which file") | Top1 **20/23**, Top3 22/23 |
| Fact layer | 6 alias bridges | **19/20** (same 20-question set) |
| Decision log | 7 "why did we decide this" | **7/7** |

On the same corpus we compared: pure semantic model 8/20, semantic+BM25 weighted 18/20, RRF 18/20, grep baseline 15/20.
**Not using a vector store is a conclusion, not laziness** — see the next section.

## Design choices

- **No vector store**: on Chinese short messages cosine scores bunch up (0.5–0.7); the semantic model fails to link "rotating" with `rotate`, yet ranks incidental mentions high. Measured on 23 dossier questions: BM25 20/23, semantic hybrid also 20/23 — 118 MB buys no stable gain.
- **Don't tune scores, fix the writes**: reranking, RRF, query pruning, co-occurrence expansion — none beat the baseline on 20 questions. The only effective move was writing "two names for one thing" into the fact layer when learned (19/20).
- **Ask back when weak**: coverage < 30% or margin < 1.2× returns `weak: true` with directions to disambiguate. Thresholds were swept: `cov<0.6` misfires 10/20, `margin<1.5` misfires 5/20; 0.3/1.2 misfires 1 and catches 2 wrong answers.
- **Cap meta-records**: the record where I restate the question is scored below "best normal record × 0.99" — every verification makes that self-referential record look more like the answer; it is recursive pollution.
- **Chinese segmentation**: `Intl.Segmenter` words + character bigrams over consecutive spans. Ablation: per-character 17/23, words + all-character bigrams 20/23.

## Known weaknesses

- **Pure paraphrase**: "the rotating plugin" needs the alias to be searchable; the fact layer can fix it, but someone has to write it in.
- **Self-pollution**: my analysis of a question reads more like the answer than the user's own words; meta-record capping helps but does not fully stop it.
- **Small sample**: 20/23 questions were written by one person; not a generalization claim. Numbers move with the corpus.
- **No permission isolation**: all memories share one gate; multi-user scenarios need their own layer.
- **No graph retrieval**: tried dossier co-occurrence graph + one-hop expansion; no gain on 23 questions (17/23), kept only as `graph.md` for browsing.

## License

MIT, see [LICENSE](LICENSE).

## Disclaimer

This is a personal project, **not affiliated with or endorsed by DeepSeek**. The whale silhouette and terms such as "big fat fish" refer to DeepSeek's public imagery and community nickname, used only as identification and homage, implying no official identity or authorization.
