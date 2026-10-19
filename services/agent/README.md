# Mezodot agent

Keeper and data service for Mezodot: relays Wormhole messages in both directions, liquidates unhealthy accounts
through `KeeperGateway`, serves signed pull-price proofs to the web app, watches the oracle and the protocol's
owner/risk events, and exposes market data, risk analytics and keeper actions over HTTP and MCP.

| Module (`AGENT_MODULES`) | Does                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `relayer`                | spoke `Deposited` → hub `KeeperGateway.relayMessage`; hub `ReleaseSent` → spoke `receiveMessage`        |
| `liquidator`             | indexes borrowers (`Borrowed`), liquidates HF < 1, converts seized collateral back into repay inventory |
| `oracle`                 | oracle watchdog; with `PYTH_API_KEY`, pushes Pyth updates (ETH's Pyth leg, MUSD/MEZO when Mezo lags)    |
| `risk`                   | volatility, VaR, LTV advice, walk-forward + Deflated Sharpe (CoinGecko histories, every 30 min)         |
| `http`                   | the HTTP API below, `/mcp`, and the protocol revenue report                                             |

Safety never depends on the agent (contracts verify every VAA and price proof); it provides liveness.

## Run

```bash
cp services/agent/.env.example services/agent/.env   # MEZODOT_ENV is required; see the table below
pnpm --filter @mezodot/agent start                     # local (tsx)
docker compose up -d agent                             # production: rebuilds the image on every `up`
```

Every variable is validated at startup. A bad value (a key that is not 32 bytes of hex, `POLL_MS=6s`, an unknown
module, a 15-character `MCP_TOKEN`, …) stops the agent with a list of what is wrong; it never falls back silently.
The effective configuration is logged at startup with secrets replaced by `set`/`configured` and URLs by their host.

The image is two bundled files on `node:22-slim` (pinned by digest), run as the `node` user (uid 1000), read-only
root filesystem, no capabilities. `docker stop` sends SIGTERM: the agent stops scheduling work, waits up to 100 s
for work in flight (a liquidation waiting for its receipt, a collateral sale, relay deliveries), then exits; compose
allows 2 min. A wait cut short loses nothing: liquidator transactions are recorded before they are broadcast and
settled from chain state after the restart, and a relay is checked on-chain before it is delivered again.

Run one agent per keeper key. Two processes sending with the same key race for nonces and take over each other's
pending transactions; the stdio MCP server therefore never sends (see MCP).

## Configuration

| Variable                                   | Default                       | Meaning                                                                                       |
| ------------------------------------------ | ----------------------------- | --------------------------------------------------------------------------------------------- |
| `MEZODOT_ENV`                              | required                      | `testnet` or `devnet`                                                                         |
| `KEEPER_PRIVATE_KEY`                       | empty: read-only              | 32-byte hex key (`0x` optional). Needs BTC on Mezo, ETH on the spokes, MUSD/MEZO to repay     |
| `AGENT_MODULES`                            | all                           | comma-separated subset of the modules above                                                   |
| `POLL_MS`                                  | 4000                          | relayer interval (500..600000 ms); the liquidator runs at twice it                            |
| `RPC_<NETWORK>`                            | SDK default                   | e.g. `RPC_MEZO_TESTNET`; comma-separate several URLs for a fallback transport                 |
| `MIN_PROFIT_USD`                           | 1                             | minimum liquidation profit after gas, fees and realising the seized collateral                |
| `LIQUIDATE_UNSELLABLE`                     | `hold`                        | seized collateral Tigris would not buy back for the repayment: `hold` it, or `skip` the pair  |
| `MAX_SALE_DISCOUNT_BPS`                    | 500                           | largest discount to the oracle value accepted when selling seized collateral                  |
| `MIN_GAS_BALANCE_<NETWORK>`                | 0.0001 BTC / 0.002 / 0.01 ETH | keeper native balance below which `/health` is degraded                                       |
| `ALERT_WEBHOOK_URL`                        | none                          | receives a JSON POST on every health change and every owner/risk event                        |
| `FETCH_TIMEOUT_MS`                         | 8000                          | deadline for Wormholescan, Supra, Hermes, CoinGecko and webhook requests                      |
| `TX_RECEIPT_TIMEOUT_MS`                    | 90000                         | how long a keeper transaction may stay unmined before it is re-sent with higher fees          |
| `ORACLE_WATCH_MS`                          | 30000                         | oracle watchdog (and Pyth pusher) interval                                                    |
| `PYTH_API_KEY`, `HERMES_URL`               | none, Pyth Hermes             | server-side Pyth pusher (never sent to browsers)                                              |
| `SUPRA_PROOF_URL`                          | Supra DORA testnet            | pull-proof endpoint                                                                           |
| `WORMHOLESCAN_API`, `WORMHOLE_VAA_APIS`    | Wormholescan testnet, none    | signed-VAA sources, tried in order (any `/v1/signed_vaa` API, e.g. a guardian endpoint)       |
| `HTTP_HOST`, `HTTP_PORT`                   | 127.0.0.1, 8787               | HTTP bind address                                                                             |
| `MCP_TOKEN`                                | none                          | bearer token (≥ 16 chars) for `/mcp`; required for `/mcp` when `HTTP_HOST` is not loopback    |
| `MCP_ALLOW_WRITE`                          | false                         | lets `trigger_liquidation`/`relay_message` execute over the agent's `/mcp` (with `MCP_TOKEN`) |
| `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS` | none                          | extra Host headers / browser origins accepted on `/mcp`                                       |
| `STATE_DIR`                                | `.state` (`/data` in Docker)  | state files; a relative path is relative to `services/agent` (where `pnpm start` runs)        |

## HTTP API

Read-only JSON with open CORS, except `/mcp`. Errors never carry upstream text: viem errors embed RPC URLs, and
those can carry API keys, so only a one-line summary with URLs removed is returned (and logged).

| Path                                  | Returns                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `GET /health`                         | health report; **503** when a critical check fails (see below)                                    |
| `GET /status`                         | the same report, always 200 (dashboards, load-balancer probes)                                    |
| `GET /metrics`                        | Prometheus text: loops, checks, balances, transactions, relayer backlog, oracle, revenue          |
| `GET /oracle/update?symbols=ETH,USDC` | signed Supra pull proofs to attach to a transaction                                               |
| `GET /oracle/health`                  | per-feed status, checked again when the report is stale; 503 when a feed is unusable              |
| `GET /revenue`                        | pool reserves and reserve factors, flash fees, reserve withdrawals, bad debt, treasury collateral |
| `GET /stats`                          | borrowers, debt, cross-chain borrow ratio, revenue totals                                         |
| `GET /liquidatable`                   | accounts below HF 1.2 with the liquidation plan and the keeper's net assessment                   |
| `GET /messages?pending=1&limit=100`   | relay messages with status, age and whether they are stuck                                        |
| `GET /events?limit=50`                | owner and risk-parameter events on the hub and spokes                                             |
| `GET /risk`                           | the risk report                                                                                   |
| `POST /mcp`                           | MCP Streamable HTTP (see below)                                                                   |

Behind a reverse proxy, probe `/status` for routing: it answers 200 whenever the agent does. `/health` turns 503 when
the keeper needs attention (no gas, stuck relays) and `/oracle/health` whenever any feed is unusable (MUSD while
Mezo's pusher lags, say), and neither must take the web app's `/oracle/update` relay out of rotation. Alert on those
two instead. `/oracle/health` stays live without the `oracle` module: a report older than two watchdog intervals is
checked again on request (one router read for all concurrent requests).

## Health, metrics and alerts

`/health` lists every check with `ok`, `severity` and a one-line `detail`. Critical checks make it answer 503:

- `loop:<name>`: no successful run for 3 intervals (at least 2 min), or a run in flight for 10 intervals (at
  least 5 min). `relayer`, `liquidator` and `oracle` are critical; `risk`, `revenue`, `pyth-pusher`, `watch` warn.
- `oracle`: a feed nobody can refresh (risk checks touching it revert), or a watchdog report older than two
  intervals (the RPC is failing; the error is shown).
- `gas:<network>`: the keeper's native balance is below `MIN_GAS_BALANCE_<NETWORK>`, on every chain it sends on.
- `relayer:backlog`: a message this agent can deliver is still pending 3× its source chain's finality.
- `relayer:scan`: a source network's logs have not been readable for 2+ minutes (its messages go unseen).
- `tx:<network>`: a keeper transaction is stuck unmined after every fee bump. It recovers once that nonce is mined
  (checked every 30 s), also when nothing else is sent afterwards.

Warnings: `relayer:sequences` (a sequence number never seen in the logs), `liquidator:queue` (liquidatable accounts
left alone, e.g. `no repay inventory`, `unpriced`, `unprofitable`), `tx:<network>` revert rate above 25%.

The report also carries native balances, repay inventory, held seized collateral, the relayer backlog, the
deployment the agent runs against, Pyth pusher status, transaction counts and the latest admin events.

With `ALERT_WEBHOOK_URL`, every check that fails or recovers, and every new owner or risk event, is POSTed as JSON
(`status`, `changes`, `events`, plus `text`/`content` that Slack, Mattermost and Discord render as is). Undelivered
alerts are retried with the next ones. The admin watch covers `OwnershipTransferStarted/Transferred`, `FeedSet`,
`SourceSet`, `SpokeSet`, `HubEmitterSet`, `AdapterSet`, `VaultManagerSet`, `TreasurySet`, `LiquidationFeeSet`,
`CollateralAdded/ParamsSet`, `MarketAdded`, `CapsSet`, `ReserveFactorSet`, `ReservesWithdrawn`, `TokenSet`,
`Paused/Unpaused` and `BadDebtWrittenOff` on VaultManager, OracleRouter, WormholeAdapter, the pools and every
SpokeGateway. Events from before the first full scan (the deployment's own setup) are recorded, not alerted.

## Keeper transactions

All sends from the keeper on one chain go through one queue in the agent, so the relayer, the liquidator, the Pyth
pusher and the MCP write tools (over the agent's `/mcp`) never race for a nonce. Gas is `max(floor, estimate × 1.3 +
20k)` with per-call floors from measured usage (`GAS_FLOOR` in `@mezodot/sdk`: Pyth update 200k each, VAA relay 250k,
Supra-proof call 1.2M, …): some Mezo RPC backends estimate as if no contract code ran. A receipt that reverted with ≥
98% of its limit used is retried once with double the limit (after a fresh estimate shows it still succeeds). A
transaction unmined after `TX_RECEIPT_TIMEOUT_MS` is re-sent at the same nonce with fees +30%, twice; if it is still
stuck, `/health` turns 503 and the next send takes over that nonce with higher fees. A transaction left pending by
another sender (a previous run, or another process using the key) is taken over the same way once it has stayed
pending for `TX_RECEIPT_TIMEOUT_MS`.

Transactions are signed locally, so every hash is known before it is broadcast. A broadcast that times out, or that a
fallback RPC answers with `already known`, is watched like any other, and failed receipt lookups (rate limits) are
polled again until the timeout. Only a receipt of one of the request's own transactions (first attempt or fee bump)
settles it. When the nonce is used by none of them (another request took the stuck nonce over and the stuck one won,
or a foreign transaction did), the call did not happen: it fails as `unknown` (`NonceConsumedError`) and is retried,
never reported as done. A transaction outcome is one of `success`, `reverted`, `out_of_gas`, `stuck`, `unknown` and
`failed` (nothing reached the chain) in `/metrics`.

## Liquidations

Each tick evaluates every indexed borrower at the prices a liquidation would post (fetching Supra proofs), orders
the liquidatable ones by uncovered debt, and sizes each plan against the repay inventory left. Before sending, the
plan is priced at what the keeper can realise, net of gas, the oracle update fee and the Wormhole fee:

- **BTC** (plain hub collateral): what Tigris pays for the seized amount (pool quote less 2% slippage). If that
  covers the repayment with `MIN_PROFIT_USD` to spare, the BTC is sold right after; otherwise `hold` liquidates
  anyway and keeps the BTC until a sale returns at least what was repaid, and `skip` leaves that pair.
  Every sale's minimum is at least the oracle value less `MAX_SALE_DISCOUNT_BPS`: a pool far below the oracle
  (testnet's sat ~5% low) never gets the keeper's BTC cheaply. The keeper's own gas (BTC is Mezo's native coin)
  is never sold: twice `MIN_GAS_BALANCE_MEZO_TESTNET` stays.
- **pTokens of the debt asset** (pMUSD for MUSD debt) redeem at par: what the receipt's `Liquidated` event says was
  seized, as far as the pool's idle cash allows; the rest is redeemed on later ticks.
- **pTokens of another asset** (pMEZO for MUSD debt) are worth what their pool's asset sells for: the MEZO they
  redeem into is quoted on Tigris for the debt asset like BTC (oracle bound, `hold` or `skip`), and once redeemed it
  is sold for the debt asset, so repay inventory comes back instead of turning into MEZO. Until then it is not MEZO
  repay inventory.
- **Spoke collateral** is paid on the spoke and taken at a 1% haircut, less the spoke gas of relaying the release
  (`receiveMessage`) that pays it to the keeper.

The pair is chosen at realisable value: the best few pairs at oracle prices are priced as above, and one that is
realised at once (sold, redeemed, paid on a spoke) goes before one whose seizure would be held, then the higher net
profit. A pair that does not pay falls back to the next one.

Seized collateral not yet converted is persisted (`heldCollateral` in `/health`) and retried every tick, also after
a restart. Every liquidation, redeem and sale is recorded in the state file before it is broadcast and settled from
chain state when its send gives up (stuck, receipts unreadable, a shutdown): its receipt is applied when found (a
seizure becomes a held lot, a sale releases its lot), and a record whose nonce another transaction has held for a
minute is dropped. While a conversion of a lot is unsettled the lot is left alone, and conversions are sized by the
lots, never by the wallet balance, so the keeper's own BTC or MEZO is never sold as seized collateral. Remote seizures
arrive on the spoke and are not converted by the agent.

## Relayer

Sources with guardian-signed VAAs are scanned to their `finalized` block (guardians sign nothing earlier). Only an
RPC that answers that it does not know the tag is scanned to the latest block instead, with the first VAA lookup
waiting out the chain's finality, and it is asked for the tag again 10 minutes later; a timeout or a 5xx on that
request fails the scan for one tick. VAA lookups back off from 10 s to 1 min while guardians have not signed, and go
to each VAA source in turn. Sequence numbers are tracked per emitter: one that never showed up in the logs (a lagging
replica, a reorg) is fetched by number. Failed deliveries back off to 10 min and are never abandoned; a message
pending 3× its source finality is flagged as stuck. A message whose payload names another contract or chain than the
one it is delivered to (a deposit made under a replaced hub, seen again by a rescan of a reused spoke) can never be
executed: it is archived (`relayer-<env>.archived.json`) instead of being retried. A RELEASE whose token transfer
failed on the spoke is recorded as `deferred`: the recipient calls `SpokeGateway.claim(token, to)`.

Deliveries run in one queue per target chain, so a congested chain (a release unmined through every fee bump during
a Sepolia fee spike) holds up neither the hub's deposits, nor releases to the other spokes, nor the next scans.

Relaying by hand (anyone can): fetch the VAA from
`https://api.testnet.wormholescan.io/v1/signed_vaa/<emitterChain>/<emitter as 32 bytes>/<sequence>` (base64), then
`cast send <keeperGateway> 'relayMessage(bytes)' 0x<vaa>` on Mezo for a deposit, or
`cast send <spokeGateway> 'receiveMessage(bytes)' 0x<vaa>` on the spoke for a release. The MCP `relay_message`
tool and the web app's "Relay it yourself" do the same.

## Redeploys

Every state file is tied to the contracts it describes: the relayer's cursors to the gateway or adapter they scan,
the borrower index and held collateral to the VaultManager, revenue totals, the risk report and the admin watch to
theirs. When the deployment JSON names other contracts, that state is not resumed: scanning restarts at the new
deployment's `startBlock`, so no borrower, deposit or release after the redeploy is skipped. Undelivered messages
and indexed borrowers of the old contracts are appended to `relayer-<env>.archived.json` and
`liquidator-<env>.archived.json`, and logged, so the old deployment's open positions stay visible.

A hub-only redeploy keeps the spokes, and their cursors stay valid: keep `relayer-<env>.json`. If it is reset anyway
(moved away, or written before deployment identities), the rescan from the spokes' `startBlock` sees the deposits
made under the previous hub again; their payload names the old adapter, so they are archived as undeliverable once
their VAA is fetched, not retried, and `/health` stays 200.

The image bakes in `packages/sdk`'s deployment JSON. `docker compose up -d agent` rebuilds it every time
(`pull_policy: build`); with plain `docker`, rebuild after every redeploy.

## MCP

Tools: `get_markets`, `get_position`, `get_oracle_health`, `get_risk_report`, `get_revenue`, `simulate_loop`,
`simulate_btc_leverage`, `simulate_btc_close`, `simulate_borrow`, `list_liquidatable`, `list_pending_messages`,
and the write tools `trigger_liquidation` and `relay_message`, which dry-run unless `MCP_ALLOW_WRITE=true`.
Balances are in token units (pTokens as 24-decimal shares, BTC as an 18-decimal token); BTC previews use live
Tigris quotes and flag a pool far from the oracle.

**stdio** (local clients). The launcher reads `services/agent/.env`; values in the client's `env` win. It follows the
running agent's state files read-only: a relative `STATE_DIR` (the default `.state` included) is resolved against
`services/agent`, whatever directory the client starts it in. It never sends a keeper transaction: it could not
record what one changes, and a second sender on the key would race the agent for nonces. Its write tools always
dry-run (`MCP_ALLOW_WRITE` is ignored there and logged); run them over the agent's HTTP `/mcp`.

```bash
claude mcp add mezodot --env MEZODOT_ENV=testnet -- node /path/to/mezodot/services/agent/bin/mcp-stdio.mjs
```

```json
{ "mcpServers": { "mezodot": { "command": "node", "args": ["/path/to/mezodot/services/agent/bin/mcp-stdio.mjs"], "env": { "MEZODOT_ENV": "testnet" } } } }
```

From the image, with the agent's state volume mounted read-only (`<compose project>_agent-state`; `docker volume ls`
shows it):

```bash
docker run --rm -i --env-file services/agent/.env -v mezodot_agent-state:/data:ro mezodot-agent:latest node mcp-stdio.mjs
```

**Streamable HTTP** (`/mcp`). Off on a non-loopback `HTTP_HOST` unless `MCP_TOKEN` is set; every request then
needs `Authorization: Bearer <MCP_TOKEN>`. Browsers are refused (no CORS; `Origin` must be in
`MCP_ALLOWED_ORIGINS`), the `Host` header must be loopback or in `MCP_ALLOWED_HOSTS` (checked before the body is
read), and bodies are capped at 512 KiB. Write tools over HTTP need both `MCP_ALLOW_WRITE=true` and a token.

```bash
claude mcp add --transport http mezodot https://agent.example.com/mcp --header "Authorization: Bearer $MCP_TOKEN"
```

## State

`STATE_DIR` holds small JSON files written atomically (temp file + rename): `relayer-<env>.json` (cursors,
messages, per-emitter sequences; delivered messages are pruned after 500 or a week), `liquidator-<env>.json`
(borrower index, held collateral, liquidator transactions not settled yet), `revenue-<env>.json`, `risk-<env>.json`,
`watch-<env>.json`, and the `*.archived.json` files described under Redeploys and Relayer. Only the agent writes
them.
