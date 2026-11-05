# Expansion brief — thin Parts

These Parts are complete in shape but much shorter than the rest of the book (most Parts are 15,000–35,000 words). Expand them in place. Read `_spec/STYLE.md`, then the assignment for your Parts in `_spec/OUTLINE-51-68.md` (Parts 59–68) or the Part's own files (Vol 0 Parts 70–74), then the existing files of your Parts in full.

| Part | Words now | Target | Notes |
|---|---|---|---|
| 59 Building Backends with LLMs | 10.7k | 18–22k | Cover every outline bullet with the full teaching template; the worked example in full |
| 60 Retrieval, Agents and Evaluation | 8.2k | 18–22k | pgvector EXPLAIN output, the incident story, evaluation in CI |
| 61 GraphQL and gRPC | 7.0k | 18–22k | Federation, protobuf evolution, the three-protocol worked example |
| 62 NoSQL Data Modelling | 8.4k | 18–22k | DynamoDB single-table worked example vs PostgreSQL; Cassandra write path |
| 63 Data Engineering | 8.6k | 18–22k | CDC worked example end to end; stream processing windows |
| 64 Infrastructure as Code | 7.8k | 18–22k | Full Terraform worked example; the `terraform apply` incident |
| 65 More System Designs I | 10.5k | 18–24k | Each design at the depth of Part 40 (read part-40-01 first) |
| 66 More System Designs II | 9.5k | 18–24k | Same |
| 67 Low-Level Design | 9.4k | 18–24k | All 8 listed problems fully worked: diagram, code, tests, twist |
| 68 Interview Playbook | 9.1k | 18–24k | Every outline bullet, including Q&A for Parts 51–66 |
| 70 Asynchronous JavaScript | 6.9k | 12–15k | Volume 0 is for beginners: more worked examples and exercises, not harder material |
| 71 How the Web Works | 8.5k | 12–15k | Same |
| 72 Linux and the Command Line | 9.1k | 12–15k | Same |
| 73 Git Basics | 6.0k | 12–15k | Same |
| 74 Your First Backend | 6.8k | 12–15k | Grow the project step by step: validation, errors, tests, running with Docker |

Part 50 (the roadmap) is short on purpose; do not expand it.

## Rules

- **Write it yourself.** Do not start sub-agents or forks; at most two writers run at once on this account.
- **Only touch files of your own Parts.** Never edit another Part.
- **Keep what is there.** Do not delete or rewrite correct content, and do not renumber existing sections (search links and anchors depend on them). Fix anything that is wrong.
- **Where new material goes:** deepen existing sections in place (missing template blocks, examples, failure stories, interview questions, exercises), and add new `## NN.M` sections numbered after the last existing one.
- **Files:** keep each file between roughly 2,500 and 4,500 words. When a file would grow past that, move material into a new file with the next sequence number (`part-NN-SS-slug.md`). The H1 stays only in file `01`.
- **Closing sections** (`## Senior Checklist — Part NN` and `## Part NN — Key Takeaways`) must stay at the very end of the Part's last file. If you add a new last file, move them there and update them for the new material.
- Same voice, template, numbers, Mermaid rules and do-not list as STYLE.md. Real APIs only.

## Before you finish

- `node build/check-structure.js` from the handbook root: your Parts must show no problems.
- `node build/validate-mermaid.js part-NN` for each of your Parts: 0 broken.
- Report: words before and after per Part, files added, sections added, anything you corrected.
