## 51.5 IaC in CI/CD and policy as code

### 51.5.1 Plan on pull request, apply pipelines and preventing destructive changes

#### Concept

IaC becomes safe and collaborative when integrated into CI/CD (Part 46): a change to infrastructure code opens a pull request, CI runs `terraform plan` and posts the result for review, an approval gate guards the apply, and the apply runs in a pipeline rather than from someone's laptop. Guardrails prevent destructive changes (especially to stateful resources) from being applied casually. This turns infrastructure changes into the same reviewed, automated, controlled flow as application changes.

#### Why does it exist?

Running `terraform apply` from a laptop against production is dangerous: no review of the plan, no approval, no audit, and the risk of an unnoticed destructive change. Integrating IaC into CI/CD brings the plan into the pull request so reviewers see exactly what will change, gates the apply behind approval, runs it from a controlled pipeline with proper credentials, and records every change. Guardrails that block or require extra approval for destroying stateful resources prevent the catastrophic accident. This exists because infrastructure changes are high-stakes and deserve at least the same rigor as code changes — arguably more, since a bad one can delete a database.

#### Mental model

Imagine a bank vault with a two-person rule. One employee prepares the transfer and prints the slip (the plan); a second checks the slip against the request (review); the vault's own lock refuses certain transfers no matter who asks (policy and `deletion_protection`); and the transfer is executed by the machine from the approved slip, not retyped by hand (apply the saved plan). No single tired person at 18:00 can empty the vault.

#### How it works

```text
Infrastructure change flow in CI/CD:
  1. Engineer changes a .tf file, opens a pull request
  2. CI runs `terraform plan` -> posts the plan as a PR comment (reviewers SEE the effect)
  3. Reviewers check the plan: creates? changes? any DESTROY of a stateful resource?
  4. Policy checks run (64.5.2): block disallowed changes automatically
  5. Approval gate: a human approves the apply
  6. Merge -> the apply pipeline runs `terraform apply` with controlled credentials
  7. The change is recorded (who, what, when, the plan)
```

The key safety steps: the **plan on the pull request** makes the effect visible and reviewable before merge; **policy as code** (51.5.2) auto-blocks disallowed or dangerous changes; an **approval gate** requires human sign-off; the **apply runs in the pipeline**, not on a laptop, with scoped credentials and an audit trail. **Preventing destructive changes** specifically means guarding stateful resources — Terraform's `prevent_destroy` lifecycle flag on a database, required extra approval for any plan containing a destroy, and policy that blocks destruction of production data stores.

```hcl
# Guard a stateful resource against accidental destruction.
resource "aws_db_instance" "orders" {
  # ...
  lifecycle {
    prevent_destroy = true   # a plan that would destroy this fails -> no accidental DB deletion
  }
}
```

Know the limit of `prevent_destroy`: it is part of the resource block, so it protects against a plan that destroys or replaces the resource *while the block is still in the code*. If someone deletes the block, or renames the resource address without a `moved` block (51.7), the protection disappears with it and the plan happily shows a destroy. That is why the guardrail that actually stops deletion is on the AWS side, `deletion_protection = true` on the RDS instance, enforced by the RDS API itself, plus `skip_final_snapshot = false` and policy that rejects any plan deleting a database (51.11). Section 51.10 shows the pipeline in full.

#### How a Senior Backend Engineer thinks about this

A senior runs all infrastructure changes through CI/CD with plan-on-pull-request, review, policy checks, approval gates and pipeline-based apply, never a laptop `apply` against production, because the plan-in-the-PR is where a reviewer catches a change about to destroy a database. They layer explicit protection on stateful resources (`prevent_destroy`, extra approval for any destroy in a plan, policy blocking production data-store destruction), treating the destruction of a stateful resource as the highest-stakes operation in the whole system. They keep the apply credentials in the pipeline, scoped and audited, not on individuals' machines. In their view, infrastructure changes deserve more rigor than code changes, because a bad code deploy can be rolled back while a destroyed production database with no backup cannot.

#### Failure scenario

A team had plan-on-PR and approvals, but the apply job ran a *fresh* `terraform plan` and `apply -auto-approve` at merge time instead of applying the reviewed plan file. Between review and merge, another PR to the same root had merged and changed a shared security group. The reviewed plan showed one change; the apply executed three, including removing an ingress rule the payments service relied on, and payments could not reach its database for 11 minutes. The fix: save the plan as an artifact (`terraform plan -out=tfplan`), apply exactly that file, and serialize applies per root with a CI concurrency group so a stale plan fails instead of silently becoming a different plan. The lesson: "we review plans" only means something if the thing applied is the thing reviewed.

#### Edge cases & failure modes

- **Plan artifacts contain secrets.** A saved plan file includes values from state; store it as a short-lived, access-controlled CI artifact.
- **Two PRs, one root.** Plans computed in parallel go stale on the first merge; serialize per root and re-plan on conflict.
- **Apply fails halfway.** Terraform records what it created; rerun plan, read it, and continue. Do not delete state or retry blindly.
- **Approvals rubber-stamped.** Fifty routine plans a week train reviewers to click approve; highlight destroys automatically so the dangerous ones look different.
- **Break-glass.** Real emergencies need a documented, audited path to apply outside the normal flow, used rarely and reviewed afterwards.

#### Common mistakes

- Running `terraform apply` from a laptop against production, with no review or audit.
- No plan on the pull request, so reviewers cannot see the effect.
- No guard on stateful resources, allowing an accidental destroy to be applied.
- No approval gate on apply.
- Apply credentials on individuals' laptops instead of scoped in the pipeline.

#### Interview questions

1. **How do you integrate Terraform into CI/CD safely?** Plan on the pull request (post the plan for review), policy checks, an approval gate, and apply from the pipeline with scoped credentials and an audit trail — never a laptop apply against production.
2. **Why is the plan-on-pull-request step important?** It makes the exact effect of the change visible and reviewable before merge, so reviewers catch destructive or wrong changes.
3. **How do you prevent accidental destruction of a database?** `deletion_protection = true` on the instance (enforced by AWS), `prevent_destroy` on the resource (enforced by Terraform, but only while the block exists), a final snapshot and retained automated backups, required extra approval for any plan containing a destroy, and policy blocking destruction of production data stores.
4. **Why do infrastructure changes deserve more rigor than code changes?** A bad code deploy can be rolled back; a destroyed production database with no backup cannot — the stakes are higher.

#### Practical exercise

Set up (or describe) a CI/CD flow for Terraform: a pull request runs `terraform plan` and posts it as a comment, an approval is required, and merge triggers an apply pipeline. Add `prevent_destroy` to a database resource and verify that a change which would destroy it fails the plan. Acceptance criteria: the plan is visible on the PR before merge, apply runs in the pipeline not locally, and the database cannot be accidentally destroyed.

### 51.5.2 Policy as code

#### Concept

**Policy as code** enforces rules about infrastructure automatically, as code, in the pipeline — "no public S3 buckets", "all databases must have backups enabled", "no untagged resources", "no instance types above a cost threshold". Tools like **OPA/Conftest** and Sentinel evaluate the Terraform plan against these policies and block the apply if a rule is violated. It is automated governance (Part 80) for infrastructure, catching security and cost problems before they are applied.

#### Why does it exist?

Relying on humans to remember every security and cost rule in every infrastructure review does not scale and misses things — someone forgets to enable backups, opens a bucket to the public, or picks an oversized instance. Policy as code encodes these rules once and enforces them automatically on every change, so a violation is blocked before it reaches production, not caught later (or never). It exists to make governance automatic, consistent and un-forgettable, the same shift from manual to codified that IaC itself represents, applied to the rules about the infrastructure.

#### Mental model

Policy as code is a building inspector who reads every blueprint before construction starts, using a written checklist, and who never gets tired, never makes an exception for a friend, and stamps "rejected: no fire exit" with the page number. The human architect (reviewer) still judges whether the design is good; the inspector guarantees the non-negotiables.

#### How it works

```text
Policy as code in the pipeline:
  terraform plan -> policy engine (OPA/Conftest) evaluates the plan against rules:
    - every S3 bucket must block public access          -> violated? FAIL the pipeline
    - every database must have backup_retention >= 7     -> violated? FAIL
    - no resource may lack a cost-center tag             -> violated? FAIL
    - no instance type above the approved list            -> violated? FAIL (cost guardrail)
  -> the apply is blocked until the change complies.
```

Policies codify security rules (no public data stores, encryption required, no overly-broad permissions), cost rules (no oversized instances, required cost tags), and standards (naming, tagging) — the governance standards of Part 80, enforced automatically. Because they run on the plan in CI, they catch violations before anything is applied, turning "we have a policy that databases need backups" (which someone can forget) into "a change that disables backups cannot be merged" (which is enforced). Section 51.11 has the Rego for these rules, run with Conftest against `terraform show -json` output, and their unit tests.

#### Failure scenario

A cost policy capped instance types at `*.2xlarge` and below. A team needed a `db.r6g.4xlarge` for a month-end batch, the policy blocked it, and the team "fixed" the pipeline by adding `|| true` after the Conftest step. Six weeks later, a public S3 bucket with customer invoices went through the same pipeline unchallenged and was found by a security scanner, not by a customer, luckily. The lesson: a policy with no exception path gets disabled, and a disabled policy protects nothing. Real policy-as-code needs a documented waiver (an annotation or tag with an owner and expiry, reviewed by the policy owners; see Part 80 — Architecture Governance, 80.6) and a pipeline in which the policy step cannot be edited by the teams it governs.

#### Edge cases & failure modes

- **Policies on configuration, not plan.** Checking `.tf` files misses values computed from variables and modules; evaluate the plan JSON.
- **Unknown values.** Some attributes are `(known after apply)`; a policy must decide whether "unknown" passes or fails.
- **Deletes are not in `after`.** A deleted resource has `after = null`; policies that only inspect `after` never see the destroy. Check `change.actions`.
- **Too many advisory rules.** Hundreds of warnings nobody reads hide the one that matters; keep a small set of hard-fail rules.

#### How a Senior Backend Engineer thinks about this

A senior encodes the important infrastructure rules — security (no public data stores, encryption, least-privilege permissions; see Part 39 — Security, 39.10, and Part 45 — Cloud Architecture, 45.11), cost (instance-size limits, required tags), and standards (Part 80) — as policy-as-code that runs on every plan in CI, so violations are blocked automatically rather than relying on human reviewers to remember them. They see this as the automated-governance paved road (Part 80): the rules are consistent, un-forgettable and catch problems before they are applied, which is the only way governance scales across many services and engineers. They keep policies focused on real risks (a public production bucket, a database with no backups, a wildly oversized instance) rather than nitpicking, because over-strict policy becomes a nuisance people route around. Policy as code is, to them, the enforcement layer that makes IaC genuinely safe at scale.

#### Common mistakes

- Relying on human reviewers to remember every security and cost rule, which misses violations.
- No automated enforcement, so a change disabling backups or opening a bucket can slip through.
- Over-strict policies that nitpick and get routed around.
- Not enforcing cost guardrails, allowing oversized resources to inflate the bill.

#### Interview questions

1. **What is policy as code and why use it?** Encoding infrastructure rules (security, cost, standards) as code that automatically evaluates each Terraform plan in CI and blocks violations; it makes governance automatic, consistent and un-forgettable, catching problems before apply.
2. **Give examples of policies worth enforcing.** No public data stores, backups/encryption required, least-privilege permissions, instance-size/cost limits, required tags, naming standards.
3. **How does policy as code relate to governance (Part 80)?** It is the automated-enforcement form of architecture standards — the paved road enforced in the pipeline rather than relying on human memory.

#### Practical exercise

Write (or describe) policy-as-code rules with OPA/Conftest that fail a Terraform plan if any S3 bucket allows public access, any database has backups disabled, or any resource lacks a cost tag, and wire them into the plan step of the CI pipeline. Acceptance criteria: a plan violating any rule fails the pipeline before apply, and the rules focus on real security and cost risks.

## 51.6 GitOps, secrets and the apply-gone-wrong incident

### 51.6.1 GitOps for Kubernetes and secrets in IaC

#### Concept

**GitOps** applies IaC principles to running applications on Kubernetes (Part 44): the desired state of the cluster (deployments, services, config) lives in Git, and a controller (Argo CD or Flux) continuously reconciles the cluster to match Git. **Helm** and **Kustomize** are tools for templating and customizing Kubernetes manifests. **Secrets** (database passwords, API keys) must never be stored in IaC code or state in plaintext — they come from a secret manager, referenced by the code.

#### Why does it exist?

Deploying to Kubernetes by running `kubectl apply` by hand has the same problems as clickops: no review, no audit, drift between what is declared and what is running. GitOps makes Git the single source of truth for the cluster's state and a controller enforces it continuously, so the cluster always matches reviewed, version-controlled manifests, and drift is auto-corrected. Helm and Kustomize exist because raw Kubernetes manifests are verbose and need per-environment customization. Secret handling exists because IaC code and state are stored and shared (in Git, in remote backends) where a plaintext password would be exposed — so secrets are externalized to a secret manager and only referenced.

#### How it works — GitOps

```text
GitOps reconciliation loop:
  Git (desired cluster state: deployments, services, config)
        |  Argo CD / Flux continuously watches Git
        v
  Controller compares Git (desired) to the cluster (actual)
        |  differs?
        v
  Controller applies the difference -> cluster matches Git
        |  someone changes the cluster by hand (drift)?
        v
  Controller detects it and reconciles back to Git -> drift auto-corrected
```

The cluster's state is declared in Git; a controller (Argo CD, Flux) continuously reconciles the actual cluster to the declared state, so deploys happen by merging to Git (reviewed, audited) and manual drift is corrected automatically. **Helm** packages Kubernetes manifests as reusable, parameterized charts; **Kustomize** overlays per-environment customizations on base manifests — both solve the manifest-reuse-and-customization problem, analogous to Terraform modules (51.4).

#### How it works — secrets

```text
NEVER put secrets in IaC code or state in plaintext:
  BAD:  password = "hunter2"   in a .tf file (committed to Git, visible to all)
  BAD:  a plaintext secret ends up in the Terraform state file (stored in the backend)

Instead:
  - store secrets in a secret manager (AWS Secrets Manager, Vault)
  - IaC/code REFERENCES the secret (fetches it at deploy/run time), never embeds it
  - for Kubernetes: sealed secrets / external secrets operators pull from the manager
  - restrict and audit access to the secret manager and the Terraform state (Part 82.32, Part 88.11)
```

The rule: secrets never live in IaC code (which is in Git) or in state (which is in a shared backend) in plaintext; they live in a secret manager and are referenced. A database password committed to a `.tf` file is in Git history forever (see Part 47 — Git from Intermediate to Senior) and visible to everyone with repo access — a breach. Even values Terraform fetches can land in the state file, so the state itself must be treated as sensitive, encrypted and access-controlled. This is the secrets discipline of Part 39 — Security (39.32) and Part 46 — CI/CD (46.4) applied to infrastructure code; section 51.13 shows the concrete Terraform patterns (RDS-managed master passwords, ECS `secrets`, External Secrets Operator).

#### Failure scenario (the terraform apply that deleted a production database)

An engineer, intending to update a staging environment, ran `terraform apply` from their laptop. They had the wrong workspace/state selected — it pointed at production. The plan included a destroy of the production database (a refactor had renamed the resource's address without a `moved` block, so Terraform saw "old one removed, new one added"), but, rushing, they did not read the plan carefully and confirmed the apply. The production database was destroyed. Because backups and point-in-time recovery were in place, the data was recoverable, but there was a painful outage. Nearly every guardrail in this Part would have stopped it: plan-on-pull-request with review would have surfaced the destroy; `deletion_protection = true` would have made the AWS API refuse the delete; policy-as-code blocking production data-store destruction would have blocked it; a `moved` block would have turned the rename into a no-op. One guardrail would *not* have helped: `prevent_destroy`, because it lived in the old resource block that the refactor removed; running apply from a reviewed pipeline, not a laptop, with no human able to casually apply to production, would have prevented it; and the wrong-workspace mistake would have been caught by the pipeline targeting a fixed environment. The lesson: a Terraform apply is one of the most dangerous commands in the whole system, and it must be wrapped in every guardrail — review, prevent_destroy, policy, pipeline-only apply — because the cost of getting it wrong is a destroyed production database.

#### How a Senior Backend Engineer thinks about this

A senior uses GitOps for Kubernetes so the cluster's state is version-controlled, reviewed and continuously reconciled from Git, with Helm/Kustomize for reuse and customization, treating `kubectl apply` by hand as the clickops of Kubernetes. They never put secrets in IaC code or state, externalizing them to a secret manager and treating the state file as sensitive, encrypted and access-controlled. Above all, they treat `terraform apply` as a dangerous, high-stakes operation and wrap it in the full set of guardrails from this Part — plan-on-pull-request and review, `prevent_destroy` on stateful resources, policy-as-code, and pipeline-only apply against fixed environments — because the apply-gone-wrong incident is a database deletion, and the only reliable defense is making it impossible to apply a destructive change casually. They ensure backups and recovery exist regardless (the last line of defense; see Part 49 — Backup, Restore and Disaster Recovery, 49.4), because guardrails reduce but never fully eliminate the chance of a mistake. Section 51.15 retells this incident minute by minute.

#### Edge cases & failure modes

- **Self-heal fights autoscaling.** Argo CD with self-heal reverts `spec.replicas` that the HPA changed; omit `replicas` from the manifest or use `ignoreDifferences` (51.12).
- **Prune deletes too much.** Automated pruning removes anything no longer in Git, including a resource someone moved to another app; enable prune deliberately and protect critical resources.
- **Secrets synced into the cluster are still Kubernetes Secrets.** Base64, not encryption; enable encryption at rest for etcd and restrict `get secrets` RBAC (see Part 44 — Kubernetes, 44.7).
- **Rotation breaks long-lived connections.** Rotating a database password in Secrets Manager does not reconnect running pods; plan for reload or dual credentials.
- **The GitOps repo is now production access.** Whoever can merge to it can deploy anything; protect branches and require reviews as strictly as for production credentials.

#### Common mistakes

- `kubectl apply` by hand instead of GitOps, losing review, audit and drift correction.
- Secrets in IaC code or state in plaintext, a breach that lives in Git history forever.
- Treating the Terraform state file as non-sensitive when it can contain secrets.
- Running apply from a laptop against production, risking the wrong-workspace disaster.
- Relying on carefulness instead of guardrails (prevent_destroy, policy, pipeline-only apply).
- No backups/recovery as the last line of defense.

#### Interview questions

1. **What is GitOps?** Keeping the desired Kubernetes cluster state in Git and having a controller (Argo CD/Flux) continuously reconcile the cluster to match it, so deploys are reviewed Git merges and manual drift is auto-corrected.
2. **How do you handle secrets in IaC?** Never store them in code or state in plaintext; keep them in a secret manager and reference them, treat the state file as sensitive (encrypted, access-controlled), and use sealed/external secrets for Kubernetes.
3. **What guardrails would prevent a `terraform apply` from deleting a production database?** Plan-on-pull-request with review, `deletion_protection` on the instance and `prevent_destroy` on the resource (knowing the latter vanishes if the block is removed), `moved` blocks for renames, policy-as-code blocking production data-store destruction, pipeline-only apply against fixed environments (no laptop apply, no wrong-workspace risk), and backups as the last line of defense.
4. **What are Helm and Kustomize for?** Templating/packaging and per-environment customization of Kubernetes manifests, solving manifest reuse and customization (analogous to Terraform modules).

#### Practical exercise

Set up (or describe) a GitOps flow where Kubernetes manifests in Git are reconciled by Argo CD/Flux, using Helm or Kustomize for per-environment config. Ensure no secret appears in the manifests or Terraform state — reference a secret manager instead. Finally, list every guardrail from this Part that would have prevented the production-database-deletion incident and confirm backups exist as the last line of defense. Acceptance criteria: the cluster state is reconciled from reviewed Git, no plaintext secrets appear in code or state, and you can enumerate the layered guardrails that make a casual destructive apply impossible.

