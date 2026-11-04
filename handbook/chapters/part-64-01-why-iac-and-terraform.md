# Part 64 — Infrastructure as Code

The servers, databases, load balancers, networks and permissions your application runs on are infrastructure, and how you create and change that infrastructure matters as much as how you write code. **Infrastructure as Code (IaC)** means defining infrastructure in text files, version-controlled and applied by tooling, instead of clicking through a cloud console by hand. This Part teaches IaC from the ground up for a backend engineer: why it exists, Terraform fundamentals, state management, structuring it for many environments, the alternatives (Pulumi, CDK, CloudFormation), IaC in CI/CD, policy as code, GitOps for Kubernetes, secrets handling, and the real incident that explains why the guardrails matter.

The running example is the infrastructure for a NestJS service on AWS — a network, a PostgreSQL database, a Redis cache, a container runtime and the permissions tying them together — defined as code. This Part builds on cloud services (Part 28), Kubernetes (Part 27) and CI/CD (Part 29), turning the "how do you create this infrastructure" question those raise into a disciplined, codified answer.

## 64.1 Why infrastructure as code

### 64.1.1 Clickops, reproducibility and the case for IaC

#### Concept

The alternative to IaC is **clickops**: creating and changing infrastructure by hand in the cloud provider's web console. IaC replaces that with text files that describe the desired infrastructure, which a tool reads and makes real. The infrastructure's definition becomes code: versioned in Git, reviewed in pull requests, repeatable across environments, and auditable — the same engineering discipline you apply to application code, applied to the servers it runs on.

#### Why does it exist?

Clickops does not scale and is not safe. Infrastructure built by clicking is undocumented (the only record is what exists, and you cannot easily see why or who changed it), unrepeatable (recreating it in another region or after a disaster means remembering every click), inconsistent (staging and production drift apart because they were clicked separately), and unreviewable (a wrong click in production has no pull request and no second pair of eyes). IaC exists to fix all of this: the infrastructure is described once, applied identically everywhere, changed through reviewed pull requests, and recoverable from the code. It brings version control, review, repeatability and auditability to infrastructure.

#### Mental model

Clickops is assembling furniture from memory with no instructions — it might work once, but you cannot reliably build the same thing again, nobody can check your work, and if it breaks you are guessing at what you did. IaC is having the assembly instructions written down: anyone can build the identical thing, the instructions are reviewed before use, you can see exactly what changed between versions, and if something breaks you consult the written plan. Infrastructure as code turns "I think I set it up like this" into a precise, shared, versioned document that also builds the thing.

#### How it works

```text
Clickops:                                   Infrastructure as Code:
  open the console                            write a .tf file describing the infra
  click to create a database                  commit it, open a pull request
  click to set its size, network, backups     a teammate reviews the change
  ...no record of why or who                  CI shows a plan of what will change
  recreate elsewhere = remember every click   apply -> the tool makes it real, identically
```

With IaC you write files declaring the desired state ("a PostgreSQL database of this size, in this network, with these backups"), and the tool figures out what to create, change or leave alone to match that declaration. The files live in Git, so changes go through pull requests and review (Part 73), and the history shows every infrastructure change with its reason. The same files applied to staging and production produce consistent environments. If the infrastructure is lost, you reapply the code.

#### Failure scenario (clickops disaster)

A critical production database's automated backups had been disabled months earlier — someone had clicked the setting off during a one-time maintenance task and never re-enabled it, with no record of the change. When the database later suffered corruption, there was no recent backup to restore from, and data was lost. In an IaC world, the backup setting would be declared in code (`backup_retention_period = 30`), any change to it would be a reviewed pull request with a visible reason, and drift detection (64.2) would have flagged that the live setting no longer matched the code. The invisible, unreviewed, forgotten click is exactly the failure mode IaC prevents. The lesson: infrastructure changed by hand has no record, no review and no safety net, and the gap stays hidden until it causes an incident.

#### How a Senior Backend Engineer thinks about this

A senior treats all infrastructure as code and clickops as a liability to be eliminated, because unmanaged manual changes are undocumented, unrepeatable, inconsistent and unreviewable — the conditions under which quiet, dangerous drift accumulates until it causes an incident. They want every piece of infrastructure declared in version-controlled files, changed only through reviewed pull requests with a visible plan of the effect, and applied identically across environments so staging genuinely resembles production. They value the audit trail (who changed what and why) and the disaster-recovery property (the infrastructure can be rebuilt from code). They allow manual console changes only in genuine emergencies and then immediately bring the change back into code, because a live environment that no longer matches its code is drift waiting to surprise someone.

#### Common mistakes

- Managing production infrastructure by clickops, leaving it undocumented and unrepeatable.
- Making a quiet manual change (disabling a backup, opening a port) with no record or review.
- Letting staging and production drift apart because they were built by hand separately.
- Making an emergency manual change and never codifying it, creating drift.

#### Interview questions

1. **What is infrastructure as code and why use it over clickops?** Defining infrastructure in version-controlled files applied by tooling instead of manual console clicks; it brings version control, review, repeatability, consistency across environments, and auditability to infrastructure.
2. **What are the dangers of clickops?** Undocumented changes, unrepeatable setups, environment drift, no review of production changes, and no audit trail — conditions that hide dangerous misconfigurations until an incident.
3. **How does IaC help disaster recovery?** The infrastructure is described in code, so it can be reapplied to rebuild the environment identically, rather than recreated from memory.
4. **What should you do after an emergency manual change?** Bring it back into the code immediately, because a live environment that diverges from its code is drift that will surprise someone later.

#### Practical exercise

List the infrastructure for a simple web service (network, database, cache, compute, permissions) and, for each, note the problems of managing it by clickops (documentation, repeatability, review, drift) and how IaC addresses each. Then describe how the disabled-backup incident above would have been prevented by IaC. Acceptance criteria: you can articulate the four clickops problems and map each to an IaC benefit.

## 64.2 Terraform fundamentals

### 64.2.1 Providers, resources, plan and apply

#### Concept

**Terraform** is the most widely used IaC tool. You write declarations in its language (HCL) describing the resources you want — a network, a database, a server — and Terraform's workflow has two key steps: **plan** (show what changes it would make to reach the desired state) and **apply** (make those changes). A **provider** is a plugin that knows how to manage a particular platform's resources (AWS, GCP, Kubernetes). You declare the desired state; Terraform computes and applies the difference.

#### Why does it exist?

You need a tool that reads your infrastructure declarations and reconciles reality to match them — creating what is missing, changing what differs, leaving what matches, and removing what you deleted from the code. Doing this by hand (figuring out the API calls to create each resource in order, with dependencies) would be enormous and error-prone. Terraform exists to do that reconciliation declaratively and across many platforms via providers: you say what you want, it figures out how to get there, and it shows you the plan before it acts so there are no surprises.

#### Mental model

Terraform is like a meticulous contractor working from a blueprint. You hand over the blueprint (your declarations) describing the finished building. The contractor compares it to what is currently built (the current state), produces a punch list of exactly what will be added, changed or demolished (the plan), shows you that list for approval, and then does precisely that work (apply). You describe the end result; the contractor handles the ordering and the mechanics and never acts without showing you the plan first.

#### How it works

```hcl
# A provider: which platform, and its configuration.
provider "aws" {
  region = "us-east-1"
}

# A resource: a declaration of something you want to exist.
resource "aws_db_instance" "orders" {
  identifier              = "orders-db"
  engine                  = "postgres"
  engine_version          = "17"
  instance_class          = "db.r6g.large"
  allocated_storage       = 100
  backup_retention_period = 30          # declared, reviewed, cannot be quietly disabled
  multi_az                = true
  # ... network, credentials from a secret manager (64.6) ...
}

# Variables parameterize the config across environments.
variable "environment" { type = string }

# Outputs expose values (e.g. the database endpoint) for other code to use.
output "db_endpoint" { value = aws_db_instance.orders.endpoint }
```

```bash
terraform init      # download providers and set up the working directory
terraform plan      # show what Terraform WOULD change (no changes made) -- review this
terraform apply     # make the changes (after you confirm the plan)
```

The workflow's heart is **plan before apply**: `terraform plan` shows exactly what will be created, changed or destroyed, so you review the effect before anything happens. This is the safety mechanism — you never apply blind. Terraform is **declarative**: you describe the desired end state, not the steps, and it computes the difference from the current state (the **state**, 64.3) and makes only the needed changes. **Modules** (64.4) package reusable groups of resources; **variables** parameterize them; **outputs** expose values.

#### The destroy in the plan

A plan can show resources to be **destroyed** — this is where the danger lives. If you remove a resource from the code, or change a property that forces replacement, the plan shows a destroy. Reading the plan carefully for destroys, especially of stateful resources like databases, is critical: a plan that says it will destroy the production database must never be applied casually. This is the heart of the IaC incident in 64.5, and why the plan step and guardrails exist.

#### How a Senior Backend Engineer thinks about this

A senior treats `terraform plan` as a mandatory review step and reads it carefully every time, with particular attention to anything marked for destruction or replacement, because the plan is the last chance to catch a change that would delete a database or recreate something stateful. They keep the configuration declarative and let Terraform compute the diff, rather than reasoning about imperative steps. They parameterize with variables so one configuration serves multiple environments consistently (64.4), and expose values via outputs rather than hardcoding. They know that a Terraform apply is a powerful, potentially destructive action, so they wrap it in the guardrails of the rest of this Part — plan on pull request, review, approvals, and protection on stateful resources (64.5) — and never run a casual `apply` against production without reading the plan.

#### Common mistakes

- Running `apply` without reading the `plan`, missing a destructive change.
- Not noticing a resource marked for destroy or replace, especially a stateful one (database).
- Hardcoding environment-specific values instead of using variables.
- Not using modules, so configuration is copy-pasted and drifts.

#### Interview questions

1. **What do `terraform plan` and `terraform apply` do, and why is plan important?** `plan` shows exactly what would be created, changed or destroyed without acting; `apply` makes the changes; plan is the mandatory review step that catches destructive changes before they happen.
2. **What is a provider and a resource in Terraform?** A provider is a plugin that manages a platform's resources (AWS, GCP, Kubernetes); a resource is a declaration of a piece of infrastructure you want to exist.
3. **Why is Terraform declarative, and what does it compute?** You declare the desired end state; Terraform computes the difference from the current state and makes only the needed changes.
4. **What is the most dangerous thing a plan can show, and how do you handle it?** A destroy or forced replacement of a stateful resource (like a database); read plans carefully for these and guard stateful resources against accidental destruction (64.5).

#### Practical exercise

Write a Terraform configuration declaring a PostgreSQL database with backups enabled and multi-AZ, parameterized by an `environment` variable, with the endpoint as an output. Run `terraform plan` (against a sandbox or with a dry setup) and read the plan to identify what it would create. Then change the instance class and observe whether the plan shows a modify or a replace. Acceptance criteria: you can read the plan, identify creates versus replaces, and explain why a replace of a database would be dangerous.
