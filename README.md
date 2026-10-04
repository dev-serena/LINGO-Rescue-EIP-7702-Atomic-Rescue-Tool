# LINGO Rescue — EIP-7702 Atomic Rescue Tool

Rescue LINGO tokens from a compromised wallet on Base mainnet using EIP-7702.

- **Claim**, **unstake**, and **transfer** — all in one atomic transaction
- Gas paid entirely by a clean sponsor wallet
- Compromised wallet never receives ETH
- Broadcasts via private RPC — sweeper cannot front-run

---

## How it works

```
Compromised wallet
  └─ Signs EIP-7702 authorization offline (free, no ETH needed)

Sponsor wallet
  └─ Broadcasts ONE type-4 tx:
       authorizationList: [compromised → RescueExecutor]
       data: rescueClaim() / rescueUnstake() / rescueTransfer()
         ↓ executes AS the compromised wallet
         ├─ claim(amount, nonce, sig)    → LINGO credited
         ├─ unstake(index)...            → LINGO credited
         └─ transfer(SAFE, totalBalance) → LINGO swept out
```

---

## Prerequisites

- **Node.js 22+** — https://nodejs.org/en/download
- **A private RPC** for Base mainnet (dRPC, Alchemy, QuickNode, Chainstack)
- **Sponsor wallet** with ~0.002 ETH on Base for gas
- **RescueExecutor deployed** on Base via Remix (see Step 2)

---

## Install

```powershell
git clone https://github.com/YOUR_USERNAME/lingo-rescue.git or download repo
cd lingo-rescue
npm install
```

---

## Setup

### Step 1 — Configure .env

```powershell
copy .env.example .env
notepad .env
```

Fill in the required values:

| Variable | Description |
|---|---|
| `COMPROMISED_PRIVATE_KEY` | Private key of the hacked wallet |
| `SPONSOR_PRIVATE_KEY` | Clean wallet that pays gas |
| `SAFE_DESTINATION` | Address that receives rescued LINGO |
| `RPC_URL` | WebSocket RPC for Base (wss://) |
| `RPC_BROADCAST` | HTTP RPC for broadcasting txs |
| `RPC_BROADCAST2` | Second HTTP RPC (optional, for redundancy) |
| `EXECUTOR_ADDRESS` | RescueExecutor deployed address (see Step 2) |

**Free RPC options:**
Create free account on https://alchemy.com and https://drpc.org/
```env
RPC_URL=wss://base-mainnet.g.alchemy.com/v2/YOUR_KEY      # écoute — WebSocket gratuit
RPC_BROADCAST=https://lb.drpc.live/base/YOUR_KEY 
RPC_BROADCAST2=https://mainnet.base.org
```

---

### Step 2 — Deploy RescueExecutor on Remix

1. Go to **https://remix.ethereum.org**
2. Create a new file → paste `RescueExecutor.sol`
3. **Solidity Compiler** tab:
   - Version: `0.8.20`
   - Enable optimization ✅ — Runs: `200`
   - EVM Version: `osaka`
   - Click **Compile RescueExecutor.sol**
4. **Deploy & Run** tab:
   - Environment: **Injected Provider - MetaMask**
   - Connect your **sponsor wallet** on Base mainnet
   - Contract: `RescueExecutor`
   - Click **Deploy** → confirm in MetaMask
5. Copy the deployed address → paste in `.env`:
   ```env
   EXECUTOR_ADDRESS=0x...
   ```

> The executor only needs to be deployed once. Cost: ~$0.01 on Base.

**Already deployed — you can skip deployment and use this address directly:**
```env
EXECUTOR_ADDRESS=0xBe7b686B3d9919Db04526c3935c6d72E86310AE1
```
[Verify on Basescan](https://basescan.org/address/0xBe7b686B3d9919Db04526c3935c6d72E86310AE1)

---

## Usage

### Mode 1 — Transfer existing LINGO balance

```env
RESCUE_MODE=transfer
```

```powershell
npm run rescue
```

---

### Mode 2 — Claim rewards + transfer

Get your claim payload from the Lingo app (DevTools → Network → find the claim API response):

```env
RESCUE_MODE=claim
CLAIM_AMOUNT=
CLAIM_NONCE=
CLAIM_SIGNATURE=
```

**How to find the claim payload:**
1. Open app.lingo.lol in Chrome
2. F12 → Network → Fetch/XHR
3. Click "Claim" in the app
4. Find the API response with `signature`, `claimedAmount`, `claimId`
5. Convert values:
   - `claimedAmount` → convert to wei then hex → `CLAIM_AMOUNT`
   - `claimId` → encode to UTF-8 hex → `CLAIM_NONCE`
   - `signature` → strip `0x` → `CLAIM_SIGNATURE`

```powershell
npm run rescue
```

---

### Mode 3 — Unstake positions + transfer

First check which positions are unlocked:
1. Go to [Basescan staking contract](https://basescan.org/address/0x9aF8C0dac726CcEE2BFd6c0f3E21f320d42398AC#readContract)
2. Call `getStakes(yourCompromisedAddress)`
3. Find positions where `unlockBlock <= currentBlock`
4. Note their 0-based indices

```env
RESCUE_MODE=unstake
STAKE_INDICES=33,34,35
```

```powershell
npm run rescue
```

> ⚠️ Indices shift after each unstake — always re-check `getStakes()` between runs.

---

### Watcher — Automatic rescue on token arrival

Runs permanently before send tx or click wheel ( but close after with Ctrl +C ). Pre-signs everything at startup. Fires rescue tx in **<200ms** when LINGO arrives at the compromised wallet.

```env
RESCUE_MODE=transfer
MAX_FEE_GWEI=2
MAX_PRIORITY_GWEI=1.5
```

```powershell
npm run watch
```

Output:
```
⚙️   Arming...
🔫  ARMED in 380ms — waiting for LINGO transfer...
👀  Watching transfers → 0x52c601...

💸  LINGO received: 100 LINGO from 0x...
🚨  TRIGGER
🔥  Firing rescue tx NOW...
🚀  TX SENT in 180ms
✅  Confirmed in block 50653348
🎉  Safe destination: 100.0000 LINGO
```

---


## Scripts

| Command | Description |
|---|---|
| `npm run rescue` | One-shot rescue (transfer / claim / unstake) |
| `npm run watch` | Permanent watcher — fires on Transfer event |

---

## Files

| File | Description |
|---|---|
| `rescue.js` | Main rescue script |
| `watcher.js` | Permanent transfer watcher |
| `RescueExecutor.sol` | Delegate contract (deploy on Remix) |
| `.env.example` | Configuration template |

---

## Security

- **Never commit `.env`** — it contains private keys (already in `.gitignore`)
- Compromised wallet **never broadcasts** anything — only signs offline
- Sponsor wallet never sends ETH to the compromised wallet
- All operations atomic — sweeper cannot react between steps

---

## Contracts (Base mainnet)

| Contract | Address |
|---|---|
| LINGO token | `0xfb42Da273158B0F642F59F2Ba7cc1d5457481677` |
| Claim contract | `0x2f26621e931c32542579CF8860D7e8616DF32E0E` |
| Staking contract | `0x9aF8C0dac726CcEE2BFd6c0f3E21f320d42398AC` |
| RescueExecutor | `0xBe7b686B3d9919Db04526c3935c6d72E86310AE1` |

---

## License

MIT
