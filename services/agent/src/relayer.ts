import { join } from 'node:path';
import { keccak256, sliceHex, hexToNumber, type Address, type Hex, type PublicClient } from 'viem';
import {
  NETWORKS,
  fetchSignedVaa,
  keeperGatewayAbi,
  parseLogMessagePublished,
  signDevVaa,
  spokeGatewayAbi,
  wormholeAdapterAbi,
  type NetworkName,
} from '@mezodot/sdk';
import type { Context, Wallet } from './context';
import { JsonStore } from './store';

export type Direction = 'deposit' | 'release';
export type MessageStatus = 'waiting_vaa' | 'ready' | 'delivered' | 'failed';

export type RelayMessage = {
  id: string;
  direction: Direction;
  source: NetworkName;
  target: NetworkName;
  emitterChain: number;
  emitter: Address;
  sequence: bigint;
  txHash: Hex;
  blockNumber: bigint;
  status: MessageStatus;
  attempts: number;
  lastError?: string;
  vaa?: Hex;
  deliveredTx?: Hex;
  observedAt: number;
};

type RelayState = { cursors: Partial<Record<NetworkName, bigint>>; messages: Record<string, RelayMessage> };

const MAX_BLOCK_RANGE = 2_000n;
const MAX_ATTEMPTS = 8;

export const messageId = (emitterChain: number, emitter: Address, sequence: bigint) => `${emitterChain}/${emitter.toLowerCase()}/${sequence}`;

/** Wormhole digest that contracts use as the replay key: keccak256(keccak256(body)). */
export function vaaHash(vaa: Hex): Hex {
  const signatures = hexToNumber(sliceHex(vaa, 5, 6));
  return keccak256(keccak256(sliceHex(vaa, 6 + signatures * 66)));
}

/**
 * Permissionless relayer for both directions:
 *   spoke SpokeGateway.Deposited  → hub KeeperGateway.relayMessage
 *   hub WormholeAdapter.ReleaseSent → spoke SpokeGateway.receiveMessage
 * Safety does not depend on the relayer (contracts verify VAAs); it only provides liveness.
 */
export class Relayer {
  readonly store: JsonStore<RelayState>;

  constructor(
    private readonly ctx: Context,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.store = new JsonStore<RelayState>(join(ctx.config.stateDir, `relayer-${ctx.config.env}.json`), { cursors: {}, messages: {} });
  }

  messages(): RelayMessage[] {
    return Object.values(this.store.get().messages).sort((a, b) => b.observedAt - a.observedAt);
  }

  pending(): RelayMessage[] {
    return this.messages().filter((m) => m.status !== 'delivered');
  }

  async tick(): Promise<void> {
    await this.scanSpokes();
    await this.scanHub();
    for (const m of this.pending()) {
      if (m.status === 'failed') continue;
      await this.advance(m).catch((err: unknown) => this.fail(m, err));
    }
  }

  // --- discovery -------------------------------------------------------------

  private async range(network: NetworkName, client: PublicClient, startBlock: number): Promise<[bigint, bigint] | null> {
    const latest = await client.getBlockNumber();
    const from = this.store.get().cursors[network] ?? BigInt(startBlock);
    if (from > latest) return null;
    const to = from + MAX_BLOCK_RANGE < latest ? from + MAX_BLOCK_RANGE : latest;
    return [from, to];
  }

  private async scanSpokes(): Promise<void> {
    for (const spoke of this.ctx.spokes) {
      const r = await this.range(spoke.network, spoke.client, spoke.deployment.startBlock);
      if (!r) continue;
      const logs = await spoke.client.getContractEvents({
        address: spoke.deployment.contracts.spokeGateway,
        abi: spokeGatewayAbi,
        eventName: 'Deposited',
        fromBlock: r[0],
        toBlock: r[1],
      });
      this.store.update((s) => {
        for (const log of logs) {
          this.observe(s, {
            direction: 'deposit',
            source: spoke.network,
            target: this.ctx.hub.network,
            emitterChain: spoke.deployment.wormholeChainId,
            emitter: spoke.deployment.contracts.spokeGateway,
            sequence: log.args.sequence!,
            txHash: log.transactionHash,
            blockNumber: log.blockNumber,
          });
        }
        s.cursors[spoke.network] = r[1] + 1n;
      });
    }
  }

  private async scanHub(): Promise<void> {
    const { hub } = this.ctx;
    const r = await this.range(hub.network, hub.client, hub.deployment.startBlock);
    if (!r) return;
    const logs = await hub.client.getContractEvents({
      address: hub.deployment.contracts.wormholeAdapter,
      abi: wormholeAdapterAbi,
      eventName: 'ReleaseSent',
      fromBlock: r[0],
      toBlock: r[1],
    });
    this.store.update((s) => {
      for (const log of logs) {
        const target = this.ctx.spokes.find((sp) => sp.deployment.wormholeChainId === Number(log.args.chainId));
        if (!target) continue; // spoke not configured for this agent
        this.observe(s, {
          direction: 'release',
          source: hub.network,
          target: target.network,
          emitterChain: hub.deployment.wormholeChainId,
          emitter: hub.deployment.contracts.wormholeAdapter,
          sequence: log.args.sequence!,
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
        });
      }
      s.cursors[hub.network] = r[1] + 1n;
    });
  }

  private observe(s: RelayState, m: Omit<RelayMessage, 'id' | 'status' | 'attempts' | 'observedAt'>): void {
    const id = messageId(m.emitterChain, m.emitter, m.sequence);
    if (s.messages[id]) return;
    s.messages[id] = { ...m, id, status: 'waiting_vaa', attempts: 0, observedAt: Date.now() };
    this.ctx.log('relayer', 'observed', { id, direction: m.direction });
  }

  // --- delivery -----------------------------------------------------------------

  private async advance(m: RelayMessage): Promise<void> {
    const vaa = m.vaa ?? (await this.obtainVaa(m));
    if (!vaa) return; // guardians have not signed yet
    this.patch(m.id, { vaa, status: 'ready' });

    const hash = vaaHash(vaa);
    if (await this.isConsumed(m, hash)) {
      this.patch(m.id, { status: 'delivered' });
      this.ctx.log('relayer', 'already delivered', { id: m.id });
      return;
    }
    const wallet = this.walletFor(m.target);
    if (!wallet) return; // read-only agent: report as pending
    const txHash = await this.submit(m, vaa, wallet);
    await this.clientFor(m.target).waitForTransactionReceipt({ hash: txHash });
    this.patch(m.id, { status: 'delivered', deliveredTx: txHash });
    this.ctx.log('relayer', 'delivered', { id: m.id, txHash });
  }

  private async obtainVaa(m: RelayMessage): Promise<Hex | null> {
    const api = NETWORKS[m.source].wormholescanApi;
    if (api) return fetchSignedVaa(api, m.emitterChain, m.emitter, m.sequence, this.fetchImpl);
    // Devnet: rebuild the message from the core log and sign with the dev guardian.
    const key = this.ctx.config.devGuardianKey;
    if (!key) throw new Error('DEVNET_GUARDIAN_KEY is required on the devnet');
    const client = this.clientFor(m.source);
    const receipt = await client.getTransactionReceipt({ hash: m.txHash });
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    for (const log of receipt.logs) {
      const p = parseLogMessagePublished(log);
      if (!p || p.emitter.toLowerCase() !== m.emitter.toLowerCase() || p.sequence !== m.sequence) continue;
      return signDevVaa(key, {
        timestamp: Number(block.timestamp),
        nonce: p.nonce,
        emitterChain: m.emitterChain,
        emitter: m.emitter,
        sequence: p.sequence,
        consistencyLevel: p.consistencyLevel,
        payload: p.payload,
      });
    }
    throw new Error('LogMessagePublished not found in source transaction');
  }

  private async isConsumed(m: RelayMessage, hash: Hex): Promise<boolean> {
    if (m.direction === 'deposit') {
      return this.ctx.hub.client.readContract({ address: this.ctx.hub.deployment.contracts.wormholeAdapter, abi: wormholeAdapterAbi, functionName: 'isConsumed', args: [hash] });
    }
    const spoke = this.spoke(m.target);
    return spoke.client.readContract({ address: spoke.deployment.contracts.spokeGateway, abi: spokeGatewayAbi, functionName: 'isConsumed', args: [hash] });
  }

  private async submit(m: RelayMessage, vaa: Hex, wallet: Wallet): Promise<Hex> {
    if (m.direction === 'deposit') {
      return wallet.writeContract({ address: this.ctx.hub.deployment.contracts.keeperGateway, abi: keeperGatewayAbi, functionName: 'relayMessage', args: [vaa] });
    }
    return wallet.writeContract({ address: this.spoke(m.target).deployment.contracts.spokeGateway, abi: spokeGatewayAbi, functionName: 'receiveMessage', args: [vaa] });
  }

  /** Manually relay one message (MCP tool). */
  async relay(id: string): Promise<RelayMessage> {
    const m = this.store.get().messages[id];
    if (!m) throw new Error(`Unknown message ${id}`);
    await this.advance(m);
    return this.store.get().messages[id];
  }

  // --- helpers ------------------------------------------------------------------

  private spoke(network: NetworkName) {
    const s = this.ctx.spokes.find((sp) => sp.network === network);
    if (!s) throw new Error(`Spoke ${network} not configured`);
    return s;
  }

  private clientFor(network: NetworkName): PublicClient {
    return network === this.ctx.hub.network ? this.ctx.hub.client : this.spoke(network).client;
  }

  private walletFor(network: NetworkName): Wallet | null {
    return network === this.ctx.hub.network ? this.ctx.hub.wallet : this.spoke(network).wallet;
  }

  private patch(id: string, patch: Partial<RelayMessage>): void {
    this.store.update((s) => {
      s.messages[id] = { ...s.messages[id], ...patch };
    });
  }

  private fail(m: RelayMessage, err: unknown): void {
    const attempts = m.attempts + 1;
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
    this.patch(m.id, { attempts, lastError: message, status: attempts >= MAX_ATTEMPTS ? 'failed' : m.status });
    this.ctx.log('relayer', 'attempt failed', { id: m.id, attempts, error: message });
  }
}
