#!/usr/bin/env python3
"""Retarget "Part N — Title" refs whose title clearly names a different Part. Usage: fix-xrefs.py chapters [--apply]"""
import os, re, sys, collections
d = sys.argv[1]; apply = "--apply" in sys.argv
titles = {}
for f in sorted(os.listdir(d)):
    if re.match(r"part-\d{2}-01-", f):
        m = re.match(r"# Part (\d+) — (.+)", open(os.path.join(d, f), encoding="utf-8").readline().strip())
        if m: titles[int(m.group(1))] = m.group(2)
STOP = set("a an the and of for in on with to from by covers covered covering cover builds shows explains this that these full depth".split())
def words(t): return [w for w in re.findall(r"[a-z0-9]+", t.lower()) if w not in STOP]
tw = {n: set(words(t)) for n, t in titles.items()}
def match_score(stated, n):
    sw = words(stated)[:4]
    if not sw: return 0
    return sum(1 for w in sw if any(w == x or (len(w) > 4 and x.startswith(w[:5])) for x in tw[n])) / len(sw)
REF = re.compile(r"\bPart (\d{1,2}) — ([A-Z][^.,;:()\]\n*|]{3,60})")
changes = collections.Counter(); out = {}
for f in sorted(os.listdir(d)):
    if not f.endswith(".md"): continue
    text = open(os.path.join(d, f), encoding="utf-8").read()
    def rep(m):
        n, stated = int(m.group(1)), m.group(2)
        if n not in titles or stated.startswith("Key Takeaways"): return m.group(0)
        cur = match_score(stated, n)
        if cur >= 0.5: return m.group(0)                     # plausible paraphrase of the right Part
        cands = [k for k in titles if k != n and match_score(stated, k) >= 0.99]
        if len(cands) != 1: return m.group(0)
        k = cands[0]; changes[(n, k, stated[:45], titles[k][:45])] += 1
        return f"Part {k} — {stated}"
    new = REF.sub(rep, text)
    if new != text: out[f] = new
for (n, k, s, t), c in sorted(changes.items()): print(f"{c:2}x Part {n} -> {k}: '{s}'  =>  '{t}'")
print(f"total {sum(changes.values())} refs in {len(out)} files")
if apply:
    for f, t in out.items(): open(os.path.join(d, f), "w", encoding="utf-8").write(t)
    print("applied")
