# The knowledge layer — LLM gateway, ServiceNow RAG, and the conflict ladder

Knowledge → Reasoning → Control → Execution.

This document covers what an operator has to do to use it, and the two places
where the design deliberately refuses to act instead of guessing.

---

## 1. LLM gateway

Every model call in the app goes through `server/src/agent/providers/index.js`
(`chatTurn` / `chatOnce`). Nothing above that layer knows which vendor is
configured — `test/llm-gateway.test.js` and `test/openrouter-provider.test.js`
both assert that by walking the source tree.

`server/src/agent/providers/contract.js` states the interface an adapter must
satisfy: a one-argument `chat({ system, history, tools, maxTokens, decoding })`
returning `{ text, toolCalls, stopReason }`, over a neutral, vendor-independent
history format.

Configured in Settings (stored as `server/data/settings.json`):

```json
{ "llm": { "provider": "opencode", "model": "<model>", "baseUrl": "<root>" } }
```

| provider     | base URL                   | model             | key      |
| ------------ | -------------------------- | ----------------- | -------- |
| `anthropic`  | fixed                      | has a default     | required |
| `openai`     | has a default              | has a default     | required |
| `ollama`     | `http://localhost:11434/v1`| `llama3.1`        | no       |
| `openrouter` | has a default              | **required**      | required |
| `opencode`   | **required**               | **required**      | optional |

### On `opencode` — read this before configuring it

"OpenCode-compatible" describes a **wire format**, not a hosted service. The
adapter sends the OpenAI `/chat/completions` shape to the base URL you give it.

Both the base URL and the model are required and have no default, because
neither is knowable from here — a defaulted base URL would silently post your
system prompt, the whole conversation and ~90 tool schemas to
`localhost:11434`, which is the Ollama default in the same adapter. The gateway
refuses with instructions instead.

**Not verified against a live endpoint.** Every other provider in that table was
measured against the real API. There is no OpenCode gateway on this machine, so
the only claim being made is that the request goes out in the OpenAI
chat-completions shape. If your target speaks a different protocol — for
instance OpenCode's own session-based agent API rather than a chat-completions
endpoint — it will fail loudly at the wire, and it needs a separate adapter
behind the same interface. Say so and it can be added; nothing above the
provider directory would change.

---

## 2. ServiceNow RAG

### Nothing is fetched from the web

Documents are supplied by you. There is no crawler, and that is deliberate: the
instruction was "do not invent documentation or URLs", and the fastest way to
violate it is a crawler that half-fetches a JavaScript-rendered docs page and
then has a model reconstruct the rest. A fabricated citation is worse than a
missing one, because the agent will repeat it to a user with the authority of a
source.

### Official ServiceNow sources only

Enforced in `knowledge/sources.js`, before anything is stored. A document is
admitted only if its URL host is `servicenow.com` or a subdomain of it. Blogs,
forums, aggregators and third-party tutorials are refused however accurate they
are, and so are the placeholder hosts a generated corpus is made of — none of
them is under the vendor domain either.

Two details that matter:

- `community.servicenow.com` is **excluded** despite being under the domain. It
  is user-written. Rung 3 of the precedence ladder means *vendor-published*, and
  indexing forum content there would launder a stranger's model knowledge into a
  rung it has not earned.
- Subdomain matching requires the dot, so `notservicenow.com` and
  `servicenow.com.attacker.example` are both refused.

**What this checks, precisely:** the host. That is a verifiable fact about a
document. It does **not** and cannot verify that the page exists, that the path
is real, or that the supplied text is what that URL served — nothing offline
can, and a check implying otherwise would be a false assurance. Fabricated paths
under a real host remain the responsibility of whoever assembles the corpus.

To widen it — a licensed mirror, an internal proxy, an air-gapped copy:

```json
{ "rag": { "allowedHosts": ["docs-mirror.internal.example"] } }
```

This is the only way to admit a non-vendor host, and it is configuration rather
than code so that doing so is a decision on the record. Ingestion reports which
rule admitted each document (`official-domain:…` vs `operator-allowed:…`), so an
audit can tell the two strengths of claim apart.

### What else is refused

A relative URL, an unparseable `updated_at`, an unknown `document_type`, or any
missing metadata field. The rejection names the file and the field. An
`updated_at` in the future is a **warning**, not a refusal — clock skew is real,
but version preference falls back to that field, so a wrong date there can make
one document permanently outrank newer releases of its page.

### Corpus format

Drop files into `server/data/knowledge/` (or set `rag.corpusDir`). Two formats,
both dependency-free:

**`.json`** — one document object, or an array of them:

```json
{
  "source": "servicenow-docs",
  "product": "ITSM",
  "topic": "flow-designer",
  "version": "Xanadu",
  "document_type": "documentation",
  "url": "https://www.servicenow.com/docs/<the real page>",
  "updated_at": "2026-03-01",
  "title": "Flow triggers",
  "text": "…the document body…"
}
```

**`.md`** — `---` frontmatter of flat `key: value` lines, then the body. The
frontmatter parser handles flat scalars only and **refuses** anything else
rather than half-reading it.

`document_type` is one of: `documentation`, `api-reference`, `release-note`,
`developer-guide`, `kb-article`, `store-listing`.

Then:

```
POST /api/knowledge/ingest  {"dryRun": true}   # validate everything, write nothing
POST /api/knowledge/ingest                     # reads the corpus dir, reports what it refused
GET  /api/knowledge/status                     # what is indexed, and what cannot be ranked
GET  /api/knowledge/search?q=…
```

**Check before it lands.** `dryRun` performs every validation, collision check
and warning and writes nothing. It shares its whole decision path with the real
run (`planDocument`), so a clean dry run means a clean run — a preview computed
by a second code path is a preview that can disagree with the write it previews.

**Partial success is the normal outcome.** A corpus of 400 files with 3 bad ones
indexes 397 and names the 3. One unreadable or unstorable file never ends the
run for the others.

**Ingestion is atomic per document.** The document row, the chunk deletion and
the chunk inserts are one transaction. The intermediate state is a real hazard:
between the DELETE and the INSERTs a document exists with zero chunks, and such
a document is invisible to every search while still being counted by
`knowledgeStats` — a corpus reporting 400 documents that can retrieve 399, with
nothing saying which one went quiet.

**File order is deterministic** (sorted). When two files declare the same
document, whichever is read last wins, and unsorted traversal would answer
"which version is in the corpus" differently on different machines.

### Duplicates

Two distinct cases, reported separately because they are different problems:

| | meaning | outcome |
|---|---|---|
| `collisions` | two entries resolve to the same `source`+`url` | **error** — one silently overwrote the other; fix the corpus |
| `contentDuplicates` | identical body text under two *different* URLs | **kept**, reported — usually legitimate, but both will match the same query and eat two of the six prompt slots |

Re-ingestion is idempotent: a document whose text is unchanged keeps its chunks
and its embeddings, and reports `unchanged`. Metadata is refreshed either way,
because a moved release or `updated_at` is a real change that version-aware
retrieval reads.

### Version-aware retrieval — and the thing it cannot know

"Prefer newer documentation" needs an ordering over ServiceNow release names.
That ordering is a fact about the platform's release history, not something
derivable from a document, and deriving it from the names would be a guess
dressed as logic. **So it is operator-supplied**, oldest first:

```json
{ "rag": { "releaseOrder": ["Vancouver", "Washington DC", "Xanadu"] } }
```

Empty by default — **until you set it, no release ordering is claimed**, and
retrieval falls back to the source's own `updated_at`. Every result says which
signal decided (`release-order` or `updated-at`) and carries the caveat when it
had to fall back.

After changing it, `POST /api/knowledge/reindex-versions`. Without that, the new
order would only apply to documents ingested afterwards — a half-ranked corpus
that ranks silently and wrongly.

The preference applies **within a family** (same source, product, topic, title),
where two hits really are two releases of one page. A newer ACL page does not
supersede an older Flow Designer page. Superseded documents are listed in the
result rather than vanishing.

### Degradation is always visible

Retrieval uses the same local embedding model as recall. With no model pulled it
falls back to FTS5 keyword search and **says so**, in the result and in the
prompt block. It never presents keyword hits as semantic ones.

An empty corpus returns `mode: "none"` with an explicit note, because zero hits
from an empty corpus and zero hits from a full one mean completely different
things.

---

## 3. RAG informs. It never authorises.

The retrieved block goes into the system prompt below the measured fact ledger
and above the session digest. It is stamped `REFERENCE ONLY` and the precedence
ladder travels with it — an unlabelled paragraph of official documentation is
the most authoritative-sounding text in the prompt, and would otherwise read as
permission.

That is enforced structurally, not by prompt wording:

- Every knowledge tool is `mutating: false`.
- No `server/src/knowledge/*` module imports `servicenow/*`, the orchestrator,
  the write guard, the mutation pipeline, or provenance — asserted by
  `test/knowledge-agent.test.js` over the import graph.
- `routes/knowledge.js` cannot reach ServiceNow at all.
- The tool-execution path (`executeTool`, where the approval gate lives) does
  not consult anything from the knowledge layer — also asserted.
- `canAuthorize()` returns false for any source set without a live read-back or
  a real capability result. `assertNotAuthorizedByKnowledge()` is the throwing
  form.

The approval gate, write guard, impersonation controls, elevation gate,
read-back verification and audit trail are all untouched.

---

## 4. Conflict handling

`server/src/knowledge/precedence.js`:

```
1. live PDI state
2. actual SNADA tool / SDK capability
3. current official documentation
4. LLM knowledge
```

Two behaviours worth knowing:

**An assertion is not a reading.** A claim tagged `live_pdi` or
`tool_capability` with no `evidence` attached is **demoted to model knowledge**,
and the demotion is reported. The model's belief about live state wearing live
state's authority is the most dangerous shape in this design.

**It stops rather than guessing.** Two contradictory claims at the same rung, or
no evidenced claim at all, returns `verdict: "stop_and_ask"` with the question to
put to the human. No tie-break is invented.

The spec's own example resolves cleanly: documentation says a feature exists,
the installed SDK does not support it → capability outranks documentation → the
feature is unavailable *here*, and no implementation of it may be generated.

---

## 5. SNADA knowledge memory

`snada_observations` — separate from both the documentation corpus (what
ServiceNow *says*) and the instance fact ledger (small, per-instance, broadcast
into every prompt).

Categories: `sdk-limitation`, `implementation-success`,
`implementation-failure`, `version-behaviour`, `tooling-defect`.

**Every row must carry the artifact.** `evidence_kind` is one of `read-back`,
`tool-result`, `instance-query`, `compile-output`, `http-error`, `test-run` —
"the model concluded it" is not on the list and never will be — and `evidence`
must be the error text, the read-back or the compiler output itself. A write
without one is refused. An observation with no evidence is an LLM output with a
database row, which is exactly what this store exists to be different from.

Scope follows the fact ledger's rule: `*` for a property of the SDK or the
platform, otherwise the instance it was measured on. A single-instance
measurement never leaks to another instance.

A recorded `sdk-limitation` or `tooling-defect` becomes a `tool_capability`
claim for the conflict ladder — which is how a measured limitation overrules a
documentation page, from data rather than from a rule written into a prompt.
`implementation-success` is deliberately **not** promoted: "it worked once" is
not a general capability claim.
