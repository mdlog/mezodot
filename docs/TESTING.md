# Try Mezodot

Mezodot is a lending market on Mezo testnet. It needs about 15 minutes, a wallet and testnet funds, and no real money. The contracts are unaudited, so use a wallet with nothing of value in it.

**App:** <https://mezodot.mdloglabs.org>

## Set up

1. Add Mezo testnet to an EVM wallet such as MetaMask, or connect with Mezo Passport from the app's Connect button.
   - Chain ID `31611`, RPC `https://rpc.test.mezo.org`, explorer `https://explorer.test.mezo.org`
2. Get testnet BTC and MEZO from the [Mezo faucet](https://faucet.test.mezo.org/). BTC also pays for gas, so keep a little aside.
3. For MUSD, use Mezo's [testnet app](https://testnet.mezo.org) or swap some BTC on its pools.

## Pick a task

Each takes a few minutes. Do as many as you like.

| Task               | Where          | What to do                                                                                                      | Needs             |
| ------------------ | -------------- | --------------------------------------------------------------------------------------------------------------- | ----------------- |
| Supply             | `#/markets`    | Supply MUSD or MEZO, and watch it arrive as pMUSD or pMEZO. Withdraw some.                                      | MUSD or MEZO      |
| Borrow against BTC | `#/markets`    | Post a little BTC as collateral, then borrow MEZO or MUSD on `#/borrow`. Repay it.                              | 0.001 BTC         |
| BTC long           | `#/loop`       | Open a small BTC long, then close it.                                                                           | 0.001 BTC         |
| MUSD loop          | `#/loop`       | Open a 2× MUSD loop, then unwind it.                                                                            | 5 MUSD            |
| BTC trove          | `#/trove`      | Open a Mezo trove and supply its MUSD in one go, then repay and close it. Needs an EOA wallet such as MetaMask. | 0.05 BTC, 5 MUSD  |
| Cross-chain        | `#/crosschain` | Lock WETH on Base Sepolia and borrow on Mezo against it. The credit takes about 20 minutes.                     | Base Sepolia WETH |

## What to tell us

Whatever you find helps, including "I got stuck here". Open a [GitHub issue](https://github.com/mdlog/mezodot/issues) or post in the Mezo Discord, with:

- Your wallet address and the transaction hash, if there is one. Addresses are public, and this is how we find your session on-chain.
- What you tried, and what you expected to happen.
- What happened instead: the error text or a screenshot.
- One thing that confused you, even if it worked in the end.

Never send a private key or seed phrase. We will never ask for one.

## Known rough edges

- First load can take a while: the live demo is not a static build yet.
- A borrow against ETH or USDC needs the agent's price relay. If it is down, the app says so.
- Trove limits come from Mezo: at least 2,000 MUSD of debt, so about 0.04 BTC or more of collateral.
