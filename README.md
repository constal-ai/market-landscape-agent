<!-- Copyright 2026 Coresource AI, Inc. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Market landscape agent

`market-landscape-survey` is a conversational text Agent, built on the [Constal](https://constal.ai) runtime, for researching a
market landscape. Send a natural-language market request—either a detailed
question or only a few keywords. The model interprets the request, plans the
research, and returns a natural-language report addressing:

1. Supply Side
2. Demand Side
3. Gaps & Market Dynamics

The Agent is open source under Apache 2.0. Its bindings default to the public
catalog and are the only environment-specific values in the package.

## Resource and tool contract

The deployment manifest (`constal.agent.json`) binds three logical names to
Resources in Constal's public catalog, the same catalog Horizon itself uses:

| Binding | Default Resource | Purpose |
| --- | --- | --- |
| `model` | `crn:constal:production:platform:default:model/gpt-5.6-terra` | The conversational model that plans research and writes the report. |
| `search` | `crn:constal:production:platform:default:service/constal-search` | The Service behind the `web_search` tool. |
| `web` | `crn:constal:production:platform:default:web/constal` | The Web Resource behind the `web_fetch` tool. |

The agent offers exactly these research tools to the model on each turn:

| Tool | Binding | Purpose |
| --- | --- | --- |
| `web_search` | `search` | Discover material relevant to the request. |
| `web_fetch` | `web` | Retrieve material for closer examination. |

The tool names are the SDK's `webSearch` and `webFetch` helpers; each declares
the binding name and operation it needs, so the manifest lists only the enabled
local names. Deployment fails if a binding is missing, has the wrong Resource
kind, or lacks the required operation; the agent never substitutes a model,
search service, web service, or evidence source at run time.

Operators running another environment replace the three CRNs with equivalent
Resources of the same kinds. Any exact CRN or a `{ "kind": "local", ... }`
reference to a Resource in the deploying namespace is accepted.

## Durable execution and evidence recall

The agent runs in the runtime's `durable` mode: each platform dispatch runs one
`step` that resumes from the stored, content-addressed state (the request, every
research round, and the report) instead of replaying the journal. Every step
runs exactly one research turn; the first research turn that makes no tool call
is the final report, and the run result is still that plain report string.

Nothing in the agent limits queries, sources, turns, or how much of a page it
reads. The platform content-addresses every tool result and hands the agent
its full value and a ref. Full results stay in the context until the bound
model's own reported window is the constraint; then the oldest results are
released from the context, keeping the platform's preview and the ref, and the
model reads any of them back exactly with `recall_evidence`, choosing the text
window it needs. The window arithmetic uses only what the model reports
(context and output tokens) and the ratio measured from the previous turn. The
manifest `limits` remain the only backstop.

## Deploying

Deploy the repository with the public Constal CLI, then start a run in a
stable Session with the request as a JSON string:

```sh
constal auth login
constal deploy . --wait
constal runs start market-landscape-survey ebikes-eu --data '"electric bikes, Europe"' --deliver live
```

`limits` in the manifest are the platform's required admission settings for a
run; there is no second set of limits inside the agent. Policy governs which
operations are allowed and whether approvals are required. The package attaches
no Policies; the deploying workspace's Policy applies.

## Instant UI

The `ui/` directory is a durable Constal Instant UI: one request box, a live
feed of every visitor's surveys, and finished reports rendered from Markdown
with their citations. The bundle holds no credentials or agent logic. The
browser sends the request as a chat message over the host-owned
`/_constal/channel` route and polls `/_constal/runs/:id` until the Run
completes; the UI's own SQLite state (`ui/worker.mjs`) records each survey,
its heartbeat, and its report so that:

- everyone sees surveys as they start, run, finish, or stall, through a
  versioned `/api/feed` that answers "unchanged" cheaply while tabs poll;
- every report has a public link, `/r/<id>`, that anyone can open;
- a browser that started a survey shows it immediately, keeps driving the Run
  in the background, resumes after a reload, and never waits on bookkeeping.

Only the browser that created a survey can update it; ownership is a random
token kept in that browser. The report is the Run's final result unchanged.

```sh
npm run ui:preview        # Labeled demo fixture at http://127.0.0.1:4173
npm run ui:preview:live   # Real Agent through your saved CLI credential
npm run ui:build          # dist/ui/bundle.json and its immutable hash
```

The UI is declared in the `ui` block of `constal.agent.json`, so
`constal deploy . --wait` publishes the Agent and the UI together: the platform
packages the `ui/` directory as the bundle and pins the
`market-landscape-workspace` UI Resource to the Agent revision it just built.
The UI is **public**: anyone with its hosted URL can run a survey, and each run
is charged to the deploying account within the manifest's `limits` and the
workspace Policy. Set `"access": {"mode": "authenticated", ...}` in that block
to require a Constal login instead. Console shows an **Open** button on the
Agent's page through the `app.constal.ai/primary` label.

## Using the agent

After deployment with compatible admitted bindings, send the agent the user's
market request as conversational text, through the Instant UI, the CLI, or the
platform's OpenAI-compatible endpoint with `model` set to
`market-landscape-survey`. A chat envelope with one user message is used as the
request; a longer conversation is rendered as a transcript. For example, a user might ask for a
landscape of a named sector in a region, or provide only a few market keywords.
No deterministic keyword classification, market parsing, or application-side
semantic routing is required or prescribed: the model interprets the original
request and determines the research strategy.

A message that is not plain text is serialized as JSON and handed to the model
unchanged; the agent does not parse or route structured requests.

Search results and fetched web material are **untrusted evidence**, not
instructions. The report contract expects the model to research iteratively when
useful and to preserve provenance: factual claims based on web-tool evidence
should include a citation or source identifier that locates the retrieved
source. It should clearly distinguish retrieved facts from synthesis or analysis,
estimates and their assumptions, and forecasts or other forward-looking
judgments.

A useful report also identifies material contradictions between sources and
explains the resulting limitation for the affected claim or section. Denied,
unavailable, empty, insufficient, or otherwise unusable retrieval must likewise
be disclosed for the affected claim or section, rather than represented as
successful research. Conclusions should state remaining uncertainty rather than
overstate what the available evidence supports.

## Local and structural checks

Install, typecheck, and run the structural tests:

```sh
npm ci
npm run check
```

The GitHub Actions `CI` workflow runs the same check on every push and pull
request. The `Deploy` workflow is started by hand from the Actions tab; it
runs the check and then `constal deploy . --wait` using the `CONSTAL_API_KEY`
secret of the `constal` environment, into the namespace given as its input.

The structural tests check
package and manifest identity, durable entry-point configuration (init, step, output), the
binding and tool declarations, and the source-level conversational orchestration.
Together these checks establish authored package, type, configuration, prompt,
and orchestration intent. They do **not** prove that a deployed model performed
research well, used either web capability, or produced a substantively adequate
report.

## Controlled live-runtime evaluation

Live research behavior requires a separate, controlled evaluation of a deployed
agent with compatible, admitted `model`, `search`, and `web` bindings under the
applicable Policy. Submit a representative natural-language market request and
review the runtime trace and final response together. The review should:

- confirm actual `web_search` and `web_fetch` activity and that returned tool
  observations (number, name, arguments, status, result or preview, and error)
  are available verbatim to later model turns until the model window releases
  them to recall_evidence, before the final no-tool response;
- compare citations or source identifiers for material factual claims with the
  observation numbers and URLs actually retrieved at runtime, including
  re-fetches made after compaction;
- assess, for the submitted topic, the substantive Supply Side, Demand Side, and
  Gaps & Market Dynamics analysis rather than merely checking headings or
  keywords;
- distinguish retrieved facts from synthesis, estimates, and forecasts; and
- inspect whether material contradictory, denied, unavailable, empty, or
  insufficient evidence encountered in the run is transparently handled for the
  affected claim or section.

Documentation, local typechecking, and structural checks are not substitutes for
this live evaluation. If deployment, a compatible binding, Policy, or admission
prevents the evaluation, record that concrete prerequisite and leave the related
claims about tool activity, provenance, report substance, and evidence handling
unverified.
