## 51.3 State management

### 51.3.1 Remote state, locking and drift

#### Concept

Terraform keeps a **state file** recording what it created and how the declarations map to real resources. This state is how Terraform knows the current reality to compute the diff against. State management — where the state lives, how concurrent access is controlled (**locking**), and detecting when reality has diverged from state (**drift**) — is one of the most important and error-prone parts of using Terraform.

#### Why does it exist?

Terraform needs to know what already exists to decide what to change, and it cannot reliably rediscover every resource from the cloud each time, so it records a mapping in the state file. That file becomes critical: it is the source of truth for what Terraform manages. If two people apply at once, they can corrupt it or make conflicting changes, so **locking** exists. If someone changes a resource by hand (clickops), reality diverges from the state — **drift** — and Terraform's plan will try to "correct" it, so drift must be detected and understood. State management exists because the state file is both essential and fragile, and sharing it safely across a team requires deliberate handling.

#### Mental model

The state file is Terraform's memory of what it built — its inventory list mapping "the database I call `orders`" to the actual cloud resource. If this memory is lost, Terraform forgets it owns those resources and may try to recreate them; if two people edit the memory at once, it gets scrambled; if someone changes a resource without updating the memory, Terraform's view and reality disagree. Remote state is keeping this memory in a shared, safe place rather than on one person's laptop; locking is ensuring only one person edits the memory at a time; drift detection is noticing when the memory and the real world have diverged.

#### How it works

- **Remote state**: the state file is stored in a shared remote backend (an S3 bucket, a Terraform Cloud workspace), not on an individual's laptop, so the whole team works from one state and it is not lost if a laptop dies. Local state on one machine is a recipe for disaster on a team.
- **Locking**: the backend locks the state during a plan or apply so two people cannot write simultaneously and corrupt the state or make conflicting changes. With the S3 backend, Terraform 1.10 and later can lock with a lock file in the bucket itself (`use_lockfile = true`); the older mechanism, a DynamoDB table (`dynamodb_table`), still works but is deprecated.
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

#### Practical example

The backend for the production network and data layer of the orders service, plus the bucket that holds it (the bucket itself is created once by a small bootstrap configuration with local state, then never touched):

```hcl
# envs/production/data/backend.tf
terraform {
  required_version = ">= 1.10.0"
  backend "s3" {
    bucket       = "acme-tfstate-prod-111122223333"
    key          = "orders/production/data.tfstate"   # one state file per root configuration
    region       = "ap-south-1"
    encrypt      = true
    kms_key_id   = "arn:aws:kms:ap-south-1:111122223333:key/0a1b2c3d-4e5f-6789-abcd-ef0123456789"
    use_lockfile = true                               # S3-native locking (Terraform 1.10+)
  }
}
```

```hcl
# bootstrap/state-bucket.tf
resource "aws_s3_bucket" "tfstate" {
  bucket = "acme-tfstate-prod-111122223333"
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  versioning_configuration { status = "Enabled" }      # every state write is a recoverable version
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket                  = aws_s3_bucket.tfstate.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
```

Useful state commands, all of which take the lock: `terraform state list` (what is managed), `terraform state show aws_db_instance.orders` (what Terraform believes), `terraform plan -refresh-only` (show drift without proposing to change real resources), and `terraform force-unlock <LOCK_ID>` (only after confirming the holder is truly dead).

#### Failure scenario

At 16:20 a CI apply for the production data layer was cancelled by a runner timeout halfway through modifying an ElastiCache parameter group. The lock stayed in place, so the next pipeline failed with `Error acquiring the state lock`. An engineer, under pressure to ship a fix, ran `terraform force-unlock` and then an apply from a laptop with an older checkout of the code. That apply saw the state the cancelled job had partially written and planned to revert two changes merged that morning; it was caught only because the plan showed unexpected `~` lines on resources the engineer had not touched. The recovery: restore nothing, stop, rerun plan from the main branch in CI, and let the pipeline finish the interrupted change. The rules added: force-unlock only from CI with a second person, never apply from a stale checkout, and S3 versioning on the state bucket so a bad write can be rolled back. The lesson: a lock error is a question ("is someone else changing this?"), not an obstacle to remove.

#### Edge cases & failure modes

- **Lost state.** Without versioning, a corrupted or deleted state file means Terraform no longer knows it owns anything; a plan would propose creating everything again. Version the bucket; restore the previous object.
- **Secrets in state.** Any attribute a provider returns is stored, including generated passwords; encrypt, restrict, and avoid putting secrets there at all (51.13).
- **One giant state.** 3,000 resources in one state means slow plans (minutes), one lock for every team, and a huge blast radius; split by layer and service (51.8).
- **Cross-state references.** `terraform_remote_state` gives a consumer read access to the whole other state, secrets included; prefer publishing specific outputs to SSM Parameter Store and reading them with a data source.
- **Hand-editing state JSON.** Never; use `state mv`, `state rm`, or better, `moved`, `removed` and `import` blocks (51.7), which are reviewable.

#### How a Senior Backend Engineer thinks about this

A senior always uses remote state with locking for any shared infrastructure, never local state on a laptop, because local state is lost when the laptop dies and offers no protection against two people applying at once. They treat the state file as sensitive and critical — it maps to real resources and can contain secrets (51.6) — so it is stored securely with access control. They watch for drift: an unexpected change in a plan means someone changed something by hand, and they investigate rather than blindly applying, because the plan might be about to undo a necessary emergency fix or reveal an unauthorized change. They use `terraform import` to bring existing clickops resources under management incrementally. State discipline is, in their view, the difference between Terraform being a reliable tool and a source of its own incidents.

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

## 51.4 Structuring Terraform and the alternatives

### 51.4.1 Modules, environments and versioning

#### Concept

Real infrastructure spans many environments (dev, staging, production) and many services, and copy-pasting Terraform for each is unmaintainable. **Modules** package a reusable group of resources (a "service" module creating a database, cache and compute) with inputs and outputs, so you define the pattern once and instantiate it per environment and service. Structuring Terraform well — modules, per-environment configuration, module versioning — is what keeps IaC maintainable at scale.

#### Why does it exist?

Without modules, the Terraform for staging and production is duplicated, so they drift apart and a change must be made in many places. A module lets you define "a standard service's infrastructure" once and instantiate it with different inputs per environment (smaller database in staging, larger in production) and per service, keeping them consistent by construction. Versioning modules means a change to the standard pattern can be rolled out deliberately rather than instantly affecting everything. Good structure exists because infrastructure, like code, needs reuse, consistency and controlled change as it grows.

#### Mental model

A module is a recipe card in a restaurant chain. Head office writes "the standard burger" once; every branch cooks from the same card and only changes what the card allows (the size, the sauce). When head office improves the recipe, they print version 2 and branches switch when they are ready, test kitchen first. Copy-pasted Terraform is every branch improvising its own burger from memory.

#### How it works

```hcl
# A reusable module: infra/modules/postgres/main.tf (trimmed to the essentials)
variable "name"              { type = string }
variable "environment"       { type = string }
variable "instance_class"    { type = string }
variable "subnet_ids"        { type = list(string) }
variable "security_group_id" { type = string }

variable "multi_az" {
  type    = bool
  default = true                                    # safe default: callers must opt out
}

resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-${var.environment}"
  subnet_ids = var.subnet_ids
}

resource "aws_db_instance" "this" {
  identifier                  = "${var.name}-${var.environment}"
  engine                      = "postgres"
  engine_version              = "17"
  instance_class              = var.instance_class
  allocated_storage           = 100
  username                    = "${var.name}_admin"
  manage_master_user_password = true
  db_subnet_group_name        = aws_db_subnet_group.this.name
  vpc_security_group_ids      = [var.security_group_id]
  multi_az                    = var.multi_az
  backup_retention_period     = 30
  deletion_protection         = true
  lifecycle { prevent_destroy = true }
}

output "endpoint" { value = aws_db_instance.this.endpoint }
```

```hcl
# Per-environment usage: infra/environments/production/main.tf
module "orders_db" {
  source            = "git::https://github.com/acme/terraform-modules.git//postgres?ref=v2.3.0"  # pinned version
  name              = "orders"
  environment       = "production"
  instance_class    = "db.r6g.large"               # bigger in production
  subnet_ids        = module.network.private_data_subnet_ids
  security_group_id = aws_security_group.orders_db.id
}

# infra/environments/staging/main.tf instantiates the SAME module with smaller inputs
# (instance_class = "db.t4g.medium", multi_az = false), so staging and production
# share one definition and stay consistent.
```

The structure: a `modules/` directory (or a separate modules repository, as in the `source` above) of reusable building blocks, and an `environments/` directory that instantiates them with per-environment inputs. This keeps environments consistent (same module, different sizes) and changes DRY (fix the module once). **Module versioning** — referencing a module by a version tag rather than always the latest — lets you adopt a change to the standard pattern environment by environment, so a module update does not instantly and simultaneously alter every environment (a safety and rollout control, the same compatibility thinking as Part 24). Section 51.8 covers layout, blast radius and why Terraform workspaces are a poor way to separate staging from production.

#### Failure scenario

A platform team changed the shared `ecs-service` module so every service got a new target-group health check path, and because twelve services referenced the module by `?ref=main` rather than a tag, the next apply of each service picked up the change. Four services did not serve `/health/ready`; their targets went unhealthy within a minute of apply and the ALB returned 503s for those services until the change was reverted 25 minutes later. The fix was to pin every module source to a tag, release module changes with a changelog, and roll them out staging-first. The lesson: an unpinned module is a deploy to every environment that nobody reviewed.

#### Edge cases & failure modes

- **Renaming inside a module.** Renaming a resource inside a module changes the address in every caller's state; ship a `moved` block in the module (51.7) or every caller plans a destroy.
- **Breaking input changes.** Removing or renaming a variable breaks callers; treat module inputs like a public API with semantic versioning.
- **Too many knobs.** A module with 80 variables is the provider re-exported; expose the decisions a service team should make and hard-code the standards.
- **Providers inside modules.** Declaring `provider` blocks in a reusable module prevents callers from using `for_each` on it and makes removal painful; pass providers in from the root.

#### How a Senior Backend Engineer thinks about this

A senior structures Terraform into reusable modules instantiated per environment, so environments are consistent by construction (staging is production at a smaller size, from the same code) and changes are made once. They version shared modules so a change to the standard infrastructure pattern can be rolled out deliberately — staging first, then production — rather than hitting every environment at once, which is both a safety control and an echo of the compatibility discipline from Part 24. They keep the structure simple enough to understand (over-abstracted Terraform with deeply nested modules is as bad as copy-paste), and they treat the module library as a paved road (Part 80) — the standard, reviewed way to provision a service's infrastructure. The goal is consistency, reuse and controlled change, matching how they structure application code.

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

### 51.4.2 Pulumi, CDK, CloudFormation and choosing

#### Concept

Terraform is the most common IaC tool but not the only one. **Pulumi** lets you write infrastructure in real programming languages (including TypeScript). **AWS CDK** also uses programming languages and compiles to CloudFormation. **CloudFormation** is AWS's native IaC service using YAML/JSON. They occupy the same role — declaring infrastructure as code — with different languages and tradeoffs.

#### Why does it exist?

Teams differ. A platform team managing AWS, Cloudflare, Datadog and GitHub from one workflow needs a tool with providers for all of them. A TypeScript product team that wants to unit-test its infrastructure and share types between application and infrastructure code wants a real language. An AWS-only enterprise with strict change control may want the provider's own managed service so there is no state file to run. The alternatives exist because "declare infrastructure" has several reasonable answers, and the right one depends on who writes it, what it targets, and what the organization already runs. One fact shapes the landscape: in August 2023 HashiCorp moved Terraform to the Business Source License, and the Linux Foundation's **OpenTofu** fork continues under an open-source license with the same HCL and largely compatible state, so "Terraform" in this Part applies to OpenTofu too, except for features added after the fork by either side.

#### Mental model

All four are ways of writing the same blueprint. Terraform and CloudFormation are blueprints drawn with a fixed set of symbols: limited, but anyone can read any blueprint. Pulumi and CDK are blueprints produced by a program: you can generate a hundred similar floors with a loop and test the program, but a reader must now understand the program to know what the building looks like.

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

For a TypeScript backend team, Pulumi or CDK can appeal because the infrastructure is in a familiar language with real abstractions and testability. Terraform remains the common default for its maturity, multi-cloud providers and ubiquity (most engineers know it, most examples use it). The choice is a tradeoff between a dedicated declarative language with the biggest ecosystem (Terraform) and a real programming language with more power but more ways to over-complicate (Pulumi/CDK). Section 51.9 puts the same database in Pulumi and CDK TypeScript next to the Terraform version so you can compare them line by line.

#### Failure scenario

A team chose CDK for a new service and, a year later, a CloudFormation stack update failed halfway through replacing an ALB listener and went into `UPDATE_ROLLBACK_FAILED` because a resource it tried to roll back had been changed by hand. CloudFormation refused further updates to the stack until the rollback was continued with that resource skipped (`ContinueUpdateRollback` with resources to skip), and the team spent an afternoon learning CloudFormation internals they thought CDK had hidden. Nothing about the choice was wrong; the lesson is that every tool's failure modes are those of its engine (CloudFormation for CDK, the state backend for Terraform and Pulumi), and you must learn the engine before production needs you to.

#### Edge cases & failure modes

- **Mixing tools on the same resources.** Terraform and CDK both managing one security group means each reverts the other; one owner per resource.
- **Programmatic IaC with network calls at synth time.** A CDK app that looks things up live produces different templates on different days; CDK caches lookups in `cdk.context.json`, which must be committed.
- **License and fork drift.** Terraform and OpenTofu are diverging slowly; pick one per organization and pin it in CI.
- **Migration cost.** Moving between tools means importing every resource into the new tool's state without recreating it; budget weeks, not days.

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
