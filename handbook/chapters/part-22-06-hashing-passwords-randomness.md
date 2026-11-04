## 22.13 Hashing and HMAC

#### Concept

A **hash function** turns any input into a fixed-size fingerprint. SHA-256 turns a 2 GB file or a 3-byte string into 32 bytes. The same input always gives the same output; a one-bit change in the input gives a completely different output; and there is no practical way to go from the output back to the input, or to find two inputs with the same output. Hashes are for **integrity**: has this changed?

An **HMAC** (Hash-based Message Authentication Code) is a hash that also takes a secret key. Only someone who has the key can produce the correct HMAC for a message, and anyone with the key can verify it. HMACs are for **authenticity**: did this come from someone who has the key, and is it unchanged?

Neither of these is encryption. A hash does not hide anything; it just makes changes detectable.

#### Why does it exist?

Backends constantly need to know whether bytes are what they claim to be: is this uploaded file the one whose checksum we recorded, is this webhook from Stripe or from someone pretending to be Stripe, has this signed URL been edited to point at a different object, is this cache key unique for this query. Plain hashing answers "unchanged" when the reference hash is stored somewhere safe. HMAC answers "unchanged and from a key holder" when the message travels through untrusted hands.

#### Mental model

Imagine a wax seal on a letter. Anyone can see whether the seal is broken (integrity), which is a hash. Now imagine a seal pressed with a signet ring only the king owns. A broken seal shows tampering, and the pattern shows it was the king who sealed it (authenticity), which is an HMAC. Neither the seal nor the ring hides the letter's contents; for that you need an envelope no one can open, which is encryption (22.16).

#### How it works

1. `SHA-256(message)` produces 32 bytes. Use it for: content checksums (S3 ETags, deduplication), cache keys, fingerprinting high-entropy tokens before storing them (refresh tokens, API keys), and commit ids in Git. Do **not** use it for passwords (22.14): it is designed to be fast, and fast is exactly what password hashing must not be.
2. `HMAC-SHA256(key, message)` mixes a secret key into the hashing in a way that is secure against "length-extension" tricks that break naive `SHA256(key + message)`. Use it for: webhook signatures, signed URLs, signed cookies, `HS256` JWTs, tamper-evident audit chains, and deriving sub-keys.
3. **Compare in constant time.** A normal string comparison stops at the first differing byte, and the time difference (nanoseconds, but measurable over many requests) leaks how many leading bytes matched. `crypto.timingSafeEqual` compares every byte regardless. Every place you compare a secret-derived value uses it. No exceptions.
4. Node's `crypto` module has everything: `createHash('sha256')`, `createHmac('sha256', key)`, `timingSafeEqual`.

```ts
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

export const hmacHex = (key: Buffer, data: string | Buffer) => createHmac('sha256', key).update(data).digest('hex');

// Both inputs must be Buffers of equal length; otherwise timingSafeEqual throws.
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
```

#### Practical example

A file-upload service stores the SHA-256 of every uploaded file. When the same bytes are uploaded again by another user, the service links to the existing object instead of storing a second copy (deduplication), saving 30 percent of storage. Separately, a payment provider signs each webhook with HMAC-SHA256 over the timestamp and body using a shared secret; the NestJS receiver recomputes and compares in constant time before trusting a single byte of the payload (full implementation in 22.18).

#### NestJS example

A cache key built from a hash of a normalised query, so that huge filters do not produce huge Redis keys, and an HMAC-based signed cookie value.

```ts
// search-cache.service.ts
@Injectable()
export class SearchCacheService {
  constructor(private redis: RedisService) {}

  private keyFor(tenantId: string, filters: Record<string, unknown>): string {
    // Sort keys so {a,b} and {b,a} hash the same.
    const canonical = JSON.stringify(filters, Object.keys(filters).sort());
    return `search:${tenantId}:${sha256Hex(canonical).slice(0, 32)}`; // 128 bits is enough for a cache key
  }

  async getOrCompute<T>(tenantId: string, filters: Record<string, unknown>, compute: () => Promise<T>): Promise<T> {
    const key = this.keyFor(tenantId, filters);
    const hit = await this.redis.client.get(key);
    if (hit) return JSON.parse(hit) as T;
    const value = await compute();
    await this.redis.client.set(key, JSON.stringify(value), { EX: 60 });
    return value;
  }
}
```

#### PostgreSQL example

PostgreSQL can hash too (`pgcrypto`), which is useful for content-addressed storage and for indexing long values.

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE files (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sha256     bytea NOT NULL,                          -- content fingerprint
  size_bytes bigint NOT NULL,
  s3_key     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX files_sha256_idx ON files (sha256);   -- dedupe by content

-- Indexing a long URL by its hash keeps the index small:
CREATE INDEX pages_url_hash_idx ON pages (digest(url, 'sha256'));
-- and query with the same expression:
SELECT * FROM pages WHERE digest(url, 'sha256') = digest($1, 'sha256');
```

#### Production scenario

An image service computes SHA-256 on every upload (about 400 MB per second per core; a 5 MB image takes about 12 ms). Hashing runs in a stream while the bytes are written to S3, so it adds no extra pass over the data. Webhook HMAC verification is microseconds. Constant-time comparisons are so cheap that the only reason to ever skip them is not knowing they exist.

#### Failure scenario

A team verified webhook signatures with `signature === computed`. A researcher demonstrated, over about 200,000 requests against a staging endpoint, statistically recovering the first bytes of a valid signature from response timing. It never became a real exploit, but it turned into a finding on the pentest report and a two-day remediation across 14 endpoints, because the same helper had been copied everywhere. `timingSafeEqual` in one shared function would have cost nothing.

#### Edge cases & failure modes

- `timingSafeEqual` throws when lengths differ; check length first and return false.
- Hashing user input without normalisation (`NFC`, trimming, lower-casing where appropriate) produces mismatches, for example email hashes.
- `SHA256(secret + message)` instead of HMAC: vulnerable to length extension.
- MD5 and SHA-1 for anything security-related; both have practical collision attacks. SHA-1 in Git is a legacy exception, not a recommendation.
- Hashing high-entropy tokens with bcrypt: needless 50 ms per lookup; SHA-256 is correct there.
- Hashing low-entropy values (phone numbers, 6-digit codes) with a plain hash: an attacker enumerates the input space in seconds. Use HMAC with a secret key or a slow hash.
- Hex vs base64 mismatches between signer and verifier.

#### How a Senior Backend Engineer thinks about this

They keep a single small `crypto` utility module with `sha256`, `hmac`, and `safeEqual`, reviewed once, used everywhere. They know which side of the entropy line a value sits on (high entropy: hash it; low entropy: slow hash or keyed hash) and apply the matching tool. They would rather explain HMAC to a colleague for ten minutes than accept a bespoke "signature" scheme.

#### Common mistakes

- `===` on signatures.
- SHA-256 for passwords.
- Storing the HMAC key next to the data it protects.
- Believing a hash "encrypts" personal data. Hashed emails are still personal data if the input space is enumerable.

#### Interview questions

1. *Hash vs HMAC vs encryption: one sentence each.* Expected: integrity; authenticity with a key; confidentiality.
2. *Why is `SHA256(key + msg)` unsafe and HMAC safe?* Expected: length extension.
3. *Why does a timing attack matter for signature comparison when the difference is nanoseconds?* Expected: statistical recovery over many requests; the fix is free.
4. *When is SHA-256 the right choice for storing a secret?* Expected: high-entropy tokens and API keys.

#### Practical exercise

Create a `CryptoUtil` provider with `sha256`, `hmac`, and `safeEqual`. Refactor every signature and token comparison in an existing project to use it. Acceptance criteria: a grep for `=== ` on any variable named like `signature`, `token`, or `hash` returns nothing in request-handling code; unit tests show `safeEqual` returns false on length mismatch without throwing.

## 22.14 Password Hashing and Salting

#### Concept

Passwords are never stored. What is stored is the output of a deliberately slow, salted, one-way function, so that if the `users` table leaks, the attacker gets hashes that cost real money to reverse. The functions built for this are **argon2id** (the current recommendation), **bcrypt** (older, still fine, widely deployed), and **scrypt**. Plain SHA-256, even with a salt, is not one of them, because it runs at billions of guesses per second on a GPU.

A **salt** is a random value stored alongside the hash and mixed into it, so that two users with the same password get different hashes and an attacker cannot precompute a table of hashes for common passwords. bcrypt and argon2 generate and embed the salt automatically. A **pepper** is an additional secret kept outside the database (in the app's secrets manager) and mixed in as well, so that a database-only leak is not enough to even start cracking.

#### Why does it exist?

Databases leak: backups, SQL injection, a laptop, a misconfigured bucket. The password table is the crown jewel because people reuse passwords, so your leak becomes their bank's problem. Slow hashing converts "we leaked 10 million passwords" into "we leaked 10 million hashes that would cost the attacker years of GPU time to crack for the strong ones". Salting stops the attacker from cracking all users at once. Peppering makes a database-only leak nearly worthless.

#### Mental model

Imagine shredding a document and keeping the shreds (hash). Anyone can shred the same document and compare shreds to see if it is the same document, but nobody can rebuild it from shreds. Now imagine the shredder is deliberately slow (one page per second) so that trying a million candidate documents takes eleven days, and imagine each person's shredder cuts in a unique random pattern (salt), so shreds from one person's document tell you nothing about another's.

#### How it works

1. **Registration**: `hash = argon2.hash(password, { type: argon2id, memoryCost: 64 MiB, timeCost: 3, parallelism: 1 })`. The output string encodes algorithm, parameters, salt and hash: `$argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>`. Store the whole string.
2. **Login**: `argon2.verify(storedHash, candidate)`. The library reads the parameters and salt from the stored string, recomputes, and compares in constant time.
3. **Cost factors**: tune so that one hash takes about 50 to 100 ms on your production CPU. For bcrypt that is a cost of 11 to 12 today (each increment doubles the time). For argon2id, memory of 64 MiB with 3 iterations is a reasonable start. Re-measure yearly; hardware gets faster.
4. **Upgrade on login**: when you raise the cost or switch from bcrypt to argon2id, you cannot rehash existing rows because you do not have the passwords. Instead, at successful login you have the plaintext for a moment: verify against the old hash, then rehash with the new parameters and update the row. Over months the table migrates itself; force a reset for accounts that never log in.
5. **Pepper**: `argon2.hash(password, { secret: pepperBuffer })` (argon2 supports a key parameter natively); for bcrypt, `bcrypt.hash(hmac(pepper, password))`. Keep the pepper in the secrets manager, versioned, so it can be rotated by re-peppering on login.
6. **Timing on login**: a login for a non-existent email must take as long as one for a real email, or an attacker can enumerate users by response time. Always run a hash verify, against a dummy hash when the user does not exist.
7. **Event loop**: bcrypt's async API and argon2 both run hashing on libuv's thread pool (4 threads by default), so the event loop stays free, but the pool is shared with file system and DNS work. At 40 logins per second with 80 ms hashes you need 3.2 threads continuously; set `UV_THREADPOOL_SIZE` higher (8 to 16) on auth nodes, or move auth to its own deployment so a login surge cannot starve other I/O. Never use `bcrypt.hashSync` in a request handler; it blocks the entire process.

#### Practical example

A marketplace migrates from bcrypt cost 10 (about 60 ms in 2019, about 25 ms on current hardware) to argon2id. New registrations use argon2id. Logins against bcrypt rows verify with bcrypt, then rehash with argon2id in the same request. After 90 days, 82 percent of active users are migrated; the rest are dormant and get a forced reset email when they return. Login p95 rises from 30 ms to 95 ms, accepted as the price of a real password hash.

#### NestJS example

```ts
// users.service.ts (credential handling)
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as argon2 from 'argon2';
import * as bcrypt from 'bcrypt';
import { User } from './user.entity';

@Injectable()
export class UsersService {
  private readonly pepper: Buffer;
  private readonly argonOpts: argon2.Options & { raw?: false };
  // A real argon2 hash of a random string, used to equalise timing when the user does not exist.
  private readonly dummyHash = '$argon2id$v=19$m=65536,t=3,p=1$c29tZXNhbHQ$Zy7WkQ2a0f3o1z5B7Y9qX9F1o6tE3v0mQ4wKp8rN2hM';

  constructor(cfg: ConfigService, @InjectRepository(User) private repo: Repository<User>) {
    this.pepper = Buffer.from(cfg.getOrThrow<string>('PASSWORD_PEPPER'), 'base64');
    this.argonOpts = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1, secret: this.pepper };
  }

  async hashPassword(plain: string): Promise<string> {
    return argon2.hash(plain, this.argonOpts);   // runs on the libuv thread pool, ~70 ms
  }

  async verifyCredentials(email: string, plain: string): Promise<User | null> {
    const user = await this.repo.findOne({ where: { email }, relations: { roles: true } });
    const stored = user?.passwordHash ?? this.dummyHash;

    let ok = false;
    if (stored.startsWith('$argon2')) {
      ok = await argon2.verify(stored, plain, { secret: this.pepper });
    } else if (stored.startsWith('$2')) {
      ok = await bcrypt.compare(plain, stored);   // legacy rows; no pepper on the old scheme
    }
    if (!user || !ok || user.status !== 'active') return null;

    // Upgrade-on-login: migrate legacy hashes and outdated cost parameters.
    if (!stored.startsWith('$argon2') || argon2.needsRehash(stored, this.argonOpts)) {
      await this.repo.update(user.id, { passwordHash: await this.hashPassword(plain) });
    }
    return user;
  }
}
```

The DTO enforces length limits. A 1 MB password is a cheap denial of service against a memory-hard hash; argon2 and bcrypt inputs should be capped (bcrypt also silently truncates at 72 bytes).

```ts
// register.dto.ts
import { IsEmail, IsString, Length } from 'class-validator';
export class RegisterDto {
  @IsEmail() email: string;
  @IsString() @Length(12, 128) password: string;   // NIST: length over complexity rules; check against breach lists separately
}
```

#### PostgreSQL example

```sql
-- password_hash holds the full encoded string: algorithm, params, salt, hash.
ALTER TABLE users ADD COLUMN password_hash text NOT NULL;
ALTER TABLE users ADD COLUMN password_changed_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE users ADD COLUMN tokens_invalid_before timestamptz NOT NULL DEFAULT 'epoch';

-- Find rows still on the legacy scheme (for migration progress dashboards):
SELECT count(*) FILTER (WHERE password_hash LIKE '$2%')      AS bcrypt_rows,
       count(*) FILTER (WHERE password_hash LIKE '$argon2%') AS argon2_rows
FROM users;

-- Never do this: it means someone is trying to compute hashes in SQL.
-- SELECT * FROM users WHERE password_hash = md5($1);
```

The application role should have `UPDATE (password_hash)` but a separate reporting role should have no `SELECT` on `password_hash` at all; column-level grants make that possible: `GRANT SELECT (id, email, created_at) ON users TO app_reporting;`.

#### Production scenario

An auth service handling 60 logins per second at peak with argon2id at 64 MiB and 70 ms. CPU: 60 times 0.07 equals 4.2 cores busy just hashing, spread across 6 pods with `UV_THREADPOOL_SIZE=8`. Memory: each in-flight hash needs 64 MiB, so 10 concurrent hashes per pod means 640 MiB of headroom; the pod memory limit is set accordingly to avoid OOMKilled under a login surge. A credential-stuffing attack raising logins to 600 per second would need 42 cores; that is why login has rate limiting and a captcha threshold (22.31), not a bigger cluster.

#### Failure scenario

At 19:20 the whole API went slow, p99 from 120 ms to 9 seconds. Login volume had tripled because of a marketing email. bcrypt at cost 12 (about 250 ms on the older instance type) saturated the default 4-thread libuv pool in every pod; DNS lookups and file reads queued behind hashes, so every outbound HTTP call to the payment provider (which needed DNS) stalled. Nobody had connected "login is slow" to "checkout is failing". Fixes: `UV_THREADPOOL_SIZE=16`, cost tuned to 80 ms on the current CPU, and auth moved to its own deployment so a login surge cannot starve checkout.

#### Edge cases & failure modes

- Unbounded password length: DoS against memory-hard hashing.
- Unicode normalisation: `é` as one code point vs two; normalise to NFC before hashing or users get locked out from another keyboard.
- bcrypt 72-byte truncation: `password123...` beyond 72 bytes is ignored; also a null byte truncates in some implementations.
- Timing enumeration when the user does not exist; always verify against a dummy hash.
- Thread pool starvation and OOM under login surges.
- Pepper rotation: keep the old pepper available and re-pepper on login; store a pepper version per row or encode it in the hash prefix.
- Cost never revisited; a 2016 bcrypt cost of 10 is now cheap.
- Breach-list checking (Have I Been Pwned k-anonymity API) missing, so `Password123!` passes complexity rules.
- Hashing synchronously in a request handler.

#### How a Senior Backend Engineer thinks about this

They pick argon2id, tune to about 70 ms on production hardware, add a pepper from the secrets manager, and write upgrade-on-login from day one because the parameters *will* change. They size thread pools and memory for the login peak, not the average, and they isolate auth compute from the rest of the API. They treat the password table as the most sensitive data in the company and restrict even read access to it.

#### Common mistakes

- SHA-256 with a salt, or worse, MD5.
- `bcrypt.hashSync` in a controller.
- One global cost setting never revisited.
- No dummy verify for unknown users.
- Logging the request body on `/auth/login` (the password is in it).
- Password complexity rules instead of length and breach checks.

#### Interview questions

1. *Why not SHA-256 with a salt for passwords?* Expected: designed to be fast; GPUs do billions per second; need memory-hard slow hashes.
2. *bcrypt vs argon2id: differences and when you would still choose bcrypt.* Expected: argon2id is memory-hard and tunable; bcrypt is ubiquitous, 72-byte limit; choose bcrypt only for ecosystem constraints.
3. *How do you migrate password hashes without the plaintext?* Expected: upgrade on login; forced reset for dormant accounts.
4. *What is a pepper and how do you rotate it?*
5. *How does password hashing affect the Node event loop and what do you tune?* Expected: libuv thread pool, `UV_THREADPOOL_SIZE`, isolation of auth.
6. *How do you prevent user enumeration through login timing?*

#### Practical exercise

Implement `UsersService.verifyCredentials` with argon2id, a pepper from config, a dummy hash for unknown users, and upgrade-on-login from bcrypt. Acceptance criteria: a test seeds a bcrypt user, logs in, and asserts the row now holds an argon2id hash; login timing for an unknown email is within 10 percent of a known email over 50 samples; a 10 KB password is rejected by the DTO before hashing; `UV_THREADPOOL_SIZE` is documented in the deployment manifest.

## 22.15 Randomness

#### Concept

Security depends on values an attacker cannot predict: session ids, refresh tokens, password reset tokens, CSRF tokens, encryption keys, IVs, TOTP secrets, PKCE verifiers. Those values must come from a **cryptographically secure pseudo-random number generator** (CSPRNG). In Node that is `crypto.randomBytes`, `crypto.randomUUID`, `crypto.randomInt`, and `crypto.getRandomValues`. `Math.random()` is not one of them, and using it for anything security-related is a bug, not a style preference.

#### Why does it exist?

`Math.random()` in V8 uses xorshift128+, a fast generator designed for games and simulations. Its internal state is 128 bits and can be recovered from a handful of consecutive outputs; from there every past and future value is predictable. A password reset token built from `Math.random()` can be predicted by an attacker who requests a few resets for themselves first. The CSPRNG draws from operating-system entropy (`/dev/urandom`, `getrandom`) and is designed so that observed outputs reveal nothing about future ones.

#### Mental model

Imagine a lottery machine. `Math.random()` is a machine with a visible gear train: watch it spin a few times and you can compute the next ball. The CSPRNG is a machine sealed in a box, stirred by radio noise, cosmic rays and keyboard timings; no amount of watching past draws helps.

#### How it works

1. `randomBytes(n)` returns `n` bytes from the OS CSPRNG. Encode as `base64url` for tokens (43 characters for 32 bytes) or `hex` (64 characters). 32 bytes (256 bits) is the standard token size; 16 bytes (128 bits) is acceptable for short-lived values like CSRF tokens.
2. `randomUUID()` returns a UUIDv4 with 122 random bits, fine for identifiers and for `jti` claims; it is slightly slower than `randomBytes` because of formatting.
3. `randomInt(min, max)` returns an unbiased integer in the range. Do not do `Math.floor(Math.random() * n)`, and do not do `randomBytes(1)[0] % n` either, because modulo introduces bias when `n` does not divide 256.
4. Performance: `randomBytes` costs a few microseconds; there is no reason to cache or reuse random values. The old advice about "entropy running out" does not apply to modern kernels.
5. Uniqueness is not the same as unpredictability: a database sequence is unique and completely predictable. Never use sequences, timestamps, or user ids as tokens.

#### NestJS example

A token helper used by password reset, email verification, invitations and refresh tokens.

```ts
// tokens.util.ts
import { randomBytes, randomInt, randomUUID, createHash } from 'node:crypto';

export function newOpaqueToken(bytes = 32): { raw: string; hash: string } {
  const raw = randomBytes(bytes).toString('base64url');            // sent to the user once
  const hash = createHash('sha256').update(raw).digest('hex');      // stored; raw never hits the DB
  return { raw, hash };
}

export function newNumericCode(digits = 6): string {
  // Unbiased integer in [0, 10^digits); randomInt handles the bias correction.
  return String(randomInt(0, 10 ** digits)).padStart(digits, '0');
}

export const newJti = () => randomUUID();
```

```ts
// password-reset.service.ts (excerpt)
async requestReset(email: string): Promise<void> {
  const user = await this.users.findByEmail(email);
  // Always respond identically to avoid enumeration; only do work if the user exists.
  if (!user) return;
  const { raw, hash } = newOpaqueToken();
  await this.resets.save({ userId: user.id, tokenHash: hash, expiresAt: new Date(Date.now() + 15 * 60_000) });
  await this.mailer.sendPasswordReset(user.email, `https://app.example.com/reset?token=${raw}`);
}
```

#### PostgreSQL example

PostgreSQL's `gen_random_uuid()` and `gen_random_bytes(n)` (from `pgcrypto`) use a CSPRNG. `random()` does not.

```sql
-- Good: gen_random_uuid() is cryptographically random (core since PG13).
CREATE TABLE password_resets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE INDEX password_resets_user_idx ON password_resets (user_id) WHERE used_at IS NULL;

-- Bad: random() is a Mersenne-Twister-style generator, predictable, never for tokens.
-- SELECT encode(sha256(random()::text::bytea), 'hex');
```

#### Production scenario

A notification platform issues about 2,000 unsubscribe and magic-link tokens per second. `randomBytes(32)` at a few microseconds each is invisible in the profile. The tokens are stored hashed and expire in 15 minutes; expired rows are purged nightly. The only randomness-related alert is on the container's `/dev/urandom` availability at startup, which once failed in a stripped-down image and blocked token generation entirely, which is the correct failure mode: no randomness means no tokens, never weak tokens.

#### Failure scenario

An older codebase generated 8-character alphanumeric invitation codes with `Math.random()`. A researcher requested 20 invitations, reconstructed the generator state, and predicted the next codes, gaining access to a private beta. The fix was `randomBytes`, longer codes, and hashing the code at rest. The interesting part of the postmortem: the code had passed two reviews because it "looked random".

#### Edge cases & failure modes

- `Math.random()` anywhere near a token, id, key, IV, salt or nonce.
- Modulo bias when mapping random bytes to a range.
- Reusing an IV or nonce with the same AES-GCM key (22.16): catastrophic, and it usually comes from a "random" IV that was not.
- Seeding a PRNG with time in tests and accidentally shipping it.
- Short tokens (6 hex characters) that are brute-forceable regardless of the generator; entropy needs both a good source and enough bits.
- Treating UUIDv1 (time and MAC based) or UUIDv7 (time-prefixed) as secrets; they are identifiers with predictable structure.

#### How a Senior Backend Engineer thinks about this

They have one `tokens.util.ts`, they lint for `Math.random` in server code, and they think in bits: 128 for short-lived, 256 for anything long-lived. They store hashes of tokens and design so that the failure mode of the random source is "stop", not "degrade".

#### Common mistakes

- `Math.random().toString(36).slice(2)` for tokens.
- Sequential ids as "codes".
- Storing raw tokens.
- Six-character codes without rate limiting.

#### Interview questions

1. *Why is `Math.random` unsafe for tokens?* Expected: small recoverable state; predictable outputs.
2. *How many bits should a reset token have and how do you encode it?* Expected: 128 to 256; base64url; hash at rest.
3. *What is modulo bias and how does `randomInt` avoid it?*
4. *Why does a UUIDv7 make a bad secret but a good primary key?*

#### Practical exercise

Add an ESLint rule (`no-restricted-properties` on `Math.random`) to a NestJS project and fix every hit. Replace any custom code generator with the `tokens.util.ts` above. Acceptance criteria: CI fails on `Math.random` in `src/`; all token columns store hashes; a statistical test over 100,000 `newNumericCode()` outputs shows a uniform distribution of leading digits.
