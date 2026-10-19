import { describe, expect, it } from 'vitest';
import { codeIdentifiers, markdownSection, ownerFunctions, undocumented } from '../lib/admin-docs';

const SOURCE = `
interface IThing {
    function setX(uint256 x) external; // onlyOwner in the implementation
}

/// @notice onlyOwner here is a comment, not a modifier.
abstract contract Pool is Ownable2Step, Pausable {
    function setCaps(uint256 supplyCap_, uint256 borrowCap_) external onlyOwner {
        supplyCap = supplyCap_;
    }

    function withdrawReserves(uint256 amount, address to) external onlyOwner nonReentrant {}

    /* function old() external onlyOwner {} */
    function deposit(uint256 assets, address receiver) public whenNotPaused returns (uint256) {}
}

contract Vault is Pool {
    function addCollateral(Config calldata c)
        external
        onlyOwner
        returns (uint256 id)
    {}

    function withdrawFor(address account, uint256 id, address to, bytes[] calldata priceUpdate)
        external
        payable
        onlyOperatorOf(account)
    {}
}
`;

describe('ownerFunctions', () => {
  it('finds onlyOwner functions with their contract, including multi-line signatures', () => {
    const names = ownerFunctions(SOURCE, 'x.sol').map((f) => `${f.contract}.${f.name}`);
    expect(names).toEqual(['Pool.setCaps', 'Pool.withdrawReserves', 'Vault.addCollateral', 'Pool.transferOwnership', 'Pool.renounceOwnership']);
  });

  it('ignores interfaces, comments and other modifiers', () => {
    const names = ownerFunctions(SOURCE).map((f) => f.name);
    expect(names).not.toContain('setX');
    expect(names).not.toContain('old');
    expect(names).not.toContain('withdrawFor');
  });
});

describe('SECURITY.md admin section', () => {
  const doc = [
    '# Security',
    '## Trust',
    'The owner may call `setCaps` (mentioned outside the admin section).',
    '### Admin powers',
    '| Function | Power |',
    '| `Pool.withdrawReserves`, `addCollateral` | ... |',
    '| `transferOwnership` / `acceptOwnership` | rotation |',
    '## Oracle design',
    '`renounceOwnership` is listed after the section.',
  ].join('\n');

  it('takes the section up to the next heading of its level or higher', () => {
    const section = markdownSection(doc, 'Admin powers')!;
    expect(section).toContain('withdrawReserves');
    expect(section).not.toContain('Oracle design');
    expect(markdownSection(doc, 'Missing')).toBeNull();
  });

  it('collects identifiers from code spans', () => {
    expect([...codeIdentifiers('`OracleRouter.setFeed` / `pause` (VaultManager)')]).toEqual(['OracleRouter', 'setFeed', 'pause']);
  });

  it('reports owner-only functions the section does not name', () => {
    const missing = undocumented(ownerFunctions(SOURCE), markdownSection(doc, 'Admin powers')!);
    expect(missing.map((f) => f.name)).toEqual(['setCaps', 'renounceOwnership']);
  });
});
