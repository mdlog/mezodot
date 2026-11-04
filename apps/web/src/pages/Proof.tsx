import { ExternalLink, ShieldCheck } from 'lucide-react';
import { AddressLink, PageTitle, PanelTitle, SummaryStrip, TxLink } from '../components/ui';
import { HUB, networkByName } from '../chain/env';
import { PROOF, PROOF_CONTRACTS } from '../data/proof';

const REPOSITORY = 'https://github.com/mdlog/mezodot';
const sourcifyUrl = (address: string) => `https://repo.sourcify.dev/${HUB.chain.id}/${address}`;

/** Every path exercised on live testnets, one explorer click away. */
export function Proof() {
  const contracts = HUB.deployment?.contracts;
  return (
    <>
      <PageTitle
        eyebrow="INTELLIGENCE"
        title="See it on-chain."
        subtitle="Each path below ran on a live testnet. Open any transaction in its explorer, or read the verified source of the contract behind it."
      />
      <SummaryStrip
        snapshot={
          <>
            MEZO TESTNET <i>/</i> BASE SEPOLIA <i>/</i> ETHEREUM SEPOLIA
          </>
        }
        time="Source verified on Sourcify"
        icon={ShieldCheck}
      />
      <div className="proof-sections">
        {PROOF.map((section) => (
          <section className="panel proof-section" key={section.title}>
            <PanelTitle label={section.title} />
            <p className="proof-note">{section.note}</p>
            <ul className="proof-txs">
              {section.txs.map((tx) => {
                const network = networkByName(tx.network);
                return (
                  <li key={tx.hash}>
                    <span>{tx.label}</span>
                    {network ? <TxLink network={network} hash={tx.hash} /> : <code>{tx.hash}</code>}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        <section className="panel proof-section">
          <PanelTitle label="Contracts" meta={HUB.label} />
          <ul className="proof-txs">
            {PROOF_CONTRACTS.map(({ label, key }) => {
              const address = contracts?.[key];
              if (!address) return null;
              return (
                <li key={key}>
                  <span>{label}</span>
                  <span className="proof-links">
                    <AddressLink network={HUB} address={address} />
                    <a href={sourcifyUrl(address)} target="_blank" rel="noreferrer">
                      Source <ExternalLink size={12} />
                    </a>
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="proof-note">
            Mezo&apos;s Blockscout cannot yet verify contracts built with solc&apos;s via-IR pipeline, so hub sources are checked on Sourcify. Spoke gateways
            are verified on Blockscout too.{' '}
            <a href={`${REPOSITORY}/blob/main/docs/EVIDENCE.md`} target="_blank" rel="noreferrer">
              Full evidence, with how to reproduce it <ExternalLink size={12} />
            </a>
          </p>
        </section>
      </div>
    </>
  );
}
