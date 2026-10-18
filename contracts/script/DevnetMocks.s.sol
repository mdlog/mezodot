// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";
import {DevWormhole} from "../test/mocks/DevWormhole.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";
import {MockSupraPull} from "../test/mocks/MockSupraPull.sol";
import {MockTigrisRouter} from "../test/mocks/MockTigrisRouter.sol";

/// @notice Local devnet only: deploys the external dependencies that exist on real testnets
///         (Wormhole core, Pyth, Supra pull, tokens) so the production deploy scripts can run unchanged.
/// Env: ROLE (hub|spoke), WORMHOLE_CHAIN_ID, GUARDIAN (dev guardian address).
///      Mock tokens are minted to the first five default anvil accounts.
/// Prints KEY=value lines consumed by scripts/devnet/start.sh.
contract DevnetMocks is Script {
    uint256 internal constant FUND_ACCOUNTS = 5;

    function run() external {
        string memory role = vm.envString("ROLE");
        uint16 chainId = uint16(vm.envUint("WORMHOLE_CHAIN_ID"));
        address guardian = vm.envAddress("GUARDIAN");

        vm.startBroadcast();
        DevWormhole wormhole = new DevWormhole(chainId, guardian, 0);
        console2.log(string.concat("WORMHOLE=", vm.toString(address(wormhole))));
        if (keccak256(bytes(role)) == keccak256("hub")) {
            MockPyth pyth = new MockPyth(60, 1);
            MockSupraPull supra = new MockSupraPull();
            MockERC20 musd = new MockERC20("Mezo USD", "MUSD", 18);
            MockERC20 mezo = new MockERC20("Mezo", "MEZO", 18);
            MockERC20 btc = new MockERC20("Bitcoin", "BTC", 18);
            _fund(musd, 1_000_000e18);
            _fund(mezo, 100_000_000e18);
            _fund(btc, 100e18);
            // Stand-in for the Tigris MUSD/BTC pool at the devnet BTC price (80,000 MUSD per BTC).
            MockTigrisRouter router = new MockTigrisRouter();
            router.setRate(address(musd), address(btc), 1e18 / 80_000);
            router.setRate(address(btc), address(musd), 80_000e18);
            console2.log(string.concat("PYTH=", vm.toString(address(pyth))));
            console2.log(string.concat("SUPRA_PULL=", vm.toString(address(supra))));
            console2.log(string.concat("MUSD=", vm.toString(address(musd))));
            console2.log(string.concat("MEZO=", vm.toString(address(mezo))));
            console2.log(string.concat("BTC=", vm.toString(address(btc))));
            console2.log(string.concat("TIGRIS_ROUTER=", vm.toString(address(router))));
            // The mock router needs no factory; any non-zero address is recorded.
            console2.log(string.concat("TIGRIS_FACTORY=", vm.toString(address(router))));
        } else {
            MockERC20 weth = new MockERC20("Wrapped Ether", "WETH", 18);
            MockERC20 usdc = new MockERC20("USD Coin", "USDC", 6);
            _fund(weth, 100e18);
            _fund(usdc, 1_000_000e6);
            console2.log(string.concat("WETH=", vm.toString(address(weth))));
            console2.log(string.concat("USDC=", vm.toString(address(usdc))));
        }
        vm.stopBroadcast();
    }

    /// Mints to the default anvil accounts derived from the standard test mnemonic.
    function _fund(MockERC20 token, uint256 amount) internal {
        string memory mnemonic = "test test test test test test test test test test test junk";
        for (uint32 i = 0; i < FUND_ACCOUNTS; i++) {
            token.mint(vm.addr(vm.deriveKey(mnemonic, i)), amount);
        }
    }
}
