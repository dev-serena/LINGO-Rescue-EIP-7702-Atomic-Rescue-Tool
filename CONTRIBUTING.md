# Publishing to GitHub

## Step 1 — Create the repository

1. Go to **https://github.com/new**
2. Repository name: `lingo-rescue`
3. Description: `EIP-7702 atomic rescue tool for LINGO tokens on Base`
4. Visibility: **Public** or **Private**
5. ❌ Do NOT initialize with README (we already have one)
6. Click **Create repository**

---

## Step 2 — Install Git on Windows

Download from **https://git-scm.com/download/win**
After install, open **Git Bash** or **PowerShell**.

---

## Step 3 — Push to GitHub

Open **Git Bash** in the project folder:

```bash
cd /path/to/lingo-rescue-v3

# Initialize git
git init

# Add all files (except .env — already in .gitignore)
git add .

# First commit
git commit -m "Initial release — EIP-7702 LINGO rescue tool"

# Connect to your GitHub repo (replace YOUR_USERNAME)
git remote add origin https://github.com/YOUR_USERNAME/lingo-rescue.git

# Push
git branch -M main
git push -u origin main
```

---

## Step 4 — Verify .env is NOT pushed

After pushing, go to your GitHub repo and confirm:
- ✅ `.env.example` is visible
- ❌ `.env` is NOT there (contains your private keys)

---

## Updating later

```bash
git add .
git commit -m "description of changes"
git push
```
