/* Site configuration: paths, the nine volumes, past numberings (for old bookmarks),
 * the home page "Start here" paths and the roadmap role paths.
 * Everything a non-programmer might want to change lives here.
 */
const path = require('path');

const BUILD = path.resolve(__dirname, '..');
const ROOT = path.resolve(BUILD, '..');

const PATHS = {
  BUILD,
  ROOT,
  CHAPTERS: path.join(ROOT, 'chapters'),
  SITE: path.join(ROOT, 'site'),
  SITE_ASSETS: path.join(ROOT, 'site', 'assets'),
  SRC_ASSETS: path.join(__dirname, 'assets'),
  NODE_MODULES: path.join(BUILD, 'node_modules'),
};

const EDITION = new Date().toISOString().slice(0, 10);
const REPO_URL = 'https://github.com/Praveen7j7/developerMaterial';
const SITE_TITLE = 'The Backend Engineering Handbook';
const SHORT_TITLE = 'Backend Handbook';
const WORDS_PER_MINUTE = 200; // technical prose with code reads slower than fiction

// ---------- old bookmarks ----------
// Part numbers before the 2026-11-05 renumbering, in today's order: OLD_NUMBERS[n - 1] is the old number of Part n.
// Used only to send old bookmarks (#part-69, #693-...) to the new anchors.
const OLD_NUMBERS = [69, 70, 71, 72, 73, 74, 1, 2, 3, 4, 5, 6, 7, 8, 61, 9, 10, 11, 12, 13, 14, 15, 31, 32, 62,
  16, 17, 18, 19, 20, 21, 33, 34, 35, 36, 59, 60, 63, 22, 23, 24, 25, 26, 27, 28, 29, 30, 37, 38, 39, 64,
  40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 65, 66, 67, 68, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85,
  51, 52, 53, 54, 55, 56, 57, 58];

// 2026-11-11: five Parts were inserted (0, 7, 53, 80, 89) and the rest shifted.
// NOV5_OF(n) is the 2026-11-05 number of today's Part n (null for the new Parts).
const NEW_PARTS_2026_11_11 = [0, 7, 53, 80, 89];
function NOV5_OF(n) {
  if (NEW_PARTS_2026_11_11.includes(n)) return null;
  return n <= 6 ? n : n <= 52 ? n - 1 : n <= 79 ? n - 2 : n - 3;
}
// Past numberings, oldest first; a newer numbering wins when two map the same old anchor.
const PAST_NUMBERINGS = [
  n => { const n5 = NOV5_OF(n); return n5 == null ? null : OLD_NUMBERS[n5 - 1]; },  // before 2026-11-05
  NOV5_OF,                                                                          // 2026-11-05 to 2026-11-11
];

// ---------- the volumes ----------
// `short` is the spine label on narrow screens; `cover` names the motif drawn in covers.js. Colours live in assets/css/tokens.css ([data-vol="N"]).
const VOLUMES = [
  { n: 0, short: 'Scratch', slug: 'from-scratch', title: 'From Scratch', cover: 'sprout', parts: [0, 1, 2, 3, 4, 5, 6, 7], blurb: 'Starting from zero: how to understand any technology, JavaScript and TypeScript, async, how the web works, Linux, Git, your first NestJS backend and your first frontend.' },
  { n: 1, short: 'Foundations', slug: 'foundations', title: 'Foundations', cover: 'blocks', parts: [8, 9, 10, 11], blurb: 'Data structures, algorithms, operating systems, the Node.js runtime and networking. The layer underneath every framework.' },
  { n: 2, short: 'APIs', slug: 'architecture-and-apis', title: 'Architecture and APIs', cover: 'blueprint', parts: [12, 13, 14, 15, 16], blurb: 'Choosing a system shape, clean design and patterns, domain-driven design, and API design people can live with — REST, GraphQL and gRPC.' },
  { n: 3, short: 'Data', slug: 'data', title: 'Data', cover: 'cylinders', parts: [17, 18, 19, 20, 21, 22, 23, 24, 25, 26], blurb: 'The relational model, SQL, PostgreSQL internals, indexing, transactions, ORMs, scaling, migrations, compatibility and NoSQL modelling.' },
  { n: 4, short: 'Distributed', slug: 'distributed-systems', title: 'Distributed Systems', cover: 'nodes', parts: [27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39], blurb: 'Caching, messaging, distributed systems and transactions, reliability, concurrency, storage, search, real-time, jobs, LLM backends, RAG and data engineering.' },
  { n: 5, short: 'Production', slug: 'production-engineering', title: 'Production Engineering', cover: 'gauge', parts: [40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53], blurb: 'Security, testing, performance, observability, containers, Kubernetes, cloud, CI/CD, Git, SRE, disaster recovery, cost, infrastructure as code and AI-assisted engineering.' },
  { n: 6, short: 'Mastery', slug: 'mastery', title: 'Mastery', cover: 'summit', parts: [54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68], blurb: 'System designs, capacity estimation, debugging, the senior mindset, levels, interviews, projects, patterns, decisions, the roadmap, low-level design and the interview playbook.' },
  { n: 7, short: 'Frontend', slug: 'frontend-and-full-stack', title: 'Frontend and Full Stack', cover: 'browser', parts: [69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80], blurb: 'How the browser builds a page, frontend tooling, React and Next.js, client data fetching, frontend-backend contracts, browser auth and security, web performance, testing, shipping frontends, one feature built end to end, and frontend and full-stack interviews.' },
  { n: 8, short: 'Architect', slug: 'principal-and-architect', title: 'Principal and Architect', cover: 'compass', parts: [81, 82, 83, 84, 85, 86, 87, 88, 89], blurb: 'Writing as an architect, technical strategy, governance, large migrations, org design, influence, growing engineers, enterprise multi-tenant SaaS, and staff and principal interviews.' },
];
const volFile = v => `vol-${v.n}-${v.slug}.html`;

// ---------- home page: "Start here" ----------
// `go` is a list of [label, partNumber | 'vol:N'] targets, in reading order.
const START_PATHS = [
  { id: 'new', icon: 'book-open', who: 'New to coding', why: 'Learn how to learn a technology, then build up from your first variable to your first backend.', go: [['Part 0', 0], ['Volume 0', 'vol:0']] },
  { id: 'backend', icon: 'server', who: 'Backend developer', why: 'Fill in the layer under the framework: data structures, the OS, the Node runtime and networking.', go: [['Volume 1', 'vol:1']] },
  { id: 'fullstack', icon: 'code-xml', who: 'Full-stack developer', why: 'Your first frontend, then how the browser, React, Next.js and the backend contract fit together.', go: [['Part 7', 7], ['Volume 7', 'vol:7']] },
  { id: 'senior', icon: 'target', who: 'Senior engineer', why: 'System designs, capacity estimates, debugging under pressure and the decisions seniors own.', go: [['Volume 6', 'vol:6']] },
  { id: 'architect', icon: 'layers', who: 'Architect or principal', why: 'Writing, strategy, governance, large migrations and influence beyond one team.', go: [['Volume 8', 'vol:8']] },
  { id: 'interview', icon: 'message-circle-question', who: 'Preparing for interviews', why: 'Question banks with model answers for backend, frontend, full-stack, staff and principal loops.', go: [['59', 59], ['67', 67], ['68', 68], ['80', 80], ['89', 89]] },
];

// ---------- roadmap page: role paths ----------
// Stages come from Part 64 (parsed in roadmap.js). A role highlights the Parts in its stages,
// plus an optional extra track of Parts the five stages do not list.
const ROLE_PATHS = [
  { id: 'all', label: 'Everything', stages: [1, 2, 3, 4, 5], extra: null },
  { id: 'backend', label: 'Backend', stages: [1, 2, 3, 4], extra: null },
  { id: 'fullstack', label: 'Full-stack', stages: [1, 2], extra: { title: 'Frontend track', note: 'Volume 7, read after Stage 1 and alongside Stage 2.', parts: [69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80] } },
  { id: 'architect', label: 'Architect', stages: [4, 5], extra: null },
];

// Teaching-block headings (####) that get an icon and a tone. Matched on the start of the heading text.
const TEACHING_BLOCKS = [
  [/^concept\b/i, 'lightbulb', 'concept'],
  [/^why does it exist|^why the question matters/i, 'circle-help', 'plain'],
  [/^mental model/i, 'brain', 'model'],
  [/^how it works|^how to actually answer/i, 'cog', 'plain'],
  [/^(failure scenario|edge cases|the mistake people make|where juniors misapply|when not to use)/i, 'triangle-alert', 'warn'],
  [/^common mistakes/i, 'bug', 'warn'],
  [/^(production scenario|real-world scenario)/i, 'server', 'plain'],
  [/^how a (senior|principal)/i, 'graduation-cap', 'plain'],
  [/^interview questions/i, 'message-circle-question', 'practice'],
  [/^(practical exercise|try it yourself)/i, 'pencil-line', 'practice'],
  [/^worked answer/i, 'circle-check', 'practice'],
  [/example$|^(nestjs|postgresql|typeorm|sequelize|react|backend side|artifact|worked example|practical example)/i, 'code-xml', 'plain'],
];

module.exports = {
  PATHS, EDITION, REPO_URL, SITE_TITLE, SHORT_TITLE, WORDS_PER_MINUTE,
  PAST_NUMBERINGS, VOLUMES, volFile, START_PATHS, ROLE_PATHS, TEACHING_BLOCKS,
};
