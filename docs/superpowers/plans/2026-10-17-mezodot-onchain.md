# Mezodot On-chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Mezodot PRD as real contracts (Mezo hub + Base/Eth Sepolia spokes), an agent service (relayer, liquidator, risk engine, MCP) and an on-chain frontend, fully tested on a local two-chain devnet; deployment scripts prepared but not executed.

**Architecture:** ERC-4626 pTokens that are also lending pools; VaultManager holds positions and risk; Wormhole Core messages (verified VAAs) carry spoke collateral state; permissionless KeeperGateway for agents. Off-chain TypeScript agent relays VAAs and liquidates; React app reads/writes via wagmi + Mezo Passport.

**Tech Stack:** Solidity 0.8.28, Foundry 1.5, OpenZeppelin 5, Pyth SDK; Node 22, TypeScript 5.9, viem 2, @modelcontextprotocol/sdk, Vitest 3; React 18, Vite 6, wagmi 2, RainbowKit 2, @mezo-org/passport.

**Spec:** `docs/superpowers/specs/2026-10-17-mezodot-onchain-design.md`

**Plan granularity note:** At the user's instruction ("lanjutkan semua hingga selesai") this plan pins exact interfaces and required tests per task instead of inlining full code, to avoid writing the system twice. The interfaces below are binding across tasks.

## Global Constraints

- Mezo testnet chainId `31611`; Wormhole chains: Mezo `50`, Eth Sepolia `10002`, Base Sepolia `10004`.
- All USD values and prices are WAD (1e18). Risk params in basis points (`uint16`, 10_000 = 100%).
- No upgradeability; admin is `Ownable2Step`; `Pausable` blocks deposit/borrow only — never repay, liquidate, withdraw.
- Every mutating external function is `nonReentrant`; tokens moved with `SafeERC20`.
- No hard-coded addresses in contracts; deployments live in `packages/sdk/src/deployments/<network>.json`.
- Commits: plain messages, no AI attribution trailers (user CLAUDE.md).
- UI never labels on-chain data "simulated"; when a network has no deployment it says so.

## Review Focus

1. **Flash-loan share-price manipulation** — depositing into a pool while its own flash loan is outstanding must not mint extra shares (`totalAssets` must include outstanding flash amount). Test in Task 3.
2. **Replayed or foreign VAA** — same VAA twice, or a VAA from an unregistered emitter/chain, must revert without crediting. Test in Task 6.
3. **Stale / low-confidence oracle** — risk-checked actions revert on prices older than 120 s or `conf/price > 2%`; views still return last price with its timestamp. Test in Task 4.
4. **Withdraw/liquidate leaving HF < 1 or exceeding LTV** — withdrawals that would break `Σ value×LTV ≥ debt` revert; liquidation is rejected when HF ≥ 1 and capped at 50% close factor. Test in Task 5.
5. **Unwind when hub debt relies on loop collateral** — unwind that leaves the account over max LTV reverts and returns nothing. Test in Task 7.

---

## Binding interfaces

```solidity
// contracts/src/libraries/Payload.sol
library Payload {
    uint8 constant VERSION = 1; uint8 constant DEPOSIT = 1; uint8 constant RELEASE = 2;
    struct Message { uint8 msgType; uint64 nonce; bytes32 account; bytes32 token; uint256 amount; }
    function encode(Message memory m) internal pure returns (bytes memory); // 106 bytes, packed
    function decode(bytes memory data) internal pure returns (Message memory); // reverts InvalidPayload
}

// contracts/src/interfaces/IWormhole.sol — subset of the official interface (same struct layout)
interface IWormhole {
    struct Signature { bytes32 r; bytes32 s; uint8 v; uint8 guardianIndex; }
    struct VM { uint8 version; uint32 timestamp; uint32 nonce; uint16 emitterChainId; bytes32 emitterAddress;
        uint64 sequence; uint8 consistencyLevel; bytes payload; uint32 guardianSetIndex; Signature[] signatures; bytes32 hash; }
    function publishMessage(uint32 nonce, bytes memory payload, uint8 consistencyLevel) external payable returns (uint64);
    function parseAndVerifyVM(bytes calldata encodedVM) external view returns (VM memory vm, bool valid, string memory reason);
    function messageFee() external view returns (uint256);
    function chainId() external view returns (uint16);
}

// contracts/src/hub/InterestRateModel.sol (all WAD, per-year inputs)
constructor(uint256 baseRatePerYear, uint256 slope1PerYear, uint256 kink, uint256 slope2PerYear);
function utilization(uint256 cash, uint256 borrows, uint256 reserves) public pure returns (uint256);
function borrowRatePerSecond(uint256 cash, uint256 borrows, uint256 reserves) external view returns (uint256);
function supplyRatePerSecond(uint256 cash, uint256 borrows, uint256 reserves, uint256 reserveFactor) external view returns (uint256);

// contracts/src/hub/PToken.sol — `contract PToken is ERC4626, MezodotPool, IERC3156FlashLender`
constructor(IERC20 asset, string name, string symbol, InterestRateModel irm, uint256 reserveFactorWad, address owner);
function setVaultManager(address vm) external onlyOwner;      // one-time
function accrueInterest() public;
function borrow(address account, uint256 amount, address receiver) external onlyVaultManager;
function notifyRepay(address account, uint256 amount) external onlyVaultManager returns (uint256 applied); // tokens already transferred in
function borrowBalanceCurrent(address account) external returns (uint256);
function borrowBalanceStored(address account) public view returns (uint256);
function totalBorrows() / totalReserves() / borrowIndex() / reserveFactor() / cash() views;
function borrowRatePerSecond() / supplyRatePerSecond() views;
function setCaps(uint256 supplyCap, uint256 borrowCap) external onlyOwner; function withdrawReserves(uint256, address) external onlyOwner;
// flash: maxFlashLoan, flashFee (9 bps), flashLoan — totalAssets includes flashOutstanding.

// contracts/src/hub/OracleRouter.sol
constructor(IPyth pyth, uint256 maxAge, uint256 maxConfBps, address owner);
function setFeed(bytes32 key, bytes32 priceId) external onlyOwner;        // key = keccak256(symbol)
function updatePrices(bytes[] calldata updates) external payable returns (uint256 feePaid); // refunds excess to msg.sender
function getPrice(bytes32 key) external view returns (uint256 priceWad);   // strict: age + confidence
function getPriceUnsafe(bytes32 key) external view returns (uint256 priceWad, uint256 publishTime);

// contracts/src/hub/VaultManager.sol
struct CollateralConfig { bool enabled; bool isRemote; address token; uint16 chainId; bytes32 remoteToken;
    uint8 decimals; bytes32 priceKey; uint16 ltvBps; uint16 ltBps; uint16 bonusBps; uint256 cap; }
struct Market { PToken pool; bytes32 priceKey; uint8 decimals; bool enabled; }
struct RiskSnapshot { uint256 collateralValue; uint256 adjustedCollateral; uint256 borrowLimit; uint256 debtValue; uint256 healthFactor; }
function addCollateral(CollateralConfig calldata c) external onlyOwner returns (uint256 id);
function setCollateralParams(uint256 id, uint16 ltvBps, uint16 ltBps, uint16 bonusBps, uint256 cap, bool enabled) external onlyOwner;
function addMarket(PToken pool, bytes32 priceKey) external onlyOwner returns (uint256 marketId);
function setAdapter(address adapter) external onlyOwner;
function setOperator(address operator, bool approved) external;
function depositCollateral(uint256 id, uint256 shares) external;                       // local only
function depositCollateralFor(address account, uint256 id, uint256 shares) external;  // operator; pulls from msg.sender
function withdrawCollateral(uint256 id, uint256 shares, address to, bytes[] calldata priceUpdate) external payable;
function withdrawCollateralFor(address account, uint256 id, uint256 shares, address to, bytes[] calldata priceUpdate) external payable; // operator
function withdrawRemote(uint256 id, uint256 amount, bytes32 recipient, bytes[] calldata priceUpdate) external payable;
function borrow(uint256 marketId, uint256 amount, bytes[] calldata priceUpdate) external payable;
function borrowFor(address account, uint256 marketId, uint256 amount, address receiver, bytes[] calldata priceUpdate) external payable; // operator
function repay(uint256 marketId, uint256 amount, address onBehalfOf) external returns (uint256 applied); // type(uint256).max = all
function liquidate(address account, uint256 marketId, uint256 repayAmount, uint256 collateralId, uint256 minSeize,
    address localReceiver, bytes32 remoteReceiver, bytes[] calldata priceUpdate) external payable returns (uint256 seized);
function creditRemote(address account, uint256 id, uint256 amount) external; // onlyAdapter
function remoteCollateralId(uint16 chainId, bytes32 token) external view returns (uint256 idPlusOne);
function collateralBalance(address account, uint256 id) external view returns (uint256);
function getRiskSnapshot(address account) external view returns (RiskSnapshot memory); // uses getPriceUnsafe
function collateralCount() / marketCount() / collaterals(id) / markets(id) views;
events: CollateralDeposited, CollateralWithdrawn, RemoteCredited, RemoteWithdrawRequested, Borrowed, Repaid, Liquidated, OperatorSet.

// contracts/src/hub/WormholeAdapter.sol
constructor(IWormhole wormhole, VaultManager vm, uint8 consistencyLevel, address owner);
function setSpoke(uint16 chainId, bytes32 emitter) external onlyOwner;
function receiveMessage(bytes calldata encodedVaa) external returns (bytes32 hash);   // DEPOSIT only
function sendRelease(uint16 chainId, bytes32 token, bytes32 recipient, uint256 amount) external payable returns (uint64 sequence); // onlyVaultManager
function messageFee() external view returns (uint256); function isConsumed(bytes32 hash) external view returns (bool);
events: DepositReceived(hash, chainId, account, token, amount), ReleaseSent(sequence, chainId, recipient, token, amount).

// contracts/src/spoke/SpokeGateway.sol
constructor(IWormhole wormhole, uint16 hubChainId, uint8 consistencyLevel, address owner);
function setHubEmitter(bytes32 emitter) external onlyOwner;
function setToken(address token, bool allowed, uint256 cap) external onlyOwner;
function deposit(address token, uint256 amount) external payable returns (uint64 sequence); // msg.value = wormhole fee
function receiveMessage(bytes calldata encodedVaa) external returns (bytes32 hash);          // RELEASE only
function locked(address token) external view returns (uint256); function isConsumed(bytes32) external view returns (bool);
events: Deposited(sequence, account, token, amount), Released(hash, recipient, token, amount).

// contracts/src/hub/LeverageManager.sol — IERC3156FlashBorrower
constructor(VaultManager vm, PToken pool, uint256 marketId, uint256 collateralId);
function loop(uint256 principal, uint256 leverageWad, uint256 minShares, bytes[] calldata priceUpdate) external payable returns (uint256 shares, uint256 debt);
function unwind(uint256 repayAmount, uint256 shares, uint256 minOut, bytes[] calldata priceUpdate) external payable returns (uint256 out);
event Looped(account, principal, leverageWad, shares, debt); event Unwound(account, repaid, shares, out);

// contracts/src/hub/KeeperGateway.sol
constructor(VaultManager vm, WormholeAdapter adapter);
function triggerLiquidation(address account, uint256 marketId, uint256 repayAmount, uint256 collateralId, uint256 minSeize,
    bytes32 remoteReceiver, bytes[] calldata priceUpdate) external payable returns (uint256 seized);
function relayMessage(bytes calldata vaa) external returns (bytes32);
function getRiskSnapshot(address account) external view returns (VaultManager.RiskSnapshot memory);
function keeperCount() external view returns (uint256); function stats(address) external view returns (uint64 liquidations, uint64 relays);
```

TypeScript (`packages/sdk`): `deployments` (`getDeployment(network)`), ABIs (`vaultManagerAbi`, `pTokenAbi`, …), `math` (`healthFactor`, `borrowCapacity`, `planLoop`, `supplyApy`), `pyth` (`fetchPriceUpdate(ids): Promise<{updates: Hex[]; prices}>`), `wormhole` (`fetchSignedVaa(chain, emitter, seq)`, `parseLogMessagePublished`), `payload` (`encodePayload`, `decodePayload`).

---

### Task 1: Monorepo restructure
**Files:** move `src/ index.html public/ vite.config.ts tsconfig.json app.config.ts eslint.config.js` → `apps/web/`; root `package.json` (workspace scripts), `pnpm-workspace.yaml` (`apps/*`, `packages/*`, `services/*`).
- [ ] Move with `git mv`; `apps/web/package.json` keeps current deps/scripts.
- [ ] Root scripts: `check` = `pnpm -r check && forge test --root contracts`.
- [ ] Verify `pnpm --filter web check && pnpm --filter web build` pass; commit.

### Task 2: Contracts scaffold, Payload, dev Wormhole
**Files:** `contracts/foundry.toml`, `remappings.txt`, `lib/` (OZ v5, pyth-sdk-solidity, forge-std), `src/libraries/Payload.sol`, `src/interfaces/IWormhole.sol`, `test/mocks/DevWormhole.sol`, `test/utils/VaaSigner.sol`, `test/Payload.t.sol`, `test/DevWormhole.t.sol`.
- DevWormhole: real VAA v1 format, single guardian; `publishMessage` emits `LogMessagePublished(sender, sequence, nonce, payload, consistencyLevel)`; `parseAndVerifyVM` checks `ecrecover(keccak256(keccak256(body)))`.
- Tests: encode/decode round-trip (fuzz), wrong length/version reverts; signed VAA verifies, tampered body/wrong signer invalid; sequence increments per emitter.

### Task 3: InterestRateModel + PToken
**Files:** `src/hub/InterestRateModel.sol`, `src/hub/MezodotPool.sol`, `src/hub/PToken.sol`, `test/InterestRateModel.t.sol`, `test/PToken.t.sol`, `test/mocks/MockERC20.sol`.
- Tests: kinked rate at 0/kink/100% util; supply rate ≤ borrow rate × util; deposit→borrow→warp 365d→exchange rate grows ≈ supply APY; reserves accrue RF share; debt rounds up; borrow/notifyRepay only VaultManager; withdraw capped by cash; caps; pause blocks deposit not withdraw; inflation attack (1 wei + donation) loses attacker money; **flash loan: fee to reserves, unpaid reverts, deposit during flash mints fair shares (Review Focus 1)**.

### Task 4: OracleRouter
**Files:** `src/hub/OracleRouter.sol`, `test/OracleRouter.t.sol` (MockPyth).
- Tests: negative/positive expo normalisation to WAD; stale > maxAge reverts (**RF 3**); conf > 2% reverts; `updatePrices` pays fee and refunds excess; unknown key reverts; `getPriceUnsafe` returns stale price with timestamp.

### Task 5: VaultManager (local collateral)
**Files:** `src/hub/VaultManager.sol`, `test/VaultManager.t.sol`, `test/utils/HubFixture.sol` (deploys MUSD/MEZO mocks, pools, MockPyth, oracle, VM).
- Tests: deposit/withdraw pToken collateral; borrow within LTV, over LTV reverts; HF formula vs hand calc; repay partial/all/onBehalfOf; withdraw breaking LTV reverts (**RF 4**); operator gating; liquidation only HF<1, close factor 50%, seize incl. bonus, `minSeize`; snapshot values; pause semantics.

### Task 6: WormholeAdapter + SpokeGateway (remote collateral)
**Files:** `src/hub/WormholeAdapter.sol`, `src/spoke/SpokeGateway.sol`, `test/CrossChain.t.sol`.
- Tests: spoke deposit locks + publishes DEPOSIT; hub receive credits; **replay and unregistered emitter/chain revert (RF 2)**; RELEASE-type to hub rejected; withdrawRemote checks HF then publishes RELEASE; spoke releases only from hub emitter, replay guarded; remote liquidation sends RELEASE to liquidator; cap enforcement; USDC 6-dec valuation.

### Task 7: LeverageManager
**Files:** `src/hub/LeverageManager.sol`, `test/LeverageManager.t.sol`.
- Tests: PRD flow C — 1,000 MUSD × 3 → collateral ≈ 3,000 MUSD of pMUSD, debt 2,000 + fee, HF ≈ 1.275 (LT 85%); leverage above LTV reverts; minShares guard; unwind returns equity ≈ principal − fees; **unwind leaving hub debt over LTV reverts (RF 5)**; requires operator approval.

### Task 8: KeeperGateway
**Files:** `src/hub/KeeperGateway.sol`, `test/KeeperGateway.t.sol`.
- Tests: liquidation through gateway pays keeper seized collateral; keeper count unique; relay counts; snapshot passthrough.

### Task 9: Invariants + PRD end-to-end
**Files:** `test/invariant/PoolInvariant.t.sol`, `test/invariant/CrossChainInvariant.t.sol`, `test/E2E.t.sol`.
- Invariants: `cash + totalBorrows ≥ totalReserves`; Σ user debt ≤ totalBorrows + dust; remote credit per (chain, token) ≤ spoke locked.
- E2E: flows A, B (Base spoke), C, plus remote liquidation round-trip.

### Task 10: Deploy scripts + devnet
**Files:** `contracts/script/DeployHub.s.sol`, `DeploySpoke.s.sol`, `ConfigureCrossChain.s.sol`, `DeployDevnet.s.sol`, `scripts/devnet/start.sh`, `contracts/.env.example`.
- Scripts read env (`MUSD`, `MEZO`, `PYTH`, `WORMHOLE`, feed ids), write `packages/sdk/src/deployments/<network>.json`. Devnet: anvil `31337` (hub, Wormhole chain 50) + anvil `31338` (spoke, chain 10004), DevWormhole + MockPyth + mock tokens, seeded liquidity and test accounts.
- Verify: `scripts/devnet/start.sh` brings up both chains and deployments JSON validates.

### Task 11: SDK package
**Files:** `packages/sdk/{package.json,src/index.ts,src/abis/*.ts (generated),src/deployments/*.json,src/math.ts,src/pyth.ts,src/wormhole.ts,src/payload.ts}`, `packages/sdk/scripts/gen-abis.mjs`, tests.
- Tests: math matches Solidity vectors (HF, capacity, loop plan); payload encode/decode equals Solidity bytes; `parseLogMessagePublished` on a real log fixture.

### Task 12–15: Agent service
**Files:** `services/agent/src/{config.ts,chains.ts,relayer.ts,liquidator.ts,risk/{stats.ts,dsr.ts,walkforward.ts,report.ts,history.ts},mcp/server.ts,http.ts,index.ts}`, `Dockerfile`, `docker-compose.yml`, tests.
- Task 12 Relayer: watch, fetch (wormholescan | devnet signer), submit, idempotent; tests with mocked fetch.
- Task 13 Liquidator: index, evaluate, profit, simulate, send; unit tests on selection/profit.
- Task 14 Risk engine: stats, DSR, walk-forward, LTV recommendation; reference-value tests; report from fixture history.
- Task 15 MCP + HTTP + Docker: tools per spec, write tools dry-run by default; tests call tool handlers directly.

### Task 16–17: Web on-chain
**Files:** `apps/web/src/{wagmi.ts,providers.tsx,hooks/*.ts,pages/*.tsx,components/*.tsx}`; remove `lib/engine.ts` simulation (keep pure math via sdk).
- Task 16: providers (Mezo Passport `getConfig`, chains incl. devnet), `useProtocol` (markets, snapshot, balances), `useTx` (approve + write + toast), Pyth update helper; network/deployment guard.
- Task 17: wire Markets (supply/withdraw), Borrow (borrow/repay), Cross-chain (spoke deposit + lifecycle + withdrawRemote), Loop (loop/unwind), Agents (risk report + keeper stats), Activity (events), Dashboard (KPIs from chain).
- Verify: typecheck, lint, unit tests, build; Playwright smoke against devnet (connect devnet account, supply, borrow, loop).

### Task 18: Devnet E2E (agent + contracts)
- Script `scripts/devnet/e2e.ts`: spoke deposit → relayer credits → borrow → MockPyth price drop → liquidator liquidates → RELEASE relayed → liquidator receives WETH on spoke. Assert each step.

### Task 19: Docs
- `README.md` (what/why/how, architecture diagram, quickstart), `docs/DEPLOY.md`, `docs/SECURITY.md` (threat model, limitations), update `TODO.md`.

### Task 20: Final review
- Fresh reviewer subagent over whole repo; fix findings; full `pnpm check`.
