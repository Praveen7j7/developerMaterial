## 64.3 State management

### 64.3.1 Remote state, locking and drift

#### Concept

Terraform keeps a **state file** recording what it created and how the declarations map to real resources. This state is how Terraform knows the current reality to compute the diff against. State management — where the state lives, how concurrent access is controlled (**locking**), and detecting when reality has diverged from state (**drift**) — is one of the most important and error-prone parts of using Terraform.

#### Why does it exist?

Terraform needs to know what already exists to decide what to change, and it cannot reliably rediscover every resource from the cloud each time, so it records a mapping in the state file. That file becomes critical: it is the source of truth for what Terraform manages. If two people apply at once, they can corrupt it or make conflicting changes, so **locking** exists. If someone changes a resource by hand (clickops), reality diverges from the state — **drift** — and Terraform's plan will try to "correct" it, so drift must be detected and understood. State management exists because the state file is both essential and fragile, and sharing it safely across a team requires deliberate handling.

#### Mental model

The state file is Terraform's memory of what it built — its inventory list mapping "the database I call `orders`" to the actual cloud resource. If this memory is lost, Terraform forgets it owns those resources and may try to recreate them; if two people edit the memory at once, it gets scrambled; if someone changes a resource without updating the memory, Terraform's view and reality disagree. Remote state is keeping this memory in a shared, safe place rather than on one person's laptop; locking is ensuring only one person edits the memory at a time; drift detection is noticing when the memory and the real world have diverged.

#### How it works

- **Remote state**: the state file is stored in a shared remote backend (an S3 bucket, a Terraform Cloud workspace), not on an individual's laptop, so the whole team works from one state and it is not lost if a laptop dies. Local state on one machine is a recipe for disaster on a team.
- **Locking**: the backend locks the state during an apply (via a lock mechanism, for example a DynamoDB table with the S3 backend) so two people cannot apply simultaneously and corrupt the state or make conflicting changes.
- **State drift**: when a resource is changed outside Terraform (a manual console change), the real resource no longer matches the state. `terraform plan` detects this (it shows the resource would be changed back to match the code) — so drift surfaces as unexpected changes in a plan. The response is to either bring the change into code or let Terraform reconcile it, but never ignore it.
- **Importing existing resources**: resources created before Terraform (or by hand) can be brought under management with `terraform import`, which adds them to the state so Terraform manages them going forward — the path from clickops to IaC for existing infrastructure.

```text
Remote state in a shared backend (S3 + a lock table):
  developer A: terraform apply -> acquires lock -> reads state -> plans -> applies -> updates state -> releases lock
  developer B: terraform apply while A holds the lock -> waits (locking prevents a clash)

Drift:
  someone changes the DB instance class by hand in the console
  -> terraform plan now shows it would change it BACK to the code's value
  -> the drift is visible; you codify the change or let Terraform reconcile it
```

#### How a Senior Backend Engineer thinks about this

A senior always uses remote state with locking for any shared infrastructure, never local state on a laptop, because local state is lost when the laptop dies and offers no protection against two people applying at once. They treat the state file as sensitive and critical — it maps to real resources and can contain secrets (64.6) — so it is stored securely with access control. They watch for drift: an unexpected change in a plan means someone changed something by hand, and they investigate rather than blindly applying, because the plan might be about to undo a necessary emergency fix or reveal an unauthorized change. They use `terraform import` to bring existing clickops resources under management incrementally. State discipline is, in their view, the difference between Terraform being a reliable tool and a source of its own incidents.

#### Common mistakes

- Local state on one laptop for shared infrastructure, risking loss and conflicts.
- No locking, so concurrent applies corrupt the state.
- Ignoring drift shown in a plan instead of investigating its cause.
- Treating the state file as non-sensitive when it can contain secrets and maps to real resources.
- Not importing existing resources, so Terraform tries to recreate things that already exist.

#### Interview questions

1. **What is the Terraform state file and why does it matter?** A record mapping declarations to real resources, used to compute the diff; it is the source of truth for what Terraform manages, so losing or corrupting it is serious.
2. **Why use remote state with locking?** Remote state lets a team share one state safely and survives a lost laptop; locking prevents concurrent applies from corrupting the state or making conflicting changes.
3. **What is state drift and how do you handle it?** When a resource is changed outside Terraform so reality diverges from state; it shows up as unexpected changes in a plan, and you investigate and either codify the change or let Terraform reconcile — never ignore it.
4. **How do you bring existing (clickops) resources under Terraform management?** `terraform import` adds them to the state so Terraform manages them going forward.

#### Practical exercise

Configure a remote state backend with locking (for example S3 plus a lock table) for a Terraform project, then simulate drift by changing a managed resource by hand and running `terraform plan` to see the drift detected. Finally, describe how you would import an existing manually-created resource into Terraform management. Acceptance criteria: state is remote and locked, the plan detects the manual change as drift, and you can explain the import path from clickops to IaC.

## 64.4 Structuring Terraform and the alternatives

### 64.4.1 Modules, environments and versioning

#### Concept

Real infrastructure spans many environments (dev, staging, production) and many services, and copy-pasting Terraform for each is unmaintainable. **Modules** package a reusable group of resources (a "service" module creating a database, cache and compute) with inputs and outputs, so you define the pattern once and instantiate it per environment and service. Structuring Terraform well — modules, per-environment configuration, module versioning — is what keeps IaC maintainable at scale.

#### Why does it exist?

Without modules, the Terraform for staging and production is duplicated, so they drift apart and a change must be made in many places. A module lets you define "a standard service's infrastructure" once and instantiate it with different inputs per environment (smaller database in staging, larger in production) and per service, keeping them consistent by construction. Versioning modules means a change to the standard pattern can be rolled out deliberately rather than instantly affecting everything. Good structure exists because infrastructure, like code, needs reuse, consistency and controlled change as it grows.

#### How it works

```hcl
# A reusable module: infra/modules/service/main.tf
# defines a database + cache + compute for one service, parameterized by inputs.
variable "name" { type = string }
variable "environment" { type = string }
variable "db_instance_class" { type = string }
# ... resources for the service's db, cache, compute, using the variables ...
output "db_endpoint" { value = aws_db_instance.this.endpoint }
```

```hcl
# Per-environment usage: infra/environments/production/main.tf
module "orders_service" {
  source            = "../../modules/service"      # reuse the module
  name              = "orders"
  environment       = "production"
  db_instance_class = "db.r6g.large"               # bigger in production
}

# infra/environments/staging/main.tf instantiates the SAME module with smaller inputs,
# so staging and production share one definition and stay consistent.
```

The structure: a `modules/` directory of reusable building blocks, and an `environments/` directory (or workspaces) that instantiate them with per-environment inputs. This keeps environments consistent (same module, different sizes) and changes DRY (fix the module once). **Module versioning** — referencing a module by a version tag rather than always the latest — lets you adopt a change to the standard pattern environment by environment, so a module update does not instantly and simultaneously alter every environment (a safety and rollout control, the same compatibility thinking as Part 32).

#### How a Senior Backend Engineer thinks about this

A senior structures Terraform into reusable modules instantiated per environment, so environments are consistent by construction (staging is production at a smaller size, from the same code) and changes are made once. They version shared modules so a change to the standard infrastructure pattern can be rolled out deliberately — staging first, then production — rather than hitting every environment at once, which is both a safety control and an echo of the compatibility discipline from Part 32. They keep the structure simple enough to understand (over-abstracted Terraform with deeply nested modules is as bad as copy-paste), and they treat the module library as a paved road (Part 53) — the standard, reviewed way to provision a service's infrastructure. The goal is consistency, reuse and controlled change, matching how they structure application code.

#### Common mistakes

- Copy-pasting Terraform per environment, causing drift and multi-place changes.
- No module versioning, so a module change instantly affects every environment.
- Over-abstracting into deeply nested modules that are hard to understand.
- Inconsistent environments because they were defined separately rather than from a shared module.

#### Interview questions

1. **Why use modules in Terraform?** To define a reusable group of resources once with inputs/outputs and instantiate it per environment and service, keeping environments consistent and changes DRY.
2. **How do you keep staging and production consistent?** Instantiate the same module with different inputs (sizes) per environment, so they share one definition and differ only by parameter.
3. **Why version shared modules?** So a change to the standard pattern can be rolled out environment by environment deliberately, rather than instantly altering every environment at once.

#### Practical exercise

Refactor duplicated Terraform for staging and production into a shared `service` module instantiated per environment with different instance sizes, and reference the module by a version. Acceptance criteria: staging and production use the same module (differing only by inputs), a change to the module is made in one place, and the version reference allows a staged rollout.

### 64.4.2 Pulumi, CDK, CloudFormation and choosing

#### Concept

Terraform is the most common IaC tool but not the only one. **Pulumi** lets you write infrastructure in real programming languages (including TypeScript). **AWS CDK** also uses programming languages and compiles to CloudFormation. **CloudFormation** is AWS's native IaC service using YAML/JSON. They occupy the same role — declaring infrastructure as code — with different languages and tradeoffs.

#### How it works — the decision table

| Tool | Language | Scope | Strength | Tradeoff |
|---|---|---|---|---|
| Terraform | HCL (declarative) | Multi-cloud (providers) | Mature, huge ecosystem, cloud-agnostic, widely known | Its own language; state management to run |
| Pulumi | Real languages (TypeScript, Python, ...) | Multi-cloud | Full programming power, familiar language, testable | State management; programming power can over-complicate |
| AWS CDK | Real languages (compiles to CloudFormation) | AWS-focused | Programming power, AWS-native, no separate state | AWS-centric; CloudFormation underneath |
| CloudFormation | YAML/JSON (declarative) | AWS only | AWS-native, no extra tooling, managed state | AWS-only; verbose; slower |

```text
Choose Terraform when:               Choose Pulumi/CDK when:            Choose CloudFormation when:
- multi-cloud or cloud-agnostic       - the team strongly prefers a       - AWS-only and you want the
- you want the largest ecosystem        real programming language           native, no-extra-tooling option
  and community knowledge              - you need programming constructs   - you accept AWS lock-in and verbosity
- declarative HCL is acceptable         (loops, conditionals, tests)
```

For a TypeScript backend team, Pulumi or CDK can appeal because the infrastructure is in a familiar language with real abstractions and testability. Terraform remains the common default for its maturity, multi-cloud providers and ubiquity (most engineers know it, most examples use it). The choice is a tradeoff between a dedicated declarative language with the biggest ecosystem (Terraform) and a real programming language with more power but more ways to over-complicate (Pulumi/CDK).

#### How a Senior Backend Engineer thinks about this

A senior chooses the IaC tool by the team's context and needs, not fashion: Terraform as the safe default for its maturity, multi-cloud support and ubiquity; Pulumi or CDK when the team strongly values infrastructure in a real, familiar, testable language and the extra programming power genuinely helps; CloudFormation when fully committed to AWS and wanting the native option. They are wary that programming-language IaC (Pulumi/CDK) makes it easy to over-engineer infrastructure with excessive abstraction, so they keep it as simple as declarative IaC would be. Whatever the tool, the principles are the same — version control, plan/review before apply, remote state, modules, guardrails — so they do not treat the tool choice as the important decision; the discipline around it is.

#### Common mistakes

- Choosing a tool by fashion rather than team context and needs.
- Over-engineering infrastructure because a programming language makes abstraction easy (Pulumi/CDK).
- Assuming the tool choice matters more than the surrounding discipline (plan/review, state, guardrails).

#### Interview questions

1. **How do Terraform, Pulumi, CDK and CloudFormation differ?** Terraform uses declarative HCL and is multi-cloud with the largest ecosystem; Pulumi and CDK use real programming languages (CDK compiles to CloudFormation, AWS-focused); CloudFormation is AWS's native declarative YAML/JSON. They share the IaC role with different languages and tradeoffs.
2. **When would a TypeScript team choose Pulumi or CDK?** When they strongly prefer infrastructure in a familiar, testable language with real programming constructs and the power helps; the risk is over-abstraction.
3. **Why is Terraform a common default?** Maturity, multi-cloud providers, a huge ecosystem, and ubiquity (most engineers know it), with declarative HCL that resists over-engineering.

#### Practical exercise

For a TypeScript backend team on AWS, write a short comparison of Terraform versus Pulumi/CDK for their IaC, considering language familiarity, multi-cloud needs, ecosystem, and the risk of over-abstraction, and make a recommendation. Acceptance criteria: the recommendation follows from the team's stated context, and you note that the surrounding discipline (plan/review, state, guardrails) matters more than the tool choice.
