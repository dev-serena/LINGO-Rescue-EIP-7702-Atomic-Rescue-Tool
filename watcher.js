// ═══════════════════════════════════════════════════════════════════════════════
//  watcher.js — Fast LINGO Watcher
//
//  Watches for LINGO arriving at the compromised wallet via WebSocket event.
//  Pre-signs everything at startup so it can fire in <200ms on trigger.
//
//  Run: node watcher.js
// ═══════════════════════════════════════════════════════════════════════════════

import "dotenv/config";
import {
  createPublicClient, createWalletClient,
  webSocket, http,
  encodeFunctionData, parseAbi,
  formatUnits, parseUnits, getAddress,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { eip7702Actions } from "viem/experimental";

// ── Addresses ─────────────────────────────────────────────────────────────────
const LINGO_TOKEN = "0xfb42Da273158B0F642F59F2Ba7cc1d5457481677";

// ── ABIs ──────────────────────────────────────────────────────────────────────
const LINGO_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const RESCUE_ABI = parseAbi([
  "function rescueTransfer(address token, address destination) external",
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

// Optional: override gas fees (in Gwei). Leave empty for auto (2x estimated).
// Set higher than the sweeper to ensure your tx is accepted first.
// Sweeper observed at ~1.034 Gwei — set MAX_FEE_GWEI=2 to be safe.
// Example: MAX_FEE_GWEI=2  MAX_PRIORITY_GWEI=1.5
const MAX_FEE_GWEI      = process.env.MAX_FEE_GWEI
  ? parseUnits(process.env.MAX_FEE_GWEI, 9)
  : null;
const MAX_PRIORITY_GWEI = process.env.MAX_PRIORITY_GWEI
  ? parseUnits(process.env.MAX_PRIORITY_GWEI, 9)
  : null;

// Derive both wss and https from whatever format is in .env
const WSS_RPC  = RPC_URL.startsWith("wss://") ? RPC_URL
               : RPC_URL.startsWith("ws://")  ? RPC_URL.replace("ws://", "wss://")
               : RPC_URL.replace("https://", "wss://").replace("http://", "wss://");

// RPC_BROADCAST = separate RPC for sending txs (optional, defaults to HTTP version of RPC_URL)
const BROADCAST_RPC  = process.env.RPC_BROADCAST ||
  (RPC_URL.startsWith("wss://") ? RPC_URL.replace("wss://", "https://")
 : RPC_URL.startsWith("ws://")  ? RPC_URL.replace("ws://",  "https://")
 : RPC_URL);

// Optional second broadcast RPC — tx sent on both in parallel, fastest wins
const BROADCAST_RPC2 = process.env.RPC_BROADCAST2 || null;

// ── State ─────────────────────────────────────────────────────────────────────
let armed       = false;
let firing      = false;
let armedParams = null;  // pre-signed tx params
let triggerQueue = [];   // queue of missed triggers while firing/arming

// ── Accounts ──────────────────────────────────────────────────────────────────
const compromisedAccount = privateKeyToAccount(COMPROMISED_KEY);
const sponsorAccount     = privateKeyToAccount(SPONSOR_KEY);

// ── Clients ───────────────────────────────────────────────────────────────────
const wsTransport   = webSocket(WSS_RPC, { reconnect: true, keepAlive: { interval: 10_000 } });
const httpTransport = http(BROADCAST_RPC, { retryCount: 3, retryDelay: 500 });

const publicClient  = createPublicClient({ chain: base, transport: wsTransport });
const sponsorClient  = createWalletClient({ account: sponsorAccount, chain: base, transport: httpTransport });

// Second sponsor client for parallel broadcast (if RPC_BROADCAST2 is set)
const sponsorClient2 = BROADCAST_RPC2
  ? createWalletClient({ account: sponsorAccount, chain: base, transport: http(BROADCAST_RPC2, { retryCount: 2, retryDelay: 300 }) })
  : null;
const compromisedClient = createWalletClient({ account: compromisedAccount, chain: base, transport: httpTransport })
  .extend(eip7702Actions());

// ── Pre-sign and arm ──────────────────────────────────────────────────────────
async function arm() {
  armed  = false;
  firing = false;

  log("⚙️ ", "Arming...");
  const t0 = Date.now();

  try {
    // Fetch all needed data in one parallel batch
    const [sponsorEth, lingoBalance, sponsorNonce, compromisedNonce, fees, execCode] =
      await Promise.all([
        publicClient.getBalance({ address: sponsorAccount.address }),
        publicClient.readContract({ address: LINGO_TOKEN, abi: LINGO_ABI, functionName: "balanceOf", args: [compromisedAccount.address] }),
        publicClient.getTransactionCount({ address: sponsorAccount.address }),
        publicClient.getTransactionCount({ address: compromisedAccount.address }),
        publicClient.estimateFeesPerGas(),
        publicClient.getBytecode({ address: EXECUTOR_ADDRESS }),
      ]);

    // Verify executor
    if (!execCode || execCode === "0x") {
      log("❌", `No contract at EXECUTOR_ADDRESS ${EXECUTOR_ADDRESS}`); return;
    }

    // Check sponsor ETH
    if (sponsorEth < parseUnits("0.001", 18)) {
      log("⚠️ ", `Sponsor ETH low: ${formatUnits(sponsorEth, 18)} ETH`);
    }

    log("🪙", `LINGO balance: ${fmt(lingoBalance)}`);
    log("🔢", `Nonces: sponsor=${sponsorNonce} compromised=${compromisedNonce}`);

    // Build rescue calldata
    const rescueCalldata = encodeFunctionData({
      abi: RESCUE_ABI, functionName: "rescueTransfer",
      args: [LINGO_TOKEN, SAFE_DESTINATION],
    });

    // Sign EIP-7702 authorization
    const authorization = await compromisedClient.signAuthorization({
      contractAddress: EXECUTOR_ADDRESS,
      nonce:           compromisedNonce,
    });

    const maxFee  = MAX_FEE_GWEI      ?? (fees.maxFeePerGas      * 2n);
    const maxPrio = MAX_PRIORITY_GWEI ?? (fees.maxPriorityFeePerGas * 2n);
    log("⛽", `maxFee: ${formatUnits(maxFee, 9)} Gwei  maxPriority: ${formatUnits(maxPrio, 9)} Gwei${MAX_FEE_GWEI ? " (manual)" : " (auto 2x)"}`);

    // Store pre-signed params — ready to fire instantly
    armedParams = {
      rescueCalldata,
      authorization,
      maxFeePerGas:         maxFee,
      maxPriorityFeePerGas: maxPrio,
      gasLimit:             120_000n,
      sponsorNonce:         BigInt(sponsorNonce),
    };

    armed = true;
    log("🔫", `ARMED in ${Date.now() - t0}ms — waiting for LINGO transfer...`);

    // If triggers arrived while arming, check balance first
    if (triggerQueue.length > 0) {
      triggerQueue = []; // clear queue
      // Check if there is actually LINGO to rescue
      try {
        const bal = await publicClient.readContract({
          address: LINGO_TOKEN, abi: LINGO_ABI,
          functionName: "balanceOf", args: [compromisedAccount.address],
        });
        if (bal > 0n) {
          log("🔁", `Balance: ${fmt(bal)} — firing queued rescue`);
          setTimeout(() => fire(bal, "queued"), 50);
        } else {
          log("ℹ️ ", "Queued triggers cleared — balance already 0 (previous rescue covered it)");
        }
      } catch { }
    }

  } catch (err) {
    log("❌", `Arm failed: ${err.shortMessage || err.message}`);
    log("🔄", "Retrying arm in 10s...");
    setTimeout(arm, 10_000);
  }
}

// ── Fire rescue tx ────────────────────────────────────────────────────────────
async function fire(amount, from) {
  if (firing) {
    log("⏳", `Queuing trigger: ${fmt(amount)} from ${from} (firing in progress)`);
    triggerQueue.push({ amount, from });
    return;
  }
  if (!armed) {
    log("⏳", `Queuing trigger: ${fmt(amount)} from ${from} (arming in progress)`);
    triggerQueue.push({ amount, from });
    return;
  }

  firing = true;
  armed  = false;
  const t0 = Date.now();

  log("🚨", `TRIGGER: ${fmt(amount)} received from ${from}`);
  log("🔥", "Firing rescue tx NOW...");

  try {
    const p = armedParams;
    const txParams = {
      account:              sponsorAccount,
      to:                   compromisedAccount.address,
      data:                 p.rescueCalldata,
      authorizationList:    [p.authorization],
      maxFeePerGas:         p.maxFeePerGas,
      maxPriorityFeePerGas: p.maxPriorityFeePerGas,
      gas:                  p.gasLimit,
      nonce:                p.sponsorNonce,
    };

    // Broadcast on both RPCs in parallel — fastest one confirms
    const broadcasts = [sponsorClient.sendTransaction(txParams)];
    if (sponsorClient2) broadcasts.push(sponsorClient2.sendTransaction(txParams).catch(() => null));

    const results  = await Promise.allSettled(broadcasts);
    const txHash   = results.find(r => r.status === "fulfilled" && r.value)?.value;

    if (!txHash) throw new Error("All broadcast RPCs failed");

    log("🚀", `TX SENT in ${Date.now() - t0}ms — ${txHash}`);
    if (sponsorClient2) log("📡", "Broadcast on 2 RPCs in parallel");
    log("🔗", `https://basescan.org/tx/${txHash}`);

    // Wait for confirmation
    log("⏳", "Waiting for confirmation...");
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });

    if (receipt.status === "success") {
      const safeBalance = await publicClient.readContract({
        address: LINGO_TOKEN, abi: LINGO_ABI,
        functionName: "balanceOf", args: [SAFE_DESTINATION],
      });
      log("✅", `Confirmed in block ${receipt.blockNumber} (${Date.now() - t0}ms total)`);
      log("🎉", `Safe destination: ${fmt(safeBalance)}`);
    } else {
      log("❌", `TX REVERTED — https://basescan.org/tx/${txHash}`);
    }

  } catch (err) {
    log("❌", `Fire error: ${err.shortMessage || err.message}`);
  }

  // Re-arm then process any queued triggers
  log("🔄", "Re-arming in 3s...");
  setTimeout(async () => {
    await arm();
    // Check balance before firing queued triggers
    if (triggerQueue.length > 0) {
      triggerQueue = [];
      try {
        const bal = await publicClient.readContract({
          address: LINGO_TOKEN, abi: LINGO_ABI,
          functionName: "balanceOf", args: [compromisedAccount.address],
        });
        if (bal > 0n) {
          log("🔁", `Balance: ${fmt(bal)} — firing queued rescue`);
          await fire(bal, "queued");
        } else {
          log("ℹ️ ", "Queue cleared — balance is 0 (previous rescue covered it)");
        }
      } catch { }
    }
  }, 3000);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  sep("LINGO Fast Watcher");
  log("👤", `Watching     : ${compromisedAccount.address}`);
  log("🏦", `Destination  : ${SAFE_DESTINATION}`);
  log("⚙️ ", `Executor     : ${EXECUTOR_ADDRESS}`);
  log("📡", `Listen RPC    : ${WSS_RPC.slice(0, 40)}...`);
  log("📡", `Broadcast RPC1: ${BROADCAST_RPC.slice(0, 40)}...`);
  if (BROADCAST_RPC2) log("📡", `Broadcast RPC2: ${BROADCAST_RPC2.slice(0, 40)}...`);

  // Arm first — must be ready before watching
  await arm();

  // ── Transfer event constants ─────────────────────────────────────────────
  // keccak256("Transfer(address,address,uint256)")
  const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  // Compromised address padded to 32 bytes for topic matching
  const addressTopic   = "0x000000000000000000000000" + compromisedAccount.address.slice(2).toLowerCase();

  let flashblocksActive = false;

  // ── Raw WebSocket for Flashblocks pendingLogs ─────────────────────────────
  // Direct JSON-RPC over WebSocket — works with any provider that supports pendingLogs
  function startFlashblocksWS() {
    // Node.js 22+ has native WebSocket, no need for 'ws' package
    const WS = globalThis.WebSocket;
    if (!WS) { log("⚠️ ", "WebSocket not available (need Node.js 22+)"); return false; }

    const ws = new WS(WSS_RPC);
    let subId = null;

    ws.addEventListener("open", () => {
      log("⚡", "WebSocket connected — subscribing to pendingLogs (Flashblocks)");
      // Try pendingLogs (Flashblocks ~200ms) first, fallback to logs (~2s)
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id:      1,
        method:  "eth_subscribe",
        params:  ["pendingLogs", {
          address: LINGO_TOKEN,
          topics:  [TRANSFER_TOPIC, null, addressTopic],
        }],
      }));
      // If pendingLogs fails, try standard logs subscription
      ws._fallbackSent = false;
    });

    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data.toString());

        // Subscription confirmed
        if (msg.id === 1 && msg.result) {
          subId = msg.result;
          flashblocksActive = true;
          log("⚡", `Flashblocks pendingLogs active — subId: ${subId}`);
          log("⚡", "Detection: ~200ms (Flashblocks pre-confirmation)");
          return;
        }

        // pendingLogs not supported — try standard logs subscription
        if (msg.id === 1 && msg.error) {
          log("⚠️ ", `pendingLogs not supported: ${msg.error.message}`);
          log("🔄", "Trying standard logs subscription (~2s detection)...");
          ws._fallbackSent = true;
          ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id:      2,
            method:  "eth_subscribe",
            params:  ["logs", {
              address: LINGO_TOKEN,
              topics:  [TRANSFER_TOPIC, null, addressTopic],
            }],
          }));
          return;
        }

        // logs subscription confirmed (fallback)
        if (msg.id === 2 && msg.result) {
          subId = msg.result;
          flashblocksActive = false; // standard logs, not Flashblocks
          log("👀", `Standard logs subscription active — subId: ${subId}`);
          return;
        }
        if (msg.id === 2 && msg.error) {
          log("❌", `logs subscription also failed: ${msg.error.message}`);
          log("👀", "watchEvent safety net still active");
          ws.close();
          return;
        }

        // Incoming Transfer event
        if (msg.method === "eth_subscription" && msg.params?.subscription === subId) {
          const logData = msg.params.result;
          if (!logData?.topics || logData.topics[0] !== TRANSFER_TOPIC) return;

          const amount = BigInt(logData.data || "0x0");
          const from   = "0x" + logData.topics[1].slice(26);

          if (amount > 0n) {
            log("⚡", `Flashblocks: ${fmt(amount)} from ${from.slice(0, 10)}...`);
            fire(amount, from);
          }
        }
      } catch { }
    });

    ws.addEventListener("error", (err) => {
      log("⚠️ ", `Flashblocks WS error: ${err?.message || err}`);
    });

    ws.addEventListener("close", () => {
      if (flashblocksActive) {
        log("⚠️ ", "Flashblocks WS closed — reconnecting in 3s...");
        flashblocksActive = false;
        setTimeout(startFlashblocksWS, 3000);
      }
    });

    return true;
  }

  // Start Flashblocks WebSocket
  try {
    startFlashblocksWS();
  } catch (err) {
    log("⚠️ ", `Flashblocks WS failed: ${err.message}`);
  }

  // ── Standard watchEvent (safety net + fallback) ───────────────────────────
  // Always active. If Flashblocks fired already → just logs confirmation.
  // If Flashblocks inactive → fires the rescue tx.
  publicClient.watchEvent({
    address: LINGO_TOKEN,
    event:   LINGO_ABI.find(x => x.name === "Transfer"),
    args:    { to: compromisedAccount.address },
    onLogs:  (logs) => {
      for (const l of logs) {
        const amount = l.args.value || 0n;
        const from   = l.args.from  || "unknown";
        if (flashblocksActive) {
          // Flashblocks already fired ~200ms ago — this is the on-chain confirmation
          log("✅", `On-chain confirmed: ${fmt(amount)}`);
        } else {
          // Flashblocks not active — fire from standard event
          fire(amount, from);
        }
      }
    },
    onError: (err) => log("⚠️ ", `watchEvent error: ${err.message}`),
  });

  log("👀", `Watching transfers → ${compromisedAccount.address.slice(0, 10)}...`);
  log("✅", "Watcher running. Press Ctrl+C to stop.\n");

  // Re-arm every 10 minutes to refresh nonce and gas price
  setInterval(async () => {
    if (!firing) {
      log("🔄", "Scheduled re-arm (10min refresh)...");
      await arm();
    }
  }, 10 * 60 * 1000);

  process.on("SIGINT", () => { log("👋", "Stopped."); process.exit(0); });
  process.on("unhandledRejection", (err) => log("⚠️ ", String(err?.message || err)));
}

main().catch(err => {
  console.error(`\n❌  Fatal: ${err.shortMessage || err.message || err}`);
  process.exit(1);
});
