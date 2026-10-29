# Architecture

The canonical design doc (scope, plan, risks) lives with the project notes. This page is the short version that ships with the code.

## Life of a dispute

1. **Order captured.** `OrderBook.capture` stores a receipt, a product snapshot and a return-policy snapshot in the Evidence Vault, keyed by the PayPal capture (transaction) ID. Shipping and delivery add tracking items; every update is a new item, so history stays.
2. **Buyer opens a dispute.** PayPal sends `CUSTOMER.DISPUTE.CREATED`. `CaseManager.handleWebhook` verifies the signature (`PayPalGateway.verifyWebhook`), dedupes by event ID, then fetches the full dispute.
3. **Analysis.** `analyze()` runs triage, scores evidence for the dispute reason, prices ACCEPT / FIGHT / OFFER, drafts with citations and reviews the drafts. It returns typed `ActionProposal`s. It never calls PayPal.
4. **Decision.** The console shows the facts, the evidence checklist, the expected-loss table and an editable draft. Edits are re-checked live (`POST /api/cases/:id/check`).
5. **Execution.** `approve` hands the proposal to the `Executor`, which re-fetches the dispute, re-validates it against policy, calls PayPal once per idempotency key and writes the audit log.
6. **Resolution.** `CUSTOMER.DISPUTE.RESOLVED` records an outcome (won, lost, settled, accepted), updates KPIs and, for fights, the win-rate priors.

## Case states

`NEW > TRIAGED > ASSESSED > AWAITING_APPROVAL > EXECUTING > WAITING`, then `RESOLVED > OUTCOME_RECORDED > CLOSED`.
`WAITING` returns to `AWAITING_APPROVAL` when PayPal or the buyer needs the seller again (for example a declined offer, which re-runs the analysis without offers).
A failed PayPal call lands in `ACTION_FAILED` and can be retried. Illegal transitions throw.

## Decision engine

```
A = disputed amount   F = dispute fee if lost   p = P(win | reason, evidence bucket)   q(x) = P(buyer accepts offer x)

ACCEPT   expected loss = A
FIGHT    expected loss = (1 - p) * (A + F)
OFFER x  expected loss = q(x) * x + (1 - q(x)) * (1 - p) * (A + F)
```

- `p` comes from beta-binomial counts per (reason, strength bucket), seeded with assumptions and updated by resolved fights. The console says when odds are still assumptions.
- `q(x)` is a logistic in `x / A`. A buyer who received nothing wants nearly everything back (midpoint 0.85); for "not as described" a partial refund is plausible (0.5). Offers the buyer is very unlikely to take are not priced.
- An offer is preferred over fighting only if it wins by more than 3% of the amount, and fighting is not recommended below a 35% win probability.
- All of these are in `DEFAULT_CONFIG`. The $15 fee is illustrative; set your own.

## Evidence

`src/engine/evidence.ts` encodes PayPal's reason-to-evidence table and scores a weighted checklist per reason (item not received, not as described, and a generic fallback). Weights are starter values to tune with the evals.
Tracking status entered by the merchant is flagged as merchant-asserted; a carrier-verified flag would raise confidence.

## Trust boundaries

| Boundary | Enforced by |
|---|---|
| The model cannot move money | `Executor` is the only writer; it needs an approved `ActionProposal` |
| Only legal actions | `canDo()` checks the HATEOAS link PayPal returns right now |
| No unsupported claims | `checkCitations()` and the review step; the policy engine re-checks edits |
| Buyer text is data | Triage extracts fields; drafts never echo buyer text; injection attempts are flagged |
| Replays are harmless | Idempotency keys; webhook event IDs deduped |
| Tamper evidence | Hash-chained audit log (`AuditLog.verify`) |
| Sandbox only | `LivePayPal` refuses non-sandbox base URLs |

## Gateways

`PayPalGateway` has two implementations. `LivePayPal` calls the sandbox REST API (OAuth, Orders v2, Tracking, Disputes v1, webhook verification).
`SimulatedPayPal` models the Disputes API: statuses and stages, HATEOAS links by stage and status, allowed offer and claim types, evidence validation (file types, 10 MB limit), balance checks, PayPal's `ERRDIS` test values, appeals and webhooks.
Its unspecified transitions are guesses to be replaced by recorded sandbox fixtures (see `docs/SPIKES.md`).

## Extending

- **Persistence.** `Vault`, `AuditLog` and `CaseManager` hold state in memory. Swap in SQLite or Postgres behind the same methods.
- **A model.** Implement `LLM` (`triage`, `draft`, `review`); `ClaudeLLM` is the reference.
- **More reasons.** Add a rubric in `assess()` and offer types in the simulator.
- **MCP.** Expose `list_cases`, `get_case`, `draft_response` and `propose_action` over the MCP SDK; keep execution out of reach (approval only in the console).
