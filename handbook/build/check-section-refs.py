#!/usr/bin/env python3
"""List "Part N.M" references whose section N.M does not exist (broken links)."""
import os, re, sys, collections
d = sys.argv[1]
secs = set(); parts = set()
for f in sorted(os.listdir(d)):
    if not re.match(r"part-\d{2}-\d{2}-.*\.md$", f): continue
    p = int(f[5:7]); parts.add(p)
    for line in open(os.path.join(d, f), encoding="utf-8"):
        m = re.match(r"^#{2,3}\s+(\d{1,3})\.(\d+)(?:\.(\d+))?", line)
        if m and int(m.group(1)) == p: secs.add((p, int(m.group(2))))
bad = []; ok = 0
for f in sorted(os.listdir(d)):
    if not f.endswith(".md"): continue
    for i, line in enumerate(open(os.path.join(d, f), encoding="utf-8"), 1):
        for m in re.finditer(r"\bParts? (\d{1,3})\.(\d{1,2})(?!\d)", line):
            n, s = int(m.group(1)), int(m.group(2))
            if (n, s) in secs: ok += 1
            else: bad.append((f, i, m.group(0), line.strip()[max(0, m.start()-60):m.end()+40]))
print(f"Part N.M references: {ok} ok, {len(bad)} broken")
for b in bad[: int(sys.argv[2]) if len(sys.argv) > 2 else 400]: print(f"  {b[0]}:{b[1]}  {b[2]}  | {b[3]}")
