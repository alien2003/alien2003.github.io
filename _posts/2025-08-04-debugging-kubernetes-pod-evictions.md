---
title: "Pod evictions when nothing on the dashboard is wrong"
date: 2025-08-04 09:30:00 +0000
tags: [kubernetes, sre, kubelet, cgroups, oom, debugging]
---

You can usually find the cause of a pod eviction in five minutes.
`requests` not set. JVM heap leak. Log volume past
`ephemeral-storage`. The kubelet's own log line tells you which.

This post is about the other kind. Every pod has correct requests
and limits. Dashboards look fine. `free -m` says there's plenty of
memory. Pods still die in waves at 14:23 on a Tuesday, and there is
no Friday-night-pager glory to make up for it.

<!--more-->

A bit of vocabulary before the gory bits, because confusing these two
costs hours.

The **Eviction API** is what `kubectl drain` uses. Cooperative,
honors `PodDisruptionBudget`, runs from the control plane.
**Node-pressure eviction** is the kubelet on a worker, acting alone,
based on host-level signals it reads from cgroupfs. Different code path,
different policy, different consequences. The kernel **OOM killer** is a
third thing entirely; it doesn't know what a pod is.

When pods die "too fast for the kubelet to log", that's the kernel.
When pods die in clean waves of two or three with `Evicted` status,
that's the kubelet. Both can fire on the same node within seconds.

## The signal isn't RSS, it isn't `free`, and dashboards lie about it

Defaults from
[`pkg/kubelet/eviction/defaults_linux.go`][defaults]:

```text
memory.available  < 100Mi
nodefs.available  < 10%
nodefs.inodesFree < 5%
imagefs.available < 15%
imagefs.inodesFree < 5%
```

`memory.available` is computed from the node's root cgroup as

```text
memory.available := capacity[memory] − memory.workingSet
```

and `workingSet` is read from cgroupfs, not from `/proc/meminfo`. On
v1 it's `memory.usage_in_bytes − total_inactive_file`; on v2,
`memory.current − inactive_file` from `memory.stat`. The kubelet ships
a shell reproduction at
[`/examples/admin/resource/memory-available.sh`][memscript]. Keep a
copy on each node. When production goes sideways you want a tool
that prints the same number kubelet sees.

Working set is **bigger than RSS** by exactly the size of the
`active_file` page cache. Which leads to the next part.

## The `active_file` page-cache trap

Filed as [kubernetes#43916][issue43916] in 2017, still open.

The kernel's page-cache reclaim list has two halves: `inactive_file`
and `active_file`. Both are page cache, both reclaimable. The kernel
demotes pages from active to inactive under pressure and then reclaims
from the inactive end. The kubelet subtracts `inactive_file` from
working set on the assumption that "active" means in-use. That
assumption is wrong for any workload that re-reads its working set.

A second `read()` of the same page promotes it to active. Index scans,
Parquet readers, Prometheus remote-read, anything mmap-heavy. They
all grow `active_file` while RSS holds steady. The kubelet then sees a
node it considers full of memory pressure that the kernel would happily
reclaim if asked.

Shape of the issue, on a quiet test node:

```bash
$ awk '$1 ~ /^(rss|active_file|total_inactive_file)$/' \
    /sys/fs/cgroup/memory/memory.stat
rss 482344960
active_file 12058624
total_inactive_file 9854976

$ dd if=/var/log/syslog of=/dev/null bs=1M count=512 status=none
$ dd if=/var/log/syslog of=/dev/null bs=1M count=512 status=none

$ awk '$1 ~ /^(rss|active_file|total_inactive_file)$/' \
    /sys/fs/cgroup/memory/memory.stat
rss 482344960          # unchanged
active_file 530378752  # +500MB cache, all "active"
total_inactive_file 23097344
```

That 500 MB now counts against `memory.available`. Across a busy node
with several pods doing the same trick, you can lose multiple GB of
apparent capacity to data the kernel would throw away if it needed to.

Mitigations are all bad. Dropping caches works (`echo 1 >
/proc/sys/vm/drop_caches`) and hurts every other tenant on the host;
do not put it in cron. Bounding the workload's own cgroup with
`memory.max` keeps its cache local. cgroup v2 plus the `MemoryQoS`
feature gate (alpha as of 1.27, see [the announcement][memqos]) lets
the kernel apply `memory.high` back-pressure before kubelet ever sees
node-level pressure, but you have to be on a recent enough kubelet,
recent enough kernel, and willing to run an alpha gate.

## tmpfs `emptyDir` is a stealth eviction generator

`emptyDir: {medium: Memory}` is a tmpfs. Files written to it are
anonymous from the cgroup's perspective, so they count against the
writing container's `memory.workingSet` (and therefore its
`memory.limit` if set) and against the node's `memory.available`
calculation.

If `sizeLimit` is omitted, the tmpfs grows up to node-allocatable
memory by default. A pod that writes 30 GiB to `/dev/shm` on a 32 GiB
node has, from the kubelet's perspective, just made the node go full.
Eviction ranks by usage-over-request, more on that next, and the
offender's "request" is whatever its containers declared, which almost
never includes the tmpfs. Innocent neighbours get evicted. The pod
eating the RAM is fine.

Both fields, always:

```yaml
volumes:
  - name: scratch
    emptyDir:
      medium: Memory
      sizeLimit: 256Mi
containers:
  - name: app
    resources:
      requests: { memory: 512Mi }   # must include the tmpfs ceiling
      limits:   { memory: 768Mi }
```

`sizeLimit` is enforced by the kernel via `tmpfs -o size=`, so writes
past it return `ENOSPC` and the pod gets evicted by the kubelet's
local-storage logic with a clean reason. If the container's own memory
limit is below the tmpfs size, the cgroup OOM kills the writing
process before any node-level event fires, and you get a confusing
crash with no `Evicted` pod state.

## Eviction ranking is not OOM ranking

Two algorithms. They use different signals and they routinely target
different pods.

The kubelet's pod ordering, from
[`pkg/kubelet/eviction/helpers.go`][helpers]:

```go
orderedBy(exceedMemoryRequests(stats), priority, memory(stats)).Sort(pods)
```

Pods over their memory request go first, then by `PriorityClass`, then
by absolute usage above request. QoS class is not in this comparator.
People assume `BestEffort` always dies first; it does, but only because
its request is zero so it always exceeds requests by definition once it
uses anything at all.

The kernel's ordering is `oom_score`, which is a function of RSS as a
fraction of total RAM, adjusted by `oom_score_adj`. The kubelet writes
those values from
[`pkg/kubelet/qos/policy.go`][qospolicy]:

```go
KubeletOOMScoreAdj    = -999
KubeProxyOOMScoreAdj  = -999
guaranteedOOMScoreAdj = -997
besteffortOOMScoreAdj = 1000
// burstable:
oomScoreAdjust = 1000 - (1000 * containerMemReq / memoryCapacity)
```

The Burstable formula is the part that surprises people. A container
that requests 10% of node memory gets `oom_score_adj = 900`. One that
requests 1% gets 990. **Asking for less makes the kernel more likely to
kill you for the same RSS**, which is the opposite of what most people
expect from "I'll just request a little, it's fine".

Conversely, a Burstable pod with a huge request and currently low RSS
has a small `oom_score_adj` and is unlikely to be picked by the
kernel. It is the very *first* candidate for the kubelet's manager
if it's over its current usage relative to request. So under
sudden pressure you can lose two pods to the same event: the kernel
takes one, the kubelet wakes up ten seconds later and takes another.

## The 10-second polling gap

The eviction manager runs `synchronize()` on a `monitoringInterval`
that defaults to 10s
([`eviction_manager.go`][evman]; the historical thread is at
[kubernetes#30173][issue30173]). Between polls it relies on the kernel
memcg notifier (`cgroup.event_control` on v1, `memory.events` on v2)
to wake it early, but only for thresholds the kubelet wired the
notifier for, which means **only `memory.available`** gets the fast
path. `nodefs`, `imagefs`, and `pid.available` are 10-second polls,
period.

A spike that exhausts memory faster than the polling interval races
the kernel OOM killer and loses. There's no fix. Headroom is the
defense: oversize the threshold, size requests honestly, and don't
pack nodes to 95%.

## Allocatable quietly subtracts the eviction-hard threshold

From [Reserve Compute Resources][allocatable]:

```text
Allocatable = Capacity − kube-reserved − system-reserved − eviction-hard
```

So raising `memory.available` from `100Mi` to `1Gi` to "be safer" cuts
schedulable memory by 900 MiB on every node in the cluster. Across a
fleet of one hundred 8-core nodes that's ~88 GiB of capacity that just
disappeared. `kubectl describe node` doesn't tell you why allocatable
dropped; you have to remember you changed the threshold.

## The ghost pressure window

`--eviction-pressure-transition-period` defaults to **5 minutes**.
After pressure clears, the node holds the `MemoryPressure=True`
condition (or `DiskPressure`/`PIDPressure`) for the full window, which
the scheduler honors as a `NoSchedule` taint.

In practice you see a node "stuck" in MemoryPressure with `kubectl top
node` reporting 30% use, four minutes after the pressure cleared. A
rolling deploy stalls because half its target nodes are silently
refusing pods. The cluster autoscaler refuses to scale the node *down*
because apparently-pressured nodes aren't removal candidates.

The window is there to prevent flapping. Tune it down on noisy nodes
(`--eviction-pressure-transition-period=30s`) at the cost of more
scheduler churn.

## Minimum-reclaim defaults to zero, which is why you see waves

After evicting a pod, the kubelet checks the signal again. If the
threshold is no longer crossed, it stops. With
`--eviction-minimum-reclaim=0` (the default), the death of one
small pod is enough to satisfy the predicate even if the freed memory
is a rounding error.

A slow leak in some other workload then trips the threshold every
~30 seconds, the kubelet evicts one pod, the leak resumes, the
threshold trips again, and on it goes. Evictions get spread across
many pods, masking the actual leaker. Set a real reclaim:

```yaml
evictionMinimumReclaim:
  memory.available: "500Mi"
  nodefs.available: "1Gi"
```

Now each round must produce real headroom, which slows the cadence and
concentrates evictions on fewer larger pods. The leaker surfaces
faster.

## Per-pod ephemeral-storage limits evict before nodefs ever signals

[Local Storage Capacity Isolation][localstorage] went GA in 1.25.
`ephemeral-storage` requests/limits work like memory: exceed yours and
the kubelet evicts your pod, with no node-level signal at all. Per-pod,
summed across container writable layers, stdout/stderr logs, and
non-memory `emptyDir` volumes.

The classic victim is a noisy logger with `limits.ephemeral-storage:
1Gi`. A burst of error logs to stdout at 50 MB/s blows past it in 20
seconds and the pod dies with reason `Pod ephemeral local storage
usage exceeds the total limit`. The disk is fine. The other pods are
fine. Look in the pod's events, not the node's.

## Hard eviction ignores graceful shutdown

A hard threshold trip is `SIGKILL` after a 0-second grace period. The
container's `preStop` hook does not run, `terminationGracePeriodSeconds`
is ignored, and `PodDisruptionBudget` is not consulted. Soft thresholds
respect `--eviction-max-pod-grace-period`, which is a kubelet flag (not
a pod field) and which **caps** whatever the pod declared. If your pod
asks for 600s and the kubelet caps at 30s, you get 30s.

Stateful workloads that need to flush on shutdown have to do it on
`SIGTERM` from the drain path, not the eviction path. The two paths
are not interchangeable, even though the API surface looks similar.

## Filtering for kubelet-driven evictions specifically

Since 1.25, the kubelet sets a `DisruptionTarget` condition on evicted
pods, with `reason=TerminationByKubelet`. Per-pod-limit evictions
don't get this. Those are deemed the pod's fault and shouldn't be
retried.

```bash
kubectl get pods -A -o json | jq -r '
  .items[]
  | select(.status.conditions[]?
    | select(.type=="DisruptionTarget" and .reason=="TerminationByKubelet"))
  | "\(.metadata.namespace)/\(.metadata.name) on \(.spec.nodeName)"
'
```

Same `DisruptionTarget` type covers `PreemptionByScheduler` and
`EvictionByEvictionAPI`. Different reasons, different remediations.
A useful field in `kube-state-metrics`.

## A real one: five things wrong at once

We had a production cluster running maybe forty nodes, m5.4xlarge,
nothing exotic. A data team rolled out a new analytics service that
read large Parquet files (8–12 GB each) off an internal blob store on
an hourly cadence. Memory request 16Gi, limit 24Gi, sized off a load
test. They tested it for a week in staging. Looked great.

Production rolled the change Tuesday morning. By 14:00 we had pods
flapping on three nodes. Not the analytics pods themselves: random
neighbours. A Go web service. A Prometheus exporter. The cluster's own
metrics-server, twice.

`kubectl describe node` showed `MemoryPressure: True`. Fine,
expected when the kubelet evicts. But `kubectl top node` reported 62%
memory used. `free -m` on the node, same number. No OOM in `dmesg`.
Pods reported `status.reason: Evicted` and `message: The node was low
on resource: memory`.

That's the first head-scratch. The kubelet says low on memory. The
node says it has plenty.

I'd already learned from §1 to not trust `free -m`, so I went to
`memory.workingSet` directly. From the node's stats summary endpoint:

```bash
$ kubectl get --raw /api/v1/nodes/agumon-prod-03/proxy/stats/summary \
  | jq '.node.memory'
{
  "time": "2025-07-22T14:13:22Z",
  "availableBytes": 89128960,        # 85 MiB. yikes
  "usageBytes": 67284598784,         # 62 GiB, matches free -m
  "workingSetBytes": 67195469824,    # 62.5 GiB
  "rssBytes": 18043871232,           # 17 GiB
  "pageFaults": ...
}
```

`workingSetBytes` was 62.5 GiB on a 64 GiB node. `rssBytes` was 17 GiB.
The 45 GiB delta is page cache that the kubelet was counting against
me. I'd never seen that wide a gap before. Reading
`/sys/fs/cgroup/memory/memory.stat` confirmed it: `active_file` was
sitting at ~38 GiB.

So this was §2: active_file trap, exactly the read-heavy Parquet
workload pattern from #43916. The analytics service was reading
the same files multiple times per run (Parquet predicate pushdown +
partition pruning, two passes over each file), promoting pages to
active. Cache the kernel would gladly drop, that the kubelet considered
real load.

Cool, so why are *neighbours* getting evicted instead of the analytics
pod? Section §4. The kubelet's ranker is `(exceedMemoryRequests,
priority, memory)`. The analytics pod requested 16Gi and was using ~12
GiB RSS, so it was *under* request. The Go web service requested 256Mi
and was using ~290 MiB. Over request by a hair, no PriorityClass set,
and absolute usage above request was 35 MiB. First in the order. Goodbye.

Then there was the second weird thing in the timeline. Out of every
five eviction events, one had no kubelet log entry at all in the
preceding 10 seconds. `dmesg -T` had it:

```
[Tue Jul 22 14:18:47 2025] oom-kill:constraint=CONSTRAINT_MEMCG,
  nodemask=(null), cpuset=...,task=otel-collector,pid=2891034,
  uid=65532
[Tue Jul 22 14:18:47 2025] Memory cgroup out of memory: Killed process
  2891034 (otel-collector) total-vm:1247892kB, anon-rss:412348kB,
  oom_score_adj:961
```

`oom_score_adj: 961`. That's the Burstable formula from §4 hitting an
otel-collector with `requests.memory: 100Mi` on a 64 GiB node:
`1000 − 1000 × 100/65536 ≈ 998`, close enough. The collector wasn't
even leaking; it was a bystander whose request had been set conservatively
(§4 again, small requests raise oom_score_adj). The kernel grabbed it
during the 10-second window between kubelet polls (§5) when the active_file
spike pushed `memory.available` straight through the floor.

So now I had two kill paths firing for one root cause. We were also
seeing the wave behaviour from §8: the kubelet would evict one
neighbour, free 290 MiB, declare victory, and 12 seconds later the
analytics service would issue another file read and active_file would
climb again. We watched seven separate eviction events on a single
node in two minutes, each freeing a tiny amount.

And the cluster-autoscaler refused to scale up because the affected
nodes still had `MemoryPressure=True` from §7's 5-minute window. The
nodes looked busy to the scheduler but had 30% RSS by the time autoscaler
checked. New nodes weren't coming online; tainted nodes were rejecting
the rescheduled pods. Pods sat Pending for four minutes at a time.

The fixes, in priority order. The first three got us through that day:

```yaml
# 1. minimum-reclaim non-zero, so each eviction round actually does something
evictionMinimumReclaim:
  memory.available: "1Gi"

# 2. transition period down so cleared nodes start accepting pods again
evictionPressureTransitionPeriod: "45s"

# 3. analytics pod gets a memory.high via cgroup v2 MemoryQoS so its
#    page cache can't blow past its limit
featureGates:
  MemoryQoS: true
```

The lasting fix was in the analytics service: a `--cache-dir` flag we
hadn't been using that pointed Parquet caching at a sized
`emptyDir: {medium: Memory, sizeLimit: 4Gi}` with the matching memory
request and limit, so the cache was bounded to that container's
cgroup instead of being node-global page cache. Pages still get cached;
they just no longer eat into other tenants' eviction budget.

Total damage: about three hours of production weirdness, six hours of
debugging, and one shared post-mortem with a slide titled *"things
`kubectl top` will never tell you"*. The author of the analytics
service had done nothing wrong by any reasonable reading of the
kubernetes docs. The system was correct as designed and pathological
in interaction.

## What I check first now

When pods evict in waves and the dashboards say nothing's wrong, in
this order: `workingSetBytes` minus `rssBytes` (cache delta), then
`active_file` from `memory.stat` (the §2 number), then the kubelet log
for the 10s before each eviction (`§5` race), then the kubelet's
ranker on the surviving versus evicted pods (`exceedMemoryRequests`
first), and then `--eviction-minimum-reclaim` to see if I've been
papering over a leak with wave evictions.

If none of that fits and you've still got phantom evictions, you're
probably looking at a memcg accounting bug in your kernel. Bisect the
kernel before you bisect the workload.

[defaults]: https://github.com/kubernetes/kubernetes/blob/master/pkg/kubelet/eviction/defaults_linux.go
[memscript]: https://kubernetes.io/examples/admin/resource/memory-available.sh
[issue43916]: https://github.com/kubernetes/kubernetes/issues/43916
[memqos]: https://kubernetes.io/blog/2023/05/05/qos-memory-resources/
[helpers]: https://github.com/kubernetes/kubernetes/blob/master/pkg/kubelet/eviction/helpers.go
[qospolicy]: https://github.com/kubernetes/kubernetes/blob/master/pkg/kubelet/qos/policy.go
[evman]: https://github.com/kubernetes/kubernetes/blob/master/pkg/kubelet/eviction/eviction_manager.go
[issue30173]: https://github.com/kubernetes/kubernetes/issues/30173
[allocatable]: https://kubernetes.io/docs/tasks/administer-cluster/reserve-compute-resources/
[localstorage]: https://kubernetes.io/blog/2022/09/19/local-storage-capacity-isolation-ga/
