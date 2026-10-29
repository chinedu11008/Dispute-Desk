# Dispute Desk

AI dispute counsel for PayPal merchants. Evidence is gathered at checkout, a recommended move arrives in seconds, and one
tap submits it.

When a buyer opens a PayPal dispute, Dispute Desk:

1. **Already has the proof.** At checkout and fulfilment, an append-only Evidence Vault snapshots the receipt, listing,
   return policy, tracking and delivery proof.
2. **Triages and scores it.** It checks the vault against what PayPal accepts for that dispute reason and rates the evidence.
3. **Prices three moves.** Fight with evidence, make an offer, or accept the claim, by expected loss, including the fee if a fight is lost.
4. **Drafts with citations.** Every factual sentence must point to a stored evidence item, or it cannot be sent.
5. **Waits for a human.** The model proposes, a policy engine validates, you approve, and only then does code call PayPal.
6. **Learns.** Resolved fights update the win-rate estimates the next recommendation uses.

PayPal's Agent Toolkit can list a dispute and concede it. Dispute Desk adds the other half: evidence, offers, escalation and appeal.

## Run it (no install, no keys)

Needs Node 22.18 or newer. There are no runtime dependencies.

```bash
npm test            # 61 tests, fully offline
npm run demo        # the whole loop in your terminal, five sample disputes
npm start           # console at http://localhost:3000
```

Open the console, pick a sample dispute, and press **Send to PayPal**. In `SIMULATED` mode a "Sandbox control" bar lets you play PayPal
(rule for you or the buyer) and the buyer (accept or turn down an offer).

> `SIMULATED` mode uses a local model of PayPal's Disputes API built from PayPal's documentation. The console says so in the header.
> Use `LIVE_SANDBOX` to talk to PayPal's real sandbox.

## Use PayPal's sandbox

```bash
cp .env.example .env     # fill in sandbox credentials, set MODE=LIVE_SANDBOX
npm start
node scripts/spike.ts    # list helper commands (create an order, show a dispute, provide evidence, adjudicate)
```

Steps, and the open questions each one answers, are in [docs/SPIKES.md](docs/SPIKES.md). The adapter refuses any URL that is not a sandbox URL.
Point PayPal's webhooks at `<public url>/webhooks/paypal` for `CUSTOMER.DISPUTE.CREATED`, `UPDATED` and `RESOLVED`.

## Use a real model

```bash
LLM=claude ANTHROPIC_API_KEY=... npm start     # triage on a fast model, drafting and review on a stronger one
LLM_CACHE=record ...                           # save every model answer to cache/llm.json
LLM_CACHE=replay npm start                     # replay them later with no key (deterministic demos)
```

The default `LLM=heuristic` is a deterministic offline stand-in. It builds every sentence from a stored evidence item, so the
pipeline, citation rules and policy checks behave the same with or without a model.

## How it fits together

```
Console / API ──► CaseManager (state machine) ──► Agent pipeline ──► ActionProposal
      ▲                  │                          triage, assess,        │
      │ approve / edit   │ webhooks                 price, draft, review    ▼
      └──────────────────┤                                          Policy engine ──► Executor ──► PayPal gateway
                         ▼                                                                         (Live | Simulated)
                   Evidence Vault  ◄── Demo store (checkout, ship, deliver)
```

| Path | What it does |
|---|---|
| `src/engine/evidence.ts` | What PayPal accepts per dispute reason, and a weighted evidence score |
| `src/engine/decision.ts` | Expected loss for accept, fight and offer; priors that learn from outcomes |
| `src/agent/` | `pipeline.ts`, the `LLM` interface (`HeuristicLLM`, `ClaudeLLM`, `CachingLLM`) and the citation checker |
| `src/policy/policy.ts` | Rules every proposal must pass: action available now, evidence type allowed, amounts, deadline, citations |
| `src/exec/executor.ts` | The only code that writes to PayPal; idempotent, re-validates, logs |
| `src/orchestrator/cases.ts` | Case state machine, webhook handling, approvals, outcomes, KPIs |
| `src/paypal/` | `gateway.ts` interface, `live.ts` sandbox adapter, `simulator.ts` Disputes API model |
| `src/vault/`, `src/audit/` | Append-only evidence; hash-chained audit log |
| `public/index.html` | The console |

Design rules: the model never holds PayPal credentials; every money-moving action needs human approval; only actions whose
link PayPal currently returns can be proposed; amounts and fees are code, not prompts; buyer text is treated as data;
simulated and live data are never blurred.

## What is verified

- 61 automated tests: decision math, evidence scoring, citations, policy, the simulator state machine and PayPal's `ERRDIS` test values,
  the live adapter against stubbed HTTP (request shapes, retries, error mapping), the Claude provider, the case flow from webhook to outcome, and the HTTP API.
- The console was exercised in a headless browser: blocked edit, restore, send, adjudication, offer acceptance.
- **Not yet verified against PayPal's real sandbox.** The live adapter follows PayPal's published docs. Simulator transitions that the docs
  leave unspecified are marked in `src/paypal/simulator.ts` and are checked by the spikes in `docs/SPIKES.md`.
- The probabilities and the dispute fee are starting assumptions, labelled as such in the console. They are not PayPal data.

## License

MIT, see [LICENSE](LICENSE).
