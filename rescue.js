// ═══════════════════════════════════════════════════════════════════════════════
//  LINGO Rescue v3 — EIP-7702 atomic rescue
//  Modes: transfer | claim | unstake
// ═══════════════════════════════════════════════════════════════════════════════

import "dotenv/config";
import {
  createPublicClient, createWalletClient,
  http, encodeFunctionData, parseAbi,
  formatUnits, parseUnits, getAddress,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { eip7702Actions } from "viem/experimental";

// ── Addresses ─────────────────────────────────────────────────────────────────
const LINGO_TOKEN    = "0xfb42Da273158B0F642F59F2Ba7cc1d5457481677";
const CLAIM_CONTRACT = "0x2f26621e931c32542579CF8860D7e8616DF32E0E";
const STAKE_CONTRACT = "0x9aF8C0dac726CcEE2BFd6c0f3E21f320d42398AC";

// ── ABIs ──────────────────────────────────────────────────────────────────────
const LINGO_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);
const STAKE_ABI = [
  {
    name: "unstake", type: "function",
    inputs: [{ name: "_stakeIndex", type: "uint256" }],
    outputs: [], stateMutability: "nonpayable",
  },
  {
    name: "getStakes", type: "function",
    inputs: [{ name: "_user", type: "address" }],
    outputs: [{ name: "", type: "tuple[]", components: [
      { name: "amount",      type: "uint128" },
      { name: "unlockBlock", type: "uint128" },
    ]}],
    stateMutability: "view",
  },
];
const RESCUE_ABI = parseAbi([
  "function rescueTransfer(address token, address destination) external",
  "function rescueClaim(address claimContract, uint256 amount, bytes32 nonce, bytes signature, address token, address destination) external",
  "function rescueUnstake(address stakeContract, uint256[] indices, address token, address destination) external",
]);

// ── Helpers ───────────────────────────────────────────────────────────────────
const H   = (s) => (s && !s.startsWith("0x") ? "0x" + s : s);
const ts  = () => new Date().toISOString().replace("T", " ").slice(0, 23);
const log = (e, m) => console.log(`[${ts()}] ${e}  ${m}`);
const sep = (t) => console.log(`\n${"═".repeat(62)}\n  ${t}\n${"═".repeat(62)}`);
const fmt = (w) => parseFloat(formatUnits(w, 18)).toLocaleString("en", { maximumFractionDigits: 4 }) + " LINGO";
const req = (k) => {
  if (!process.env[k]) { console.error(`\n❌  Missing .env: ${k}`); process.exit(1); }
  return process.env[k];
};

// ── Load .env ─────────────────────────────────────────────────────────────────
const COMPROMISED_KEY  = H(req("COMPROMISED_PRIVATE_KEY"));
const SPONSOR_KEY      = H(req("SPONSOR_PRIVATE_KEY"));
const SAFE_DESTINATION = getAddress(req("SAFE_DESTINATION"));
const RPC_URL          = req("RPC_URL");
const EXECUTOR_ADDRESS = getAddress(req("EXECUTOR_ADDRESS"));
const MODE             = (process.env.RESCUE_MODE || "transfer").toLowerCase();

const HTTP_RPC = RPC_URL.startsWith("wss://") ? RPC_URL.replace("wss://", "https://")
               : RPC_URL.startsWith("ws://")  ? RPC_URL.replace("ws://",  "https://")
               : RPC_URL;

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  sep("LINGO Rescue v3 — EIP-7702");

  const compromisedAccount = privateKeyToAccount(COMPROMISED_KEY);
  const sponsorAccount     = privateKeyToAccount(SPONSOR_KEY);

  log("👤", `Compromised  : ${compromisedAccount.address}`);
  log("💚", `Sponsor      : ${sponsorAccount.address}`);
  log("🏦", `Destination  : ${SAFE_DESTINATION}`);
  log("⚙️ ", `Executor     : ${EXECUTOR_ADDRESS}`);
  log("🎯", `Mode         : ${MODE.toUpperCase()}`);

  // Warn if CLAIM_NONCE is set but mode is not claim — it will be ignored
  if (MODE !== "claim" && process.env.CLAIM_NONCE) {
    log("⚠️ ", "CLAIM_NONCE is set in .env but RESCUE_MODE is not 'claim' — it will be ignored");
  }
  // Warn if STAKE_INDICES is set but mode is not unstake
  if (MODE !== "unstake" && process.env.STAKE_INDICES) {
    log("⚠️ ", "STAKE_INDICES is set in .env but RESCUE_MODE is not 'unstake' — it will be ignored");
  }

  if (SAFE_DESTINATION.toLowerCase() === compromisedAccount.address.toLowerCase()) {
    console.error("\n❌  SAFE_DESTINATION must differ from compromised wallet!"); process.exit(1);
  }

  const transport     = http(HTTP_RPC, { retryCount: 3, retryDelay: 500 });
  const publicClient  = createPublicClient({ chain: base, transport });
  const sponsorClient = createWalletClient({ account: sponsorAccount, chain: base, transport });
  const compromisedClient = createWalletClient({ account: compromisedAccount, chain: base, transport })
    .extend(eip7702Actions());

  // ── Step 1: State ─────────────────────────────────────────────────────────
  sep("Step 1 — Fetching chain state");
  const [sponsorEth, lingoBalance, sponsorNonce, compromisedNonce, currentBlock] =
    await Promise.all([
      publicClient.getBalance({ address: sponsorAccount.address }),
      publicClient.readContract({ address: LINGO_TOKEN, abi: LINGO_ABI, functionName: "balanceOf", args: [compromisedAccount.address] }),
      publicClient.getTransactionCount({ address: sponsorAccount.address }),
      publicClient.getTransactionCount({ address: compromisedAccount.address }),
      publicClient.getBlockNumber(),
    ]);

  log("💰", `Sponsor ETH  : ${formatUnits(sponsorEth, 18)} ETH`);
  log("🪙", `LINGO balance: ${fmt(lingoBalance)}`);
  log("📍", `Block        : ${currentBlock}`);
  log("🔢", `Nonces       : sponsor=${sponsorNonce}  compromised=${compromisedNonce}`);

  if (sponsorEth < parseUnits("0.001", 18)) {
    console.error("\n❌  Sponsor needs ≥0.001 ETH on Base."); process.exit(1);
  }

  // ── Step 2: Verify executor ───────────────────────────────────────────────
  sep("Step 2 — Verifying RescueExecutor");
  const execCode = await publicClient.getBytecode({ address: EXECUTOR_ADDRESS });
  if (!execCode || execCode === "0x") {
    console.error(`\n❌  No contract at ${EXECUTOR_ADDRESS}. Deploy on Remix first.`); process.exit(1);
  }
  log("✅", `RescueExecutor confirmed (${execCode.length / 2 - 1} bytes)`);

  // ── Step 3: Build calldata ────────────────────────────────────────────────
  sep("Step 3 — Building rescue calldata");
  let rescueCalldata;
  let gasLimit = 200_000n;

  if (MODE === "transfer") {
    if (lingoBalance === 0n) {
      console.error("\n❌  LINGO balance is 0 — nothing to transfer."); process.exit(1);
    }
    rescueCalldata = encodeFunctionData({
      abi: RESCUE_ABI, functionName: "rescueTransfer",
      args: [LINGO_TOKEN, SAFE_DESTINATION],
    });
    log("📋", `rescueTransfer() — ${fmt(lingoBalance)} → destination`);
    gasLimit = 120_000n;

  } else if (MODE === "claim") {
    const claimAmount    = BigInt(H(req("CLAIM_AMOUNT")));
    const claimNonceRaw  = H(req("CLAIM_NONCE"));
    const claimSignature = H(req("CLAIM_SIGNATURE"));
    if (claimAmount === 0n)          { console.error("\n❌  CLAIM_AMOUNT is 0"); process.exit(1); }
    if (claimSignature.length < 132) { console.error("\n❌  CLAIM_SIGNATURE too short"); process.exit(1); }
    const claimNonce32 = "0x" + claimNonceRaw.replace("0x", "").padStart(64, "0");
    rescueCalldata = encodeFunctionData({
      abi: RESCUE_ABI, functionName: "rescueClaim",
      args: [CLAIM_CONTRACT, claimAmount, claimNonce32, claimSignature, LINGO_TOKEN, SAFE_DESTINATION],
    });
    log("📋", `rescueClaim(${fmt(claimAmount)}) + transfer all → destination`);
    gasLimit = 380_000n;

  } else if (MODE === "unstake") {
    const indices = req("STAKE_INDICES").split(",").map(s => BigInt(s.trim())).sort((a,b) => a < b ? -1 : 1);
    const stakes  = await publicClient.readContract({
      address: STAKE_CONTRACT, abi: STAKE_ABI,
      functionName: "getStakes", args: [compromisedAccount.address],
    });
    log("📦", `Total positions: ${stakes.length}`);
    let totalUnstake = 0n;
    for (const idx of indices) {
      const n = Number(idx);
      if (n >= stakes.length) { console.error(`\n❌  Index ${idx} out of range`); process.exit(1); }
      const s = stakes[n];
      if (s.unlockBlock > currentBlock) {
        const h = Math.round(Number(s.unlockBlock - currentBlock) * 2 / 3600);
        console.error(`\n❌  Index ${idx} locked ~${h}h`); process.exit(1);
      }
      totalUnstake += s.amount;
      log("✅", `Index ${idx}: ${fmt(s.amount)} — unlocked`);
    }
    rescueCalldata = encodeFunctionData({
      abi: RESCUE_ABI, functionName: "rescueUnstake",
      args: [STAKE_CONTRACT, indices, LINGO_TOKEN, SAFE_DESTINATION],
    });
    log("📋", `rescueUnstake([${indices.join(",")}]) + transfer ${fmt(lingoBalance + totalUnstake)}`);
    gasLimit = 200_000n + BigInt(indices.length) * 120_000n;

  } else {
    console.error(`\n❌  Unknown RESCUE_MODE="${MODE}". Use: transfer | claim | unstake`); process.exit(1);
  }

  // ── Step 4: Sign EIP-7702 authorization ──────────────────────────────────
  sep("Step 4 — EIP-7702 Authorization");
  log("✍️ ", `Signing: ${compromisedAccount.address} → ${EXECUTOR_ADDRESS}`);
  const authorization = await compromisedClient.signAuthorization({
    contractAddress: EXECUTOR_ADDRESS,
    nonce:           compromisedNonce,
  });
  log("✅", `Signed. yParity=${authorization.yParity}`);

  // ── Step 5: Simulate ──────────────────────────────────────────────────────
  sep("Step 5 — Simulation");
  log("🧪", "Simulating...");
  try {
    await publicClient.call({
      account: sponsorAccount.address,
      to: compromisedAccount.address,
      data: rescueCalldata,
      authorizationList: [authorization],
    });
    log("✅", "Simulation PASSED.");
  } catch (err) {
    console.error(`\n❌  Simulation FAILED: ${err.shortMessage || err.message}`);
    process.exit(1);
  }

  // ── Step 6: Gas + broadcast ───────────────────────────────────────────────
  const fees   = await publicClient.estimateFeesPerGas();
  const maxFee  = fees.maxFeePerGas * 2n;
  const maxPrio = fees.maxPriorityFeePerGas * 2n;
  log("⛽", `maxFeePerGas: ${formatUnits(maxFee, 9)} Gwei`);

  sep("Step 6 — Broadcasting");
  console.log(`\n  From : ${compromisedAccount.address}`);
  console.log(`  To   : ${SAFE_DESTINATION}`);
  console.log(`  Mode : ${MODE.toUpperCase()}`);
  console.log(`\n  ⚠️  Broadcasting in 5 seconds. Ctrl+C to abort...\n`);
  await new Promise(r => setTimeout(r, 5000));

  const txHash = await sponsorClient.sendTransaction({
    account:              sponsorAccount,
    to:                   compromisedAccount.address,
    data:                 rescueCalldata,
    authorizationList:    [authorization],
    maxFeePerGas:         maxFee,
    maxPriorityFeePerGas: maxPrio,
    gas:                  gasLimit,
    nonce:                BigInt(sponsorNonce),
  });

  log("🚀", `TX SENT: ${txHash}`);
  log("🔗", `https://basescan.org/tx/${txHash}`);

  // ── Step 7: Confirm ───────────────────────────────────────────────────────
  sep("Step 7 — Confirmation");
  log("⏳", "Waiting...");
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });

  if (receipt.status === "success") {
    const safeBalance = await publicClient.readContract({
      address: LINGO_TOKEN, abi: LINGO_ABI,
      functionName: "balanceOf", args: [SAFE_DESTINATION],
    });
    sep("✅ SUCCESS");
    log("🎉", `Block ${receipt.blockNumber}`);
    log("🎉", `Safe destination: ${fmt(safeBalance)}`);
    log("🔗", `https://basescan.org/tx/${txHash}`);
  } else {
    console.error(`\n❌  REVERTED — https://basescan.org/tx/${txHash}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`\n❌  Fatal: ${err.shortMessage || err.message || err}`);
  process.exit(1);
});
