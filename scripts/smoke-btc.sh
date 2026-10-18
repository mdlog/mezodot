#!/usr/bin/env bash
# BTC smoke test on a live hub, with tiny amounts, through cast. It exercises the path no automated test reaches:
# Mezo's BTC precompile (native-balance ERC-20) and the real Tigris pool, neither of which runs on an anvil fork.
#   1. BTC collateral: post to VaultManager and withdraw it again (no debt, no price needed).
#   2. BTC leverage: open 1.5x through SwapLeverageManager (Tigris flash swap), close half, close the rest.
# Every step is checked on-chain at the block it landed in: wallet movements, debt, collateral and events. Addresses
# come from packages/sdk/src/deployments/<network>.json. The signer is a Foundry keystore whose path and password
# file are passed as arguments and never printed. Use a dedicated account with no open position.
#
#   scripts/smoke-btc.sh --keystore <file> --password-file <file> [--network mezo-testnet] [--rpc <url>]
#       [--collateral 0.0001] [--principal 0.0002] [--leverage-bps 15000] [--slippage-bps 100]
#       [--supply <MUSD>] [--gas-reserve 0.001] [--dry-run]
#
# --supply deposits that much MUSD into pMUSD first (an open borrows from pMUSD's idle cash) and redeems it at
# the end. --dry-run stops after the preflight checks and quotes. Exits 0 when every check passed, 1 on the first
# failed check (the step it names says what is left open), 2 on a usage error. Needs cast, jq, bc and curl.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NETWORK=mezo-testnet
RPC=""
KEYSTORE=""
PASSWORD_FILE=""
COLLATERAL=0.0001
PRINCIPAL=0.0002
LEVERAGE_BPS=15000
SLIPPAGE_BPS=100
SUPPLY=0
GAS_RESERVE=0.001
DRY_RUN=false
# Keyless Supra DORA testnet proofs (SUPRA_TESTNET_PROOF_URL in the SDK); pair 18 = BTC/USD, router source tag 2.
SUPRA_URL=https://rpc-testnet-dora-2.supra.com/get_proof
SUPRA_TAG=02
DEADLINE_SEC=900
# Mezo's BTC: the native gas balance behind an ERC-20 precompile. Anywhere else (devnet) BTC is a plain token.
NATIVE_BTC=0x7b7c000000000000000000000000000000000000

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --keystore) KEYSTORE=${2:-}; shift 2 ;;
    --password-file) PASSWORD_FILE=${2:-}; shift 2 ;;
    --network) NETWORK=${2:-}; shift 2 ;;
    --rpc) RPC=${2:-}; shift 2 ;;
    --collateral) COLLATERAL=${2:-}; shift 2 ;;
    --principal) PRINCIPAL=${2:-}; shift 2 ;;
    --leverage-bps) LEVERAGE_BPS=${2:-}; shift 2 ;;
    --slippage-bps) SLIPPAGE_BPS=${2:-}; shift 2 ;;
    --supply) SUPPLY=${2:-}; shift 2 ;;
    --gas-reserve) GAS_RESERVE=${2:-}; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h | --help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

# --- output (nothing here ever prints the keystore path or the password file) -------------------------------

redact() {
  local s=$1
  [ -z "$KEYSTORE" ] || s=${s//"$KEYSTORE"/<keystore>}
  [ -z "$PASSWORD_FILE" ] || s=${s//"$PASSWORD_FILE"/<password-file>}
  printf '%s' "$s"
}
die() { echo "✗ $(redact "$*")" >&2; exit 1; }
ok() { echo "  ✓ $*"; }
note() { echo "  ! $*"; }
step() { echo; echo "› $*"; }

calc() { BC_LINE_LENGTH=0 bc <<<"$1"; }                       # integer math on uint256-sized values
# Wei → decimal units, trailing zeros trimmed ("0" stays "0").
show() { BC_LINE_LENGTH=0 bc <<<"scale=18; ($1) / 10^18" | sed -E 's/^(-?)\./\10./; /\./ { s/0+$//; s/\.$// }'; }
lc() { tr '[:upper:]' '[:lower:]' <<<"$1"; }
# expect <description> <bc boolean expression>; expect_eq <description> <actual> <expected> (case-insensitive)
expect() { [ "$(calc "$2")" = 1 ] && ok "$1" || die "$1  (failed: $2)"; }
expect_eq() { [ "$(lc "$2")" = "$(lc "$3")" ] && ok "$1" || die "$1  (expected $3, got $2)"; }

for tool in cast jq bc curl; do command -v "$tool" >/dev/null || die "$tool is required"; done
if [ -z "$KEYSTORE" ] || [ -z "$PASSWORD_FILE" ]; then echo "--keystore and --password-file are required" >&2; usage; fi
[ -r "$KEYSTORE" ] || die "the keystore file is missing or unreadable"
[ -r "$PASSWORD_FILE" ] || die "the password file is missing or unreadable"
MODE=$(stat -c '%a' "$PASSWORD_FILE" 2>/dev/null || stat -f '%Lp' "$PASSWORD_FILE")
[[ $MODE =~ 00$ ]] || note "the password file is readable by group or others: chmod 600 it (docs/DEPLOY.md, key storage)" >&2
WALLET=(--keystore "$KEYSTORE" --password-file "$PASSWORD_FILE")
ERR=$(mktemp)
trap 'rm -f "$ERR"' EXIT

# --- chain helpers: every read fails loudly instead of yielding an empty value ----------------------------

# call [--block N] <to> <signature> [args...] → cast's output with the " [1.2e18]" annotations dropped
call() {
  local out
  out=$(cast call --rpc-url "$RPC" "$@" 2>"$ERR") || die "eth_call $* failed: $(head -c 400 "$ERR")"
  sed -E 's/ \[[^]]*\]//g' <<<"$out"
}
# Field <n> (1-based) of a struct returned by call.
field_of() { tr -d '()' <<<"$1" | awk -F', ' -v n="$2" '{ print $n }'; }
balance() { cast balance --rpc-url "$RPC" "$@" 2>"$ERR" || die "eth_getBalance failed: $(head -c 400 "$ERR")"; }
now() { cast block latest --field timestamp --rpc-url "$RPC" 2>"$ERR" || die "cannot read the latest block: $(head -c 400 "$ERR")"; }
wei() { cast to-wei "$1" 2>/dev/null || die "not an amount: $1"; }

GAS_SPENT=0
LAST_BLOCK=""
LAST_FEE=0
LAST_MAX_FEE=0
RECEIPT=""
# send <label> <to> <signature> [args...]: node estimate +30% +20k gas (as the SDK does), keystore-signed.
send() {
  local label=$1 to=$2 sig=$3 estimate limit status hash price
  shift 3
  estimate=$(cast estimate --rpc-url "$RPC" --from "$ACCOUNT" "$to" "$sig" "$@" 2>"$ERR") || die "$label: estimate failed: $(head -c 600 "$ERR")"
  [[ $estimate =~ ^[0-9]+$ ]] || die "$label: unexpected gas estimate"
  limit=$((estimate * 13 / 10 + 20000))
  RECEIPT=$(cast send --rpc-url "$RPC" "${WALLET[@]}" --gas-limit "$limit" --json "$to" "$sig" "$@" 2>"$ERR") ||
    die "$label: $(head -c 600 "$ERR")"
  status=$(jq -r .status <<<"$RECEIPT")
  hash=$(jq -r .transactionHash <<<"$RECEIPT")
  [ "$status" = 0x1 ] || [ "$status" = 1 ] || die "$label reverted: $hash"
  LAST_BLOCK=$(cast to-dec "$(jq -r .blockNumber <<<"$RECEIPT")")
  price=$(cast to-dec "$(jq -r '.effectiveGasPrice // "0x0"' <<<"$RECEIPT")")
  LAST_FEE=$(calc "$(cast to-dec "$(jq -r .gasUsed <<<"$RECEIPT")") * $price")
  LAST_MAX_FEE=$(calc "$limit * $price")
  GAS_SPENT=$(calc "$GAS_SPENT + $LAST_FEE")
  ok "$label  $hash (block $LAST_BLOCK)"
}
# Non-indexed fields of the first <event signature> log that <address> emitted in the last receipt, one per line.
event_data() {
  local address topic data
  address=$(lc "$1")
  topic=$(cast keccak "$2")
  data=$(jq -r --arg a "$address" --arg t "$topic" '[.logs[] | select((.address | ascii_downcase) == $a and .topics[0] == $t)][0].data // empty' <<<"$RECEIPT")
  [ -n "$data" ] || die "no $2 event in the last transaction"
  cast abi-decode "f()($3)" "$data" | sed -E 's/ \[[^]]*\]//g'
}

# --- deployment -------------------------------------------------------------------------------------------

DEPLOYMENT="$ROOT/packages/sdk/src/deployments/$NETWORK.json"
[ -f "$DEPLOYMENT" ] || die "no deployment JSON for $NETWORK"
json() { jq -er "$1 // empty" "$DEPLOYMENT" || die "$NETWORK.json has no $1 (deployed before the flash-swap leverage desk?)"; }
VM=$(json .contracts.vaultManager)
SWAP=$(json .contracts.swapLeverageManager)
PAIR=$(json .contracts.tigrisPool)
ORACLE=$(json .contracts.oracleRouter)
PMUSD=$(json .contracts.pMUSD)
BTC=$(json .tokens.BTC)
MUSD=$(json .tokens.MUSD)
CHAIN_ID=$(json .chainId)
if [ -z "$RPC" ]; then
  RPC_VAR="RPC_$(tr '[:lower:]-' '[:upper:]_' <<<"$NETWORK")"  # the agent's override convention
  RPC=${!RPC_VAR:-}
  if [ -z "$RPC" ]; then
    case "$NETWORK" in
      mezo-testnet) RPC=https://rpc.test.mezo.org ;;
      devnet-hub) RPC=http://127.0.0.1:8545 ;;
      *) die "pass --rpc for $NETWORK" ;;
    esac
  fi
fi
BTC_KEY=$(cast keccak BTC)
MUSD_KEY=$(cast keccak MUSD)
MAX_UINT=$(cast max-uint)
WAD=1000000000000000000
if [ "$(lc "$BTC")" = "$NATIVE_BTC" ]; then BTC_NATIVE=true; else BTC_NATIVE=false; fi

# Wallet balances of the smoke account at <block> (default latest): BTC is the native balance on Mezo.
btc_balance() {
  if $BTC_NATIVE; then balance --block "${1:-latest}" "$ACCOUNT"; else call --block "${1:-latest}" "$BTC" "balanceOf(address)(uint256)" "$ACCOUNT"; fi
}
musd_balance() { call --block "${1:-latest}" "$MUSD" "balanceOf(address)(uint256)" "$ACCOUNT"; }

# expect_btc_moved <description> <signed wei>: the last transaction moved exactly that much BTC into (+) or out of
# (−) the wallet. On Mezo BTC is also the gas balance, so the receipt's fee comes off as well; the check allows up
# to the whole gas limit's fee there, so chain-specific fee accounting cannot fail it but a wrong amount does.
expect_btc_moved() {
  local delta
  delta=$(calc "$(btc_balance "$LAST_BLOCK") - $(btc_balance "$((LAST_BLOCK - 1))")")
  if ! $BTC_NATIVE; then
    expect "$1: wallet BTC moved by $(show "$2")" "$delta == $2"
  elif [ "$(calc "$delta == $2 - $LAST_FEE")" = 1 ]; then
    ok "$1: wallet BTC moved by $(show "$2") and $(calc "$LAST_FEE") wei of gas, exactly"
  else
    expect "$1: wallet BTC moved by $(show "$2") less at most the gas limit's fee (measured $(show "$delta"))" \
      "$delta <= $2 && $delta >= $2 - $LAST_MAX_FEE"
  fi
}
expect_musd_moved() {
  local delta
  delta=$(calc "$(musd_balance "$LAST_BLOCK") - $(musd_balance "$((LAST_BLOCK - 1))")")
  expect "$1: wallet MUSD moved by $(show "$2")" "$delta == $2"
}
# SwapLeverageManager holds nothing between transactions: the last one left its BTC and MUSD balances as they were
# (compared with the block before, so dust anyone sent it earlier cannot fail the check).
expect_manager_untouched() {
  local token before after
  for token in "$BTC" "$MUSD"; do
    before=$(call --block "$((LAST_BLOCK - 1))" "$token" "balanceOf(address)(uint256)" "$SWAP")
    after=$(call --block "$LAST_BLOCK" "$token" "balanceOf(address)(uint256)" "$SWAP")
    [ "$before" = "$after" ] || die "SwapLeverageManager kept $(show "$after - $before") of token $token after the last transaction"
  done
  ok "SwapLeverageManager kept no BTC or MUSD"
}

# Price updates for a call that prices the position (open, partial close): none while BTC's stored price stays
# valid for 3 more minutes, else a fresh keyless Supra proof for BTC's secondary leg. MUSD has no keyless leg.
price_update() {
  local info proof
  info=$(call "$ORACLE" "getPriceInfo(bytes32)(bool,uint256,uint256)" "$MUSD_KEY")
  if [ "$(sed -n 1p <<<"$info")" != true ] || [ "$(sed -n 3p <<<"$info")" -le "$(($(now) + 120))" ]; then
    die "MUSD price unavailable or about to expire: wait for Mezo's hourly Pyth push, or push one (docs/RUNBOOK.md, oracle outage)"
  fi
  info=$(call "$ORACLE" "getPriceInfo(bytes32)(bool,uint256,uint256)" "$BTC_KEY")
  if [ "$(sed -n 1p <<<"$info")" = true ] && [ "$(sed -n 3p <<<"$info")" -gt "$(($(now) + 180))" ]; then
    echo "[]"
    return
  fi
  [ "$NETWORK" = mezo-testnet ] || die "BTC price unavailable on $NETWORK and no keyless proof source is known for it"
  proof=$(curl -fsS --max-time 20 -X POST "$SUPRA_URL" -H 'content-type: application/json' -d '{"pair_indexes":[18],"chain_type":"evm"}' |
    jq -r '.proof_bytes // empty') || die "Supra proof request failed"
  [ -n "$proof" ] || die "Supra returned no proof"
  echo "[0x${SUPRA_TAG}${proof#0x}]"
}

# Smallest BTC sale whose pool quote covers <MUSD wei>: start at oracle prices, then scale by the quote's shortfall.
sell_for() {
  local target=$1 sell quote _
  sell=$(calc "$target * $MUSD_PRICE / $BTC_PRICE + 1")
  for _ in 1 2 3 4 5 6 7 8; do
    quote=$(call "$PAIR" "getAmountOut(uint256,address)(uint256)" "$sell" "$BTC")
    if [ "$(calc "$quote >= $target")" = 1 ]; then
      echo "$sell"
      return
    fi
    sell=$(calc "$sell * $target / ($quote + 1) + 1")
  done
  die "could not size a BTC sale covering $(show "$target") MUSD"
}

# --- preflight --------------------------------------------------------------------------------------------

step "preflight on $NETWORK"
ACCOUNT=$(cast wallet address "${WALLET[@]}" 2>"$ERR") || die "cannot open the keystore: $(head -c 300 "$ERR")"
ok "signer $ACCOUNT"
expect_eq "chain id $CHAIN_ID" "$(cast chain-id --rpc-url "$RPC")" "$CHAIN_ID"
expect_eq "SwapLeverageManager.pair() is the deployment's Tigris pool" "$(call "$SWAP" "pair()(address)")" "$PAIR"
expect_eq "SwapLeverageManager.collateral() is BTC" "$(call "$SWAP" "collateral()(address)")" "$BTC"
BTC_ID=$(call "$SWAP" "collateralId()(uint256)")
SNAPSHOT=$(call "$VM" "getRiskSnapshot(address)((uint256,uint256,uint256,uint256,uint256))" "$ACCOUNT")
expect_eq "account has no debt (a clean smoke account)" "$(field_of "$SNAPSHOT" 4)" 0
expect_eq "account has no BTC collateral posted" "$(call "$VM" "collateralBalance(address,uint256)(uint256)" "$ACCOUNT" "$BTC_ID")" 0
$BTC_NATIVE || note "BTC is a plain token on $NETWORK: wallet checks read its balanceOf, gas is paid separately"

COLLATERAL_WEI=$(wei "$COLLATERAL")
PRINCIPAL_WEI=$(wei "$PRINCIPAL")
SUPPLY_WEI=$(wei "$SUPPLY")
RESERVE_WEI=$(wei "$GAS_RESERVE")
GAS_START=$(balance "$ACCOUNT")
BTC_START=$(btc_balance)
MUSD_START=$(musd_balance)
if $BTC_NATIVE; then
  NEEDED=$(calc "$COLLATERAL_WEI + $PRINCIPAL_WEI + $RESERVE_WEI")
  expect "BTC balance $(show "$BTC_START") covers collateral + principal + gas reserve ($(show "$NEEDED"))" "$BTC_START >= $NEEDED"
else
  NEEDED=$(calc "$COLLATERAL_WEI + $PRINCIPAL_WEI")
  expect "BTC balance $(show "$BTC_START") covers collateral + principal ($(show "$NEEDED"))" "$BTC_START >= $NEEDED"
  expect "gas balance $(show "$GAS_START") covers the gas reserve" "$GAS_START >= $RESERVE_WEI"
fi
[ "$SUPPLY_WEI" = 0 ] || expect "MUSD balance $(show "$MUSD_START") covers --supply $SUPPLY" "$MUSD_START >= $SUPPLY_WEI"

UPDATE=$(price_update)
if [ "$UPDATE" = "[]" ]; then ok "MUSD and BTC prices are fresh: no pull update needed"; else ok "BTC price is stale: risk-checked calls attach a Supra proof"; fi
BTC_PRICE=$(call "$ORACLE" "getPriceUnsafe(bytes32)(uint256,uint256)" "$BTC_KEY" | sed -n 1p)
MUSD_PRICE=$(call "$ORACLE" "getPriceInfo(bytes32)(bool,uint256,uint256)" "$MUSD_KEY" | sed -n 2p)
ok "BTC \$$(show "$BTC_PRICE"), MUSD \$$(show "$MUSD_PRICE")"
# principal × BTC/MUSD × (L − 1): the MUSD that buys the extra exposure.
BORROW=$(calc "$PRINCIPAL_WEI * $BTC_PRICE * ($LEVERAGE_BPS - 10000) / ($MUSD_PRICE * 10000)")
expect "leverage $LEVERAGE_BPS bps borrows something" "$BORROW > 0"
BOUGHT_QUOTE=$(call "$PAIR" "getAmountOut(uint256,address)(uint256)" "$BORROW" "$MUSD")
MIN_BOUGHT=$(calc "$BOUGHT_QUOTE * (10000 - $SLIPPAGE_BPS) / 10000")
CASH=$(call "$PMUSD" "cash()(uint256)")
ok "plan: open $(show "$PRINCIPAL_WEI") BTC at $LEVERAGE_BPS bps, borrowing $(show "$BORROW") MUSD for about $(show "$BOUGHT_QUOTE") BTC (min $(show "$MIN_BOUGHT"))"
expect "pMUSD idle cash $(show "$CASH") MUSD plus --supply covers the borrow (an open borrows from it)" "$CASH + $SUPPLY_WEI >= $BORROW"
if $DRY_RUN; then
  echo
  echo "dry run: preflight passed, nothing sent"
  exit 0
fi

# --- 1. BTC collateral: post and withdraw -----------------------------------------------------------------

step "1. BTC collateral: post $(show "$COLLATERAL_WEI") BTC, then withdraw it"
send "BTC.approve(VaultManager)" "$BTC" "approve(address,uint256)" "$VM" "$COLLATERAL_WEI"
send "VaultManager.depositCollateral" "$VM" "depositCollateral(uint256,uint256)" "$BTC_ID" "$COLLATERAL_WEI"
expect_eq "collateralBalance = $(show "$COLLATERAL_WEI") BTC" "$(call --block "$LAST_BLOCK" "$VM" "collateralBalance(address,uint256)(uint256)" "$ACCOUNT" "$BTC_ID")" "$COLLATERAL_WEI"
# The precompile's transferFrom moves native BTC: exactly the amount leaves the wallet, besides the gas.
expect_btc_moved "deposit" "-$COLLATERAL_WEI"
send "VaultManager.withdrawCollateral" "$VM" "withdrawCollateral(uint256,uint256,address,bytes[])" "$BTC_ID" "$COLLATERAL_WEI" "$ACCOUNT" "[]"
expect_eq "collateralBalance = 0" "$(call --block "$LAST_BLOCK" "$VM" "collateralBalance(address,uint256)(uint256)" "$ACCOUNT" "$BTC_ID")" 0
expect_btc_moved "withdrawal" "$COLLATERAL_WEI"

# --- optional liquidity for the borrow --------------------------------------------------------------------

SHARES=0
if [ "$SUPPLY_WEI" != 0 ]; then
  step "supply $(show "$SUPPLY_WEI") MUSD to pMUSD (redeemed at the end)"
  SHARES_BEFORE=$(call "$PMUSD" "balanceOf(address)(uint256)" "$ACCOUNT")
  send "MUSD.approve(pMUSD)" "$MUSD" "approve(address,uint256)" "$PMUSD" "$SUPPLY_WEI"
  send "pMUSD.deposit" "$PMUSD" "deposit(uint256,address)" "$SUPPLY_WEI" "$ACCOUNT"
  SHARES=$(calc "$(call --block "$LAST_BLOCK" "$PMUSD" "balanceOf(address)(uint256)" "$ACCOUNT") - $SHARES_BEFORE")
  expect "minted $SHARES pMUSD shares" "$SHARES > 0"
fi

# --- 2. BTC leverage --------------------------------------------------------------------------------------

step "2a. open: $(show "$PRINCIPAL_WEI") BTC principal, borrow $(show "$BORROW") MUSD"
GRANTED=false
if [ "$(call "$VM" "isOperator(address,address)(bool)" "$ACCOUNT" "$SWAP")" != true ]; then
  send "VaultManager.setOperator(SwapLeverageManager)" "$VM" "setOperator(address,bool)" "$SWAP" true
  GRANTED=true
fi
send "BTC.approve(SwapLeverageManager)" "$BTC" "approve(address,uint256)" "$SWAP" "$PRINCIPAL_WEI"
UPDATE=$(price_update)
DEADLINE=$(($(now) + DEADLINE_SEC))
send "SwapLeverageManager.open" "$SWAP" "open(uint256,uint256,uint256,uint256,bytes[])" "$PRINCIPAL_WEI" "$BORROW" "$MIN_BOUGHT" "$DEADLINE" "$UPDATE"
OPENED_RAW=$(event_data "$SWAP" "Opened(address,uint256,uint256,uint256,uint256)" "uint256,uint256,uint256,uint256")
mapfile -t OPENED <<<"$OPENED_RAW"
BOUGHT=${OPENED[2]}
expect "Opened: borrowed = debt = $(show "$BORROW") MUSD (no flash fee)" "${OPENED[1]} == $BORROW && ${OPENED[3]} == $BORROW"
expect "bought $(show "$BOUGHT") BTC ≥ min $(show "$MIN_BOUGHT")" "$BOUGHT >= $MIN_BOUGHT"
expect_eq "pMUSD debt = borrow, exactly" "$(call --block "$LAST_BLOCK" "$PMUSD" "borrowBalanceStored(address)(uint256)" "$ACCOUNT")" "$BORROW"
POSTED=$(calc "$PRINCIPAL_WEI + $BOUGHT")
expect_eq "BTC collateral = principal + bought ($(show "$POSTED"))" "$(call --block "$LAST_BLOCK" "$VM" "collateralBalance(address,uint256)(uint256)" "$ACCOUNT" "$BTC_ID")" "$POSTED"
HF=$(field_of "$(call --block "$LAST_BLOCK" "$VM" "getRiskSnapshot(address)((uint256,uint256,uint256,uint256,uint256))" "$ACCOUNT")" 5)
expect "health factor $(show "$HF") > 1" "$HF > $WAD"
expect_btc_moved "open" "-$PRINCIPAL_WEI"
expect_musd_moved "open" 0
expect_manager_untouched

step "2b. close half the debt"
DEBT=$(call "$PMUSD" "borrowBalanceView(address)(uint256)" "$ACCOUNT")
REPAY=$(calc "$DEBT / 2")
SELL=$(sell_for "$(calc "$REPAY * 10050 / 10000")")
UPDATE=$(price_update)
DEADLINE=$(($(now) + DEADLINE_SEC))
# Withdraw exactly what is sold: the position keeps the rest; the sale's MUSD beyond the repayment comes back.
send "SwapLeverageManager.close (half)" "$SWAP" "close(uint256,uint256,uint256,uint256,uint256,bytes[])" "$REPAY" "$SELL" "$SELL" "$REPAY" "$DEADLINE" "$UPDATE"
CLOSED_RAW=$(event_data "$SWAP" "Closed(address,uint256,uint256,uint256,uint256,uint256)" "uint256,uint256,uint256,uint256,uint256")
mapfile -t CLOSED <<<"$CLOSED_RAW"
expect "Closed: repaid $(show "${CLOSED[0]}") MUSD and sold $(show "${CLOSED[2]}") BTC as requested" "${CLOSED[0]} == $REPAY && ${CLOSED[2]} == $SELL"
DEBT_AFTER=$(call --block "$LAST_BLOCK" "$PMUSD" "borrowBalanceStored(address)(uint256)" "$ACCOUNT")
expect "debt fell by the repayment ($(show "$DEBT_AFTER") MUSD left)" "$DEBT_AFTER < $DEBT && $DEBT_AFTER + $REPAY >= $DEBT"
COLL=$(call --block "$LAST_BLOCK" "$VM" "collateralBalance(address,uint256)(uint256)" "$ACCOUNT" "$BTC_ID")
expect "BTC collateral fell by the sale ($(show "$COLL") left)" "$COLL == $POSTED - $SELL"
expect_btc_moved "partial close" 0
expect_musd_moved "partial close (sale proceeds beyond the repayment)" "${CLOSED[4]}"
expect_manager_untouched

step "2c. close the rest"
DEBT=$(call "$PMUSD" "borrowBalanceView(address)(uint256)" "$ACCOUNT")
# 0.3% over the live debt covers interest until the transaction lands; the excess MUSD is returned.
SELL=$(sell_for "$(calc "$DEBT * 10030 / 10000")")
expect "the sale needed ($(show "$SELL") BTC) fits in the collateral" "$SELL <= $COLL"
DEADLINE=$(($(now) + DEADLINE_SEC))
# Repaying everything and withdrawing everything needs no price at all: nothing attached.
send "SwapLeverageManager.close (rest)" "$SWAP" "close(uint256,uint256,uint256,uint256,uint256,bytes[])" "$MAX_UINT" "$MAX_UINT" "$SELL" 0 "$DEADLINE" "[]"
CLOSED_RAW=$(event_data "$SWAP" "Closed(address,uint256,uint256,uint256,uint256,uint256)" "uint256,uint256,uint256,uint256,uint256")
mapfile -t CLOSED <<<"$CLOSED_RAW"
expect_eq "debt = 0" "$(call --block "$LAST_BLOCK" "$PMUSD" "borrowBalanceStored(address)(uint256)" "$ACCOUNT")" 0
expect_eq "BTC collateral = 0" "$(call --block "$LAST_BLOCK" "$VM" "collateralBalance(address,uint256)(uint256)" "$ACCOUNT" "$BTC_ID")" 0
expect "returned the unsold $(show "${CLOSED[3]}") BTC and $(show "${CLOSED[4]}") MUSD of excess proceeds" "${CLOSED[3]} == $COLL - $SELL && ${CLOSED[0]} >= $DEBT"
expect_btc_moved "full close" "${CLOSED[3]}"
expect_musd_moved "full close" "${CLOSED[4]}"
expect_manager_untouched

if [ "$SHARES" != 0 ]; then
  step "redeem the supplied pMUSD"
  send "pMUSD.redeem" "$PMUSD" "redeem(uint256,address,address)" "$SHARES" "$ACCOUNT" "$ACCOUNT"
fi
if $GRANTED; then
  step "revoke the operator approval granted above"
  send "VaultManager.setOperator(SwapLeverageManager, false)" "$VM" "setOperator(address,bool)" "$SWAP" false
fi

# --- summary ----------------------------------------------------------------------------------------------

step "summary"
GAS_END=$(balance "$ACCOUNT")
BTC_END=$(btc_balance)
MUSD_END=$(musd_balance)
expect "BTC left for gas ($(show "$GAS_END")) ≥ reserve $(show "$RESERVE_WEI")" "$GAS_END >= $RESERVE_WEI"
ok "gas $(show "$GAS_SPENT") BTC; net change $(show "$BTC_END - $BTC_START") BTC, $(show "$MUSD_END - $MUSD_START") MUSD (swap fees and slippage)"
echo
echo "✓ BTC smoke test passed on $NETWORK"
