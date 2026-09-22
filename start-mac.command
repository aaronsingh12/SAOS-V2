#!/usr/bin/env bash
#
# Double-click in Finder to start SAOS on a Mac (after setup-mac.sh has run once).
# Starts the API on :4000 and the UI on :5173, opens the browser, and keeps
# running in this Terminal window — close the window or press Ctrl+C to stop.

cd "$(dirname "$0")" || exit 1

# Finder-launched windows may not have loaded ~/.zprofile yet.
for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  [ -x "$b" ] && { eval "$("$b" shellenv)"; break; }
done
if command -v brew >/dev/null 2>&1 && [ -d "$(brew --prefix)/opt/node@24/bin" ]; then
  PATH="$(brew --prefix)/opt/node@24/bin:$PATH"
fi

if ! command -v node >/dev/null 2>&1 || [ ! -d server/node_modules ] || [ ! -d client/node_modules ]; then
  echo "SAOS is not set up on this Mac yet. Run:  bash setup-mac.sh"
  read -r -p "Press RETURN to close." _
  exit 1
fi

( sleep 8; open "http://localhost:5173" ) >/dev/null 2>&1 &
exec npm run dev
