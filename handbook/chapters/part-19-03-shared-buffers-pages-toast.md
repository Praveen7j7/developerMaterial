## 19.4 Shared buffers and on-disk storage

### 19.4.1 Shared buffers: PostgreSQL's own page cache

#### Concept

PostgreSQL never reads or writes a row directly from disk. Everything happens in units of **8 KB pages** (also called blocks). A page is loaded from the data file into **shared buffers**, a fixed-size array of 8 KB slots in shared memory, and every backend reads and modifies rows inside those slots. Modified pages are called **dirty** and are written back later by the background writer or the checkpointer, never by your `COMMIT`.

The setting `shared_buffers` decides how many slots exist. The default (128 MB) is tiny; production servers use roughly 25 percent of RAM.

#### Why does it exist?

Disk is slow and page-oriented. An NVMe random read costs about 100 microseconds, an EBS gp3 read 0.5 to 1 ms, while a page already in shared buffers costs well under a microsecond to pin. A cache that holds the hot working set (recent orders, the `inventory` table, the top of every B-tree) turns most queries into pure memory operations. Having PostgreSQL's own cache (rather than relying only on the OS page cache) lets it track which pages are dirty, pin pages that are in use, and control write ordering relative to the WAL, which the operating system cannot do for it.

#### Mental model

Imagine a librarian with a desk (shared buffers) and an archive room (disk). Every book requested is brought to the desk. The desk has a fixed number of slots; when it is full, the least-recently-used book goes back to the archive. If someone wrote notes in a book (dirty page), it must be copied back to the archive before the slot can be reused. The librarian also keeps a stack of the most-touched books close at hand: that is why the top pages of a B-tree index practically never leave memory.

#### How it works

1. A backend needs page 12,345 of `orders`. It hashes (relation, fork, block number) into the buffer mapping table in shared memory.
2. **Hit:** the page is present. The backend pins it (increments a pin count so nobody evicts it), bumps its usage count (0 to 5), reads the tuples, unpins. Cost: roughly 0.1 to 1 microsecond plus lock overhead.
3. **Miss:** the backend runs the **clock-sweep** algorithm: it walks a circular pointer over the buffer array, decrementing usage counts, until it finds a buffer with count 0 that is not pinned. If that buffer is dirty, the backend must write it out first (this shows up as `buffers_backend` in `pg_stat_bgwriter`, or in `pg_stat_io` on PG 16+). Then it issues a `read()` syscall for the 8 KB page. The OS may serve it from *its* page cache (5 to 20 microseconds) or from disk (100 microseconds to 1 ms).
4. The **background writer** runs ahead of the clock hand and writes dirty, low-usage buffers so that step 3 rarely has to write. `bgwriter_lru_maxpages` (100) and `bgwriter_delay` (200 ms) limit how much it does per round.
5. Large sequential scans (tables bigger than a quarter of shared buffers), bulk writes, and VACUUM use a small **ring buffer** (256 KB for scans, 16 MB for `COPY`) so that one reporting query does not evict your whole hot set.
6. **Double caching:** the OS page cache also holds file data. A page can sit in both. This is why `shared_buffers` above roughly 8 to 16 GB gives diminishing returns on most workloads: the OS cache already holds the rest, and huge shared buffers make checkpoints write more at once. The planner is told about the *combined* cache size through `effective_cache_size` (typically 50 to 75 percent of RAM); this only influences cost estimates, it allocates nothing.

```text
Backend wants a page
   |
   v
 buffer mapping table (hash) --hit--> pin, read, unpin   (~0.5 us)
   |
  miss
   |
   v
 clock sweep: find victim slot (evict, write if dirty)
   |
   v
 read() 8 KB from OS
   |--- OS page cache hit  (~10 us)
   '--- disk read         (NVMe ~100 us, EBS ~500-1000 us)
```

**Buffer hit ratio.** `pg_stat_database.blks_hit` counts shared-buffer hits, `blks_read` counts reads from the OS (which may still be OS-cache hits, not disk). A ratio below 99 percent on an OLTP database usually means the working set does not fit or a scan is churning the cache. Turning on `track_io_timing` makes `blk_read_time` show real time spent waiting for reads, which separates OS-cache reads from disk reads.

Realistic numbers: a 32 GB instance with `shared_buffers = 8GB` and a 40 GB database. The hot set (last 30 days of `orders`, all of `inventory`, all index upper levels) is about 6 GB; the hit ratio sits at 99.7 percent. A monthly report that scans all of `order_items` (25 GB) pushes hit ratio to 97 percent for ten minutes and p99 latency doubles, because even with the ring buffer it evicts OS-cache pages and causes real disk reads for everyone else.

#### Practical example

`GET /products/:id` reads one product row through the primary key index. Index root and internal pages: always in shared buffers. Leaf page: usually cached. Heap page: cached if that product was read recently. Cold product on a cold instance: 3 or 4 disk reads at 0.7 ms each on EBS gives a 3 ms request instead of 0.3 ms. After a restart or a failover, the whole cache is cold, and for the first minutes every request pays this. That is the "slow after failover" effect, and `pg_prewarm` exists to fix it.

#### NestJS example

A health endpoint that exposes buffer hit ratio and disk read time, which you can scrape with Prometheus. It uses the `@nestjs/terminus` health check style with a custom indicator.

```ts
// db-cache.health.ts
import { Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { DataSource } from 'typeorm';

@Injectable()
export class DbCacheHealthIndicator {
  constructor(
    private readonly dataSource: DataSource,
    private readonly health: HealthIndicatorService,
  ) {}

  async isHealthy(key = 'pg_cache') {
    const indicator = this.health.check(key);
    const [row] = await this.dataSource.query(`
      SELECT round(100.0 * blks_hit / greatest(blks_hit + blks_read, 1), 2) AS hit_ratio,
             blk_read_time                                                  AS read_ms
      FROM pg_stat_database
      WHERE datname = current_database()`);
    const hitRatio = Number(row.hit_ratio);
    // 99% is a reasonable floor for OLTP; below that, investigate scans or RAM
    return hitRatio >= 99
      ? indicator.up({ hitRatio, readMs: Number(row.read_ms) })
      : indicator.down({ hitRatio, readMs: Number(row.read_ms) });
  }
}
```

Health checks like this are for dashboards and alerts, not for Kubernetes readiness; a cold cache after failover should not take pods out of rotation.

#### PostgreSQL example

Inspect what is actually in the cache with `pg_buffercache`:

```sql
CREATE EXTENSION IF NOT EXISTS pg_buffercache;

SELECT c.relname,
       count(*)                                   AS buffers,
       pg_size_pretty(count(*) * 8192)            AS cached,
       round(100.0 * count(*) /
             (SELECT setting::int FROM pg_settings WHERE name = 'shared_buffers'), 1)
                                                  AS pct_of_cache,
       sum(CASE WHEN b.isdirty THEN 1 ELSE 0 END) AS dirty
FROM pg_buffercache b
JOIN pg_class c ON b.relfilenode = pg_relation_filenode(c.oid)
WHERE b.reldatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
GROUP BY c.relname
ORDER BY buffers DESC
LIMIT 8;
```

```text
 relname                  | buffers | cached  | pct_of_cache | dirty
--------------------------+---------+---------+--------------+-------
 orders                   |  412880 | 3226 MB |         39.4 | 18211
 idx_orders_user_created  |  201330 | 1573 MB |         19.2 |  4410
 order_items              |  188002 | 1469 MB |         17.9 |  9002
 inventory                |    7680 |   60 MB |          0.7 |  7620   <-- almost every page dirty
 idx_orders_pkey          |   98110 |  766 MB |          9.4 |  1201
```

`inventory` being almost entirely dirty tells you it is rewritten constantly (500 updates per second) and that every checkpoint rewrites all 60 MB of it.

Warm the cache after a restart or failover instead of letting users do it:

```sql
CREATE EXTENSION IF NOT EXISTS pg_prewarm;
SELECT pg_prewarm('inventory');                        -- whole table
SELECT pg_prewarm('idx_orders_user_created', 'buffer'); -- into shared buffers
```

With `shared_preload_libraries = 'pg_prewarm'` and `pg_prewarm.autoprewarm = on`, PostgreSQL records the buffer contents periodically and reloads them automatically on start.

#### TypeORM example

The cache is invisible to TypeORM, but your entity design decides how many pages a query touches. Selecting only needed columns keeps wide or TOASTed columns out of the read path:

```ts
// Avoid pulling the jsonb attributes column (possibly TOASTed) into a listing
const products = await productRepo.find({
  select: { id: true, sku: true, name: true, priceCents: true },
  where: { sku: In(skus) },
});
```

#### Sequelize example

```ts
const products = await Product.findAll({
  attributes: ['id', 'sku', 'name', 'priceCents'],
  where: { sku: { [Op.in]: skus } },
});
```

#### Production scenario

Sizing on a 64 GB RDS instance running a 300 GB database: `shared_buffers = 16GB`, `effective_cache_size = 48GB`. The daily working set is 30 GB, so it does not fit in shared buffers but does fit in shared buffers plus OS cache. Hit ratio is 98.5 percent, which is acceptable because `blk_read_time` shows that most "reads" are OS cache hits at 15 microseconds. The team's alert is not on hit ratio; it is on `blk_read_time` per second and on EBS read IOPS, which is what actually hurts latency.

Monitoring checklist: hit ratio per database, `pg_stat_io` (PG 16+) per backend type, `buffers_backend` (backends forced to write), EBS/NVMe read IOPS and latency, and `pg_buffercache` snapshots of the top relations.

#### Failure scenario

At 06:00 a nightly analytics job ran `SELECT ... FROM order_items JOIN orders ...` across two years of data on the primary. The ring buffer protected shared buffers, but the 30 GB scan flushed the OS page cache. For the next 20 minutes, every cold read of an `orders` page went to EBS at 0.8 ms, the API p99 rose from 90 ms to 700 ms, and the pool's `connectionTimeoutMillis` started firing because each request held its connection 8 times longer. The fix was to run analytics on a replica (see Part 23 — Database Scaling) and to warm the cache after the job.

#### Edge cases & failure modes

- Cold cache after restart, failover, or instance resize: minutes of elevated latency; use `pg_prewarm` and warm-up traffic before switching load balancers.
- A single `SELECT *` on a table wider than the cache thrashes the OS cache even though shared buffers are protected by the ring.
- Very large `shared_buffers` (over 50 percent of RAM) starves the OS cache and `work_mem`, and makes checkpoints heavier.
- Huge pages: on Linux, `huge_pages = try` reduces TLB pressure for big shared buffers; on containers it may silently fail to allocate.
- `pg_buffercache` scanning itself takes a lock on every buffer briefly; do not run it every second on a 64 GB cache.
- Checksums (`data_checksums`, enabled at `initdb`) detect corruption when a page is read into shared buffers; a checksum failure on a hot page turns into repeated errors until the page is repaired from a replica or backup.

#### How a Senior Backend Engineer thinks about this

They care less about the hit ratio number and more about *what* is in the cache and *why* it left. They keep analytics off the primary. They budget RAM as `shared_buffers + (max_connections × work_mem × expected sorts) + OS cache`. They warm caches before traffic shifts. They explain to a product manager: "After a database failover the first few minutes are slow because the new server has an empty memory cache; we pre-load it so customers do not notice."

#### Common mistakes

- Setting `shared_buffers` to 80 percent of RAM because "more cache is better".
- Alerting on hit ratio alone and missing that `blks_read` are OS cache hits.
- Running reports on the primary and blaming the API code for latency.
- Forgetting that `effective_cache_size` is a planner hint, not an allocation.

#### Interview questions

1. *What is the difference between `shared_buffers` and the OS page cache, and why does PostgreSQL keep both?* Expected: PostgreSQL needs dirty tracking, pinning and WAL ordering; the OS cache is a second layer it cannot control. Follow-up: what does `effective_cache_size` do?
2. *Why can a 97 percent buffer hit ratio be fine on one system and a disaster on another?* Expected: the misses may be OS-cache hits (cheap) or EBS reads (expensive); `track_io_timing` separates them.
3. *How does a large sequential scan avoid evicting the hot working set?* Expected: ring buffers.
4. *What happens to latency right after a failover and how do you mitigate it?*

#### Practical exercise

On a local instance, create `orders` with 20 million rows. Restart PostgreSQL, run a point lookup and record `EXPLAIN (ANALYZE, BUFFERS)` output (`shared read`). Run it again (`shared hit`). Then `pg_prewarm` the table and index and repeat after another restart. Acceptance criteria: you can show `read` turning into `hit`, explain the timing difference, and describe when `pg_prewarm` belongs in a failover runbook.

### 19.4.2 Heap pages, tuple layout, and TOAST

#### Concept

A table's rows live in a **heap**: a plain sequence of 8 KB pages with no ordering. Each row is stored as a **tuple**, which is a header (23 bytes) plus the column data. Inside a page, tuples are found through a small array of **line pointers** at the start of the page. A row's physical address, called the **ctid**, is `(page number, line pointer number)`; every index entry stores a ctid, which is how an index scan finds the heap row.

Values that do not fit comfortably in a page (a 50 KB `jsonb` document, a long `text` description) are compressed and, if still too big, sliced into chunks and stored in a side table. That mechanism is called **TOAST** (The Oversized-Attribute Storage Technique).

#### Why does it exist?

Fixed 8 KB pages make caching, WAL and I/O simple, but rows have variable sizes and can exceed a page. Line pointers let tuples move within a page (during defragmentation by VACUUM or HOT pruning) without changing their ctid, so indexes stay valid. TOAST exists so that a table with one occasionally-huge column does not force every row read to drag megabytes through the cache.

#### Mental model

Imagine a filing cabinet drawer (page). At the front is an index card listing where each document sits in the drawer (line pointers). Documents (tuples) are stacked from the back. If a document is too thick, you keep a sticky note in its place saying "see box 17 in the basement" (TOAST pointer), and the basement (toast table) holds the thick document cut into numbered chunks.

#### How it works

Page layout:

```text
+-----------------------------+ 0
| page header (24 bytes)      |  pd_lsn, pd_checksum, pd_lower, pd_upper, pd_special ...
+-----------------------------+
| line pointers (4 bytes each)|  lp1 -> offset 8100, lp2 -> offset 8040, lp3 (dead) ...
|  ...grows downward          |
+-----------------------------+ pd_lower
|                             |
|        free space           |
|                             |
+-----------------------------+ pd_upper
| tuple 3 | tuple 2 | tuple 1 |  tuples grow upward from the end
+-----------------------------+ 8192  (special space is empty for heap pages)
```

Tuple layout:

1. **Header, 23 bytes**: `t_xmin` (transaction that inserted it), `t_xmax` (transaction that deleted or updated it, 0 if none), `t_cid` (command id within the transaction), `t_ctid` (points to itself, or to the newer version after an update), `t_infomask` and `t_infomask2` (flag bits: has nulls, committed hints, HOT flags), `t_hoff` (offset to data).
2. **Null bitmap** (only if any column is null): one bit per column, rounded up to bytes.
3. **Padding** to an 8-byte boundary (`MAXALIGN`), so the header effectively costs 24 bytes.
4. **Column data** in declared column order, each aligned to its type's requirement: `int4` to 4 bytes, `int8`/`timestamptz`/`float8` to 8 bytes, `text`/`jsonb` are variable-length with a 1 or 4 byte length prefix.

So a row `(id bigint, quantity int, updated_at timestamptz)` costs 24 header + 8 + 4 + 4 padding + 8 = 48 bytes, plus a 4-byte line pointer: 52 bytes. Reordering columns so 8-byte types come first (`id, updated_at, quantity`) saves the 4 padding bytes. On a 500 million row table, that is 2 GB of heap and cache. The maximum number of tuples per 8 KB page is 291; a typical `orders` row of about 100 bytes gives roughly 70 rows per page.

TOAST, step by step:

1. When a tuple is about to exceed `TOAST_TUPLE_THRESHOLD` (about 2 KB), PostgreSQL looks at its variable-length columns, largest first.
2. Depending on the column's storage strategy (`EXTENDED` is the default for `text`, `jsonb`, `bytea`), it first tries to **compress** the value (`pglz` by default, `lz4` if `default_toast_compression = lz4` on PG 14+, which is 3 to 5 times faster to compress and decompress).
3. If the tuple still exceeds `toast_tuple_target` (2 KB by default, settable per table), the value is moved **out of line** into the table's toast relation `pg_toast.pg_toast_<oid>`, split into chunks of about 2,000 bytes, indexed by `(chunk_id, chunk_seq)`. The main tuple keeps an 18-byte pointer.
4. Reading the column later means an index lookup plus one heap fetch per chunk in the toast table, then decompression. A 200 KB jsonb value is about 100 chunks: 100 extra page reads.
5. Updating any other column copies the toast pointer, not the value; TOAST data is only rewritten when the toasted column itself changes.

Storage strategies you can set with `ALTER TABLE products ALTER COLUMN attributes SET STORAGE ...`:

| Strategy | Compress? | Out-of-line? | Use when |
|---|---|---|---|
| `PLAIN` | no | no | fixed-size types only |
| `MAIN` | yes | last resort | you want the value kept in the main tuple |
| `EXTENDED` | yes | yes | default; general purpose |
| `EXTERNAL` | no | yes | already-compressed data (images, gzip), or substring access on `text`/`bytea` |

#### Practical example

`products.attributes` holds a jsonb document per product: usually 1 to 3 KB, but for 5 percent of products (with rich specification sheets) 40 to 120 KB. Those 5 percent live in the toast table. `GET /products?category=...` listing 50 products with `SELECT *` fetches all toast chunks even though the listing renders only `name` and `price_cents`: 50 products × (about 2 to 60 chunk reads) instead of 50 heap reads. The fix is to select only the columns the endpoint needs, or move rarely-read attributes to a separate `product_details` table.

#### PostgreSQL example

Look inside a page with `pageinspect`, and measure toast:

```sql
CREATE EXTENSION IF NOT EXISTS pageinspect;

-- Tuples on the first page of orders: xmin/xmax are the MVCC columns (see 11.7)
SELECT lp, lp_flags, t_xmin, t_xmax, t_ctid, t_hoff
FROM heap_page_items(get_raw_page('orders', 0))
LIMIT 5;
```

```text
 lp | lp_flags |  t_xmin  |  t_xmax  | t_ctid | t_hoff
----+----------+----------+----------+--------+--------
  1 |        1 | 48812201 |        0 | (0,1)  |     24
  2 |        1 | 48812201 | 48819903 | (0,7)  |     24   <-- updated; new version at (0,7)
  3 |        3 |          |          |        |          <-- redirect (HOT chain)
  4 |        1 | 48812210 |        0 | (0,4)  |     24
```

```sql
-- How much of products actually lives in TOAST?
SELECT pg_size_pretty(pg_relation_size('products'))               AS heap,
       pg_size_pretty(pg_relation_size(reltoastrelid))             AS toast,
       pg_size_pretty(pg_indexes_size('products'))                 AS indexes
FROM pg_class WHERE relname = 'products';
```

```text
 heap    | toast   | indexes
---------+---------+---------
 610 MB  | 4.2 GB  | 280 MB
```

Switch to LZ4 for new values and reduce CPU spent decompressing:

```sql
ALTER TABLE products ALTER COLUMN attributes SET COMPRESSION lz4;   -- PG 14+
-- existing values keep pglz until rewritten; VACUUM FULL or pg_repack rewrites them
```

#### TypeORM example

Declare the column with the right PostgreSQL type; `simple-json` stores a string in `text`, which loses jsonb operators and indexing.

```ts
@Entity('products')
export class Product {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id!: string;

  @Column({ type: 'text' })
  sku!: string;

  @Column({ type: 'text' })
  name!: string;

  // jsonb: binary, indexable with GIN, TOASTed when large
  @Column({ type: 'jsonb', default: () => "'{}'" })
  attributes!: Record<string, unknown>;

  @Column({ name: 'price_cents', type: 'integer' })
  priceCents!: number;
}
```

#### Sequelize example

```ts
Product.init(
  {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    sku: { type: DataTypes.TEXT, allowNull: false },
    name: { type: DataTypes.TEXT, allowNull: false },
    attributes: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    priceCents: { type: DataTypes.INTEGER, allowNull: false, field: 'price_cents' },
  },
  { sequelize, tableName: 'products', underscored: true },
);
```

#### Production scenario

A catalogue of 2 million products: heap 610 MB, toast 4.2 GB, because a sync job rewrites `attributes` for every product every night even when nothing changed. Each rewrite creates a new toast tuple set (100 chunks for a big product) and leaves the old ones dead until autovacuum on the *toast table* cleans them. Toast tables have their own autovacuum statistics and are often forgotten. The sync job was changed to `UPDATE ... WHERE attributes IS DISTINCT FROM $2`, which reduced nightly toast churn by 96 percent and shrank the table by 3 GB after `pg_repack`.

#### Failure scenario

"Index row size 3168 exceeds btree version 4 maximum 2704 for index". A developer added a B-tree index on `products.attributes` (the whole jsonb) to "speed up searches". B-tree entries must fit in a third of a page; large TOASTed values cannot be indexed that way. The migration failed in production after succeeding on a dev database with small documents. The right tool is a GIN index on the jsonb or an expression index on the specific key (Part 20).

#### Edge cases & failure modes

- TOAST bloat when large values are rewritten frequently; monitor `pg_stat_all_tables` for `pg_toast.*` relations.
- `SELECT *` on wide tables through an ORM silently detoasts every row.
- Column order padding waste on very large tables.
- Values over roughly 2.7 KB cannot go in a B-tree index entry.
- `pglz` decompression CPU on hot paths; switch to `lz4`.
- `bytea` images in the database: the database becomes a slow, expensive blob store; use object storage and keep a key.
- Toast chunks are read with their own index; a bloated toast index makes reads of large values slower still.

#### How a Senior Backend Engineer thinks about this

They design tables so that hot, small columns stay in the main tuple and large, rarely-read blobs live elsewhere (a side table, or S3 with a key). They order columns to avoid padding on tables that will reach hundreds of millions of rows. They know a jsonb column of 100 KB is a toast table with its own vacuum needs and its own I/O cost, and they ask "how often is it read, how often is it rewritten?" before agreeing to it.

#### Common mistakes

- Storing large blobs or entire API responses in jsonb columns on hot tables.
- Rewriting unchanged jsonb values in sync jobs.
- Expecting a B-tree index on a jsonb column to work.
- Not vacuuming or monitoring toast tables.

#### Interview questions

1. *What is a ctid and why do indexes store it?* Expected: physical row address (page, line pointer); indexes point to heap tuples; VACUUM and HOT rely on line pointers so ctids stay stable within a page.
2. *When does a value get TOASTed and what does reading it cost?* Expected: tuple above about 2 KB triggers compression then out-of-line storage in 2 KB chunks; reading is an index lookup plus a heap read per chunk.
3. *Why does column order matter for storage?* Expected: alignment padding.
4. *Why did a B-tree index on a jsonb column fail in production but not in dev?*

#### Practical exercise

Create `products` with a jsonb column and insert 100,000 rows with 5 percent having 60 KB documents. Measure heap, toast and index sizes. Compare `EXPLAIN (ANALYZE, BUFFERS)` for `SELECT *` vs `SELECT id, name` for 50 rows. Then change the column to `lz4` compression, rewrite the values, and measure again. Acceptance criteria: you show buffer counts differing by an order of magnitude and explain where the extra reads come from.
