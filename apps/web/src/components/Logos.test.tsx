import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NETWORKS, type NetworkName } from '@mezodot/sdk';
import { ChainLogo, TokenLogo } from './Logos';

const badges = (html: string) => html.match(/class="logo-badge[^"]*"/g) ?? [];

describe('chain and token logos', () => {
  it('draws a logo for every network, never an initial', () => {
    for (const network of Object.keys(NETWORKS) as NetworkName[]) {
      const html = renderToStaticMarkup(<ChainLogo network={network} />);
      expect(html).toMatch(/^<svg class="logo-mark"/);
    }
  });

  it('badges receipt tokens with Mezodot and spoke assets with their chain', () => {
    expect(badges(renderToStaticMarkup(<TokenLogo symbol="pMUSD" />))).toEqual(['class="logo-badge logo-badge--square"']);
    expect(badges(renderToStaticMarkup(<TokenLogo symbol="MUSD" />))).toEqual([]);
    expect(badges(renderToStaticMarkup(<TokenLogo symbol="USDC" network="base-sepolia" />))).toEqual(['class="logo-badge"']);
    // WETH already shows the Ethereum diamond; an Ethereum badge would only repeat it.
    expect(badges(renderToStaticMarkup(<TokenLogo symbol="WETH" network="eth-sepolia" />))).toEqual([]);
    expect(badges(renderToStaticMarkup(<TokenLogo symbol="WETH" network="base-sepolia" />))).toEqual(['class="logo-badge"']);
  });

  it('falls back to a neutral coin for tokens without artwork', () => {
    expect(renderToStaticMarkup(<TokenLogo symbol="REMOTE" />)).toContain('logo-unknown');
    expect(renderToStaticMarkup(<TokenLogo symbol="pToken" />)).toContain('logo-unknown');
  });
});
