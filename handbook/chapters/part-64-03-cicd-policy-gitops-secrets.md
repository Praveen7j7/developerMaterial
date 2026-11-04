## 64.5 IaC in CI/CD and policy as code

### 64.5.1 Plan on pull request, apply pipelines and preventing destructive changes

#### Concept

IaC becomes safe and collaborative when integrated into CI/CD (Part 29): a change to infrastructure code opens a pull request, CI runs `terraform plan` and posts the result for review, an approval gate guards the apply, and the apply runs in a pipeline rather than from someone's laptop. Guardrails prevent destructive changes (especially to stateful resources) from being applied casually. This turns infrastructure changes into the same reviewed, automated, controlled flow as application changes.

#### Why does it exist?

Running `terraform apply` from a laptop against production is dangerous: no review of the plan, no approval, no audit, and the risk of an unnoticed destructive change. Integrating IaC into CI/CD brings the plan into the pull request so reviewers see exactly what will change, gates the apply behind approval, runs it from a controlled pipeline with proper credentials, and records every change. Guardrails that block or require extra approval for destroying stateful resources prevent the catastrophic accident. This exists because infrastructure changes are high-stakes and deserve at least the same rigor as code changes — arguably more, since a bad one can delete a database.

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

The key safety steps: the **plan on the pull request** makes the effect visible and reviewable before merge; **policy as code** (64.5.2) auto-blocks disallowed or dangerous changes; an **approval gate** requires human sign-off; the **apply runs in the pipeline**, not on a laptop, with scoped credentials and an audit trail. **Preventing destructive changes** specifically means guarding stateful resources — Terraform's `prevent_destroy` lifecycle flag on a database, required extra approval for any plan containing a destroy, and policy that blocks destruction of production data stores.

```hcl
# Guard a stateful resource against accidental destruction.
resource "aws_db_instance" "orders" {
  # ...
  lifecycle {
    prevent_destroy = true   # a plan that would destroy this fails -> no accidental DB deletion
  }
}
```

#### How a Senior Backend Engineer thinks about this

A senior runs all infrastructure changes through CI/CD with plan-on-pull-request, review, policy checks, approval gates and pipeline-based apply, never a laptop `apply` against production, because the plan-in-the-PR is where a reviewer catches a change about to destroy a database. They layer explicit protection on stateful resources (`prevent_destroy`, extra approval for any destroy in a plan, policy blocking production data-store destruction), treating the destruction of a stateful resource as the highest-stakes operation in the whole system. They keep the apply credentials in the pipeline, scoped and audited, not on individuals' machines. In their view, infrastructure changes deserve more rigor than code changes, because a bad code deploy can be rolled back while a destroyed production database with no backup cannot.

#### Common mistakes

- Running `terraform apply` from a laptop against production, with no review or audit.
- No plan on the pull request, so reviewers cannot see the effect.
- No guard on stateful resources, allowing an accidental destroy to be applied.
- No approval gate on apply.
- Apply credentials on individuals' laptops instead of scoped in the pipeline.

#### Interview questions

1. **How do you integrate Terraform into CI/CD safely?** Plan on the pull request (post the plan for review), policy checks, an approval gate, and apply from the pipeline with scoped credentials and an audit trail — never a laptop apply against production.
2. **Why is the plan-on-pull-request step important?** It makes the exact effect of the change visible and reviewable before merge, so reviewers catch destructive or wrong changes.
3. **How do you prevent accidental destruction of a database?** `prevent_destroy` lifecycle on the resource, required extra approval for any plan containing a destroy, and policy blocking destruction of production data stores.
4. **Why do infrastructure changes deserve more rigor than code changes?** A bad code deploy can be rolled back; a destroyed production database with no backup cannot — the stakes are higher.

#### Practical exercise

Set up (or describe) a CI/CD flow for Terraform: a pull request runs `terraform plan` and posts it as a comment, an approval is required, and merge triggers an apply pipeline. Add `prevent_destroy` to a database resource and verify that a change which would destroy it fails the plan. Acceptance criteria: the plan is visible on the PR before merge, apply runs in the pipeline not locally, and the database cannot be accidentally destroyed.

### 64.5.2 Policy as code

#### Concept

**Policy as code** enforces rules about infrastructure automatically, as code, in the pipeline — "no public S3 buckets", "all databases must have backups enabled", "no untagged resources", "no instance types above a cost threshold". Tools like **OPA/Conftest** and Sentinel evaluate the Terraform plan against these policies and block the apply if a rule is violated. It is automated governance (Part 53) for infrastructure, catching security and cost problems before they are applied.

#### Why does it exist?

Relying on humans to remember every security and cost rule in every infrastructure review does not scale and misses things — someone forgets to enable backups, opens a bucket to the public, or picks an oversized instance. Policy as code encodes these rules once and enforces them automatically on every change, so a violation is blocked before it reaches production, not caught later (or never). It exists to make governance automatic, consistent and un-forgettable, the same shift from manual to codified that IaC itself represents, applied to the rules about the infrastructure.

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

Policies codify security rules (no public data stores, encryption required, no overly-broad permissions), cost rules (no oversized instances, required cost tags), and standards (naming, tagging) — the governance standards of Part 53, enforced automatically. Because they run on the plan in CI, they catch violations before anything is applied, turning "we have a policy that databases need backups" (which someone can forget) into "a change that disables backups cannot be merged" (which is enforced).

#### How a Senior Backend Engineer thinks about this

A senior encodes the important infrastructure rules — security (no public data stores, encryption, least-privilege permissions, Part 23), cost (instance-size limits, required tags), and standards (Part 53) — as policy-as-code that runs on every plan in CI, so violations are blocked automatically rather than relying on human reviewers to remember them. They see this as the automated-governance paved road (Part 53): the rules are consistent, un-forgettable and catch problems before they are applied, which is the only way governance scales across many services and engineers. They keep policies focused on real risks (a public production bucket, a database with no backups, a wildly oversized instance) rather than nitpicking, because over-strict policy becomes a nuisance people route around. Policy as code is, to them, the enforcement layer that makes IaC genuinely safe at scale.

#### Common mistakes

- Relying on human reviewers to remember every security and cost rule, which misses violations.
- No automated enforcement, so a change disabling backups or opening a bucket can slip through.
- Over-strict policies that nitpick and get routed around.
- Not enforcing cost guardrails, allowing oversized resources to inflate the bill.

#### Interview questions

1. **What is policy as code and why use it?** Encoding infrastructure rules (security, cost, standards) as code that automatically evaluates each Terraform plan in CI and blocks violations; it makes governance automatic, consistent and un-forgettable, catching problems before apply.
2. **Give examples of policies worth enforcing.** No public data stores, backups/encryption required, least-privilege permissions, instance-size/cost limits, required tags, naming standards.
3. **How does policy as code relate to governance (Part 53)?** It is the automated-enforcement form of architecture standards — the paved road enforced in the pipeline rather than relying on human memory.

#### Practical exercise

Write (or describe) policy-as-code rules with OPA/Conftest that fail a Terraform plan if any S3 bucket allows public access, any database has backups disabled, or any resource lacks a cost tag, and wire them into the plan step of the CI pipeline. Acceptance criteria: a plan violating any rule fails the pipeline before apply, and the rules focus on real security and cost risks.

## 64.6 GitOps, secrets and the apply-gone-wrong incident

### 64.6.1 GitOps for Kubernetes and secrets in IaC

#### Concept

**GitOps** applies IaC principles to running applications on Kubernetes (Part 27): the desired state of the cluster (deployments, services, config) lives in Git, and a controller (Argo CD or Flux) continuously reconciles the cluster to match Git. **Helm** and **Kustomize** are tools for templating and customizing Kubernetes manifests. **Secrets** (database passwords, API keys) must never be stored in IaC code or state in plaintext — they come from a secret manager, referenced by the code.

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

The cluster's state is declared in Git; a controller (Argo CD, Flux) continuously reconciles the actual cluster to the declared state, so deploys happen by merging to Git (reviewed, audited) and manual drift is corrected automatically. **Helm** packages Kubernetes manifests as reusable, parameterized charts; **Kustomize** overlays per-environment customizations on base manifests — both solve the manifest-reuse-and-customization problem, analogous to Terraform modules (64.4).

#### How it works — secrets

```text
NEVER put secrets in IaC code or state in plaintext:
  BAD:  password = "hunter2"   in a .tf file (committed to Git, visible to all)
  BAD:  a plaintext secret ends up in the Terraform state file (stored in the backend)

Instead:
  - store secrets in a secret manager (AWS Secrets Manager, Vault)
  - IaC/code REFERENCES the secret (fetches it at deploy/run time), never embeds it
  - for Kubernetes: sealed secrets / external secrets operators pull from the manager
  - restrict and audit access to the secret manager and the Terraform state (Part 23)
```

The rule: secrets never live in IaC code (which is in Git) or in state (which is in a shared backend) in plaintext; they live in a secret manager and are referenced. A database password committed to a `.tf` file is in Git history forever (Part 73) and visible to everyone with repo access — a breach. Even values Terraform fetches can land in the state file, so the state itself must be treated as sensitive, encrypted and access-controlled. This is the Part 23 and Part 72 secrets discipline applied to infrastructure code.

#### Failure scenario (the terraform apply that deleted a production database)

An engineer, intending to update a staging environment, ran `terraform apply` from their laptop. They had the wrong workspace/state selected — it pointed at production. The plan included a destroy of the production database (a refactor had removed and re-added the resource in a way that forced replacement), but, rushing, they did not read the plan carefully and confirmed the apply. The production database was destroyed. Because backups and point-in-time recovery were in place, the data was recoverable, but there was a painful outage. Every guardrail in this Part would have stopped it: plan-on-pull-request with review would have surfaced the destroy; `prevent_destroy` on the database would have failed the plan; policy-as-code blocking production data-store destruction would have blocked it; running apply from a reviewed pipeline, not a laptop, with no human able to casually apply to production, would have prevented it; and the wrong-workspace mistake would have been caught by the pipeline targeting a fixed environment. The lesson: a Terraform apply is one of the most dangerous commands in the whole system, and it must be wrapped in every guardrail — review, prevent_destroy, policy, pipeline-only apply — because the cost of getting it wrong is a destroyed production database.

#### How a Senior Backend Engineer thinks about this

A senior uses GitOps for Kubernetes so the cluster's state is version-controlled, reviewed and continuously reconciled from Git, with Helm/Kustomize for reuse and customization, treating `kubectl apply` by hand as the clickops of Kubernetes. They never put secrets in IaC code or state, externalizing them to a secret manager and treating the state file as sensitive, encrypted and access-controlled. Above all, they treat `terraform apply` as a dangerous, high-stakes operation and wrap it in the full set of guardrails from this Part — plan-on-pull-request and review, `prevent_destroy` on stateful resources, policy-as-code, and pipeline-only apply against fixed environments — because the apply-gone-wrong incident is a database deletion, and the only reliable defense is making it impossible to apply a destructive change casually. They ensure backups and recovery exist regardless (the last line of defense, Part 13), because guardrails reduce but never fully eliminate the chance of a mistake.

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
3. **What guardrails would prevent a `terraform apply` from deleting a production database?** Plan-on-pull-request with review, `prevent_destroy` on the database, policy-as-code blocking production data-store destruction, pipeline-only apply against fixed environments (no laptop apply, no wrong-workspace risk), and backups as the last line of defense.
4. **What are Helm and Kustomize for?** Templating/packaging and per-environment customization of Kubernetes manifests, solving manifest reuse and customization (analogous to Terraform modules).

#### Practical exercise

Set up (or describe) a GitOps flow where Kubernetes manifests in Git are reconciled by Argo CD/Flux, using Helm or Kustomize for per-environment config. Ensure no secret appears in the manifests or Terraform state — reference a secret manager instead. Finally, list every guardrail from this Part that would have prevented the production-database-deletion incident and confirm backups exist as the last line of defense. Acceptance criteria: the cluster state is reconciled from reviewed Git, no plaintext secrets appear in code or state, and you can enumerate the layered guardrails that make a casual destructive apply impossible.

## Senior Checklist — Part 64

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
- [ ] I can explain why IaC beats clickops and codify infrastructure in Terraform
- [ ] I always read the plan and watch for destroys/replaces of stateful resources
- [ ] I use remote state with locking and understand and detect drift
- [ ] I structure Terraform with versioned modules instantiated per environment
- [ ] I run IaC through CI/CD with plan-on-PR, approval, policy-as-code and pipeline apply
- [ ] I guard stateful resources (prevent_destroy) and never apply from a laptop to production
- [ ] I use GitOps for Kubernetes and keep secrets out of IaC code and state

## Part 64 — Key Takeaways

- IaC replaces clickops with version-controlled, reviewed, repeatable, auditable infrastructure definitions; unmanaged manual changes are undocumented drift that hides until it causes an incident.
- Terraform declares desired state; `plan` shows exactly what will change and is the mandatory review step, especially for destroys or replacements of stateful resources.
- The state file maps declarations to real resources; use remote state with locking, treat it as sensitive, and investigate drift shown in a plan rather than ignoring it.
- Structure Terraform as versioned modules instantiated per environment so environments are consistent by construction and changes are made once and rolled out deliberately.
- Terraform, Pulumi, CDK and CloudFormation all do IaC with different languages and tradeoffs; choose by team context, and remember the surrounding discipline matters more than the tool.
- Run IaC through CI/CD: plan on the pull request for review, policy checks, an approval gate, and apply from the pipeline with scoped credentials — never a laptop apply against production.
- Guard stateful resources explicitly (`prevent_destroy`, extra approval for any destroy, policy blocking production data-store destruction) because a bad apply can delete a database.
- Policy as code enforces security, cost and standards rules automatically on every plan, making governance consistent and un-forgettable (the automated paved road of Part 53).
- GitOps keeps Kubernetes state in Git and reconciles continuously (Argo CD/Flux, with Helm/Kustomize), making deploys reviewed and drift auto-corrected.
- Never put secrets in IaC code or state; externalize them to a secret manager and reference them, and keep backups as the last line of defense, because guardrails reduce but never eliminate the chance of a destructive mistake.
