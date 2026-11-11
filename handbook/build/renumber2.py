#!/usr/bin/env python3
"""Renumber Parts to make room for new Parts (2026-11-11 mapping; see OLD2NEW below).

Usage: python3 build/renumber.py <chapters_dir> [--apply] [--report out.tsv]
Without --apply it only reports what it would change.

What it rewrites:
  - file names        part-OLD-SS-slug.md -> part-NEW-SS-slug.md
  - headings          # Part OLD, ## OLD.M, ### OLD.M.K, closing sections
  - "Part N" / "Parts A, B and C" / "Parts A–B" references (ranges are expanded,
    then compressed again in the new numbering)
  - bare section references "OLD.M" / "OLD.M.K" in prose, only when OLD.M is a
    real section heading and the number is not a version, a measurement or code.
"""
import os, re, sys, json

# 2026-11-11: insert five new Parts in reading order.
# New Parts (written after this run): 0 (How to Understand Any Technology), 7 (Your First Frontend),
# 53 (AI-Assisted Engineering), 80 (Frontend and Full-Stack Interviews), 89 (Staff and Principal Interviews).
# Existing parts shift: 1-6 same, 7-51 +1, 52-77 +2, 78-85 +3.
OLD2NEW = {}
for p in range(1, 86):
    OLD2NEW[p] = p if p <= 6 else p + 1 if p <= 51 else p + 2 if p <= 77 else p + 3
assert len(OLD2NEW) == 85 and len(set(OLD2NEW.values())) == 85
assert not ({0, 7, 53, 80, 89} & set(OLD2NEW.values()))

DASH = r"(?:–|-|—|to)"

def compress(nums):
    nums = sorted(set(nums)); out = []; i = 0
    while i < len(nums):
        j = i
        while j + 1 < len(nums) and nums[j + 1] == nums[j] + 1: j += 1
        out.append(str(nums[i]) if i == j else (f"{nums[i]}–{nums[j]}" if j > i + 1 else f"{nums[i]}, {nums[j]}"))
        i = j + 1
    return out

def join_list(items):
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]

# "Parts 59–66", "Parts 1, 2 and 5", "Parts 40, 41, 65 and 66", "Part 22"
PARTS_RE = re.compile(r"\b(Parts?|parts?)(\s+)((?:\d{1,2}(?!\d)(?:\s*" + DASH + r"\s*\d{1,2}(?!\d))?)(?:(?:\s*,\s*|\s+and\s+|\s*&\s*)\d{1,2}(?!\d)(?:\s*" + DASH + r"\s*\d{1,2}(?!\d))?)*)(?![\d.]\d)")

def map_parts(m):
    word, sp, body = m.group(1), m.group(2), m.group(3)
    nums = []
    for a, b in re.findall(r"(\d{1,2})(?:\s*" + DASH + r"\s*(\d{1,2}))?", body):
        a = int(a)
        if b:
            b = int(b)
            if not (1 <= a <= 85 and 1 <= b <= 85 and a < b): return m.group(0)
            nums += list(range(a, b + 1))
        else:
            if not 1 <= a <= 85: return m.group(0)
            nums.append(a)
    new = [OLD2NEW[n] for n in nums]
    items = compress(new)
    if len(nums) == 1:
        return f"{word}{sp}{new[0]}"
    plural = word if word.endswith("s") else word + "s"
    return f"{plural}{sp}{join_list(items)}"

UNIT = r"(?:\s?(?:ms|s\b|%|x\b|×|k\b|K\b|M\b|B\b|GB|MB|KB|TB|GiB|MiB|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|req|rps|RPS|qps|QPS|times|stars|percent|μs|us\b|ns\b|cores?|vCPU|CPU|USD|cents?|tokens?|words?|lines?|rows?|points?|GHz|Mbps|Gbps|kbps|°|/\d))"
VERSIONY = re.compile(r"(?:\b(?:v|V|version|versions|Version|release|Release|since|until|ES|ECMAScript|HTTP/|TLS|SSL|IPv|Node|Node\.js|node|React|Next\.js|Next|Vite|TypeScript|TS|Redis|PostgreSQL|Postgres|PG|MySQL|Kafka|NestJS|Nest|Python|Java|Go|Kubernetes|k8s|Terraform|OpenTofu|pnpm|npm|yarn|ESLint|Prettier|Turborepo|Nx|Tailwind|Jest|Vitest|Playwright|MSW|Prisma|TypeORM|Sequelize|Docker|Compose|OpenAPI|Swagger|OAuth|OIDC|Unicode|Chrome|Safari|Firefox|iOS|Android|Ubuntu|Debian|Alpine|macOS|Windows|Git|git|webpack|Webpack|Babel|esbuild|Rolldown|Turbopack|Rspack|Zod|zod|TanStack|Query|Zustand|Redux|RTK|Lighthouse|Sentry|Argo|ArgoCD|Helm|Flux|dbt|Flink|Spark|Debezium|MongoDB|Mongo|Mongoose|DynamoDB|Cassandra|TimescaleDB|Timescale|pgvector|Elasticsearch|OpenSearch|BullMQ|Bull|RabbitMQ|AMQP|MQTT|RFC|ISO|WCAG|CVSS|SemVer|semver|Claude|GPT|Opus|Sonnet|Haiku|Fable|Gemini|Llama|Mistral|Express|Fastify|Bun|Deno|Angular|Vue|Svelte|Remix|Astro|Nuxt|Apollo|urql|Pact|Storybook|Cypress|Puppeteer|Selenium|axe|axe-core|Lambda|Aurora|Graviton|Ruby|Rails|PHP|Rust|Spring|Linux|kernel|Bash|bash|zsh|OpenSSL|curl|Nginx|nginx|Envoy|Istio|Grafana|Prometheus|OpenTelemetry|OTel|Datadog|Jaeger|Loki|Tempo|Vault|Consul|etcd|Kafka\s+Connect|Connect|Snowflake|BigQuery|Redshift|Iceberg|Parquet|Avro|Protobuf|proto|gRPC|GraphQL|HTTP|SQL|JSON|YAML|CSS|HTML|DOM|ECMA|Electron|Expo|Flutter|Kotlin|Swift|Scala|Elixir|Erlang|Haskell|Clojure|Perl|Lua|Julia|R|MATLAB|NumPy|pandas|scikit|PyTorch|TensorFlow|ONNX|CUDA|LTS|Iris)\s*v?\s*)$")

CUR = {"part": 0}

def is_code_line_ctx(line):
    return False

def process(text, part_old, sections, stats):
    CUR["part"] = part_old
    lines = text.split("\n"); out = []; in_fence = False
    for line in lines:
        if re.match(r"^\s*```", line):
            in_fence = not in_fence; out.append(line); continue
        # 1) headings (structural, by file's own part)
        m = re.match(r"^(#{1,5})\s+(.*)$", line) if not in_fence else None
        if m:
            hashes, rest = m.group(1), m.group(2)
            mm = re.match(r"^(\d{1,2})\.(\d+(?:\.\d+)*)\b(.*)$", rest)
            if mm and int(mm.group(1)) == part_old and len(hashes) >= 2:
                line = f"{hashes} {OLD2NEW[part_old]}.{mm.group(2)}{mm.group(3)}"
                stats["heading"] += 1
                # fall through so "see Part N" inside heading text is also mapped
        # 2) Part / Parts references (everywhere, including fences)
        line, n = PARTS_RE.subn(map_parts, line)
        stats["part_ref"] += n
        if in_fence:
            out.append(line); continue
        # 3) bare section references in prose, skipping inline code
        segs = re.split(r"(`[^`]*`)", line)
        for i, seg in enumerate(segs):
            if i % 2 == 1: continue
            segs[i] = map_sections(seg, sections, stats)
        out.append("".join(segs))
    return "\n".join(out)

SEC_RE = re.compile(r"(?<![\w.$/#@:\-+=])(\d{1,2})\.(\d{1,2})((?:\.\d{1,2})?)(?![\d]|\.\d|" + UNIT + r")")

def map_sections(seg, sections, stats):
    if re.match(r"^(#{1,5})\s+\d", seg):  # heading prefix already mapped
        head = re.match(r"^(#{1,5}\s+\d+(?:\.\d+)*)", seg).group(1)
        return head + map_sections(seg[len(head):], sections, stats)
    def rep(m):
        a, b, c = int(m.group(1)), int(m.group(2)), m.group(3)
        if (a, b) not in sections:
            return m.group(0)
        before = seg[max(0, m.start() - 40):m.start()]
        if VERSIONY.search(before):
            stats["skip_version"] += 1; stats["skips"].append(before[-25:] + "[" + m.group(0) + "]"); return m.group(0)
        after = seg[m.end():m.end() + 30]
        # numeric context: money, ratios, approximations, magnitudes, numeric ranges
        if (re.search(r"[$€£₹~≈]\s*$|[\d]\s*[x×*/]\s*$|\b(?:about|around|roughly|approximately|approx\.|nearly|almost|over|under|only|just|total|Total|factor|ratio|score|rating|average|avg|median|p50|p95|p99|forked|reads|costs?|takes?|weighs?|least|need|needs)\s+$", before)
                or re.match(r"\s*(?:million|billion|thousand|trillion|lakh|crore|bn|mn|m\b|ms|s\b|to\s+\d+(?![.\d])|[–-]\s*\d+(?![.\d])|\s*(?:to|[–-])\s*\d+\s*(?:s|ms|x|%|GB|MB)\b)", after)
                or re.match(r"^\s*\|?\s*$", before[-3:]) and re.match(r"\s*\|\s*[\d.,~$]", after)):
            stats["skip_numeric"] += 1; stats["numskips"].append(before[-25:] + "[" + m.group(0) + "]" + after[:15]); return m.group(0)
        strong = a >= 15 or a == CUR["part"] or (c and c != ".0") or re.search(r"(?:[Ss]ections?|§|[Ss]ee(?: also)?|\bin|\bPart|Part \d{1,2}\b[^.;]{0,80}|[(\[]|\d{1,2}\.\d{1,2}(?:\.\d{1,2})?(?:,| and| or| to| through|–|-)\s?)\s*$", before)
        punct = re.match(r"(?:[)\].,;:|]|\s*$|'s\b|\s(?:and|or|to|through|covers?|explains?|shows?|showed|turns?|called|introduces?|introduced|describes?|described|walks?|built|builds?|above|below|earlier|later)\b)", after)
        near_version = re.search(r"(?:" + VERSIONY.pattern[:-1] + r")\d+(?:\.\d+)*\s*(?:and|or|,|/|vs\.?|\(|\s)\s*[^\s]{0,4}\s*$", before)
        # a list/range cue only counts when the neighbour is a real section of the same part
        lm = re.search(r"(\d{1,2})\.(\d{1,2})(?:\.\d{1,2})?(?:,| and| or| to| through|–|-)\s?\s*$", before)
        if lm and strong and not (a >= 15 or a == CUR["part"] or (c and c != ".0")) and not re.search(r"(?:[Ss]ections?|§|[Ss]ee(?: also)?|\bin|\bPart|[(\[])\s*$", before):
            if not ((int(lm.group(1)), int(lm.group(2))) in sections and int(lm.group(1)) == a):
                strong = None
        rm = re.match(r"\s*(?:to|–|-)\s*(\d{1,2})\.(\d{1,2})", after)
        if rm and int(rm.group(1)) != a:
            near_version = True
        word_cue = re.search(r"(?:[Ss]ections?|§|[Ss]ee(?: also)?|\bin|\bPart\b[^.;]{0,80}|[(\[])\s*$", before)
        if re.match(r"\d{1,2}\.0\d", m.group(0)):
            near_version = True                      # 1.05, 1.02: a number, never a section
        if lm and not word_cue and not ((int(lm.group(1)), int(lm.group(2))) in sections and int(lm.group(1)) == a):
            near_version = True                      # list of plain numbers: 0.8, 1.6, 3.2
        if a <= 2 and not word_cue and a != CUR["part"]:
            near_version = True                      # 1.x / 2.x outside Parts 1-2 need a word cue
        if re.match(r":\d", after):
            near_version = True                      # ratios such as 4.5:1
        if re.search(r"(?:default|=|[Oo]ver|under|closer to|between)\s*$", before):
            near_version = True
        if near_version or not (strong or punct):
            stats["skip_weak"] = stats.get("skip_weak", 0) + 1; stats["numskips"].append("WEAK " + before[-25:] + "[" + m.group(0) + "]" + after[:15]); return m.group(0)
        stats["sec_ref"] += 1
        stats["samples"].append(before[-30:] + "[" + m.group(0) + "]" + seg[m.end():m.end() + 15])
        return f"{OLD2NEW[a]}.{b}{c}"
    return SEC_RE.sub(rep, seg)

def main():
    d = sys.argv[1]; apply = "--apply" in sys.argv
    rep_path = sys.argv[sys.argv.index("--report") + 1] if "--report" in sys.argv else None
    files = sorted(f for f in os.listdir(d) if re.match(r"^part-\d{2}-\d{2}-.*\.md$", f))
    # real section ids from H2 headings (and H3 parents)
    sections = set()
    for f in files:
        p = int(f[5:7])
        for line in open(os.path.join(d, f), encoding="utf-8"):
            m = re.match(r"^#{2,3}\s+(\d{1,2})\.(\d+)", line)
            if m and int(m.group(1)) == p:
                sections.add((p, int(m.group(2))))
    stats = {"heading": 0, "part_ref": 0, "sec_ref": 0, "skip_version": 0, "skip_numeric": 0, "samples": [], "skips": [], "numskips": []}
    results = {}
    for f in files:
        p = int(f[5:7])
        text = open(os.path.join(d, f), encoding="utf-8").read()
        # H1: "# Part OLD — Title" is covered by the Part regex
        new_text = process(text, p, sections, stats)
        new_name = f"part-{OLD2NEW[p]:02d}-{f[8:]}"
        results[f] = (new_name, new_text)
    print(json.dumps({k: v for k, v in stats.items() if k not in ("samples", "skips", "numskips")}))
    if rep_path:
        with open(rep_path, "w") as fh:
            fh.write("== SECTION REFS MAPPED ==\n" + "\n".join(stats["samples"]) + "\n== SKIPPED AS VERSION ==\n" + "\n".join(stats["skips"]) + "\n== SKIPPED AS NUMBER ==\n" + "\n".join(stats["numskips"]) + "\n")
    if apply:
        for f in files: os.remove(os.path.join(d, f))
        for f, (nn, txt) in results.items():
            with open(os.path.join(d, nn), "w", encoding="utf-8") as fh: fh.write(txt)
        print(f"applied: {len(files)} files renamed and rewritten")
    if "--build-site" in sys.argv:
        bp = sys.argv[sys.argv.index("--build-site") + 1]
        b = open(bp, encoding="utf-8").read()
        def fix(m):
            olds = [int(x) for x in re.findall(r"\d+", m.group(1))]
            return "parts: [" + ", ".join(str(OLD2NEW[o]) for o in olds) + "]"
        b2, n = re.subn(r"parts: \[([\d,\s]+)\]", fix, b)
        print(f"build-site VOLUMES arrays rewritten: {n}")
        if apply: open(bp, "w", encoding="utf-8").write(b2)
    if "--readme" in sys.argv:
        rp = sys.argv[sys.argv.index("--readme") + 1]
        r = open(rp, encoding="utf-8").read()
        r2, n = PARTS_RE.subn(map_parts, r)
        print(f"README Part refs rewritten: {n}")
        if apply: open(rp, "w", encoding="utf-8").write(r2)

if __name__ == "__main__":
    main()
