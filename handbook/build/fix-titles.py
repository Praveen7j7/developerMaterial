#!/usr/bin/env python3
"""Replace paraphrased titles in "Part N — Title" references with Part N's real title.
Only the capitalised title phrase is replaced; following words ("covers the ...") stay.
Usage: fix-titles.py chapters [--apply]"""
import os, re, sys, collections
d = sys.argv[1]; apply = "--apply" in sys.argv
titles = {}
for f in sorted(os.listdir(d)):
    if re.match(r"part-\d{2}-01-", f):
        m = re.match(r"# Part (\d+) — (.+)", open(os.path.join(d, f), encoding="utf-8").readline().strip())
        if m: titles[int(m.group(1))] = m.group(2)
norm = lambda t: re.sub(r"[^a-z0-9]+", " ", t.lower()).strip()
CONNECT = {"and", "or", "of", "the", "&", "in", "to", "vs", "a", "an", "with"}
def phrase(text):
    """Length of the leading title phrase: capitalised words, joined by connectors only when a capitalised word follows."""
    toks = list(re.finditer(r"\S+", text)); end = 0; i = 0
    def cap(w): return bool(re.match(r"[A-Z0-9]", w)) and w not in ("Part", "Parts")
    while i < len(toks):
        w = toks[i].group(0).rstrip(",.;:)")
        if cap(w):
            end = toks[i].start() + len(w); i += 1
            if w != toks[i - 1].group(0): break            # word carried trailing punctuation
        elif w.lower() in CONNECT and i + 1 < len(toks) and cap(toks[i + 1].group(0).rstrip(",.;:)")):
            i += 1
        else: break
    return end
KEEP = {(7, "LRU Cache"), (12, "State"), (53, "Turning"), (55, "How"), (78, "Writing"), (29, "The"), (4, "Working"),
        (52, "Notification System"), (43, "Containers and Kubernetes")}
RETARGET = {(26, "API Design"): 14, (30, "API Design"): 14, (30, "Message Brokers"): 27,
            (21, "Schema Design and Migrations"): 23, (39, "Event-Driven Architecture"): 29}
RENAME_OK = {(30, "Resilience Patterns"), (30, "Resilience"), (29, "Event-Driven Architecture"), (22, "Replication and High Availability"),
             (22, "Partitioning"), (21, "ORMs in Depth"), (59, "Event Sourcing and CQRS in Depth"), (24, "Backward and Forward Compatibility"),
             (48, "Observability and SRE"), (19, "Indexing"), (40, "Testing"), (48, "Incident Response and On-Call"), (41, "Performance and Optimization"),
             (42, "Observability"), (35, "Background Jobs"), (41, "Backend Performance"), (50, "Cost Engineering"), (28, "Distributed Systems"),
             (7, "Data Structures"), (30, "Reliability Engineering"), (77, "Full-Stack Worked Project"), (34, "Real-Time Systems"), (14, "API Design")}
REF = re.compile(r"\bPart (\d{1,2}) — (?=[A-Z])")
changes = collections.Counter(); out = {}; REVIEW = []
for f in sorted(os.listdir(d)):
    if not f.endswith(".md"): continue
    text = open(os.path.join(d, f), encoding="utf-8").read(); res = []; pos = 0
    for m in REF.finditer(text):
        n = int(m.group(1)); start = m.end()
        if n not in titles: continue
        real = titles[n]
        if text.startswith(real, start): continue
        rest = text[start:start + 120].split("\n")[0]
        L = phrase(rest)
        if L == 0: continue
        stated = rest[:L]
        if stated.startswith("Key Takeaways") or stated.startswith("Senior Checklist"): continue
        if (norm(real) + " ").startswith(norm(stated) + " "): continue      # a short form of the real title is fine
        if (n, stated) in KEEP: continue
        if (n, stated) in RETARGET:
            k = RETARGET[(n, stated)]; changes[(n, stated, f"Part {k} — {titles[k]}")] += 1
            res.append(text[pos:m.start()]); res.append(f"Part {k} — {titles[k]}"); pos = start + L; continue
        if norm(stated) == norm(real): continue
        after = rest[L:]
        STOPW = {"and","or","of","the","in","to","a","an","for","with","as","from","by"}
        sig = lambda t: {w for w in re.findall(r"[a-z0-9]+", t.lower()) if w not in STOPW}
        overlap = sig(stated) & sig(real) or any(len(w) > 4 and any(x.startswith(w[:5]) for x in sig(real)) for w in sig(stated))
        clean_end = re.match(r"(?:\s*[,.;:)\]]|\s*\(|\s*$|\s+(?:covers?|covered|explains?|explained|shows?|showed|builds?|built|has|goes|walks?|is|was|for|on|makes?|made|treats?|discusses|describes?|introduces?|teaches|already|in depth|later)\b)", after)
        if not overlap and (n, stated) not in RENAME_OK or not clean_end and (n, stated) not in RENAME_OK:
            REVIEW.append(f"{f}: Part {n} — [{stated}]{after[:40]}   (real: {real[:50]})"); continue
        changes[(n, stated, real)] += 1
        res.append(text[pos:start]); res.append(real); pos = start + L
    if res:
        res.append(text[pos:]); out[f] = "".join(res)
for (n, s, r), c in sorted(changes.items(), key=lambda x: -x[1])[:200]: print(f"{c:2}x Part {n}: '{s}' -> '{r}'")
print(f"total {sum(changes.values())} refs in {len(out)} files")
print(f"--- for review ({len(REVIEW)}):"); print("\n".join(REVIEW))
if apply:
    for f, t in out.items(): open(os.path.join(d, f), "w", encoding="utf-8").write(t)
    print("applied")
