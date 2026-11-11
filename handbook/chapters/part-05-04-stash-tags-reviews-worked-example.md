## 5.9 Stash and tags

### 5.9.1 Shelving unfinished work, and naming releases

#### Concept

Two small tools you will use every week. **`git stash`** puts your uncommitted changes on a shelf so your working directory is clean, and later puts them back. **Tags** are permanent names for specific commits, used to mark releases (`v1.4.0`), so anyone can find exactly what code was deployed.

#### Why does it exist?

Stash exists because work gets interrupted. You are halfway through a feature when someone asks you to check a bug on `main`; your changes are not ready to commit, and switching branches with them is confusing (5.2). Tags exist because commit hashes are unmemorable: "what did we ship on Tuesday?" should have an answer like `v1.4.0`, not `9c1e2f0`.

#### Mental model

Stash is a drawer: you sweep the papers off your desk into it, help a colleague on a clean desk, then tip the drawer back out. A tag is a bookmark with a label, permanently clipped to one page of the history book.

#### How it works

```bash
git stash push -m "coupon form half done"     # shelve tracked changes with a description
git stash push -u -m "with new files"        # -u: include untracked (new) files too
git stash list                               # stash@{0}: On feat/coupons: coupon form half done
git stash show -p stash@{0}                  # what is in it
git stash pop                                # reapply the newest stash and remove it from the list
git stash apply stash@{1}                    # reapply a specific stash, keep it in the list
git stash drop stash@{1}                     # delete one stash

git tag                                      # list tags
git tag -a v1.4.0 -m "Release 1.4.0: coupons" # an annotated tag on the current commit (recommended)
git tag -a v1.3.2 5e0f311 -m "Hotfix"         # tag an older commit
git push origin v1.4.0                       # tags are NOT pushed by git push; push them explicitly
git show v1.4.0                              # the tag's message and the commit it points to
git switch --detach v1.3.2                   # look at the code exactly as released (read-only "detached HEAD")
```

Release tags usually follow **semantic versioning**, `MAJOR.MINOR.PATCH` (4.6): bump PATCH for fixes, MINOR for new backward-compatible features, MAJOR for breaking changes. Many CI pipelines (Part 51) build and deploy when a tag matching `v*` is pushed.

**Detached HEAD** sounds alarming but only means "you are looking at a commit, not at a branch". You can look around and run the code. If you want to keep changes made there, create a branch first: `git switch -c fix/from-v1.3.2`.

#### Practical example — an interruption

```bash
# On feat/coupons, half-way through. A teammate asks: "does main still build?"
git status                                   # 3 modified files, 1 new file
git stash push -u -m "coupon form half done"
git switch main && git pull
npm ci && npm run build                      # check main: it builds
git switch feat/coupons
git stash pop                                # your 4 changes are back, exactly as they were
git status
```

#### Practical example — tagging a release and finding it later

```bash
git switch main && git pull
git log --oneline -1                         # 7b1c9d2 Merge pull request #142 from feat/coupons
git tag -a v1.4.0 -m "Release 1.4.0: coupons at checkout"
git push origin v1.4.0
# Three weeks later: "what changed between the last two releases?"
git log --oneline v1.3.2..v1.4.0             # every commit in 1.4.0 that was not in 1.3.2
```

#### Edge cases & failure modes

- **`stash pop` conflicts** when the branch changed since you stashed; resolve like a merge conflict (5.4). The stash stays in the list until you drop it.
- **Forgotten stashes** pile up for months; `git stash list` regularly, and prefer a work-in-progress commit on your branch for anything longer than an hour.
- **Untracked files are not stashed** without `-u`, so new files stay behind and appear on the other branch.
- **Tags not pushed**: `git push` does not send tags; CI never sees the release.
- **Moving a published tag** (deleting and re-creating `v1.4.0` on another commit) confuses everyone who fetched it; create `v1.4.1` instead.

#### How a Senior Backend Engineer thinks about this

A senior uses stash for short interruptions and a work-in-progress commit on their own branch for anything longer, because commits are visible, named and recoverable, while stashes are easy to forget. They tag every release with an annotated tag from CI rather than by hand, follow semantic versioning, and never move a published tag.

#### Common mistakes

- Using stash as long-term storage.
- Forgetting `-u` and leaving new files behind.
- Creating tags locally and never pushing them.
- Re-pointing a released tag.

#### Interview questions

1. **When would you use `git stash`?** To clean the working directory briefly (switch branches, pull, test something) without committing half-done work.
2. **How do you see what changed between two releases?** `git log v1.3.2..v1.4.0` (and `git diff` with the same range for the code).
3. **What is a detached HEAD, and is it dangerous?** HEAD points at a commit instead of a branch; it is safe to look around, but create a branch before committing work you want to keep.

#### Practical exercise

In a practice repository, make changes to one tracked file and create one new file, stash both with a message, confirm the working directory is clean, switch branches and back, and pop the stash. Then tag the current commit as `v0.1.0` (annotated), make two more commits, tag `v0.2.0`, and list the commits between the tags. Acceptance criteria: the new file survived the stash, and `git log --oneline v0.1.0..v0.2.0` shows exactly your two commits.

#### Worked answer to the exercise

One tracked file edited, one new file created, then the stash with `-u` so the new file goes too:

```text
$ git status --short
 M src/a.ts
?? src/coupon.ts
$ git stash push -u -m "coupon work half done"
Saved working directory and index state On main: coupon work half done
$ git status
On branch main
nothing to commit, working tree clean
$ git stash list
stash@{0}: On main: coupon work half done
$ git switch other && git switch main
Switched to branch 'other'
Switched to branch 'main'
$ git stash pop
On branch main
Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
	modified:   src/a.ts

Untracked files:
  (use "git add <file>..." to include in what will be committed)
	src/coupon.ts

no changes added to commit (use "git add" and/or "git commit -a")
Dropped refs/stash@{0} (33ddbf26009e1e9597ed40df94bc881a6384d84d)
$ git status --short
 M src/a.ts
?? src/coupon.ts
```

Both changes are back, including the new `src/coupon.ts`: the first acceptance check. Now the tags:

```bash
git add . && git commit -m "Add coupon constant"
git tag -a v0.1.0 -m "Release 0.1.0"
# two more focused commits
git add src/b.ts && git commit -m "Add module b"
git add src/c.ts && git commit -m "Add module c"
git tag -a v0.2.0 -m "Release 0.2.0"
git log --oneline v0.1.0..v0.2.0
git log --oneline --decorate -4
```

```text
f85d1a9 Add module c
76a67ff Add module b
f85d1a9 (HEAD -> main, tag: v0.2.0) Add module c
76a67ff Add module b
32cb542 (tag: v0.1.0) Add coupon constant
adb43bb (other) Add module a
```

The range `v0.1.0..v0.2.0` means "reachable from `v0.2.0` but not from `v0.1.0`", which is exactly the two commits made between the releases. To prove the tags are annotated, `git show v0.1.0 --no-patch` must start with `tag v0.1.0` and a `Tagger:` line; a lightweight tag (made without `-a`) has neither. If the repository has a remote, publish them with `git push origin v0.1.0 v0.2.0`, then check with `git ls-remote --tags origin`.

**The trap.** Stashing without `-u`. The tracked edit is shelved, but `src/coupon.ts` stays in the working directory, follows you to the other branch, and can end up committed there. If `git status` is not completely clean right after `git stash push`, something was left behind.

## 5.10 Keeping your branch up to date and handling review feedback

### 5.10.1 From "changes requested" to merged

#### Concept

A pull request rarely merges as first written. Reviewers ask for changes, `main` moves on while you wait, and CI may fail. This section is the routine for all three: bring `main`'s new commits into your branch, push follow-up commits that answer review comments, and finish with the merge style your team uses (merge commit, squash, or rebase), then clean up.

#### Why does it exist?

Because a branch that falls behind `main` collects conflicts, and a pull request that ignores feedback never merges. Beginners often panic at "This branch is out-of-date with the base branch" or at twenty review comments. Both are normal, and both have a simple, repeatable answer.

#### Mental model

Imagine handing in an essay draft. The teacher's comments come back, and meanwhile the class syllabus was updated. You read the new syllabus, adjust your essay to fit it, address each comment, and hand it back with a short note saying what you changed. You do not start a new essay.

#### How it works

**Bring `main` into your branch** (the merge approach from 5.4, which never rewrites your history):

```bash
git switch feat/add-coupons
git fetch origin                        # download new commits without changing your files
git merge origin/main                   # bring main's new commits into your branch
# resolve any conflicts (5.4), run the tests, then:
git push                                # your pull request now includes the merge
```

Part 52.5 covers the alternative, `git rebase origin/main`, which replays your commits on top of `main` for a straight history. It rewrites your branch's commits, so it needs `git push --force-with-lease` and should only be used on a branch nobody else is working on.

**Answer review comments with new commits:**

```bash
# Reviewer: "Validate that the coupon code is uppercase letters and digits only."
# ... edit src/coupons/dto/apply-coupon.dto.ts ...
git add src/coupons/dto/apply-coupon.dto.ts
git commit -m "Validate coupon code format (review)"
git push                                # the pull request updates; reply to the comment: "Done in 3e1a9f0"
```

Small follow-up commits make re-review easy: the reviewer looks at only what changed since their last look.

**Merge styles** you will see as buttons on GitHub or GitLab:

| Style | What lands on `main` | Good for |
|---|---|---|
| Merge commit | All your commits plus a merge commit | Keeping every step of the branch |
| Squash and merge | One commit containing the whole pull request | Clean `main` history; one commit per feature, easy to revert |
| Rebase and merge | Your commits replayed onto `main`, no merge commit | Straight history with individual commits |

Many teams choose squash: one pull request, one commit on `main`, with the pull request title as its message. Your branch's "fix typo" commits then never clutter `main`.

**After the merge, clean up:**

```bash
git switch main
git pull                                # get the merged result
git branch -d feat/add-coupons          # delete the local branch (-d refuses if it is not merged)
git fetch --prune                       # forget remote branches that were deleted on the host
```

After a squash merge, `git branch -d` may refuse because your branch's individual commits are not on `main` (only their squashed copy is). If the pull request shows "merged", it is safe to use `git branch -D`.

#### Practical example — an out-of-date branch with a CI failure

Your pull request shows two problems: "This branch has conflicts that must be resolved" and a failing test.

```bash
git switch feat/add-coupons
git fetch origin
git merge origin/main
# CONFLICT (content): Merge conflict in src/checkout/checkout.service.ts
# open the file, keep both changes correctly (5.4), remove the markers
git add src/checkout/checkout.service.ts
git commit                              # completes the merge with the default message
npm test                                # the failing test: main renamed CartTotals.total to totalMinor
# ... update your code to use totalMinor ...
git commit -am "Use totalMinor after main's rename"
npm test                                # green
git push
```

The conflict and the CI failure had the same cause: `main` moved. Merging it in early and often keeps both small.

#### Edge cases & failure modes

- **Force-pushing to a shared branch** after a rebase overwrites a teammate's commits; use merge on shared branches, and `--force-with-lease` only on your own (Part 52).
- **"Fixing" review comments by opening a new pull request** loses the discussion; push to the same branch.
- **Huge pull requests** get shallow reviews and many conflicts; split them (5.3).
- **Resolving a conflict without running the tests** can produce code that compiles and is wrong (5.4).
- **Branch protection rules** on `main` (required reviews, required CI checks) are why the merge button stays grey; that is the gate working, not a bug.

#### How a Senior Backend Engineer thinks about this

A senior keeps their branch close to `main` by merging it in daily on long pieces of work, answers each review comment either with a commit or a short reason, and makes re-review cheap with small follow-up commits. They know their team's merge style and why it was chosen, they never force-push a branch someone else uses, and they clean up merged branches so `git branch` stays readable. They treat review as a conversation that improves the code, giving and receiving it with the same respect.

#### Common mistakes

- Letting a branch fall weeks behind `main`.
- Answering review comments with silence or with an unrelated rewrite.
- Rebasing and force-pushing a shared branch.
- Never deleting merged branches.

#### Interview questions

1. **Your pull request is out of date with `main`. What do you do?** Fetch, merge `origin/main` into the branch (or rebase if it is only yours), resolve conflicts, run tests, push.
2. **What is the difference between squash merge and a merge commit?** Squash puts the whole pull request as one commit on `main`; a merge commit keeps all branch commits plus a merge commit.
3. **Why push follow-up commits instead of amending during review?** The reviewer can see exactly what changed since their last review, and no force-push is needed.

#### Practical exercise

With a partner (or two clones of one repository acting as two people): both branch from `main`; person A changes a function and merges a pull request; person B changes the same function on their branch, opens a pull request, sees the conflict, merges `origin/main` into their branch, resolves it, gets one review comment, answers it with a follow-up commit, and merges with squash. Acceptance criteria: `main`'s history shows one commit for each pull request, and both local clones end with the feature branches deleted.

#### Worked answer to the exercise

Two clones of one repository, `a` (person A) and `b` (person B), both starting from `bca67a6 Add shipping cost function`, where free shipping starts at 5000 cents.

**Person A** lowers the threshold and gets it merged first (on the host: "Squash and merge"):

```bash
cd a
git switch -c feat/free-shipping-40
# edit src/shipping.ts: 5000 -> 4000
git commit -am "Free shipping from 40 dollars"
git push -u origin feat/free-shipping-40       # open the PR; it is approved and squash-merged as #1
```

**Person B** changed the same function on their own branch, pushed it and opened a pull request; the host now reports a conflict. B brings `main` in with a merge, which rewrites nothing:

```text
$ cd ../b
$ git fetch origin
   bca67a6..ab4ba32  main                  -> origin/main
$ git merge origin/main
Auto-merging src/shipping.ts
CONFLICT (content): Merge conflict in src/shipping.ts
Automatic merge failed; fix conflicts and then commit the result.
$ cat src/shipping.ts
<<<<<<< HEAD
export function shippingCents(subtotalCents: number, express = false): number {
  if (subtotalCents >= 5000 && !express) return 0;
=======
export function shippingCents(subtotalCents: number): number {
  if (subtotalCents >= 4000) return 0;
>>>>>>> origin/main
  return 499;
}
```

Both changes are wanted: A's new threshold and B's `express` parameter. The resolution keeps both:

```text
export function shippingCents(subtotalCents: number, express = false): number {
  if (subtotalCents >= 4000 && !express) return 0;
  return 499;
}
```

```bash
git add src/shipping.ts
git commit --no-edit                           # completes the merge
npm test                                       # always, after resolving
git push
# reviewer: "name the express fee instead of a bare number"
git add src/fees.ts && git commit -m "Name the express fee constant (review)"
git push                                       # the PR updates; approved; "Squash and merge" as #2
```

Do **not** rebase B's branch and force-push it here: the branch is already public in a pull request, and the merge approach gets the same result without rewriting anything.

**Clean up in both clones.** The host deletes the remote branch on merge (or run `git push origin --delete <branch>`), then:

```text
$ git switch main && git pull && git fetch --prune
$ git branch -d feat/free-shipping-40
error: the branch 'feat/free-shipping-40' is not fully merged
hint: If you are sure you want to delete it, run 'git branch -D feat/free-shipping-40'
$ git branch -D feat/free-shipping-40
Deleted branch feat/free-shipping-40 (was 91c0de2).
$ git log --oneline
77f4cb7 (HEAD -> main, origin/main, origin/HEAD) Charge express shipping above the free threshold (#2)
ab4ba32 Free shipping from 40 dollars (#1)
bca67a6 Add shipping cost function
```

One commit per pull request on `main`, and `git branch` in each clone lists only `main`. The `-d` refusal is expected after a squash merge: the branch's own commits are not on `main`, only their squashed copy. Check the pull request says "merged" before using `-D`.

**The trap.** Resolving the conflict by taking one side whole ("accept incoming"), which silently drops the other person's work. Read both sides and the intent behind each before you choose.

## 5.11 Worked example: one feature from ticket to merged pull request

This example follows one small change through every step of this Part, with the exact commands and the output you would see. The ticket: **TSB-4510 — "Reject coupon codes with lowercase letters; the API should return a clear 400."**

#### 1. Start from an up-to-date main (5.2)

```bash
cd ~/work/shop-api
git switch main
git pull
# Updating 5e0f311..7b1c9d2
# Fast-forward
#  src/checkout/checkout.service.ts | 14 ++++++++------
git switch -c fix/TSB-4510-coupon-code-format
```

#### 2. Make the change in small commits (5.1)

```bash
# ... edit src/coupons/dto/apply-coupon.dto.ts: add @Matches(/^[A-Z0-9]{4,16}$/) ...
git status
# modified:   src/coupons/dto/apply-coupon.dto.ts
git diff                                 # read your own change before staging it
git add src/coupons/dto/apply-coupon.dto.ts
git commit -m "Validate coupon code format in ApplyCouponDto (TSB-4510)"

# ... add a test in test/coupons.e2e-spec.ts for a lowercase code -> 400 ...
git add test/coupons.e2e-spec.ts
git commit -m "Test that lowercase coupon codes are rejected"
git log --oneline -3
# c42b8e1 Test that lowercase coupon codes are rejected
# 91f0a3d Validate coupon code format in ApplyCouponDto (TSB-4510)
# 7b1c9d2 Merge pull request #142 from feat/coupons
```

#### 3. Oops: fix the last commit before pushing (5.7)

You notice the test file also contains a stray `console.log`.

```bash
# ... remove the console.log ...
git add test/coupons.e2e-spec.ts
git commit --amend --no-edit             # fold the fix into the last commit: not pushed yet, so this is fine
```

#### 4. Push and open the pull request (5.3)

```bash
git push -u origin fix/TSB-4510-coupon-code-format
# remote: To create a merge request for fix/TSB-4510-coupon-code-format, visit:
# remote:   https://gitlab.example.com/shop/shop-api/-/merge_requests/new?...
```

The description, following 5.3: what (reject codes that are not uppercase letters and digits, 4 to 16 characters), why (support saw "coupon not found" for `save50`; users need a clear validation message), how to test (`POST /v1/checkout/coupon` with `save50` returns `400` with a message), risk (low; codes in the database are all uppercase, checked with a query).

#### 5. Main moves, and there is a conflict (5.10, 5.4)

While you wait for review, a teammate merges a change to the same DTO file.

```bash
git fetch origin
git merge origin/main
# Auto-merging src/coupons/dto/apply-coupon.dto.ts
# CONFLICT (content): Merge conflict in src/coupons/dto/apply-coupon.dto.ts
git status
# both modified:   src/coupons/dto/apply-coupon.dto.ts
```

The file shows both versions:

```text
<<<<<<< HEAD
  @Matches(/^[A-Z0-9]{4,16}$/, { message: 'Coupon codes use capital letters and digits, 4 to 16 characters' })
  code!: string;
=======
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  code!: string;
>>>>>>> origin/main
```

Both changes are wanted: your format check and your teammate's trimming. The correct result keeps both:

```text
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Matches(/^[A-Z0-9]{4,16}$/, { message: 'Coupon codes use capital letters and digits, 4 to 16 characters' })
  code!: string;
```

```bash
git add src/coupons/dto/apply-coupon.dto.ts
git commit                                # completes the merge
npm test                                  # always after resolving (5.4)
# Tests: 48 passed, 48 total
git push
```

#### 6. Review feedback (5.10)

The reviewer asks: "Should we uppercase the code for the user instead of rejecting `save50`?" After a short discussion on the pull request, the team agrees: uppercase it in the transform, and still reject anything with other characters.

```bash
# ... change the transform to value.trim().toUpperCase(); update the test: save50 -> accepted, save-50 -> 400 ...
git commit -am "Uppercase coupon codes before validation (review)"
git push
```

#### 7. Merge and clean up (5.10)

CI is green and the reviewer approves. The team uses squash merge, so `main` gets one commit titled "Validate and normalise coupon code format (TSB-4510)".

```bash
git switch main
git pull
git log --oneline -2
# e8d04c6 Validate and normalise coupon code format (TSB-4510)
# 2a6b3f9 Trim coupon codes in ApplyCouponDto
git branch -D fix/TSB-4510-coupon-code-format   # -D: squash merge means the branch's own commits are not on main
git fetch --prune
```

#### 8. Release (5.9)

At the end of the week, CI tags the release from `main`:

```bash
git tag -a v1.4.1 -m "Release 1.4.1: coupon code validation"
git push origin v1.4.1
git log --oneline v1.4.0..v1.4.1          # what went into this release
```

#### What to notice

| Step | Command family | Section |
|---|---|---|
| Up-to-date start, branch per ticket | `switch`, `pull` | 5.2 |
| Small commits with reasons | `add`, `commit`, `diff` | 5.1 |
| Fixing an unpushed commit | `commit --amend` | 5.7 |
| Sharing for review | `push -u`, pull request | 5.3 |
| Main moved: merge it in, resolve, test | `fetch`, `merge`, conflict markers | 5.4, 5.10 |
| Review answered with a commit | `commit`, `push` | 5.10 |
| Merge style and cleanup | squash, `branch -D`, `fetch --prune` | 5.10 |
| Release | `tag -a`, `push origin <tag>` | 5.9 |

#### Practical exercise

Do this whole example yourself on the API from Part 6, or any small project with a remote on GitHub or GitLab.

Acceptance criteria:

- A branch named after a ticket, at least two focused commits, and one `--amend` before the first push.
- A conflict created deliberately from a second clone, resolved so both changes survive, with tests run afterwards.
- One review comment answered with a follow-up commit.
- A squash merge, the local branch deleted, and an annotated release tag pushed.
- `git log --oneline` on `main` reads like a short, clear story of the project.

#### Worked answer to the exercise

This is open-ended, so here is a model run on the Part 6 products API and what a strong answer includes. The ticket: **TSB-4601, "Reject product names that are only spaces"**.

```bash
git switch main && git pull
git switch -c fix/TSB-4601-blank-product-names
# CreateProductDto: on name, directly above @Length(1, 200), add
#   @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
git add src/products/dto/create-product.dto.ts
git commit -m "Trim product names before validation (TSB-4601)"
# test/products.e2e-spec.ts: POST with name "   " -> 400 VALIDATION_FAILED, path "name"
git add test/products.e2e-spec.ts
git commit -m "Test that blank product names are rejected"
# spot a leftover .only in the test file, remove it
git add test/products.e2e-spec.ts && git commit --amend --no-edit   # not pushed yet: safe
git push -u origin fix/TSB-4601-blank-product-names
```

**The deliberate conflict, from a second clone acting as a teammate:**

```bash
git clone git@github.com:shop-example/products-api.git ~/work/products-api-teammate
cd ~/work/products-api-teammate
git switch -c fix/TSB-4602-name-length
# change @Length(1, 200) to @Length(1, 120) on the same name field
git commit -am "Limit product names to 120 characters (TSB-4602)"
git push -u origin fix/TSB-4602-name-length    # open this PR and merge it first
```

Back in your clone, `git fetch origin && git merge origin/main` reports `CONFLICT (content): Merge conflict in src/products/dto/create-product.dto.ts`, because your new line and the teammate's changed line touch each other (edits a few lines apart would merge automatically). The correct result keeps both decorators, `@Transform(...)` and `@Length(1, 120)`, on `name`. Then `git add`, `git commit`, `npm test && npm run test:e2e`, `git push`.

**The review comment** ("also reject names longer than 120 after trimming, and say so in the test name") gets one follow-up commit and a reply naming its hash. After approval: "Squash and merge", then:

```bash
git switch main && git pull
git branch -D fix/TSB-4601-blank-product-names   # -D: squash merge
git fetch --prune
git tag -a v0.2.0 -m "Release 0.2.0: product name validation"
git push origin v0.2.0
```

```text
$ git log --oneline -4
c7d21e9 (HEAD -> main, tag: v0.2.0, origin/main) Trim product names and reject blank ones (TSB-4601) (#7)
4b8a0f3 Limit product names to 120 characters (TSB-4602) (#6)
e2a9c14 Add cursor pagination to GET /products (#5)
91d6b20 Add SKU with a unique constraint (#4)
```

**What a strong answer shows.** A branch name with the ticket; commits whose messages say why; the `--amend` done *before* the first push; a conflict resolved so both changes survive, followed by a test run; a review answered with a commit rather than a new pull request; one squashed commit per pull request on `main`; no stale local branch (`git branch` lists only `main`); and a tag that `git ls-remote --tags origin` shows on the remote. A weak answer amends after pushing and force-pushes, or resolves the conflict by deleting the teammate's change.

## Senior Checklist — Part 5

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
- [ ] I understand the working directory, staging area and repository
- [ ] I write small, focused commits with messages that explain why
- [ ] I keep secrets and node_modules out of git with .gitignore
- [ ] I branch off up-to-date main and keep branches short-lived
- [ ] I push, open small reviewable pull requests, and write useful descriptions
- [ ] I can resolve a merge conflict and re-run tests afterward
- [ ] I know the safe undo commands and that the reflog can rescue almost anything
- [ ] I can set up Git's identity and SSH access on a new machine and check both
- [ ] I choose restore, amend, reset or revert by asking whether anyone else has seen the commits
- [ ] I can find what changed, when and why with log, show, diff and blame
- [ ] I use stash for short interruptions and annotated, pushed tags for releases
- [ ] I keep my branch up to date with main, answer review comments with follow-up commits, and clean up after merging

## Part 5 — Key Takeaways

- Git records your project's history as commits; a change moves from the working directory, through the staging area (`git add`), into the permanent history (`git commit`).
- Commit messages are documentation: explain why, make focused commits, and keep secrets and `node_modules` out of history with `.gitignore` (committed secrets must be rotated).
- Branches are cheap movable pointers that let people work in parallel; always branch off up-to-date `main` and keep branches short-lived to avoid painful merges.
- A remote is the shared central copy; you push and pull to sync, and pull requests provide the review-and-check gate before code enters `main`.
- Keep pull requests small so they get genuine review; write descriptions covering what, why, how to test and risk.
- Merge conflicts are Git correctly refusing to guess when two changes overlap; resolve by writing the correct final content, removing the markers, and re-running tests.
- Prevent most conflicts by keeping branches short and pulling `main` often; `git merge --abort` gives a clean slate when a merge goes wrong.
- The daily loop — pull, branch, commit, push, PR, review, merge, clean up — is the rhythm of professional development; Part 52 adds the advanced tools on top of it.
- Use safe tools on shared history (`git revert`, not rewriting published commits), and remember the reflog can recover almost anything, so Git is never something to fear.
- Set up your identity and SSH key once per machine, and check them before your first push.
- Before debugging a regression, read what changed: `git log -- path`, `git show`, `git blame`.
- Stash is a drawer for minutes, a commit is safe storage for hours; tags name releases and must be pushed.
