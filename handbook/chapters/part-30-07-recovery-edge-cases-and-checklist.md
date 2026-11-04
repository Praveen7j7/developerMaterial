## 30.14 Recovery scenarios

Seven procedures, step by step. Print them; you will need them under pressure, and under pressure is exactly when people improvise badly.

### 30.14.1 A secret was pushed

**Order of operations matters more than the commands.**

**Step 1 — Rotate first.** Before touching Git, invalidate the credential. Rewriting history does not un-read the secret: it was on the remote, in CI logs, in forks, in clones, in caches, and possibly in an attacker's hands. Time-to-abuse for a leaked cloud key is measured in minutes.

```bash
# Example: AWS. Create a new key, deploy it, then delete the old one.
$ aws iam create-access-key --user-name svc-orders
# update the secret store and redeploy, verify, then:
$ aws iam delete-access-key --user-name svc-orders --access-key-id AKIA...
```

**Step 2 — Assess exposure.** Check provider access logs (CloudTrail, database audit logs) for use of the credential from unexpected sources, and record the exposure window: first push time to revocation time.

**Step 3 — Rewrite history.** Use `git filter-repo` (BFG is an alternative; `filter-branch` is deprecated and dangerously slow).

```bash
$ pip install git-filter-repo

# Work on a mirror so you never damage anyone's working copy.
$ git clone --mirror git@github.com:acme/orders-api.git orders-api-mirror
$ cd orders-api-mirror

# Option A: remove a file from all history.
$ git filter-repo --invert-paths --path config/production.env

# Option B: redact a string but keep the file.
$ printf 'AKIAIOSFODNN7EXAMPLE==>REDACTED\n' > /tmp/replacements.txt
$ git filter-repo --replace-text /tmp/replacements.txt

# filter-repo removes the remote to prevent accidental pushes. Re-add it.
$ git remote add origin git@github.com:acme/orders-api.git
```

**Step 4 — Coordinate the force-push.** This rewrites every commit hash after the earliest affected commit, so every open branch and every clone is affected. Do it deliberately:

1. Announce a freeze. Ask everyone to push work and stop.
2. Temporarily disable branch protection on the affected branches (an admin action, logged).
3. Push:

   ```bash
   $ git push --force --all
   $ git push --force --tags
   ```

4. Re-enable branch protection immediately.
5. Tell everyone to **re-clone**. Do not tell them to pull: pulling merges the old and new histories and reintroduces the secret.
6. Ask the hosting provider to garbage-collect and to expire cached views of the old commits. On GitHub, old commits can remain reachable via the API by SHA and in forks; open a support request, and remember that any fork is a separate repository you cannot rewrite.

**Step 5 — Prevent recurrence.** Enable server-side push protection, add Gitleaks pre-commit and CI (Part 29, section 29.6), and move the credential to a secret manager.

### 30.14.2 A force-push overwrote a teammate

Their commits are unreachable on the remote but still exist in their local reflog, and often in the remote's reflog too.

```bash
# On the teammate's machine, or any clone that had fetched the old state:
$ git reflog show origin/feature/checkout
7b2e5d1 refs/remotes/origin/feature/checkout@{0}: fetch: forced-update
c8f1a92 refs/remotes/origin/feature/checkout@{1}: fetch: fast-forward

# c8f1a92 is the pre-force-push tip. Recreate it.
$ git branch rescue/checkout c8f1a92

# Find what was lost relative to the current remote state.
$ git log --oneline origin/feature/checkout..rescue/checkout

# Reapply onto the current branch.
$ git switch feature/checkout
$ git cherry-pick <each missing sha>
$ git push
```

If no local clone has it, check whether the host does: GitHub's Events API and the branch's activity log often retain the overwritten SHA, and a commit can be fetched by SHA even when no ref points at it (`git fetch origin <sha>`).

**Prevention:** `--force-with-lease` instead of `--force`, and branch protection blocking force-push on shared branches.

### 30.14.3 Committed to the wrong branch

You made three commits on `main` that belong on a feature branch, and you have not pushed.

```bash
# 1. Create the branch here, capturing the commits.
$ git branch feature/refunds

# 2. Move main back to where it should be.
$ git reset --hard origin/main

# 3. Continue on the feature branch.
$ git switch feature/refunds
```

If you already pushed to `main` and it is protected/shared, do not reset. Revert on `main` and cherry-pick onto the feature branch:

```bash
$ git switch feature/refunds
$ git cherry-pick <sha1> <sha2> <sha3>
$ git switch main
$ git revert --no-commit <sha3> <sha2> <sha1>     # newest first
$ git commit -m "Revert: move refund work to feature/refunds (pushed to main in error)"
```

If only the **last, unpushed** commit is on the wrong branch, the quick form is:

```bash
$ git reset --soft HEAD~1        # uncommit, keep changes staged
$ git switch -c feature/refunds  # take the staged changes with you
$ git commit -c ORIG_HEAD        # reuse the original message
```

### 30.14.4 Splitting one commit into three

```bash
$ git rebase -i HEAD~4
# mark the target commit with `edit`, save.

Stopped at 7b2e5d1... feat(orders): idempotency, logging and a dependency bump

# Undo the commit, keeping the changes in the working tree, unstaged.
$ git reset HEAD^

$ git status --short
 M src/orders/orders.service.ts
 M package.json
 M package-lock.json
 M src/common/logging.interceptor.ts

# Stage and commit each logical piece. Use -p to split within a file.
$ git add -p src/orders/orders.service.ts
$ git commit -m "feat(orders): return existing order on duplicate idempotency key"

$ git add src/common/logging.interceptor.ts
$ git commit -m "feat(observability): log idempotency key on order creation"

$ git add package.json package-lock.json
$ git commit -m "build(deps): bump pg to 8.13.1"

$ git rebase --continue
Successfully rebased and updated refs/heads/feature/refunds.
```

Verify each commit builds and tests independently before continuing — that is the whole point of splitting.

### 30.14.5 Moving commits to a new branch

Five commits on `feature/a`; the last two belong on `feature/b`.

```bash
# 1. Branch at the current tip, capturing all five.
$ git branch feature/b

# 2. Drop the last two from feature/a.
$ git switch feature/a
$ git reset --hard HEAD~2

# 3. feature/b has all five; replay only its own two onto main.
$ git rebase --onto main feature/a feature/b
```

`--onto` (30.5) is what makes step 3 precise: replay the commits in `feature/a..feature/b` — exactly the two — onto `main`.

If either branch was pushed, `--force-with-lease` and tell anyone who might have pulled.

### 30.14.6 A `package-lock.json` conflict

Never resolve a lockfile by hand and never take one side wholesale. The lockfile is a *derived artifact*: resolve the source of truth (`package.json`) and regenerate.

```bash
$ git status --short
UU package.json
UU package-lock.json

# 1. Resolve package.json manually. Keep BOTH sides' dependency additions
#    unless they genuinely conflict on the same package.
$ git checkout --conflict=diff3 package.json
# edit, remove markers
$ git add package.json

# 2. Regenerate the lockfile from the resolved package.json.
$ git checkout --theirs package-lock.json     # any valid starting point
$ npm install --package-lock-only             # rewrites the lock to match package.json
$ git add package-lock.json

# 3. Prove it actually installs and the app still works.
$ rm -rf node_modules && npm ci
$ npm run build && npm run test:unit

$ git merge --continue
```

If `npm install --package-lock-only` produces a large unexpected diff, delete the lockfile and run `npm install` fresh, then review the diff for unintended major version jumps.

You can reduce the frequency of these conflicts with a `.gitattributes` entry marking the lockfile as generated (`package-lock.json -diff linguist-generated=true`), which does not prevent the conflict but stops it from dominating the PR diff. Some teams go further with a custom merge driver that always regenerates; that is a per-team decision.

### 30.14.7 Work "lost" after a bad rebase

```bash
# 1. Find where the branch was before the rebase started.
$ git reflog show feature/refunds
9f3c1a2 feature/refunds@{0}: rebase (finish): refs/heads/feature/refunds onto 4a1c2b9
c8f1a92 feature/refunds@{1}: rebase (start): checkout origin/main
7b2e5d1 feature/refunds@{2}: commit: feat(orders): add partial refund support
```

`feature/refunds@{2}` (or the entry immediately before `rebase (start)`) is the pre-rebase state.

```bash
# 2. Recover non-destructively into a new branch first. Never reset --hard
#    as your first move during a recovery.
$ git branch rescue/pre-rebase 7b2e5d1

# 3. Compare and confirm before doing anything else.
$ git log --oneline feature/refunds..rescue/pre-rebase
$ git diff feature/refunds rescue/pre-rebase

# 4. Either reset the branch back, or cherry-pick the missing commits.
$ git switch feature/refunds
$ git reset --hard rescue/pre-rebase
# or
$ git cherry-pick <missing shas>
```

If the reflog has been pruned or you are on a fresh clone, `git fsck` finds unreachable objects directly:

```bash
$ git fsck --lost-found --no-reflog
dangling commit 7b2e5d1a9c8f4e3b2a1d0c9e8f7a6b5c4d3e2f1a
$ git show 7b2e5d1
$ git branch rescue 7b2e5d1
```

The two rules for any recovery: **do not `gc`, do not re-clone.** Both destroy the evidence you are trying to recover.

## 30.15 Edge cases and failure modes

- **Force-push to a shared branch.** Everyone's history diverges; commits based on the old tip are orphaned and pulls produce duplicated changes. Notice: colleagues report "my commits are gone" or a pull that produces dozens of conflicts. Fix: `--force-with-lease` by default, block force-push in branch protection, and recover through the remote-tracking reflog (30.14.2).

- **Rebasing published history.** The same damage as above, arrived at differently. Notice: a PR whose commit count doubles after someone pulls. Fix: the golden rule — merge into shared branches, rebase only your own.

- **Giant binaries bloating the repository forever.** A 6 MB fixture committed 340 times is 1.9 GB in the packfile, permanently, because every historical commit references its blob. Notice: clone time, `git count-objects -vH`. Fix: LFS or an artifact store going forward; history rewriting with `filter-repo` if it is worth the coordination cost. Prevention: a pre-commit hook or a CI check rejecting files over, say, 5 MB.

- **Line-ending chaos across operating systems.** Without normalisation, a Windows checkout writes CRLF, the file is committed with CRLF, and Linux engineers see the entire file as changed. Notice: whole-file diffs with no visible change; `git diff` showing `^M`; unresolvable conflicts. Fix: commit `.gitattributes` with `* text=auto eol=lf` (30.10); normalise once with `git add --renormalize .` and commit; note that shell scripts with CRLF fail in containers with a confusing `bad interpreter` error.

- **`reset --hard` destroying uncommitted work.** No reflog entry exists because the changes were never objects. Notice: immediate and irreversible. Fix: none after the fact beyond IDE local history. Prevention: `git stash -u` or a `wip` commit before any destructive operation.

- **The reverted-merge trap.** After reverting a merge, re-merging the same branch brings in nothing, because its commits are already ancestors (30.8). Notice: a clean merge with an empty or tiny diff and a missing feature. Fix: revert the revert, rebase the branch, or reapply on a fresh branch. Prevention: state the warning in the revert commit message.

- **Commits orphaned in detached HEAD.** Committing on a checked-out SHA and switching away leaves them unreferenced. Notice: Git's "you are leaving N commits behind" warning, which is easy to scroll past. Fix: `git reflog`, then `git branch <name> <sha>`, within 30 days. Prevention: create a branch as soon as you commit while detached.

- **Long-lived branches and integration hell.** Divergence cost grows superlinearly. Notice: a merge with 60 conflicting files. Fix: nothing good at that point; merge in stages, from the merge base forward, with tests between stages. Prevention: branches under two days, feature flags for incomplete work, expand/contract for schema changes.

- **Squash merges destroying bisect granularity.** A 900-line PR becomes one commit; bisect narrows to it and stops. Notice: bisect "finds" a commit whose diff is unreviewable. Fix: none retroactively. Prevention: small PRs, or rebase-merge for large ones.

- **Moved tags after a release.** `git tag -f v2.4.7 && git push --force origin v2.4.7`. Anyone who fetched before sees the old commit; anyone after sees the new one, and `git describe`-based version strings become ambiguous. Notice: two builds claiming the same version with different content. Fix: never move a release tag; cut `v2.4.8`. Enforce with protected tags on the host.

- **Hooks that do not run in CI.** Client-side hooks live on developer machines and are skippable with `--no-verify`. A team that enforces lint only through husky ships unlinted code the moment someone clones without running `npm install`. Notice: `main` failing checks that "always pass locally". Fix: every hook-enforced rule must also be a CI job (Part 29). Hooks are for fast feedback, not enforcement.

- **Case-insensitive filesystem rename problems.** On Windows and macOS (default settings), `git mv Orders.ts orders.ts` appears to do nothing, because the filesystem considers them the same file. Later, a Linux CI runner or a colleague on a case-sensitive filesystem sees two files, or an import fails with a name that resolves locally and not in the container. Notice: "module not found" only in Docker or CI. Fix: rename in two steps (`git mv Orders.ts tmp.ts && git mv tmp.ts orders.ts`), or `git config core.ignorecase false` with care. Prevention: a CI check for paths differing only by case (`git ls-files | tr 'A-Z' 'a-z' | sort | uniq -d`).

- **Shallow clones breaking version tooling.** `git clone --depth 1` or `actions/checkout` with the default `fetch-depth: 1` fetches no tags and one commit, so `git describe --tags` fails and `semantic-release` cannot determine the last release. Notice: version strings like `0.0.0-development`, or "fatal: No names found". Fix: `fetch-depth: 0` (and `fetch-tags: true`) for jobs that need history; keep depth 1 for jobs that do not, because full history costs real time on a large repository.

- **`git pull` creating surprise merge commits.** A feature branch with "Merge branch 'main' into feature" commits interleaved through it, making the PR diff unreadable. Fix: `git config --global pull.ff only` so a non-fast-forward pull fails and you decide explicitly.

- **Submodule pointer not committed.** You update the submodule but forget to commit the new pointer in the parent; CI builds the old version. Notice: works locally, fails in CI, with no diff explaining why. Fix: prefer a published package (30.10); if you must use submodules, add a CI check that the submodule pointer matches an expected ref.

- **`.gitignore` added after the file was committed.** The file stays tracked and keeps being committed. Notice: `.env` changes appearing in diffs despite being "ignored". Fix: `git rm --cached <file>`, commit, and treat any secret in it as leaked (30.14.1).

- **Committer identity wrong.** A personal email on a work laptop; commits do not attribute to the corporate account and may fail a CLA or a signed-commit policy. Fix: per-directory config with `includeIf "gitdir:~/work/"` in `~/.gitconfig`.

- **Merge queue absent on a busy repository.** Two independently green PRs break `main` together (a semantic conflict). Notice: `main` red immediately after two rapid merges. Fix: a merge queue that tests the combined result before merging.

## Senior Checklist — Part 30

- [ ] I understand the concept
- [ ] I can explain it simply
- [ ] I can implement it
- [ ] I understand its failure modes
- [ ] I understand its scaling limitations
- [ ] I understand its security implications
- [ ] I understand its operational implications
- [ ] I can choose between alternatives
- [ ] I can explain the tradeoffs
- [ ] I can answer senior-level interview questions
- [ ] I can walk an object graph with `git cat-file -p` and explain what each object contains
- [ ] I can explain why commits are snapshots and why rebase produces new hashes
- [ ] I can describe exactly what `reset --soft`, `--mixed` and `--hard` move, and what is unrecoverable
- [ ] I can recover lost commits from the reflog and from `git fsck` without re-cloning
- [ ] I can resolve a conflict correctly using `zdiff3` and prove I did not silently revert either side
- [ ] I can run an interactive rebase with `--autosquash` and produce atomic, individually testable commits
- [ ] I can state the golden rule of rebasing and say exactly why it matters
- [ ] I can revert a merge with the correct `-m` value and explain the revert-of-a-revert trap
- [ ] I can find the commit that introduced a bug with `git bisect run` and a test script
- [ ] I can use `git log -S` to find when code was added or removed, including code since deleted
- [ ] I can choose a branching strategy from the number of live versions and the deploy cadence
- [ ] I can explain what squash merging does to `git bisect` and when that trade is acceptable
- [ ] I can execute the leaked-secret procedure in the right order, starting with rotation
- [ ] I can set up `.gitattributes`, hooks and branch protection so a team avoids whole categories of accident

## Part 30 — Key Takeaways

- Git is a content-addressed object store: blobs, trees, commits and tags, named by the hash of their content. Every command makes sense once that does.
- Commits are snapshots with parents, not diffs; packfiles use deltas only as a storage detail below the model.
- A branch is a 41-byte file holding a commit hash. Creating one is free; keeping one alive for three weeks is not.
- Anything that was ever committed is recoverable through the reflog for weeks; anything never committed is gone the instant `reset --hard` runs.
- Rebase and amend create new commit objects and abandon the old ones, which is the entire reason the golden rule about shared branches exists.
- Rebase your work onto other people's; merge other people's work into shared branches. Revert on anything published, reset only on what is still yours.
- Turn on `merge.conflictstyle=zdiff3`: seeing the merge base is what stops you silently reverting a colleague's change while resolving a conflict.
- Reverting a merge does not un-merge the branch. Re-merging afterwards brings in nothing, so revert the revert or rebase the branch.
- Cherry-pick copies a change into a new commit; always use `-x`, and treat a pick that needed conflict resolution as a different change.
- `git bisect run` with a test script and a path filter turns "somewhere in 400 commits" into six automated steps and a 40-line diff.
- `git log -S` finds when a string appeared or disappeared anywhere in history, including in code that no longer exists. It is the most underused command in Git.
- Choose a branching strategy from how many versions are live, not from fashion; `develop` earns its place only when there is a real stabilisation phase.
- Small pull requests get genuinely better reviews; above roughly 400 lines reviewers stop reasoning and start skimming.
- Squash merging keeps history tidy and destroys bisect granularity; it is a good trade only while PRs stay small.
- When a secret is pushed, rotate first. History rewriting is cleanup, not containment, and it never un-reads what was already public.
