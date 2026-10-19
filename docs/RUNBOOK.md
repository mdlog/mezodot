# Incident runbook (testnet)

What to do when something goes wrong: how it shows up, what to decide, the exact commands, and how to roll back. Each lever and its limits are explained in [SECURITY.md](SECURITY.md) (admin powers, pause semantics, oracle rules); deployment procedures are in [DEPLOY.md](DEPLOY.md). Rehearse the owner actions on the devnet (`pnpm devnet`, owner = anvil #0) before you need them.

## Setup

Run from the repository root. Owner actions are signed by the deployer key ([DEPLOY.md, key storage](DEPLOY.md#key-storage)); cast prompts for its password. Price pushes and relays can be sent by any funded account.

Every `forge script` broadcast here carries `--skip-simulation`, so the node estimates each transaction's gas. Without it forge sends the gas limits of its own Cancun simulation, which Ethereum Sepolia exceeds when a storage slot is written for the first time: `SpokeGateway.pause()` needs 130,038 gas there while forge sends about 61–69k, so the pause runs out of gas and the spoke keeps taking deposits. On Mezo the flag is required for every script that touches the MEZO or BTC precompile ([DEPLOY.md, step 1](DEPLOY.md#1-hub-mezo-testnet)); the commands use it on every chain. `cast send` always uses the node's estimate.

```bash
set -a; source contracts/.env.example; set +a        # RPCs, feeds, Supra pairs (no secrets)
KEYSTORE=~/.mezodot/keystores/deployer               # owner; anything funded for permissionless actions
AGENT=https://<agent-host>
D=packages/sdk/src/deployments
VM=$(jq -r .contracts.vaultManager $D/mezo-testnet.json)
OR=$(jq -r .contracts.oracleRouter $D/mezo-testnet.json)
ADAPTER=$(jq -r .contracts.wormholeAdapter $D/mezo-testnet.json)
KEEPERS=$(jq -r .contracts.keeperGateway $D/mezo-testnet.json)
PMUSD=$(jq -r .contracts.pMUSD $D/mezo-testnet.json); PMEZO=$(jq -r .contracts.pMEZO $D/mezo-testnet.json)
BASE_GW=$(jq -r .contracts.spokeGateway $D/base-sepolia.json); ETH_GW=$(jq -r .contracts.spokeGateway $D/eth-sepolia.json)
FEED_T='((uint8,uint32,bytes32),(uint8,uint32,bytes32),uint16,uint16)'   # OracleRouter.Feed
NONE='(0,0,0x0000000000000000000000000000000000000000000000000000000000000000)'   # an empty Feed leg
```

First look, any incident:

```bash
curl -s $AGENT/health | jq '.checks[] | select(.ok | not)'   # failing checks (oracle, gas:<network>, tx:<network>, relayer:*, loop:*)
curl -s $AGENT/oracle/health | jq '.feeds[] | {symbol, status, validForSec}'
pnpm verify:deployment mezo-testnet --brief                  # wiring, owners, feeds, pauses, spoke backing
```

The agent also posts every health-check change to `ALERT_WEBHOOK_URL` when it is set.

## 1. Oracle outage

**Detect.** `/oracle/health` answers 503 once a feed is `unavailable` (no usable price and nobody can refresh it; transactions revert with `PriceUnavailable(bytes32)`) or its report is stale. A feed that is `expiring` (under a fifth of its max age left: 13 minutes for MUSD and MEZO) still answers 200; it shows only in the body and in the agent log (`MUSD expiring`, then `MUSD unavailable`). For an early warning, alert on the body, not the status code:

```bash
# Pull-backed feeds (ETH, BTC, USDC's Supra leg) expire every 120 s by design; only the single-leg push feeds
# (MUSD, MEZO) warn early when they run low.
curl -s $AGENT/oracle/health | jq -e '(.stale | not) and all(.feeds[]; .status != "unavailable" and (.status != "expiring" or (.symbol != "MUSD" and .symbol != "MEZO")))'   # non-zero exit: act now
```

Directly: `cast call $OR "getPriceInfo(bytes32)(bool,uint256,uint256)" $(cast keccak MUSD) --rpc-url $MEZO_RPC` returns `false` (or a `validUntil` within minutes).

**Impact.** Debt is priced strictly, so for an unavailable key: borrows, withdrawals with debt, liquidations of positions that hold it, MUSD loop opens and BTC leverage opens and partial closes revert. Repayments, full BTC closes, full unwinds and debt-free withdrawals keep working. A collateral key that is unavailable counts as $0 toward borrowing but never makes a position liquidatable.

**Act.** Pushing a price is permissionless; no owner key is needed.

- **MUSD / MEZO** (Pyth push only; Mezo's pusher normally refreshes them hourly, with ~5 minutes of slack against the 3,900 s max age). Push a fresh Pyth update yourself with a Pyth key that is _entitled to the feed_ (a 403 means it is not; the key in use today is not entitled to MUSD or MEZO, and `curl -s $AGENT/health | jq .pythPusher` lists the feeds the agent's key cannot refresh), and ask Mezo to check their pusher:

  ```bash
  UPDATE=$(curl -fsS -H "Authorization: Bearer $PYTH_API_KEY" \
    "https://hermes.pyth.network/v2/updates/price/latest?ids[]=$MUSD_FEED&ids[]=$MEZO_FEED&encoding=hex" | jq -r '.binary.data[0]')
  FEE=$(cast call $OR "updateFee(bytes[])(uint256)" "[0x01$UPDATE]" --rpc-url $MEZO_RPC | cut -d' ' -f1)   # 0 on Mezo testnet
  cast send $OR "updatePrices(bytes[])" "[0x01$UPDATE]" --value $FEE --rpc-url $MEZO_RPC --keystore $KEYSTORE
  cast call $OR "getPriceInfo(bytes32)(bool,uint256,uint256)" $(cast keccak MUSD) --rpc-url $MEZO_RPC   # true, price, new validUntil
  ```

  Pyth keeps only newer prices, so a push can never move a price back.

- **USDC** (Pyth push at 3,900 s plus a 120 s Supra leg), **BTC** and **ETH** (120 s Pyth legs, which the agent's keyed pusher refreshes about every minute, plus 120 s Supra legs): nothing to do on-chain. Every transaction that needs the price attaches a Supra proof when the stored one would expire first (the web app and the keeper get it from the agent's `/oracle/update`). If the agent relay is down, fetch one directly; `pair_indexes`: ETH 19, USDC 89, BTC 18:

  ```bash
  PROOF=$(curl -fsS -X POST https://rpc-testnet-dora-2.supra.com/get_proof -H 'content-type: application/json' \
    -d '{"pair_indexes":[18],"chain_type":"evm"}' | jq -r .proof_bytes)
  echo "[0x02${PROOF#0x}]"     # the bytes[] priceUpdate argument; or store it now (valid 120 s):
  cast send $OR "updatePrices(bytes[])" "[0x02${PROOF#0x}]" --rpc-url $MEZO_RPC --keystore $KEYSTORE
  ```

- If Supra's endpoint itself is down, ETH and BTC prices come only from the agent's keyed pusher (`curl -s $AGENT/health | jq .pythPusher`); without it, ETH- and BTC-backed borrowing and liquidations wait for Supra. Nothing on-chain needs changing.

**Recover.** `getPriceInfo` returns `true` with a `validUntil` about an hour out (MUSD, MEZO, USDC; at most 120 s for ETH and BTC), and `/oracle/health` lists no feed `expiring` or `unavailable`.

## 2. Oracle divergence or a bad price

**Detect.** Transactions revert with `PriceDiverged(bytes32)` (legs disagree beyond 1.5%: the router fails closed), or a served price is far from the market (compare with an independent reference), or liquidations hit positions that should be healthy. Both stored legs and the feed config:

```bash
KEY=$(cast keccak ETH)
cast call $OR "feeds(bytes32)($FEED_T)" $KEY --rpc-url $MEZO_RPC                      # (primary), (secondary), conf cap, divergence cap
PYTH_SRC=$(cast call $OR "sources(uint8)(address)" 1 --rpc-url $MEZO_RPC)
SUPRA_SRC=$(cast call $OR "sources(uint8)(address)" 2 --rpc-url $MEZO_RPC)
cast call $PYTH_SRC "latest(bytes32)(uint256,uint256,uint256)" $ETH_FEED --rpc-url $MEZO_RPC                  # price, conf (WAD), publishTime
cast call $SUPRA_SRC "latest(bytes32)(uint256,uint256,uint256)" $(cast to-uint256 $ETH_SUPRA_PAIR) --rpc-url $MEZO_RPC
```

**Decide.** A divergence revert is the safe failure: prices stop, nothing is mispriced. Act on-chain only when a leg is _wrong_ and still served (it is the fresher one, or the only one), or when a vendor contract changed under you (Supra's admin can upgrade its pull contract).

**Act (owner).** Pausing is not enough: liquidations and remote credits ignore it. In this order:

1. Stop new risk: pause the hub and both spokes (`ACTION` defaults to `pause`; `ACTION=unpause` undoes it, and any other value is refused before anything is sent):

   ```bash
   (cd contracts && MODE=hub NETWORK=mezo-testnet forge script script/Pause.s.sol --rpc-url $MEZO_RPC --keystore $KEYSTORE --broadcast --skip-simulation --slow)
   (cd contracts && MODE=spoke NETWORK=base-sepolia forge script script/Pause.s.sol --rpc-url $BASE_SEPOLIA_RPC --keystore $KEYSTORE --broadcast --skip-simulation --slow)
   (cd contracts && MODE=spoke NETWORK=eth-sepolia forge script script/Pause.s.sol --rpc-url $ETH_SEPOLIA_RPC --keystore $KEYSTORE --broadcast --skip-simulation --slow)
   cast call $ETH_GW "paused()(bool)" --rpc-url $ETH_SEPOLIA_RPC   # true; same for $BASE_GW, $VM, $PMUSD, $PMEZO
   ```

2. Take the bad leg out of service. Record the current config first (the `feeds` and `sources` output above) so you can restore it.
   - One key: re-set its feed without the bad leg. Example, ETH on Pyth only (it then needs a Pyth pull update per transaction) or on Supra only:

     ```bash
     cast send $OR "setFeed(bytes32,$FEED_T)" $(cast keccak ETH) "((1,120,$ETH_FEED),$NONE,200,0)" --rpc-url $MEZO_RPC --keystore $KEYSTORE
     cast send $OR "setFeed(bytes32,$FEED_T)" $(cast keccak ETH) "((2,120,$(cast to-uint256 $ETH_SUPRA_PAIR)),$NONE,200,0)" --rpc-url $MEZO_RPC --keystore $KEYSTORE
     ```

   - A historical price picked on purpose (a caller may submit any signed Pyth update newer than the stored one while it is within the leg's max age; [SECURITY.md, price pick window](SECURITY.md#price-pick-window)): shorten the max age of the 3,900 s legs while prices move fast. USDC's Pyth leg at 120 s makes USDC a pull feed like ETH (a Supra proof per transaction, unless the agent's Pyth key covers USDC). A shorter MUSD or MEZO max age leaves no keyless fallback: the key is unavailable from that long after each push until the next one, which stops borrows and liquidations touching it in between. Restore `3900` afterwards (`verify:deployment` reports the difference until then):

     ```bash
     cast send $OR "setFeed(bytes32,$FEED_T)" $(cast keccak USDC) "((1,120,$USDC_FEED),(2,120,$(cast to-uint256 $USDC_SUPRA_PAIR)),200,150)" --rpc-url $MEZO_RPC --keystore $KEYSTORE
     cast send $OR "setFeed(bytes32,$FEED_T)" $(cast keccak MUSD) "((1,600,$MUSD_FEED),$NONE,500,0)" --rpc-url $MEZO_RPC --keystore $KEYSTORE   # usable for 10 min per push
     ```

   - A whole vendor: `setSource` to zero makes every leg on that tag unusable at once (keys with another leg keep serving from it):

     ```bash
     cast send $OR "setSource(uint8,address)" 2 0x0000000000000000000000000000000000000000 --rpc-url $MEZO_RPC --keystore $KEYSTORE   # 2 = Supra, 1 = Pyth
     ```

   - Last resort, freeze everything: removing Pyth (tag 1) makes MUSD and MEZO unpriceable, which stops every borrow and every liquidation of MUSD/MEZO debt. Users can still repay and, once debt-free, withdraw.

3. Stop the keeper from acting on the bad price: set `AGENT_MODULES=relayer,risk,http,oracle` (no `liquidator`) in `services/agent/.env` and recreate the container with `docker compose up -d --no-build agent` (or stop and start `pnpm start`; without `--no-build`, compose first rebuilds the image from the working tree while the old container keeps running). `docker compose restart agent` keeps the environment the container was created with, and a variable set inline on the `docker compose` command line never reaches the container: compose passes it `services/agent/.env` only.

**Recover.** Restore the recorded configuration (`setSource(2, $SUPRA_SRC)`: the same `SupraSource` keeps its cache; the original feeds are in `contracts/.env.example` and in `pnpm verify:deployment` output), check with `set -a; source contracts/.env.example; set +a; pnpm verify:deployment mezo-testnet` (feeds must match the policy), re-enable the liquidator (all five `AGENT_MODULES`, `docker compose up -d --no-build agent`), then unpause: step 1's commands with `ACTION=unpause`.

## 3. Bridge or guardian incident

### A message is stuck (liveness)

**Detect.** `/health` check `relayer:backlog` fails; `curl -s "$AGENT/messages?pending=1"` lists messages with `stuck: true`; a deposit never reaches "Credited" in the UI. Guardians sign only after source-chain finality (about 17 minutes on Base Sepolia, 14 on Ethereum Sepolia, under a minute on Mezo), so check the age first.

**Act.** Anyone can relay; the contracts verify the VAA and consume each one once. Fetch the signed VAA from Wormholescan (chain ids: Mezo 50, Base Sepolia 10004, Ethereum Sepolia 10002; the emitter is the sending contract; the sequence is in the `Deposited` / `ReleaseSent` event or in `/messages`) and submit it:

```bash
vaa() { curl -fsS "https://api.testnet.wormholescan.io/v1/signed_vaa/$1/$(cast abi-encode 'f(address)' $2 | cut -c3-)/$3" | jq -r .vaaBytes | base64 -d | od -An -tx1 | tr -d ' \n'; }
# DEPOSIT from Base Sepolia, sequence 7 → the hub
cast send $KEEPERS "relayMessage(bytes)" 0x$(vaa 10004 $BASE_GW 7) --rpc-url $MEZO_RPC --keystore $KEYSTORE
# RELEASE from the hub, sequence 3 → Base Sepolia
cast send $BASE_GW "receiveMessage(bytes)" 0x$(vaa 50 $ADAPTER 3) --rpc-url $BASE_SEPOLIA_RPC --keystore $KEYSTORE
```

`AlreadyConsumed` means it was delivered already. A release whose token transfer failed is not lost: it is held as `claimable` (`ReleaseDeferred` event) and the recipient calls `claim(token, to)` on the spoke.

### Guardian or bridge compromise (forged VAAs possible)

**Detect.** Wormhole security announcements; `RemoteCredited` without a matching spoke `Deposited`; `pnpm verify:deployment` failing `hub credit ≤ locked` or `held ≥ locked`.

**Act (owner).** Pause does not stop DEPOSIT credits or RELEASEs. Cut the bridge in both directions instead; with no emitter registered, the hub rejects every DEPOSIT and refuses to send RELEASEs, and the spoke rejects every RELEASE and blocks deposits:

```bash
ZERO=0x0000000000000000000000000000000000000000000000000000000000000000
cast send $ADAPTER "setSpoke(uint16,bytes32)" 10004 $ZERO --rpc-url $MEZO_RPC --keystore $KEYSTORE
cast send $ADAPTER "setSpoke(uint16,bytes32)" 10002 $ZERO --rpc-url $MEZO_RPC --keystore $KEYSTORE
cast send $BASE_GW "setHubEmitter(bytes32)" $ZERO --rpc-url $BASE_SEPOLIA_RPC --keystore $KEYSTORE
cast send $ETH_GW "setHubEmitter(bytes32)" $ZERO --rpc-url $ETH_SEPOLIA_RPC --keystore $KEYSTORE
```

While cut, remote withdrawals and liquidations of spoke collateral revert and deposits wait. Then size the exposure (hub credit vs spoke locked per token: the spoke section of `pnpm verify:deployment`) and, if forged credit exists, stop borrowing against remote collateral: `setCollateralParams(id, ltv, lt, bonus, cap, false)` with the current values from `cast call $VM "collaterals(uint256)((bool,bool,bool,address,uint16,bytes32,uint8,bytes32,uint16,uint16,uint16,uint256))" <id>` (it keeps backing health, so nobody is liquidated by it).

**Recover.** Once the bridge is safe, restore the emitters the deployment JSON records, in both directions. Use `cast`, not `ConfigureCrossChain`: the script refuses to set an emitter, a cleared one included, while the link backs funds (hub credit for the spoke's tokens, or tokens locked on the spoke), because it cannot tell the gateway that was cut from a new one.

```bash
cast send $ADAPTER "setSpoke(uint16,bytes32)" 10004 $(cast abi-encode "f(address)" $BASE_GW) --rpc-url $MEZO_RPC --keystore $KEYSTORE
cast send $ADAPTER "setSpoke(uint16,bytes32)" 10002 $(cast abi-encode "f(address)" $ETH_GW) --rpc-url $MEZO_RPC --keystore $KEYSTORE
cast send $BASE_GW "setHubEmitter(bytes32)" $(cast abi-encode "f(address)" $ADAPTER) --rpc-url $BASE_SEPOLIA_RPC --keystore $KEYSTORE
cast send $ETH_GW "setHubEmitter(bytes32)" $(cast abi-encode "f(address)" $ADAPTER) --rpc-url $ETH_SEPOLIA_RPC --keystore $KEYSTORE
```

VAAs emitted while the link was cut are still valid and can be relayed afterwards; consumed hashes stay consumed. Verify (`pnpm verify:deployment`: emitters both ways, `hub credit ≤ locked`), then re-enable collateral.

## 4. Keeper out of gas or inventory

**Detect.** `/health` checks `gas:<network>` ("fund the keeper") or `tx:<network>` (a keeper transaction unmined) fail; `/liquidatable` lists positions below health 1 that stay there; the agent logs failed liquidations for lack of repay tokens.

**Act.** Fund the keeper address shown in `/health`: BTC on Mezo (gas; thresholds `MIN_GAS_BALANCE_<NETWORK>`), ETH on Base Sepolia and Ethereum Sepolia (RELEASE relays), and MUSD/MEZO repay inventory (a liquidation repays from the keeper's wallet). Seized pMUSD/pMEZO are redeemed and seized BTC is sold for MUSD on Tigris automatically; seized WETH/USDC arrive on the spoke and are not converted. Liquidation is permissionless, so any funded account can step in:

```bash
UPD=$(curl -fsS "$AGENT/oracle/update?symbols=MUSD,ETH" | jq -r '"[" + (.updates | join(",")) + "]"')   # what the risk check needs
cast send $(jq -r .tokens.MUSD $D/mezo-testnet.json) "approve(address,uint256)" $KEEPERS <repay> --rpc-url $MEZO_RPC --keystore $KEYSTORE
cast send $KEEPERS "triggerLiquidation(address,uint256,uint256,uint256,uint256,bytes32,bytes[])" \
  <account> 0 <repay> <collateralId> <minSeize> 0x0000000000000000000000000000000000000000000000000000000000000000 "$UPD" \
  --value $(cast call $ADAPTER "messageFee()(uint256)" --rpc-url $MEZO_RPC | cut -d' ' -f1) --rpc-url $MEZO_RPC --keystore $KEYSTORE
```

Market 0 is MUSD; the repayment is capped at half the debt; unused repay tokens and unspent BTC go back to the caller (BTC someone sent the gateway by mistake goes along only if the caller accepts it); remote collateral is released to the caller's address on the spoke. Size `minSeize` from the agent's `/liquidatable` assessment.

**Recover.** `/health` 200 and `/liquidatable` drains.

## 5. Bad debt

**Detect.** `BadDebtWrittenOff` events (VaultManager and the pool; the agent lists both in `/events` and posts them to `ALERT_WEBHOOK_URL`), `pnpm revenue:report` showing reserves used for bad debt, a falling pToken exchange rate. The Mezo RPC serves at most 10,000 blocks per log query and cast does not split a range, so scan in windows:

```bash
FROM=$(jq .startBlock $D/mezo-testnet.json); HEAD=$(cast block-number --rpc-url $MEZO_RPC)
for ((b = FROM; b <= HEAD; b += 10000)); do
  cast logs --from-block $b --to-block $((b + 9999 < HEAD ? b + 9999 : HEAD)) --address $VM "BadDebtWrittenOff(address indexed,uint256 indexed,uint256)" --rpc-url $MEZO_RPC
done
```

**Mechanism.** When a liquidation seizes an account's last collateral, the rest of its debt is written off: pool reserves absorb it first and suppliers bear the remainder through a lower exchange rate. Dust positions too small to liquidate profitably keep their debt until someone liquidates the dust.

**Act.** Liquidate leftover dust positions yourself (step 4) to settle them. To make suppliers whole, transfer the shortfall in the pool's asset to the pool: a plain transfer raises its cash and therefore the exchange rate for every supplier pro rata (`cast send <MUSD> "transfer(address,uint256)" $PMUSD <amount> ...`). Then fix the cause: lower LTV or raise the bonus with `setCollateralParams`, tighten caps with `setCaps`. Record a deliberate change where the deployment check reads the configuration, or `pnpm verify:deployment` with the deploy environment loaded keeps failing on it: risk parameters in the deploy scripts and `DEPLOYED_RISK` in `scripts/lib/verify.ts`, caps in `contracts/.env.example`. A later `ConfigureCrossChain` run leaves tuned WETH/USDC parameters alone unless `RECONCILE_PARAMS=1`.

## 6. Pause, and what it does not stop

```bash
cd contracts
MODE=hub NETWORK=mezo-testnet forge script script/Pause.s.sol --rpc-url $MEZO_RPC --keystore $KEYSTORE --broadcast --skip-simulation --slow               # VaultManager + pMUSD + pMEZO
MODE=spoke NETWORK=base-sepolia forge script script/Pause.s.sol --rpc-url $BASE_SEPOLIA_RPC --keystore $KEYSTORE --broadcast --skip-simulation --slow    # one SpokeGateway
MODE=spoke NETWORK=eth-sepolia forge script script/Pause.s.sol --rpc-url $ETH_SEPOLIA_RPC --keystore $KEYSTORE --broadcast --skip-simulation --slow      # the other one
ACTION=unpause MODE=hub NETWORK=mezo-testnet forge script script/Pause.s.sol --rpc-url $MEZO_RPC --keystore $KEYSTORE --broadcast --skip-simulation --slow
```

`ACTION` is `pause` (the default) or `unpause`; anything else (`PAUSE`, `paused`) is refused before a transaction is sent. A target already in the requested state is logged and skipped. Without `--skip-simulation` the Ethereum Sepolia pause runs out of gas ([Setup](#setup)); the single call is also `cast send $ETH_GW "pause()" --rpc-url $ETH_SEPOLIA_RPC --keystore $KEYSTORE`.

| Paused         | Stops                                                 | Still runs                                                                                                                   |
| -------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| VaultManager   | Borrows (so loop opens and BTC leverage opens)        | Collateral deposits and withdrawals, remote withdrawals, repay, `repayWithCollateral`, **liquidations**, **DEPOSIT credits** |
| PToken         | Supply (deposit, mint), pool borrows, **flash loans** | Withdraw, redeem, repayments, write-offs, reserve withdrawals                                                                |
| SpokeGateway   | New deposits                                          | **RELEASEs**, `claim`                                                                                                        |
| (not pausable) | —                                                     | Price updates, VAA relays, `KeeperGateway`, BTC closes, loop unwinds                                                         |

What pause does not stop, and the lever that does: liquidations at a wrong price (oracle, §2), credits from forged VAAs and releases (bridge cut, §3), borrowing against a doubtful collateral that is already posted (`setCollateralParams(..., enabled=false)`), the keeper's own actions (stop the agent or drop its `liquidator` module).

## 7. Key compromise

### Owner key (deployer = treasury)

**Impact.** Everything in [SECURITY.md, admin powers](SECURITY.md#admin-powers-testnet-the-deployer-eoa): the holder can repoint prices to drain the pools, re-point emitters to forge releases, withdraw reserves, and redirect fees. There is no timelock on testnet.

**Act, fast, from a clean machine** (the attacker holds the same powers; the first transaction wins):

1. Move ownership of all seven contracts to a fresh key (hardware wallet or multisig), then accept from it: [DEPLOY.md, ownership transfer](DEPLOY.md#10-ownership-transfer-and-key-rotation). If the attacker already proposed themselves, a new `transferOwnership` from the old key replaces the pending owner until they accept.
2. `setTreasury` to the new key and withdraw the old treasury's custody balances ([REVENUE.md](REVENUE.md#collecting)).
3. Check what changed while the key was exposed: `set -a; source contracts/.env.example; set +a; EXPECTED_OWNER=<new> EXPECTED_TREASURY=<new> pnpm verify:deployment mezo-testnet` compares owners, the treasury, feeds, sources, emitters, caps, the liquidation fee, every collateral's LTV, liquidation threshold and bonus, and both reserve factors with the documented configuration (the deploy environment and the deploy scripts' values). Every failure is a change to explain; `--brief` prints only those and the warnings. Also read the agent's `/events` (every owner and risk-parameter event, with its transaction), `SourceSet` in particular: the check identifies a price source only by the Pyth or Supra contract it reports wrapping, not by its code.
4. If the attacker acted, restore what they changed and tell users to exit; exits do not depend on the owner. Feeds and sources: §2; emitters: §3; risk parameters: `setCollateralParams(id, ltv, lt, bonus, cap, enabled)` with the deployed values (each failure names them); caps: `setCaps` and `SpokeGateway.setToken`; the fee: `setLiquidationFee`; reserve factors: `setReserveFactor`.

### Keeper key

No on-chain privilege (keepers are permissionless); the risk is its gas and inventory. Generate a new key, move the funds, set `KEEPER_PRIVATE_KEY` in `services/agent/.env` and recreate the agent with `docker compose up -d --no-build agent` (`restart` keeps the old key; §2, step 3).

### Agent secrets

- `MCP_TOKEN`: rotate it in `services/agent/.env` and recreate the agent (`docker compose up -d --no-build agent`); keep `MCP_ALLOW_WRITE=false` unless write tools are needed (they act only with the keeper key).
- `PYTH_API_KEY`: revoke it with Pyth, set the new one the same way; it is server-side only and never in a `VITE_*` variable.
- RPC URLs with embedded API keys (`RPC_<NETWORK>`, `VITE_RPC_URL_*`): rotate at the provider. The agent never echoes them in errors.

## 8. RPC outage

The agent's loops fail and `/health` reports `loop:*` checks stale. Point it at other endpoints with `RPC_MEZO_TESTNET`, `RPC_BASE_SEPOLIA`, `RPC_ETH_SEPOLIA` in `services/agent/.env` (one URL or a comma-separated list, tried in order) and recreate it with `docker compose up -d --no-build agent`. The web app tries `VITE_RPC_URL_<NETWORK>` (comma-separated, set at build time) before each chain's public default. `pnpm verify:deployment` and `pnpm revenue:report` read the same `RPC_<NETWORK>` values from the shell, lists included; `pnpm smoke:btc` uses the first URL of a list that answers (cast takes one).
