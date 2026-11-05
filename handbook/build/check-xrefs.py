#!/usr/bin/env python3
"""Check every "Part N — Title" reference against Part N's real H1 title."""
import os, re, sys, collections
d = sys.argv[1]
titles = {}
for f in sorted(os.listdir(d)):
    if re.match(r"part-\d{2}-01-", f):
        h = open(os.path.join(d, f), encoding="utf-8").readline()
        m = re.match(r"# Part (\d+) — (.+)", h.strip())
        if m: titles[int(m.group(1))] = m.group(2)
norm = lambda t: re.sub(r"[^a-z0-9]+", " ", t.lower()).strip()
bad = collections.Counter(); ok = 0
for f in sorted(os.listdir(d)):
    if not f.endswith(".md"): continue
    for line in open(os.path.join(d, f), encoding="utf-8"):
        for m in re.finditer(r"\bPart (\d{1,2}) — ([A-Z][^.,;:()\]\n*|]{3,60})", line):
            n, t = int(m.group(1)), m.group(2).strip()
            if t.startswith(("Key Takeaways",)) or n not in titles: continue
            real = norm(titles[n]); got = norm(t)
            if (real + ' ').startswith(got + ' ') or real.startswith(got[:12]) or got.startswith(real[:12]): ok += 1
            else: bad[(n, t[:40], titles[n][:40])] += 1
print(f"title-checked references: {ok} ok, {sum(bad.values())} mismatched ({len(bad)} distinct)")
for (n, t, r), c in bad.most_common(40): print(f"  {c:3}x Part {n}: says '{t}' / real '{r}'")
