## 28.10 Object storage: S3

#### Concept

S3 stores objects (any bytes, up to 5 TB each) under a key in a bucket, replicated across at least three AZs, addressable over HTTPS, and billed per GB-month and per request. It is not a filesystem: there are no directories, no partial updates, no appends and no locks. It is the place where product images, invoices, exports, backups, logs and uploaded files live, and it is the origin behind CloudFront. The upload mechanics from the application's point of view (multipart, validation, virus scanning, resumable uploads) are in Part 33 — File Storage and Uploads; this section covers what S3 itself guarantees and costs.

#### Why does it exist?

Files do not belong in PostgreSQL (bloat, backup size, no CDN) or on a container's disk (gone at the next deploy). S3 gives unlimited capacity with eleven nines of durability, a permission model that lets a browser upload directly without touching your API, and events that trigger processing when an object lands.

#### Mental model

Imagine a valet lot of infinite size. You hand over an item, get a claim ticket (the key), and can get it back from any window in the region. The valets keep three copies in three buildings. You can ask for "all tickets starting with `invoices/2025/09/`" and get them in order, but asking "find all red items" means reading every ticket. Overwriting means handing in a new item under the same ticket; the old one is gone unless you turned on versioning.

#### How it works

**Buckets and keys.** Bucket names are globally unique and DNS-compatible; buckets are regional. Keys are strings; the `/` is a convention that the console renders as folders, and a **prefix** is any leading substring. Throughput scales per prefix: at least 3,500 writes and 5,500 reads per second per prefix, and S3 partitions further automatically. Spread hot workloads across prefixes (`uploads/<userIdHash>/...`) rather than one prefix per day.

**Consistency.** Since December 2020 S3 is **strongly consistent** for every operation: a `GET` or `LIST` after a `PUT`, overwrite or `DELETE` reflects the change. What is *not* consistent is everything you put in front of it: CloudFront caches by TTL, your application may cache metadata, a client may cache by `ETag`. "S3 is eventually consistent" is now false; "the path to S3 has caches" is still true.

**Durability and availability.** Designed for 99.999999999% durability (across AZs) and 99.99% availability for Standard (the SLA credits at 99.9%). An AZ loss is invisible; a regional S3 event, rare as it is, means writes fail and your app must degrade (queue the upload, show a fallback image).

**Storage classes.**

| Class | Per GB-month (us-east-1, approximate) | Retrieval | Use |
|---|---|---|---|
| Standard | $0.023 | Immediate, free | Active data, images served by CDN |
| Intelligent-Tiering | $0.023 plus monitoring | Immediate | Unknown access patterns |
| Standard-IA | $0.0125 | Immediate, $0.01/GB, 30-day minimum | Old invoices, backups read rarely |
| One Zone-IA | $0.01 | Immediate, one AZ only | Re-creatable derived data |
| Glacier Instant Retrieval | $0.004 | Milliseconds, $0.03/GB, 90-day minimum | Archives read a few times a year |
| Glacier Flexible Retrieval | $0.0036 | Minutes to hours | Compliance archives |
| Glacier Deep Archive | $0.00099 | 12 hours | Seven-year retention |
| Express One Zone | Higher | Single-digit ms, directory buckets | Latency-sensitive hot data |

**Lifecycle rules** move objects between classes after N days, expire them, delete old versions and abort incomplete multipart uploads (which otherwise sit invisibly and cost money forever). **Versioning** keeps every overwritten and deleted version (a delete becomes a delete marker), which is the only protection against an application bug that overwrites a thousand images; pair it with a lifecycle rule that expires non-current versions after 30 days.

**Pre-signed URLs.** Your backend, holding credentials, signs a URL that lets anyone with the URL perform one operation (`GET` or `PUT`) on one key until an expiry. The browser uploads straight to S3; your API never sees the bytes. A pre-signed `POST` adds conditions (`content-length-range`, `content-type`, key prefix), which a pre-signed `PUT` cannot enforce. The expiry you set is capped by the **lifetime of the credentials that signed it**: an IAM user's long-lived keys can sign for up to seven days, but an ECS task role's temporary credentials expire (and rotate) within hours, so a "7-day" URL signed by a task dies early. Keep pre-signed URLs to minutes for uploads and an hour or so for downloads, and use CloudFront signed URLs (section 28.8) for long-lived access.

**Event notifications.** `s3:ObjectCreated:*`, `s3:ObjectRemoved:*` and others can invoke Lambda or land in SQS, SNS or EventBridge, filtered by prefix and suffix. Delivery is at-least-once, so the consumer must be idempotent by key and version id. EventBridge gives richer filtering and many rules per bucket; the classic notification configuration allows only one target per event type and prefix.

**Encryption and access.** Every object is encrypted at rest by default with SSE-S3; SSE-KMS adds per-key policies and CloudTrail audit of each decrypt at the cost of KMS requests (turn on **bucket keys** so a hot bucket does not throttle KMS). Block Public Access at the account level, then grant access through bucket policies and IAM roles; ACLs are disabled by default and should stay that way. Object Lock provides write-once-read-many for compliance. Cross-region replication copies new objects asynchronously (minutes typically, 15 minutes with Replication Time Control) for disaster recovery.

#### Practical example

Product images: the seller's browser asks the NestJS API for an upload ticket; the API creates a `files` row with status `pending`, returns a pre-signed `POST` for key `uploads/<sellerId>/<uuid>.jpg` limited to 8 MB and `image/jpeg`; the browser uploads; an S3 event invokes a Lambda that validates the image, produces three sizes into `images/...`, and publishes `image.ready`; a worker marks the row `ready`. A nightly job expires `pending` rows (and their orphan objects) older than 24 hours.

#### NestJS example

Issuing the pre-signed `POST` with size and type constraints.

```ts
// src/uploads/upload-ticket.service.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { randomUUID } from 'node:crypto';

@Injectable()
export class UploadTicketService {
  private readonly s3 = new S3Client({ region: process.env.AWS_REGION }); // task role credentials
  private readonly bucket = this.config.getOrThrow<string>('UPLOADS_BUCKET');

  constructor(private readonly config: ConfigService) {}

  async createImageTicket(sellerId: string) {
    const key = `uploads/${sellerId}/${randomUUID()}.jpg`;
    const { url, fields } = await createPresignedPost(this.s3, {
      Bucket: this.bucket,
      Key: key,
      Conditions: [
        ['content-length-range', 1, 8 * 1024 * 1024], // 1 byte to 8 MB, enforced by S3
        ['eq', '$Content-Type', 'image/jpeg'],
      ],
      Fields: { 'Content-Type': 'image/jpeg' },
      Expires: 300, // 5 minutes; well inside the task role credential lifetime
    });
    return { key, url, fields }; // the browser POSTs a multipart form with these fields plus the file
  }
}
```

#### PostgreSQL example

The `files` table that keeps S3 honest: the database is the source of truth about which objects exist and belong to whom; S3 holds the bytes.

```sql
CREATE TABLE files (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users(id),
  s3_key      text NOT NULL UNIQUE,
  status      text NOT NULL CHECK (status IN ('pending', 'ready', 'rejected')),
  size_bytes  bigint,
  sha256      bytea,
  created_at  timestamptz NOT NULL DEFAULT now(),
  ready_at    timestamptz
);

-- Cleanup job: pending tickets never completed. Partial index keeps it cheap
-- even when the table holds 50 million ready files.
CREATE INDEX files_pending_created_idx ON files (created_at) WHERE status = 'pending';

-- Nightly: select orphans, delete the S3 object (if any), then the row.
SELECT id, s3_key FROM files
WHERE status = 'pending' AND created_at < now() - interval '24 hours'
ORDER BY created_at
LIMIT 1000;
```

`EXPLAIN (ANALYZE, BUFFERS)` on that query with 50 million rows and a few thousand pending shows an `Index Scan using files_pending_created_idx` reading a handful of buffers in under a millisecond; without the partial index it is a full-table scan of several gigabytes.

#### Production scenario

The catalogue bucket holds 20 million images, about 4 TB. Storage in Standard costs about $92 a month; the request bill is negligible because CloudFront absorbs the reads; the lifecycle rule moves originals older than 90 days to Standard-IA (derived sizes stay hot), saving about $30 a month, and aborts incomplete multipart uploads after two days, which recovered 300 GB of invisible garbage the first time it ran. Versioning is on with non-current versions expiring after 30 days; that policy saved the catalogue once when a migration script overwrote 40,000 images with zero-byte files.

#### Failure scenario

Invoice download links began failing with `403 Forbidden` around 55 minutes after being emailed, although the API signed them with `expiresIn: 7 * 24 * 3600`. The API ran on ECS with a task role. Task role credentials are temporary and rotate roughly every hour; a pre-signed URL is only valid while the credentials that signed it are, and the SDK had silently signed with a session token that expired. Nobody had tested a link older than a few minutes. The fix: invoices moved behind CloudFront with signed URLs from a long-lived key pair, and the API's pre-signed S3 URLs were limited to 15 minutes by policy. Lesson: the expiry you type is an upper bound, not a promise.

#### Edge cases & failure modes

- **CloudFront serving a stale object** after overwrite; versioned keys or invalidation.
- **`503 SlowDown`** on a hot prefix during a bulk import; back off, spread prefixes.
- **Duplicate event notifications**; idempotent consumers keyed by `key + versionId + sequencer`.
- **Overwrite without versioning** is silent data loss.
- **Abandoned multipart uploads** accumulate cost; lifecycle abort rule.
- **`403` instead of `404`** for a missing object when the caller lacks `s3:ListBucket`; confusing but correct.
- **KMS throttling** on an SSE-KMS bucket at thousands of GETs per second; bucket keys.
- **Pre-signed URL signed with expiring credentials** as above.
- **Public bucket** through a bucket policy typo; account-level Block Public Access prevents it.
- **Cross-region replication lag** during a regional failover: the last minutes of uploads are missing in the secondary region.
- **Object key with unusual characters** (`+`, spaces, unicode) encoded differently by two SDKs, producing "not found" for an object that exists.

#### How a Senior Backend Engineer thinks about this

They never let the API proxy file bytes when a pre-signed URL can do it. They turn on versioning, Block Public Access, and an abort-multipart lifecycle rule before the first object lands. They treat the database as the index of what exists and S3 as dumb storage, so a lost row is an orphan object, not a lost file. They know the expiry rule for pre-signed URLs and the cache rule for CloudFront because they have been bitten by both.

#### Common mistakes

- Streaming uploads through the NestJS process, then wondering why 20 uploads saturate the task.
- Sequential or date-based prefixes for a write-hot workload.
- Assuming a `DELETE` frees storage when versioning is on.
- Long pre-signed expiries from a task role.
- Serving private files from public object URLs "because it is easier".

#### Interview questions

1. *Is S3 eventually consistent?* Expected: no, strongly consistent since 2020 for all operations; caches in front of it are not.
2. *Design an upload flow that never sends file bytes through your API.* Expected: pre-signed POST with conditions, database ticket, event-driven processing, cleanup of orphans.
3. *Why did a 7-day pre-signed URL expire in an hour?* Expected: temporary credentials from a role; use CloudFront signed URLs or short expiries.
4. *When would you use SSE-KMS over SSE-S3?* Expected: per-key access control, audit of decrypts, compliance; mind the request cost and bucket keys.
5. *How do you protect against an application bug that overwrites a million objects?* Expected: versioning with non-current expiry, least-privilege write roles, Object Lock for the truly critical.

#### Practical exercise

Implement the upload ticket flow end to end with a NestJS API, a bucket with versioning and Block Public Access, an S3 event to SQS, and a consumer that marks files ready. Acceptance criteria: an upload larger than 8 MB or of the wrong type is rejected by S3, not by your code; killing the consumer mid-batch produces no duplicate `ready` transitions; the cleanup job removes an orphan object from a pending ticket; overwriting an object and restoring the previous version is demonstrated with the CLI.

## 28.11 Identity and secrets: IAM, STS, Secrets Manager, Parameter Store and KMS

#### Concept

IAM decides which principal (a person, a role assumed by a workload) may call which API on which resource. STS hands out short-lived credentials so that workloads never hold permanent keys. Secrets Manager and Parameter Store hold configuration your code needs at runtime (database passwords, API keys, feature settings); KMS holds the encryption keys that protect them and everything else at rest.

#### Why does it exist?

An access key pasted into an environment variable is a permanent password to your cloud account, copied into CI logs, laptops and git history. A role is a costume a workload puts on: the credentials last an hour, are minted by AWS, and are tied to a policy that names exactly what the workload may do. Without least privilege, a bug in the image resizer can delete the orders bucket; with it, the resizer can only write to `images/`.

#### Mental model

Imagine a building where nobody owns a key. Each job (API server, worker, deploy pipeline) has a badge (role) that opens only the doors its policy lists, and the badge expires every hour and is reissued automatically by the front desk (STS). Secrets Manager is the safe where the database combination is kept, and the safe itself is locked by a key that lives in a vault nobody can enter (KMS).

#### How it works

**Principals and policies.** Users (for humans, ideally federated through an identity provider and SSO rather than IAM users at all), groups, and **roles** (for workloads and cross-account access). A **policy** is JSON: `Effect`, `Action`, `Resource`, optional `Condition`. Identity-based policies attach to principals; **resource-based policies** attach to buckets, queues, topics, secrets and KMS keys and can grant other accounts. Evaluation: everything is denied by default; an explicit `Deny` anywhere wins; an `Allow` in an identity or resource policy grants; **permission boundaries** and **service control policies** (in Organizations) cap what an allow can ever give. Changes propagate in seconds but not instantly.

**Roles for workloads.** EC2 uses an **instance profile** and fetches credentials from the instance metadata service (require IMDSv2, which defeats SSRF theft of credentials). ECS has the **task role** (your code) and the **execution role** (the agent). EKS uses **IRSA** or Pod Identity (section 28.2). Lambda has an **execution role**. In all cases the AWS SDK finds credentials through its default chain (environment, then the role endpoint) so your code never mentions them.

**STS.** `AssumeRole` returns temporary credentials (15 minutes to 12 hours) for a role, possibly in another account; `AssumeRoleWithWebIdentity` exchanges an OIDC token (from EKS, from GitHub Actions in Part 29 — CI/CD, from Cognito) for credentials; `GetCallerIdentity` is the first command you run when something says `AccessDenied` ("who am I right now?"). Role chaining (assuming a role from assumed-role credentials) is capped at one hour.

**Never long-lived keys in applications.** If you find `AWS_ACCESS_KEY_ID` in a task definition, treat it as an incident: rotate it, replace with a role. Detect the rest with the IAM credential report and IAM Access Analyzer (unused keys, public resources, cross-account grants).

**Secrets Manager.** Stores a secret string or binary, versioned with staging labels (`AWSCURRENT`, `AWSPREVIOUS`, `AWSPENDING`), encrypted with KMS, replicated to other regions if asked, and **rotated** on a schedule by a Lambda you own or an AWS-provided one for RDS. About $0.40 per secret per month and $0.05 per 10,000 API calls, so cache it in the process and refresh on failure rather than fetching per request. Two rotation strategies for databases: **single user** (change the password of the one user; anything holding the old password fails at the instant of rotation) and **alternating users** (two users, rotate the inactive one, swap labels; the old credentials keep working until the next rotation, which is what you want).

**Parameter Store** (in Systems Manager). Hierarchical parameters (`/prod/orders/db/host`), plain or `SecureString` via KMS, standard tier free up to 10,000 parameters of 4 KB, advanced tier for larger values and policies. No built-in rotation. Default throughput is 40 requests per second unless you enable the higher tier. Use it for configuration; use Secrets Manager for things that rotate.

**KMS.** Customer-managed keys cost $1 per month plus $0.03 per 10,000 requests; AWS-managed keys are free. Keys never leave KMS. Data is protected with **envelope encryption**: `GenerateDataKey` returns a plaintext data key and the same key encrypted under the KMS key; you encrypt the data with the plaintext key, throw it away, and store the encrypted data key next to the ciphertext; `Decrypt` on the encrypted data key gets it back. S3, RDS, EBS, Secrets Manager and SQS do this for you. **Key policies** are the root of access to a key (an IAM allow is not enough if the key policy does not permit the principal), which is a common source of `AccessDenied` on an SSE-KMS bucket. Request quotas are thousands per second per region; a hot S3 bucket without bucket keys can exhaust them. Automatic yearly rotation keeps old material to decrypt old data.

#### Practical example

The orders API task role policy: read one secret, consume one queue, publish to one topic, write to one S3 prefix. Everything else is denied by absence.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "ReadDbSecret", "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": "arn:aws:secretsmanager:ap-south-1:123456789012:secret:prod/orders/db-*" },
    { "Sid": "ConsumeFulfilmentQueue", "Effect": "Allow",
      "Action": ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"],
      "Resource": "arn:aws:sqs:ap-south-1:123456789012:prod-fulfilment" },
    { "Sid": "PublishOrderEvents", "Effect": "Allow",
      "Action": ["sns:Publish"],
      "Resource": "arn:aws:sns:ap-south-1:123456789012:prod-orders" },
    { "Sid": "WriteInvoices", "Effect": "Allow",
      "Action": ["s3:PutObject"],
      "Resource": "arn:aws:s3:::shop-documents/invoices/*" },
    { "Sid": "DecryptWithAppKey", "Effect": "Allow",
      "Action": ["kms:Decrypt", "kms:GenerateDataKey"],
      "Resource": "arn:aws:kms:ap-south-1:123456789012:key/2f1a...",
      "Condition": { "StringEquals": { "kms:ViaService": ["secretsmanager.ap-south-1.amazonaws.com", "s3.ap-south-1.amazonaws.com"] } } }
  ]
}
```

Note the S3 resource is the *object* ARN (`bucket/prefix/*`); a policy on `arn:aws:s3:::shop-documents` alone grants bucket-level actions like listing, and `PutObject` fails with `AccessDenied` at runtime. That single asterisk is the most common IAM bug in application roles.

#### NestJS example

Loading the database secret at bootstrap through `@nestjs/config`, caching it, and refreshing when PostgreSQL rejects the password, which is what happens the moment a single-user rotation runs.

```ts
// src/config/secrets.loader.ts
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({ region: process.env.AWS_REGION });

export interface DbSecret { username: string; password: string; host: string; port: number; dbname: string }

export async function loadDbSecret(secretId = process.env.DB_SECRET_ID!): Promise<DbSecret> {
  const out = await client.send(new GetSecretValueCommand({ SecretId: secretId })); // AWSCURRENT
  return JSON.parse(out.SecretString!) as DbSecret;
}

// Registered with ConfigModule.forRoot({ load: [dbConfig] }) so the value is
// resolved once at boot; nothing hits Secrets Manager per request.
export const dbConfig = async () => ({ db: await loadDbSecret() });
```

```ts
// src/database/database.module.ts (relevant part)
TypeOrmModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const db = config.getOrThrow<DbSecret>('db');
    return {
      type: 'postgres', host: db.host, port: db.port, database: db.dbname,
      username: db.username,
      // node-postgres accepts a function: it is called for every NEW connection,
      // so a rotated password is picked up without restarting the task.
      password: async () => (await loadDbSecret()).password,
      autoLoadEntities: true, synchronize: false,
      extra: { max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 3_000 },
    };
  },
}),
```

A password function on every new connection costs one Secrets Manager call per connection (a few per minute in steady state), which is cheap insurance against the failure story below. Cache it for 60 seconds if the fleet is large.

#### Production scenario

The platform has 24 secrets in Secrets Manager (databases, payment provider keys, JWT signing keys, CloudFront key pair), rotated quarterly except the RDS credentials, which rotate every 30 days with the alternating-users strategy. Total cost under $15 a month. Every workload has its own role; a quarterly Access Analyzer review flags unused permissions, and the last one removed `s3:*` from a worker that had been granted it during an incident two years earlier.

#### Failure scenario

At 03:00 the scheduled rotation of the orders database secret ran with the single-user strategy. The rotation Lambda changed the password in PostgreSQL and updated `AWSCURRENT`. The API tasks had received the password as an environment variable at start-up, eight days earlier. For one minute nothing happened: existing pooled connections kept working. Then idle connections recycled and new ones failed with `password authentication failed for user "orders_api"`. Readiness checks began failing; ECS replaced tasks; the replacements received the new secret and worked. Total: seven minutes of rising 5xx as tasks cycled, and a 03:07 page. The team switched to the alternating-users strategy (old credentials valid until the *next* rotation) and to the password function above, so a rotation is now invisible. Secrets injected as environment variables are a snapshot; rotation is a stream.

#### Edge cases & failure modes

- **`AccessDenied` at runtime** on an action that worked in staging: different role, missing `/*`, a KMS key policy, an SCP, or a resource policy in another account; `GetCallerIdentity` first, then the policy simulator.
- **Secret cached forever** in a module-level variable; rotation breaks the app hours later.
- **Rotation Lambda cannot reach the database** (no VPC config or security group); the secret is updated in one place and not the other.
- **Secrets Manager throttling** when 500 Lambdas cold-start at once; use the caching client library or provisioned concurrency.
- **Parameter Store 40 TPS default** exceeded by a fleet that reads per request.
- **STS credentials expiring mid-job** in a 9-hour batch; refresh through the SDK provider, not a one-time `AssumeRole`.
- **IMDSv1 enabled** and an SSRF in an image fetcher leaks the instance role.
- **Access key committed to git**: scanners find it in minutes; rotate first, ask questions later; rewriting history is in Part 30 — Git.
- **KMS key deleted** (7 to 30 day pending window): every object encrypted with it is unrecoverable once deletion completes.
- **Secrets in Terraform state or CloudFormation outputs** readable by anyone with state access.

#### How a Senior Backend Engineer thinks about this

They treat roles as the unit of identity and a long-lived key as a defect. They write the task role policy before the code and expand it only with a reviewed pull request. They design for rotation from the first day: fetch on connect, refresh on failure, alternating users. They put `kms:ViaService` and resource ARNs on everything, because "the API can read any secret in the account" is one SSRF away from a breach. They can explain to a product manager why the deploy pipeline uses OIDC instead of a shared key: "a leaked key is a permanent break-in; a role is a one-hour badge".

#### Common mistakes

- `"Action": "s3:*", "Resource": "*"` on an application role.
- Secrets as build-time environment variables baked into the image.
- One role shared by the API, the workers and the deploy pipeline.
- Single-user rotation with credentials injected at start-up.
- Reading Parameter Store on every request.

#### Interview questions

1. *Why is a role safer than an access key even if both have the same policy?* Expected: temporary, auto-rotated, no secret to leak, tied to a workload identity, revocable centrally.
2. *An app gets `AccessDenied` on `s3:PutObject` although the policy allows it on the bucket ARN. Why?* Expected: object actions need the `bucket/*` resource; also check the KMS key policy for SSE-KMS.
3. *Design database credential rotation that never breaks running services.* Expected: alternating users, fetch on connect, refresh on auth failure, or IAM database authentication.
4. *Explain envelope encryption in two sentences.* Expected: a data key encrypts the data, KMS encrypts the data key; you store the encrypted key with the data and ask KMS to unwrap it.
5. *What is a permission boundary and when do you use it?* Expected: a cap on the maximum permissions an identity policy can grant; delegating role creation to teams safely.

#### Practical exercise

Give a NestJS service a task role with the least-privilege policy above and run it against Secrets Manager with 30-day rotation enabled using the alternating-users strategy. Acceptance criteria: forcing a rotation from the console produces zero errors in a 50 RPS load test; removing `kms:Decrypt` from the policy produces a clear `AccessDenied` at boot that names the key; `aws sts get-caller-identity` from inside the task shows the task role, not the execution role; the IAM Access Analyzer report for the role shows no unused actions after a week.

## 28.12 Observability on AWS: CloudWatch, X-Ray and OpenTelemetry

#### Concept

CloudWatch is where AWS services put their metrics and where your logs land by default; it also runs alarms and dashboards. X-Ray is AWS's distributed tracing backend. OpenTelemetry (Part 25 — Observability: Logs, Metrics and Traces) is the vendor-neutral way to instrument your NestJS code and ship traces and metrics to X-Ray, CloudWatch, Prometheus or any vendor. This section is about what the AWS pieces cost, what they do well, and what they do badly.

#### Why does it exist?

Every AWS service emits metrics you did not have to write (ALB request counts and 5xx, RDS IOPS and connections, SQS oldest-message age, Lambda throttles). Your alarms on those metrics are the difference between a page at 02:14 and a customer complaint at 09:00. Logs and traces answer the follow-up: *which* request, *which* query, *which* dependency.

#### Mental model

Imagine a hospital ward. Metrics are the monitors at every bed: a number per second, cheap to keep, easy to alarm on. Logs are the nurses' notes: detailed, expensive to store, and you must know which patient to read about. Traces are one patient's complete chart across every department they visited. CloudWatch is the ward; OpenTelemetry is the standard chart format any hospital can read.

#### How it works

**Metrics.** Namespaced (`AWS/ApplicationELB`, `AWS/RDS`, your own) with dimensions (load balancer name, target group). Standard resolution is one minute (EC2 basic monitoring is five unless detailed monitoring is enabled); high-resolution custom metrics go down to one second. Custom metrics cost about $0.30 per metric per month, where a "metric" is every unique combination of name and dimension values, so `latency` with a `userId` dimension is a cardinality bomb. **Embedded Metric Format (EMF)** lets you write a JSON log line that CloudWatch turns into metrics asynchronously, with no `PutMetricData` calls and no rate limits in your request path. Percentiles (`p99`) are available on any metric where you sent raw values, not pre-aggregated ones.

**Logs.** Log groups (per service) contain streams (per task). Ingestion costs about $0.50 per GB, storage $0.03 per GB-month, and the default retention is **never expire**; set it (30 days for application logs, 1 year for audit) or the storage line grows forever. **Logs Insights** queries structured JSON logs with a SQL-like language at $0.005 per GB scanned, so scoping the time range matters. The Infrequent Access log class halves ingestion cost for logs you rarely query. Subscription filters stream logs to Kinesis, Lambda or OpenSearch.

**Alarms.** Static thresholds, anomaly-detection bands, and **composite alarms** that page only when several conditions hold ("5xx rate high AND healthy hosts below 3"), which cuts noise. The `TreatMissingData` setting matters for sparse metrics: an alarm on the DLQ depth must treat missing as `notBreaching`, and an alarm on "requests per second" must treat missing as `breaching` (no data means the service is gone). Alarm actions go to SNS, then to PagerDuty, Slack or an auto-scaling policy. About $0.10 per alarm per month.

**Container Insights.** Per-task and per-pod CPU, memory, network and restart metrics for ECS and EKS, plus performance logs. Useful, and billed as custom metrics, so a cluster with 500 containers can cost a few hundred dollars a month in Insights alone.

**X-Ray versus OpenTelemetry.** X-Ray stores traces (segments and subsegments), draws a service map, and samples by default at one request per second plus 5% of the rest, at about $5 per million traces recorded. The AWS SDK and Lambda integrate with it natively. OpenTelemetry is the instrumentation standard: the NestJS process runs the OTel SDK with auto-instrumentation for HTTP, `pg`, `ioredis` and the AWS SDK, exports OTLP to a collector (the AWS Distro for OpenTelemetry, ADOT, as a sidecar or daemon), and the collector exports to X-Ray, CloudWatch metrics, Amazon Managed Prometheus, or a vendor. Instrument with OpenTelemetry, choose X-Ray as *a* backend; never instrument with the X-Ray SDK directly in new code, because you would be re-instrumenting the day you change vendors.

#### Practical example

The orders API logs one JSON line per request (`requestId`, `traceId`, `route`, `status`, `durationMs`, `userId` hashed) at about 400 bytes; at 350 RPS average that is about 360 GB a month, roughly $180 in ingestion and $11 in storage with 30-day retention. Debug logging is off in production and can be enabled per request with a header for ten minutes. Metrics come from EMF lines (orders placed, payment failures by provider, checkout latency) and from ALB, RDS, SQS and ElastiCache namespaces. Four composite alarms page; twenty simple alarms only post to Slack.

#### NestJS example

Emitting a business metric through EMF from an interceptor, so the checkout latency percentile exists without any metrics API call in the request path.

```ts
// src/observability/checkout-metrics.interceptor.ts
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { createMetricsLogger, Unit } from 'aws-embedded-metrics';

@Injectable()
export class CheckoutMetricsInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const started = Date.now();
    const req = ctx.switchToHttp().getRequest<{ route?: { path: string } }>();
    return next.handle().pipe(
      tap({
        next: () => this.emit(req.route?.path ?? 'unknown', Date.now() - started, 'ok'),
        error: () => this.emit(req.route?.path ?? 'unknown', Date.now() - started, 'error'),
      }),
    );
  }

  private emit(route: string, ms: number, outcome: 'ok' | 'error'): void {
    const metrics = createMetricsLogger();          // one EMF JSON line to stdout per call
    metrics.setNamespace('Shop/Checkout');
    metrics.setDimensions({ Route: route, Outcome: outcome }); // low cardinality on purpose
    metrics.putMetric('Latency', ms, Unit.Milliseconds);
    metrics.putMetric('Count', 1, Unit.Count);
    metrics.flush().catch(() => undefined);         // never fail a request over telemetry
  }
}
```

And the Logs Insights query the on-call runs when the p99 alarm fires, against the structured request logs:

```text
fields @timestamp, requestId, route, status, durationMs, dbMs, redisMs
| filter route = "/v1/checkout" and durationMs > 2000
| sort durationMs desc
| limit 50
```

Followed by the aggregate that tells you whether the slowness is in the database or somewhere else:

```text
filter route = "/v1/checkout"
| stats pct(durationMs, 99) as p99, pct(dbMs, 99) as dbP99, count() as n by bin(1m)
```

#### Production scenario

The 02:14 page from section 28.1 was a composite alarm: `ALB 5xx rate > 2% for 3 minutes` AND `ElastiCache CurrConnections dropped to 0`. The on-call opened the dashboard where API latency, Redis connections, RDS CPU and the AZ health of ECS tasks sit on one screen, saw the Redis line flat, and did not need Logs Insights at all. That is the goal: the alarm names the cause, the dashboard confirms it, and the logs are for the 20% of incidents that are new.

#### Failure scenario

A developer set `LOG_LEVEL=debug` in the production task definition to chase a bug at 17:00 and forgot it. The debug logger printed every SQL statement with parameters and every Redis command. Ingestion went from 12 GB a day to 2.1 TB a day. The Cost Anomaly Detection alert arrived 30 hours later: the log bill for those hours was about $1,300, and the storage line would have kept growing because retention was set to never expire. Fixes: log retention set on every group by Terraform; a budget alarm at 20% above the monthly forecast; debug logging only via a per-request header with a ten-minute expiry stored in Redis; and a code review rule that a task definition change to `LOG_LEVEL` needs an expiry date in the description.

#### Edge cases & failure modes

- **Alarm stays OK on missing data** while the service is dead; set `TreatMissingData` deliberately per alarm.
- **Retention never set**; the storage bill compounds quietly.
- **Metric cardinality** from a per-user or per-order dimension; hundreds of thousands of metrics at $0.30 each.
- **Logs Insights over 90 days** scans terabytes and costs real money; scope the range.
- **Trace sampling hides the rare error**; sample 100% of errors with a tail-sampling collector, or at least of 5xx responses.
- **`PutMetricData` rate limits** hit by a fleet calling per request; use EMF.
- **Timestamps rejected** when a metric is more than two weeks in the past or two hours in the future; clock skew on a host makes its metrics vanish.
- **Log delivery lag** of a minute or two during regional trouble, exactly when you need it.
- **One-minute granularity** on ALB metrics smooths a ten-second outage into a small bump.
- **Container Insights cost** surprising a cluster with many small tasks.

#### How a Senior Backend Engineer thinks about this

They alarm on symptoms customers feel (error rate, latency, queue age) and put causes on the dashboard. They instrument with OpenTelemetry once and treat the backend as a replaceable choice. They review the observability bill with the same rigour as the RDS bill, because logs are the line item that grows without a decision. They make sure every alarm has a runbook link in its description, because an alarm without a next step is noise.

#### Common mistakes

- Logging full request and response bodies in production.
- No retention policy on log groups.
- Alarming on CPU for a Node service instead of latency and error rate.
- Instrumenting with the X-Ray SDK and having to redo it for a vendor.
- Dashboards with forty panels and no alarm.

#### Interview questions

1. *Which three alarms would you set first on a new NestJS service on ECS, and why?* Expected: ALB 5xx rate, p99 latency, healthy target count (plus DLQ depth for workers); symptoms, not causes.
2. *What is EMF and why use it over `PutMetricData`?* Expected: metrics from log lines, asynchronous, no API limits or latency in the request path.
3. *How does OpenTelemetry relate to X-Ray?* Expected: OTel instruments and exports; X-Ray is one backend via the ADOT collector.
4. *What does `TreatMissingData` control and give an example where the wrong setting hides an outage.* Expected: how absent data is evaluated; a request-count alarm treating missing as OK while the service is down.
5. *Your CloudWatch bill tripled this month. Where do you look?* Expected: log ingestion by group, custom metric count, Logs Insights scanned bytes, Container Insights.

#### Practical exercise

Instrument a NestJS service with OpenTelemetry auto-instrumentation and an ADOT sidecar on ECS exporting traces to X-Ray and metrics via EMF. Acceptance criteria: a trace of a checkout request shows the HTTP span, the PostgreSQL query spans and the Redis spans with realistic durations; a composite alarm pages only when error rate and latency both breach; every log group has a retention policy verified by a script; the monthly observability cost is estimated from actual ingestion after one day of load.
