// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ─── Interfaces ───────────────────────────────────────────────────────────────

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IClaimContract {
    // TokenClaimApy.claim(uint256 amount, bytes32 nonce, bytes signature)
    function claim(uint256 amount, bytes32 nonce, bytes calldata signature) external;
}

interface IStakingContract {
    // TokenStaking.unstake(uint256 _stakeIndex)
    function unstake(uint256 _stakeIndex) external;
}

// ─── RescueExecutor ──────────────────────────────────────────────────────────
//
// Deployed ONCE by the sponsor. Set as the EIP-7702 delegate of the compromised
// wallet. When delegated, address(this) == compromised wallet, so:
//   - claim() sends LINGO to address(this) = compromised wallet ✓
//   - unstake() sends LINGO to address(this) = compromised wallet ✓
//   - transfer() sweeps all LINGO to safe destination ✓
//
contract RescueExecutor {

    // ── Transfer existing LINGO balance ───────────────────────────────────────
    function rescueTransfer(address token, address destination) external {
        _sweep(token, destination);
    }

    // ── Claim rewards then sweep all LINGO ────────────────────────────────────
    function rescueClaim(
        address claimContract,
        uint256 amount,
        bytes32 nonce,
        bytes calldata signature,
        address token,
        address destination
    ) external {
        IClaimContract(claimContract).claim(amount, nonce, signature);
        _sweep(token, destination);
    }

    // ── Unstake positions then sweep all LINGO ────────────────────────────────
    function rescueUnstake(
        address stakeContract,
        uint256[] calldata indices,
        address token,
        address destination
    ) external {
        for (uint256 i = 0; i < indices.length; i++) {
            IStakingContract(stakeContract).unstake(indices[i]);
        }
        _sweep(token, destination);
    }

    // ── Internal: transfer entire token balance to destination ────────────────
    function _sweep(address token, address destination) internal {
        uint256 bal = IERC20(token).balanceOf(address(this));
        require(bal > 0, "no balance");
        require(IERC20(token).transfer(destination, bal), "transfer failed");
    }
}
