// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PToken} from "../src/hub/PToken.sol";

/// @notice The parts of Tigris's router that manage liquidity (Velodrome v2 style).
interface ITigrisLiquidity {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function poolFor(address tokenA, address tokenB, bool stable, address factory) external view returns (address);
    function addLiquidity(
        address tokenA,
        address tokenB,
        bool stable,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);
    function removeLiquidity(
        address tokenA,
        address tokenB,
        bool stable,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB);
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/// @notice Seeds the stable pMUSD/MUSD pool on Tigris and records it in packages/sdk/src/deployments/<NETWORK>.json.
///         The pool is permissionless: Mezodot holds no special role in it. The router creates it on first deposit.
/// Env: NETWORK, MUSD_AMOUNT (MUSD in wei).
contract DeployPMusdPool is Script {
    using stdJson for string;

    function run() external returns (address pool) {
        string memory path =
            string.concat(vm.projectRoot(), "/../packages/sdk/src/deployments/", vm.envString("NETWORK"), ".json");
        string memory json = vm.readFile(path);
        ITigrisLiquidity router = ITigrisLiquidity(json.readAddress(".contracts.tigrisRouter"));
        address factory = json.readAddress(".contracts.tigrisFactory");
        PToken pMUSD = PToken(payable(json.readAddress(".contracts.pMUSD")));
        address musd = json.readAddress(".tokens.MUSD");
        uint256 amount = vm.envUint("MUSD_AMOUNT");
        // A stable pool's first deposit must be equal once decimals are normalised (24 for pMUSD, 18 for MUSD), so the
        // pool opens at one share per MUSD. pMUSD is worth slightly more than that, which arbitrage closes.
        uint256 shares = amount * 1e6;

        vm.startBroadcast();
        IERC20(address(pMUSD)).approve(address(router), shares);
        IERC20(musd).approve(address(router), amount);
        router.addLiquidity(
            address(pMUSD), musd, true, shares, amount, shares, amount, msg.sender, block.timestamp + 600
        );
        vm.stopBroadcast();

        pool = router.poolFor(address(pMUSD), musd, true, factory);
        string[] memory keys = vm.parseJsonKeys(json, ".contracts");
        string memory obj = "contracts";
        for (uint256 i = 0; i < keys.length; i++) {
            vm.serializeAddress(obj, keys[i], json.readAddress(string.concat(".contracts.", keys[i])));
        }
        string memory contracts = vm.serializeAddress(obj, "pMusdPool", pool);
        // A dry run never overwrites the deployment record (see DeployHub).
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
            vm.writeJson(contracts, path, ".contracts");
        } else {
            console2.log("dry run: deployment not written to", path);
        }
        console2.log("pMUSD/MUSD pool", pool);
    }
}
