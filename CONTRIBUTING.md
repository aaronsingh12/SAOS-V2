# Working on NowForge together

`main` is the trunk. Every collaborator works on a short-lived branch cut from
`main`, and lands it back through a pull request. Nobody commits to `main`
directly — the branch protection we rely on is social, so this document is the
protection.

---

## Once per laptop

Requirements: **Node 22.5+** (the storage layer is `node:sqlite`, which landed in
22.5.0 — on anything older the server dies at its first import), git, and a
GitHub account that has been added as a collaborator on the repo.

```bash
git clone https://github.com/aaronsingh12/nowforge.git
cd nowforge

npm install --prefix server
npm install --prefix client

# Both halves, one terminal. Ctrl+C stops both.
npm run dev
```

Tell git who you are, so the history attributes your work to you and not to
whoever set the laptop up:

```bash
git config user.name  "Your Name"
git config user.email "you@techsnitch.co"
```

Then open http://localhost:5173 and connect your own PDI under **Dashboard**,
and your own LLM key under **Settings**.

**You do not share credentials, and you do not commit them.** They live in
`server/data/settings.json`, which is gitignored. Same for
`server/fluent-workspace/now.config.json` — it is *generated* from the tracked
`now.config.template.json` on first run, because it carries a scope sys_id and a
sys_id is instance-local. Never add either file to a commit.

---

## Every morning — start from main

Do this before you write a line of code, even if you think nothing changed
overnight. Three people are pushing to this repo; something changed.

```bash
git checkout main
git pull --ff-only origin main
```

`--ff-only` is deliberate. If it refuses, you have commits sitting on your local
`main` that were never meant to be there — stop and move them onto a branch
rather than merging them in:

```bash
git branch rescue/my-stray-work    # keep them
git reset --hard origin/main       # and make main match the remote again
```

Then cut today's branch off that fresh `main`:

```bash
git checkout -b <yourname>/<what-it-does>
```

Name it after yourself and the work — `agamya/catalog-filters`,
`aaron/flow-retry`. One branch per piece of work, not one per day: if
yesterday's branch is still open and unmerged, check it out and keep going
instead of cutting a new one.

---

## During the day

Commit as you go, in your branch. Small commits with real messages beat one
end-of-day dump — they are what makes a review possible.

```bash
git add -A
git commit -m "feat(catalog): filter items by category"
```

Run the tests before you push:

```bash
npm test
```

---

## Every evening — push and open a PR

```bash
# 1. make sure everything is committed
git status

# 2. pick up whatever landed on main today
git fetch origin
git rebase origin/main
```

If the rebase reports conflicts, fix the listed files, `git add` them, then
`git rebase --continue`. If it goes wrong, `git rebase --abort` puts you back
exactly where you started — it is always safe to retreat.

```bash
# 3. push your branch (first push of a branch needs -u)
git push -u origin <yourname>/<what-it-does>

# on later pushes of a branch you have already rebased:
git push --force-with-lease
```

`--force-with-lease`, never plain `--force`. The lease is what refuses the push
if someone else has touched your branch in the meantime, instead of silently
erasing their work.

```bash
# 4. open the PR
gh pr create --base main --fill
```

No `gh`? Push, then open the PR from the link GitHub prints in the push output.

Leave the PR open for review. Once it is merged, delete the branch and start
tomorrow from a fresh `main` — that is the whole loop.

```bash
git checkout main
git pull --ff-only origin main
git branch -d <yourname>/<what-it-does>
```

---

## Where things stand

Everything merged into `main` as of the last audit: `agamya_ui`,
`feat/role-elevation`, `fluent-live-flow-authoring`, `hotfix/duplicate-identity`,
`v0.3-experience`, `v0.5a-transport`, `fix/compaction-user-turn`. No branch is
carrying unmerged work. `master` is the original baseline and is kept only for
history — do not branch from it.

---

## The rules that are not about git

- **Never redesign the UI as a side effect.** If the work is not a UI change,
  the diff contains no UI change.
- **Read the trap ledger before you assume a behaviour.** `docs/` records the
  things on this instance that do not work the way they look like they work.
- **Fail loudly.** A swallowed error on this project costs a day of somebody
  else's time.
- **Leave the tree clean.** Nothing uncommitted, nothing stashed, at the end of
  the day.
