#!/usr/bin/env bash
#
# SAOS V2 — one-shot setup for a new Mac.
#
#   bash setup-mac.sh                 # install everything, clone to ~/SAOS-V2, start the app
#   bash setup-mac.sh --help          # every option
#
# What it does, in order (each step is skipped when already done, so re-running
# is safe and is also how you update):
#
#   1. Homebrew (and the Xcode Command Line Tools it needs)
#   2. git, the GitHub CLI, and Node.js 24 (the app needs Node 22.5+ for node:sqlite)
#   3. the code — cloned from GitHub (private repo: you sign in once in the browser),
#      or, when this script is run from inside a clone, that clone is used as-is
#   4. npm dependencies for the server, the web client and the ServiceNow SDK workspace
#   5. optional: the SAOS Python service (--with-python) and Ollama (--with-ollama)
#   6. starts the app: API on http://localhost:4000, UI on http://localhost:5173
#
# Nothing here asks for ServiceNow credentials. You connect your instance in the
# app (Dashboard → Connection) and your AI model in Settings; both are stored in
# server/data/settings.json, which is never committed.
#
# Written for the bash 3.2 that ships with macOS — no bash 4 features.

set -euo pipefail

REPO_URL="https://github.com/aaronsingh12/SAOS-V2.git"
BRANCH="main"
TARGET_DIR="${HOME}/SAOS-V2"
WITH_PYTHON=0
WITH_OLLAMA=0
RUN_TESTS=0
START_APP=1
DIR_GIVEN=0

# ── output ────────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_B=$'\033[1m'; C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_C=$'\033[36m'; C_0=$'\033[0m'
else
  C_B=''; C_G=''; C_Y=''; C_R=''; C_C=''; C_0=''
fi
step() { printf '\n%s==> %s%s\n' "${C_B}${C_C}" "$*" "${C_0}"; }
ok()   { printf '%s  ✓ %s%s\n' "${C_G}" "$*" "${C_0}"; }
warn() { printf '%s  ! %s%s\n' "${C_Y}" "$*" "${C_0}"; }
die()  { printf '\n%s✗ %s%s\n' "${C_R}" "$*" "${C_0}" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<EOF
SAOS V2 — macOS setup

Usage: bash setup-mac.sh [options]

  --dir PATH       where the project goes (default: ~/SAOS-V2; ignored when run
                   from inside an existing clone, which is then used as-is)
  --repo URL       git URL to clone (default: ${REPO_URL})
  --branch NAME    branch to check out (default: ${BRANCH})
  --with-python    also set up the SAOS Python analysis service
                   (SAOS_functionalities/saos) with Python 3.12 and a local SQLite .env
  --with-ollama    install Ollama and pull nomic-embed-text (local models / semantic recall)
  --test           run the server's offline test suite after installing
  --no-start       set everything up but do not start the app
  -h, --help       this help

Not set up on macOS: meeting-agent/ (it captures audio through Windows-only APIs).
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) TARGET_DIR="${2:?--dir needs a path}"; DIR_GIVEN=1; shift 2 ;;
    --repo) REPO_URL="${2:?--repo needs a URL}"; shift 2 ;;
    --branch) BRANCH="${2:?--branch needs a name}"; shift 2 ;;
    --with-python) WITH_PYTHON=1; shift ;;
    --with-ollama) WITH_OLLAMA=1; shift ;;
    --test) RUN_TESTS=1; shift ;;
    --no-start) START_APP=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "Unknown option: $1" ;;
  esac
done

[ "$(uname -s)" = "Darwin" ] || die "This script is for macOS. On Windows follow the Quickstart in README.md."
[ "$(id -u)" -ne 0 ] || die "Run this as your normal user, not with sudo — Homebrew refuses to run as root."

# Append a line to ~/.zprofile once, so new Terminal windows find the same tools.
persist() {
  local line="$1" profile="${HOME}/.zprofile"
  touch "$profile"
  grep -qxF "$line" "$profile" 2>/dev/null || printf '%s\n' "$line" >> "$profile"
}

# ── 1. Homebrew + Command Line Tools ─────────────────────────────────────────
step "Homebrew"
brew_bin=""
for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  [ -x "$candidate" ] && { brew_bin="$candidate"; break; }
done
if [ -z "$brew_bin" ]; then
  warn "Homebrew is not installed — installing it now. It will ask for your Mac password and to press RETURN."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [ -x "$candidate" ] && { brew_bin="$candidate"; break; }
  done
  [ -n "$brew_bin" ] || die "Homebrew did not install. Install it from https://brew.sh and run this script again."
fi
eval "$("$brew_bin" shellenv)"
persist "eval \"\$(${brew_bin} shellenv)\""
ok "Homebrew $(brew --version 2>/dev/null | awk 'NR==1{print $2}') at $(brew --prefix)"

if ! xcode-select -p >/dev/null 2>&1; then
  xcode-select --install >/dev/null 2>&1 || true
  die "The Xcode Command Line Tools are required. Finish the install window that just opened, then run this script again."
fi
ok "Xcode Command Line Tools"

# ── 2. git, GitHub CLI, Node.js ──────────────────────────────────────────────
step "git, GitHub CLI and Node.js"
brew_install() {  # brew_install <formula> [command-to-check]
  local formula="$1" cmd="${2:-$1}"
  if have "$cmd"; then ok "$formula already installed"; return 0; fi
  brew install "$formula" && ok "installed $formula"
}
brew_install git
brew_install gh

# node:sqlite is the storage layer. It needs Node 22.5+, and it is only usable
# WITHOUT a flag from 22.13 — so the check is "can node load node:sqlite", which
# is the thing that actually has to be true, not a version comparison.
node_ok() { have node && node -e "require('node:sqlite')" >/dev/null 2>&1; }
if ! node_ok; then
  if brew info node@24 >/dev/null 2>&1; then
    brew install node@24
    node_prefix="$(brew --prefix node@24)"
    export PATH="${node_prefix}/bin:${PATH}"
    persist "export PATH=\"${node_prefix}/bin:\$PATH\""
  else
    brew install node
  fi
  hash -r
fi
node_ok || die "Node.js $(node -v 2>/dev/null || echo '(none)') cannot load node:sqlite. Install Node 24 (brew install node@24) and run this script again."
ok "Node.js $(node -v), npm $(npm -v)"

# ── 3. the code ──────────────────────────────────────────────────────────────
step "Project code"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || pwd)"
is_project() { [ -f "$1/package.json" ] && [ -d "$1/server" ] && [ -d "$1/client" ] && grep -q '"name": "nowhelpassist"' "$1/package.json" 2>/dev/null; }

if [ "$DIR_GIVEN" -eq 0 ] && is_project "$SCRIPT_DIR"; then
  ROOT="$SCRIPT_DIR"
  ok "Using the clone this script is in: $ROOT"
else
  ROOT="$TARGET_DIR"
  if [ -d "$ROOT/.git" ]; then
    ok "Found an existing clone at $ROOT — updating it"
    if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
      warn "It has local changes, so it is left exactly as it is (no pull)."
    else
      git -C "$ROOT" fetch --quiet origin
      git -C "$ROOT" checkout --quiet "$BRANCH"
      git -C "$ROOT" pull --ff-only --quiet origin "$BRANCH" || warn "Could not fast-forward $BRANCH — left as it was."
    fi
  else
    [ ! -e "$ROOT" ] || die "$ROOT exists and is not a git clone. Move it aside or pass --dir somewhere else."
    # The repository is private: sign in to GitHub once, in the browser, and let
    # git use that sign-in. Skipped when git can already reach the repo.
    if ! GIT_TERMINAL_PROMPT=0 git ls-remote "$REPO_URL" >/dev/null 2>&1; then
      if ! gh auth status --hostname github.com >/dev/null 2>&1; then
        warn "Sign in to GitHub (the account that can see the repository). A browser window will open."
        gh auth login --hostname github.com --git-protocol https --web
      fi
      gh auth setup-git --hostname github.com
    fi
    git clone --branch "$BRANCH" "$REPO_URL" "$ROOT"
  fi
  is_project "$ROOT" || die "$ROOT does not look like the SAOS project (no package.json / server / client)."
  ok "Code at $ROOT ($(git -C "$ROOT" rev-parse --abbrev-ref HEAD) @ $(git -C "$ROOT" rev-parse --short HEAD))"
fi

# ── 4. npm dependencies ──────────────────────────────────────────────────────
step "npm dependencies"
npm_deps() {  # npm_deps <dir> <label>
  local dir="$1" label="$2"
  [ -f "$dir/package.json" ] || { warn "$label: no package.json — skipped"; return 0; }
  printf '  … %s\n' "$label"
  if [ -f "$dir/package-lock.json" ]; then
    # Reproducible install from the lockfile; fall back to a normal install if
    # the lockfile and package.json have drifted apart.
    (cd "$dir" && npm ci --no-audit --no-fund --loglevel=error) \
      || (cd "$dir" && npm install --no-audit --no-fund --loglevel=error)
  else
    (cd "$dir" && npm install --no-audit --no-fund --loglevel=error)
  fi
  ok "$label"
}
npm_deps "$ROOT/server" "server (API)"
npm_deps "$ROOT/client" "client (web UI)"
npm_deps "$ROOT/server/fluent-workspace" "ServiceNow SDK workspace (flows, UI policies, tables)"

# A lockfile written on Windows can, rarely, miss the macOS build of Vite's
# native bundler. Prove the client builds; if it cannot, reinstall from scratch
# so npm resolves the right platform packages.
if ! (cd "$ROOT/client" && npx --no-install vite build --outDir "$(mktemp -d)" >/dev/null 2>&1); then
  warn "The web client did not build on first try — reinstalling its packages for this Mac"
  rm -rf "$ROOT/client/node_modules"
  (cd "$ROOT/client" && npm install --no-audit --no-fund --loglevel=error)
  (cd "$ROOT/client" && npx --no-install vite build --outDir "$(mktemp -d)" >/dev/null) \
    || die "The web client still does not build. Run: cd \"$ROOT/client\" && npx vite build — and read the error."
fi
ok "web client builds"
# Loading the agent tool registry pulls in nearly every server module, so a
# missing or broken dependency shows up here rather than on the first request.
(cd "$ROOT/server" && node -e "import('./src/agent/tools.js').then(()=>process.exit(0),(e)=>{console.error(e.message);process.exit(1)})" >/dev/null) \
  || die "The server's modules did not load. Run: cd \"$ROOT/server\" && node src/index.js — and read the error."
ok "server modules load"

# ── 5a. optional: SAOS Python service ────────────────────────────────────────
if [ "$WITH_PYTHON" -eq 1 ]; then
  step "SAOS Python service"
  PYDIR="$ROOT/SAOS_functionalities/saos"
  if [ ! -f "$PYDIR/requirements.txt" ]; then
    warn "No SAOS_functionalities/saos/requirements.txt — skipped"
  else
    brew_install python@3.12 python3.12
    PY="$(brew --prefix python@3.12)/bin/python3.12"
    # `.venv`, not the committed `venv/` — that one holds Windows executables
    # and is useless here; `.venv` is gitignored.
    [ -x "$PYDIR/.venv/bin/python" ] || "$PY" -m venv "$PYDIR/.venv"
    "$PYDIR/.venv/bin/python" -m pip install --quiet --upgrade pip
    "$PYDIR/.venv/bin/python" -m pip install --quiet -r "$PYDIR/requirements.txt"
    ok "Python packages in SAOS_functionalities/saos/.venv"
    if [ ! -f "$PYDIR/.env" ]; then
      umask 077
      cat > "$PYDIR/.env" <<EOF
# Generated by setup-mac.sh for local development. Never commit this file.
APP_ENV=development
APP_SECRET_KEY=$(openssl rand -hex 32)
JWT_SECRET_KEY=$(openssl rand -hex 32)
DATABASE_URL=sqlite+aiosqlite:///./saos_dev.db
# Only read when DATABASE_URL points at PostgreSQL.
POSTGRES_PASSWORD=$(openssl rand -hex 16)
# Your ServiceNow instance — fill these in before running an analysis.
SERVICENOW_INSTANCE_URL=
SERVICENOW_READER_USERNAME=
SERVICENOW_READER_PASSWORD=
EOF
      umask 022
      ok "Created SAOS_functionalities/saos/.env (SQLite, fresh secrets) — add your ServiceNow details to it"
    else
      ok "SAOS_functionalities/saos/.env already exists — left as it is"
    fi
  fi
fi

# ── 5b. optional: Ollama ─────────────────────────────────────────────────────
if [ "$WITH_OLLAMA" -eq 1 ]; then
  step "Ollama"
  brew_install ollama
  brew services start ollama >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    curl -fs http://localhost:11434/api/tags >/dev/null 2>&1 && break
    sleep 1
  done
  if ollama pull nomic-embed-text; then
    ok "Ollama running, nomic-embed-text pulled (pick a chat model in Settings)"
  else
    warn "Ollama is installed but the model pull failed — run: ollama pull nomic-embed-text"
  fi
fi

# ── 5c. optional: tests ──────────────────────────────────────────────────────
if [ "$RUN_TESTS" -eq 1 ]; then
  step "Server test suite (offline — touches no instance)"
  (cd "$ROOT" && npm test) || warn "Some tests failed — the app can still run; see the output above."
fi

# ── done ─────────────────────────────────────────────────────────────────────
step "Ready"
cat <<EOF
  Project:   $ROOT
  Start it:  cd "$ROOT" && npm run dev        (or double-click start-mac.command)
  Open:      http://localhost:5173
  Then:      Dashboard → Connection  (your ServiceNow instance URL, user, password)
             Settings                (your AI provider and key, or Ollama)
             Dashboard → SDK setup    (lets it build flows, UI policies and tables)
EOF
if [ "$WITH_PYTHON" -eq 1 ] && [ -d "$ROOT/SAOS_functionalities/saos/.venv" ]; then
  cat <<EOF
  SAOS Python service (separate, optional):
    cd "$ROOT/SAOS_functionalities/saos"
    .venv/bin/python -m scripts.create_user          # once: your login
    .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
    .venv/bin/python -m app.orchestration.worker      # second terminal
EOF
fi
echo "  New Terminal windows find Homebrew and Node automatically (added to ~/.zprofile)."

if [ "$START_APP" -eq 1 ]; then
  step "Starting SAOS — API :4000, UI :5173 (Ctrl+C stops both)"
  ( sleep 8; open "http://localhost:5173" ) >/dev/null 2>&1 &
  cd "$ROOT"
  exec npm run dev
fi
