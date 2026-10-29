# Week 1 sandbox spikes

Dispute Desk's PayPal adapter was written from PayPal's published docs and is unit-tested against stubbed HTTP.
These spikes check it against the real sandbox. Time-box each at two hours, and save raw responses with
`node scripts/spike.ts show <disputeId> <label>`; they become fixtures for the simulator.

Setup: sandbox business account + app with the **Customer disputes** add-on on, two sandbox personal (buyer) accounts
(one with `allowappeal` in the email), funds in the business balance, credentials in `.env` (see `.env.example`).
Run `node scripts/spike.ts token` first.

| # | Question | How | Record |
|---|---|---|---|
| S1 | Can a buyer dispute an Orders-captured payment from the Resolution Center, and does the dispute's `seller_transaction_id` equal the capture ID? | `order 25` -> approve as the buyer -> `capture <orderId>` -> in sandbox.paypal.com as the buyer, open Resolution Center and report an item-not-received problem -> `disputes <captureId>` | The IDs on both sides. If they differ, fix `OrderBook.byCapture` matching. If the payment cannot be disputed, seed disputes against Send-money transactions and link them to demo orders by transaction ID. |
| S2 | What do stage, status, links and `allowed_response_options` look like right after creation and a few minutes later? | `watch <disputeId>` | Seconds until `provide-evidence` etc. appear. Save fixtures before and after. |
| S3 | Does `provide-evidence` with `PROOF_OF_FULFILLMENT` work, what status follows, and does `adjudicate` then resolve it and fire the RESOLVED webhook? | `evidence <id> UPS 1Z999 "Delivered"`, then `show`, then `adjudicate <id> SELLER_FAVOR` | The status after evidence (the simulator assumes `UNDER_REVIEW`). If a file upload is needed, check that `documents[].name` must match the multipart file name. |
| S4 | SNAD: do `make-offer` (REFUND) and `accept-claim` (PARTIAL_REFUND) behave as the simulator assumes? | `offer <id> 45`, `accept <id> 20`, buyer side in the UI | Status after each; whether the buyer must consent; whether the business balance needs funding first. |
| S5 | Does `process-chargeback` work with your app token, as a way to seed card-funded disputes? | Docs: Test and go live > Create chargeback | Yes/no and the scopes it needs. |
| S6 | Which dispute tools does PayPal's Agent Toolkit / MCP server expose today, and does the Server SDK cover Disputes? | Connect an MCP inspector to `npx @paypal/mcp --tools=all`; check the SDK's API list | The tool list. If the SDK lacks Disputes, keep `src/paypal/live.ts` (or generate a typed client with APIMatic). |

Also today: ask PayPal (developer Discord or the hackathon's Devpost discussion) to enable `DISPUTE_CREATE` and `UPDATE_BUYER`
on your sandbox app. The docs say these come through an account manager. Do not depend on the answer.

## When the simulator and the sandbox disagree

The simulator's transitions that PayPal's docs do not spell out are marked in `src/paypal/simulator.ts`
(what follows `provide-evidence`, what `escalate` leaves the status as, which outcome codes appear). Update those
first, then re-record the fixtures, then run `npm test`.

## Gate 1 (end of Week 1)

One real sandbox dispute created, defended through Dispute Desk and adjudicated, with fixtures saved.
