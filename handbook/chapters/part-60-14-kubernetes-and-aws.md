## 60.16 Kubernetes

### Q197. What actually happens when you run `kubectl apply -f deployment.yaml`?

- **Expected answer** — `kubectl` sends the manifest to the API server, which authenticates you, runs admission controllers (validating and mutating webhooks, quota checks, policy engines like OPA/Kyverno), and persists the desired state in etcd. Nothing has run yet — Kubernetes is a set of controllers reconciling desired state against actual state. The Deployment controller sees a new Deployment and creates a ReplicaSet; the ReplicaSet controller sees it needs N pods and creates Pod objects with no node assigned. The **scheduler** watches for unscheduled pods and picks a node by filtering (does it have enough allocatable CPU and memory, do node selectors, taints, tolerations and affinity rules permit it) and scoring. The **kubelet** on that node sees a pod assigned to it, pulls the image, asks the container runtime to start it, and reports status back. Meanwhile the endpoints/EndpointSlice controller adds the pod's IP to the Service once its readiness probe passes, and kube-proxy (or a CNI equivalent) programs the node's routing so Service traffic reaches it. The whole model is level-triggered reconciliation, which is why a pod deleted by hand comes back and why "it eventually converges" is the normal mental model.

- **Why it matters** — Almost every Kubernetes debugging session is "which controller is stuck and why", and you cannot answer that without this chain.

- **Follow-ups** — Your pod is `Pending` forever — which step failed and how do you check? What is the difference between a Deployment and the ReplicaSet it owns? What does level-triggered mean in practice?

- **Senior signal** — Describes controllers and reconciliation rather than reciting object names, and can point at where to look at each step.

### Q198. How do you configure liveness, readiness and startup probes for a Node service?

- **Expected answer** — Three probes with different jobs. **Liveness**: "is this process wedged?" — restart is the remedy, so it must be cheap and check nothing external. `GET /health/live` returning 200 if the event loop is responsive is enough; checking Postgres here means a database blip restarts every pod at once. Typical settings: `periodSeconds: 10`, `failureThreshold: 3`, `timeoutSeconds: 1`. **Readiness**: "should I receive traffic?" — this one *should* check critical dependencies (database connectivity, a required cache) and should flip to failing during shutdown. Failing readiness removes the pod's IP from the Service endpoints without killing it, which is exactly right for a transient dependency problem. **Startup**: covers slow boots (migrations, cache warming) with a generous `failureThreshold * periodSeconds` budget, and while it is running, liveness and readiness are suspended, so a slow start is not mistaken for a hang. The failure mode to name: a readiness probe that checks a shared dependency will fail on *every* pod simultaneously when that dependency has a hiccup, taking your whole service out of the load balancer for something that was only degraded — so keep the readiness dependency list to things without which the pod is genuinely useless, and consider returning ready-but-degraded for optional dependencies.

- **Why it matters** — Probe misconfiguration converts partial degradations into full outages.

- **Follow-ups** — Redis is down and your readiness probe checks it. What happens? Why suspend liveness during startup? What does your liveness endpoint measure?

- **Senior signal** — The correlated-readiness-failure story and the discipline of a minimal liveness check.

### Q199. How do you get a zero-downtime rolling update?

- **Expected answer** — The Deployment's `RollingUpdate` strategy with `maxSurge` and `maxUnavailable` controls the pace: `maxSurge: 25%, maxUnavailable: 0` means new pods come up before old ones go down, which costs extra capacity briefly but never reduces serving capacity. Then the details that actually determine whether users see errors. New pods must not receive traffic before they can serve it, which is the readiness probe's job — so `minReadySeconds` and an accurate readiness check matter. Old pods must stop receiving traffic *before* they stop serving: when a pod is deleted, endpoint removal and the container's `SIGTERM` happen concurrently, and endpoint propagation to kube-proxy and any ingress controller takes a second or two, so without care the pod stops accepting connections while traffic is still arriving. The fix is a `preStop` hook that sleeps 5–10 seconds (or flips readiness and waits) before the application starts draining, plus application-side graceful shutdown that finishes in-flight requests, plus `terminationGracePeriodSeconds` comfortably longer than your longest request. Also keep connections in mind: with keep-alive, a client may hold a connection to a terminating pod, so the server must send `Connection: close` during drain.

- **Why it matters** — Deploy-time 502s are extremely common and this is precisely why.

- **Follow-ups** — Why does a `preStop` sleep help when the app already handles `SIGTERM`? What value do you set for the grace period and how do you derive it? How do you verify zero downtime?

- **Senior signal** — Knows endpoint removal and `SIGTERM` race, and prescribes the sleep-then-drain ordering with a derived grace period.

### Q200. Requests versus limits, and what are QoS classes?

- **Expected answer** — A **request** is what the scheduler reserves and uses to decide whether a pod fits on a node; a **limit** is the hard ceiling enforced by cgroups at runtime. For memory, exceeding the limit means the kernel OOM-kills the container (exit 137). For CPU, exceeding the limit means throttling: the container is paused until the next cgroup period, which shows up as spiky p99 latency rather than a clean error. QoS classes follow from these: **Guaranteed** (requests equal limits for all containers) gets the strongest protection from eviction, **Burstable** (requests set, limits higher or absent) is the common case, and **BestEffort** (nothing set) is evicted first under node pressure. My practice: always set memory request equal to memory limit, because memory is incompressible and overcommitting it means the kernel picks a victim under pressure; set a CPU request that reflects steady-state usage; and be deliberate about CPU limits — a low CPU limit on a Node service causes throttling that looks like mysterious latency, and many teams get better tail latency by setting a CPU request with no limit, accepting the noisy-neighbour risk. Derive all of these from observed usage (`kubectl top`, or the VPA in recommendation mode), not from guesses.

- **Why it matters** — Wrong requests waste money or cause evictions; wrong CPU limits cause invisible latency.

- **Follow-ups** — Why is memory treated differently from CPU? What does throttling look like in Grafana? How would you right-size 40 services?

- **Senior signal** — Memory request equals limit, thoughtful position on CPU limits, and sizing from measured data.

### Q201. How does autoscaling work and what do you scale on?

- **Expected answer** — The **HPA** periodically reads a metric and adjusts replica count toward a target: with CPU utilisation, `desired = ceil(current * currentMetric / targetMetric)`. CPU is the default but it is often the wrong signal for a Node service, because an I/O-bound API can be at 30% CPU while its latency is terrible. Better signals via custom or external metrics: requests per second per pod, p95 latency, event-loop lag, or — for workers — queue depth or Kafka consumer lag, which is what KEDA is built for and is the single most useful autoscaling signal for asynchronous workloads because it scales on the backlog rather than on a symptom. Configure the behaviour: fast scale-up (short stabilisation window, allow doubling) and slow scale-down (a 5-minute stabilisation window) so you do not flap and lose warm caches and connections. Cluster Autoscaler or Karpenter adds nodes when pods cannot be scheduled, which takes 30 seconds to a few minutes, so for spiky traffic keep some headroom or use low-priority placeholder pods to pre-provision. The failure modes to state: scaling on a metric affected by the scaling itself, an HPA fighting a VPA, and scaling out a service whose bottleneck is the database — where adding pods makes things strictly worse by adding connections.

- **Why it matters** — The "we added replicas and it got slower" scenario is common and reveals whether someone understands the bottleneck.

- **Follow-ups** — Why is CPU a bad signal for an I/O-bound API? What happens when you scale a service whose database is saturated? How do you handle a 10x spike in 30 seconds?

- **Senior signal** — Queue depth and latency as signals, asymmetric scale-up/down behaviour, and the database-bottleneck warning.

### Q202. A pod is in `CrashLoopBackOff`. Walk me through debugging it.

- **Expected answer** — `kubectl describe pod` first: the events section usually names the cause and the container statuses show the last exit code and reason. Then `kubectl logs <pod> --previous`, because the current container may not have produced output yet and the *previous* crashed instance's logs are what you need. Read the exit code: 0 with a restart means the process exited normally and the container has nothing to keep running (often a wrong command or a script that finished); 1 is an application error, so read the stack trace; 137 is `SIGKILL`, usually `OOMKilled` (confirm in `describe`) or a liveness probe failing; 139 is a segfault, likely a native module. Common causes in order of frequency: a missing or malformed environment variable or secret so config validation fails at boot (which is the fail-fast behaviour working as intended), an unreachable dependency at startup, a memory limit lower than the real working set, a liveness probe that is too aggressive for a slow start (fixed with a startup probe), and an image built for the wrong architecture. If logs are silent, `kubectl run` the same image with the command overridden to a shell, or attach an ephemeral debug container (`kubectl debug`), to inspect the environment and filesystem. Related states worth distinguishing: `ImagePullBackOff` (registry credentials, wrong tag), `Pending` (no node has room, or a PVC cannot bind), and `Init:Error` (an init container failed).

- **Why it matters** — This is a daily operational task and the diagnosis order shows real experience.

- **Follow-ups** — Where do you see `OOMKilled` specifically? Why `--previous`? Your pod is `Pending` with no events — what next?

- **Senior signal** — Reads exit codes fluently, uses `--previous`, and distinguishes the sibling failure states.

### Q203. How do ConfigMaps and Secrets work, and how does a config change reach a running pod?

- **Expected answer** — Both are key-value objects in etcd. As environment variables they are read once at container start, so a change requires a pod restart — which is why "I updated the ConfigMap and nothing happened" is a frequent confusion. As mounted volumes they are updated in place by the kubelet within roughly a minute, but your process must watch the file and reload; most applications do not, so it still needs a restart. The standard trick is to put a hash of the config into the Deployment's pod template annotations so that changing the ConfigMap changes the pod spec and triggers a normal rolling update — which also gives you a rollback path, since the config change is now part of a revision. Secrets are only base64-encoded, not encrypted, so you must enable encryption at rest in etcd, restrict RBAC on secret read access (anyone who can create a pod in the namespace can usually mount and read them), and prefer external secret managers via External Secrets Operator or the CSI secrets driver so the source of truth is outside the cluster and rotation is automated. Never put secrets in a ConfigMap, and never log the resolved config.

- **Why it matters** — Config delivery and rotation is where "it works in staging" problems and credential leaks both live.

- **Follow-ups** — How do you force a rollout when a ConfigMap changes? Are Kubernetes secrets encrypted? How does a rotated database password reach the app?

- **Senior signal** — The config-hash annotation pattern and honesty about secret encoding versus encryption.

### Q204. How does a request actually reach a pod?

- **Expected answer** — From outside: DNS resolves to an ingress load balancer (an ALB or NLB pointing at an Ingress controller, or a Gateway API implementation). The Ingress controller terminates TLS and routes by host and path to a Service. A **Service** is not a proxy process; it is a stable virtual IP and a set of rules. The endpoints/EndpointSlice controller keeps the list of *ready* pod IPs behind it, and kube-proxy programs iptables or IPVS rules on every node so that traffic to the Service IP is DNAT'd to one of those pod IPs — many ingress controllers skip this and send traffic directly to pod IPs, which gives better load balancing. Inside the cluster, `orders-service.default.svc.cluster.local` resolves through CoreDNS to the Service IP. Types: `ClusterIP` (internal only), `NodePort` (a port on every node), `LoadBalancer` (provisions a cloud LB), and headless (`clusterIP: None`, returning pod IPs directly, which is what StatefulSets use). Two operational details worth knowing: readiness controls endpoint membership, so a failing probe removes a pod from routing; and the default `ndots: 5` in the pod's `resolv.conf` means unqualified lookups try several search domains first, which multiplies DNS traffic and adds latency — a common and fixable source of tail latency.

- **Why it matters** — Networking problems are opaque unless you know each hop.

- **Follow-ups** — Why is there no process listening on the Service IP? What is a headless Service for? How would you debug "connection refused" between two services?

- **Senior signal** — Knows Services are iptables rules rather than proxies, and raises the `ndots` DNS amplification.

### Q205. StatefulSet or Deployment, and would you run Postgres in Kubernetes?

- **Expected answer** — A Deployment treats pods as interchangeable: random names, no stable storage, parallel updates. A StatefulSet gives stable network identities (`db-0`, `db-1`), stable per-pod PersistentVolumeClaims that survive rescheduling, ordered creation and termination, and a headless Service for direct addressing — everything a clustered stateful system needs. So StatefulSets for databases, Kafka, Zookeeper, Elasticsearch; Deployments for stateless services. On running Postgres in Kubernetes: it is genuinely viable now with a mature operator (CloudNativePG, Zalando, Crunchy) that handles failover, backups, PITR and minor upgrades — but you are taking on database operations, and Kubernetes adds failure modes (a node drain evicting your primary, storage class performance surprises, a PVC that cannot reattach in another AZ). My default recommendation for most teams is managed (RDS, Cloud SQL): the operational burden is where the risk is, not the technology, and a team that is not ready to handle a 3 a.m. failover should not own one. I would run Postgres in-cluster when there is a real reason — cost at scale, data residency, an existing platform team with database expertise — and never as the first stateful thing a team tries.

- **Why it matters** — It is a build-versus-buy decision with severe consequences, and the honest answer requires judgement.

- **Follow-ups** — What happens to a StatefulSet pod during a node drain? How do PVCs behave across availability zones? What would make you move off RDS?

- **Senior signal** — Recommends managed by default with concrete criteria for the exception, and names the Kubernetes-specific failure modes.

### Q206. How do you keep a service available during node maintenance?

- **Expected answer** — A **PodDisruptionBudget** declares how much voluntary disruption is acceptable — `minAvailable: 2` or `maxUnavailable: 1` — and the eviction API respects it, so `kubectl drain` blocks rather than taking your last two replicas down together. Note the word voluntary: a PDB does not protect against a node crashing, only against drains, cluster upgrades and autoscaler scale-down. Alongside it: **topology spread constraints** (or pod anti-affinity) to spread replicas across nodes and availability zones, so a single node or zone failure cannot take out every replica — the default scheduler will happily place all three of your pods on one node otherwise. **Taints and tolerations** keep workloads off nodes they should not use; **priority classes** decide who gets evicted first under pressure. And graceful termination has to work (see Q199), because a drain sends `SIGTERM` and then waits only for the grace period. The failure I have seen: a PDB with `minAvailable` equal to the replica count, which makes drains hang forever and blocks cluster upgrades — so the budget must leave room for at least one pod to move, and it must be paired with enough replicas to make that true.

- **Why it matters** — Node maintenance happens constantly in a managed cluster; without these, deploys and upgrades cause outages.

- **Follow-ups** — Does a PDB help when a node hardware-fails? What happens if `minAvailable` equals the replica count? How do you spread across zones?

- **Senior signal** — The voluntary-disruption distinction and the self-blocking-PDB scar.

### Q207. How do you secure a cluster at the application team's level?

- **Expected answer** — Namespaces for isolation and quota, with RBAC granting least privilege: developers get read plus log access in their namespace, deploys happen through CI with a scoped ServiceAccount, and nobody has cluster-admin routinely. Each workload gets its own ServiceAccount — not `default` — and cloud permissions attach to it (IRSA on EKS, Workload Identity on GKE) so pods get short-lived cloud credentials with no static keys anywhere. **NetworkPolicies** are important and usually missing: by default every pod can reach every other pod, so a compromised frontend can talk directly to your database; a default-deny ingress policy per namespace plus explicit allows is the fix. Pod Security Admission (restricted profile) or a policy engine blocks privileged containers, host mounts, host networking and running as root. Also: encryption at rest for etcd, audit logging enabled and shipped somewhere, image provenance/admission control if you can, and regular review of who has what — because RBAC accumulates. The framing I use: assume one pod will eventually be compromised, and ask what it can reach; if the answer is "everything", the cluster has no meaningful security boundary.

- **Why it matters** — Default Kubernetes is wide open internally, and most teams never close it.

- **Follow-ups** — What can a compromised pod do in your cluster today? How does IRSA avoid static credentials? What does a default-deny NetworkPolicy break first?

- **Senior signal** — Assumes compromise and reasons about blast radius, and names IRSA/Workload Identity rather than mounting cloud keys.

### Q208. Production incident: latency spiked and error rate is up. What do you check in Kubernetes?

- **Expected answer** — Work outside-in and change-first. Was there a deploy or config change in the last hour — that is the single highest-prior cause, so check the rollout history and be ready to `kubectl rollout undo`. Then the service view: `kubectl get pods` for restarts, `CrashLoopBackOff`, `Pending` or `Evicted`; `kubectl top pods` and node pressure conditions for resource exhaustion; HPA status to see whether it is at max replicas. Then the dependency view: are errors concentrated on one downstream (traces will tell you immediately), is database CPU or connection count saturated, is a queue backing up. Then the platform view: node events, disk pressure, a node that went `NotReady`, DNS errors in logs (CoreDNS saturation is a classic cluster-wide latency cause), and network policy or certificate changes. Useful tools: `kubectl describe` for events, `kubectl logs --previous`, `kubectl debug` for an ephemeral container in a pod you cannot exec into (distroless images have no shell), and `kubectl get events --sort-by=.lastTimestamp` across the namespace. The habit that matters more than any command: mitigate first (roll back, scale up, shed load, disable the feature flag), diagnose second, and write down the timeline as you go because you will not remember it later.

- **Why it matters** — It is the closest thing to a live test of on-call ability.

- **Follow-ups** — What is your first action if a deploy went out 20 minutes ago? How do you exec into a distroless container? What do you do when the cluster's DNS is the problem?

- **Senior signal** — Mitigate-before-diagnose, change-first hypothesis, and knowing the cluster-level causes (DNS, node pressure) not just the application ones.

## 60.17 AWS and cloud

### Q209. EC2, ECS, EKS or Lambda — how do you choose compute?

- **Expected answer** — Start from team and workload, not from fashion. **Lambda** suits spiky, short, event-driven work — S3 triggers, webhook receivers, glue between services — with no servers to patch and true scale-to-zero; it costs you cold starts, a 15-minute limit, awkward connection pooling against Postgres (hence RDS Proxy), and a debugging experience that is worse than a normal process. **ECS on Fargate** is the sweet spot for most teams running a handful of long-lived services: containers, no cluster to operate, straightforward autoscaling, and much less to learn than Kubernetes. **EKS** earns its complexity when you have many services, need the Kubernetes ecosystem (operators, service mesh, Helm, portability), or already have platform engineers; running EKS with three services and no platform team is paying a tax for nothing. **EC2** for workloads that need specific instance control — GPUs, huge memory, licence constraints, or a database you insist on self-managing. The honest senior framing: the question is which operational burden you want, and the right answer for a 12-person team shipping a NestJS API is usually Fargate, moving to EKS only when concrete needs appear.

- **Why it matters** — Compute choice sets your operational cost and hiring needs for years.

- **Follow-ups** — What breaks when Lambda talks to Postgres at scale? What would make you migrate from Fargate to EKS? How do cold starts affect a user-facing API?

- **Senior signal** — Frames it as choosing an operational burden and is willing to recommend the less fashionable option.

### Q210. Explain IAM roles versus users, and how a pod or task gets credentials.

- **Expected answer** — An IAM **user** is a long-lived identity with static access keys; a **role** is a set of permissions that an entity assumes temporarily, receiving short-lived credentials via STS. The rule is: no static keys anywhere in a workload. An ECS task gets a **task role** and the credentials arrive through the container credentials endpoint; an EKS pod uses **IRSA** (or EKS Pod Identity), where the pod's ServiceAccount is annotated with a role ARN, the pod receives a projected OIDC token, and the SDK exchanges it for temporary credentials; an EC2 instance uses an instance profile via IMDS (enforce IMDSv2 so SSRF cannot trivially steal them). Policies should be least privilege: scope actions and resources narrowly (`s3:GetObject` on one prefix, not `s3:*` on `*`), use conditions, and prefer separate roles per service so a compromise is contained. Also know the evaluation order — an explicit `Deny` always wins, and permissions boundaries plus SCPs at the organisation level cap what any role can do regardless of its policy. Human access should be federated SSO with assumed roles and MFA, not IAM users with keys in a `.aws/credentials` file.

- **Why it matters** — Leaked static keys are a leading cause of cloud breaches, and the fix is architectural.

- **Follow-ups** — How does IRSA avoid a static secret? What does IMDSv2 change for SSRF? How do you scope an S3 policy to one tenant's prefix?

- **Senior signal** — Names the token-exchange mechanism rather than "attach a role", and connects IMDSv2 to SSRF.

### Q211. What do you need to know about S3 for a backend service?

- **Expected answer** — S3 is strongly read-after-write consistent for new objects and overwrites (since 2020), so the old "eventual consistency" workarounds are obsolete, but it is still an object store: no partial updates, no rename (a copy plus delete), and listing is expensive at scale. For uploads, do not proxy file bytes through your API — issue a **presigned URL** or presigned POST so the client uploads directly to S3, with a short expiry, a content-length range and content-type condition, and a key namespace you control (never let the client choose the full key, or they will overwrite someone else's object). Then have S3 notify you (event notification to SQS/Lambda) rather than trusting the client to tell you it finished. Storage classes and lifecycle rules are the cost lever: Standard for hot, Intelligent-Tiering when access patterns are unknown, Glacier tiers for archives, with lifecycle rules to transition and expire — plus a rule to abort incomplete multipart uploads, which silently accumulate real cost. Security: block public access at the account level, use bucket policies plus SSE-KMS, enable versioning and, for critical data, Object Lock; enable access logging or CloudTrail data events so you can answer "who read this object".

- **Why it matters** — Direct-to-S3 uploads and lifecycle policies are two of the most common missed wins.

- **Follow-ups** — Why must you control the object key? How do you know an upload completed? What is quietly costing money in an old bucket?

- **Senior signal** — Presigned uploads with constraints plus event-driven completion, and the incomplete-multipart cost detail.

