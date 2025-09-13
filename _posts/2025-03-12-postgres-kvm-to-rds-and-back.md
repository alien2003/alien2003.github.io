---
title: "From KVM Postgres to RDS and back: a migration that should not have worked"
date: 2025-03-12 09:15:00 +0000
tags: [postgres, rds, dms, aws, migration, devops, postmortem]
---

The database had been running on three KVM domains for nine years. It was
provisioned by [FAI][fai] off a debian-installer preseed that nobody on
the current team had written, configured by a Puppet module last
meaningfully edited in 2019, and patched only when the SRE on call had
the energy. PostgreSQL 9.6, on Debian 8 (jessie), past the end of LTS,
past the end of ELTS, past the end of any reasonable explanation. The
boxes were fine. They were always fine. They had been fine for so long
that nobody touched them on principle.

Then somebody from finance asked why we had three idle Xeons in a rack
in Frankfurt, and we got eight months to move it to RDS.

I am writing this in March 2025 about a migration that started in
early 2023 and ended, eventually, with the same database back on three
new KVM domains in late 2024. We did the round trip. Both directions
hurt. This is the long version of what broke.

<!--more-->

## The cast

What we were moving. About 1.4 TiB of data across two logical
databases, around 6,500 tables. PostgreSQL **9.6.24** on Debian
8.11, PGDG repo rather than stock jessie. One primary, two
streaming replicas, all on libvirt/KVM with raw LVM volumes on
local SSD. pgbouncer in transaction mode in front of the primary,
roughly 2,400 client connections collapsed to about 80 backend. A
Puppet module that managed `postgresql.conf`, `pg_hba.conf`, and
the boot-time symlinks that pointed `/var/lib/postgresql/9.6/main`
at the LVM mount. The same Puppet module also installed a
tablespace on a second LVM volume called `fast_ssd` for an
analytics schema. Custom code: 11 functions in `plperlu`
(untrusted), 3 functions in `plpython2u`, and a single ill-advised
function in `pltclu` that printed a date in Cyrillic. Three FDW
links to other Postgres clusters using `postgres_fdw`, one of
which pointed at a MySQL via `mysql_fdw` from the
[EnterpriseDB packages][edb]. A scheduled job runner that was just
a cron entry on the primary running `psql -c 'SELECT
vacuum_analyze_partitions()'` every twenty minutes. And an
application written by people who had since left the company and
who used `LISTEN`/`NOTIFY` for a job-queue pattern. A small thing.
It mattered later.

What we were moving to. RDS for PostgreSQL, two-AZ Multi-AZ,
`db.r6g.4xlarge`, storage `gp3` 2 TiB, eventual plan to upgrade to
PG 15 once we got there. RDS Proxy in front for connection
management, replacing pgbouncer.

## Why we moved

The reason in the slide deck was *consolidation onto cloud-native primitives*.
The reason in the room was that nobody under thirty in the company knew
what `apt pinning` was anymore and we needed to stop pretending the
jessie box was a strategy. Fair. The boxes were also overdue for
hardware replacement and capex was harder to defend than opex that year.

I do not have a strong opinion about that decision. I have very strong
opinions about the next twelve weeks.

## TO RDS, the things that broke

### 1. The dump that wouldn't restore (tablespaces)

First plan was the obvious one: `pg_dump --schema-only` on production,
restore to RDS, set up DMS for full load + CDC, cut over.

```text
$ psql -h tentomon-prod.xxx.eu-central-1.rds.amazonaws.com -U postgres -f schema.sql
psql:schema.sql:18241: ERROR:  permission denied to create tablespace "fast_ssd"
HINT:  Must be superuser to create a tablespace.
```

RDS does not give you superuser. There is no `postgres` superuser; the
master user gets `rds_superuser`, and `rds_superuser` is not a real
superuser, it's a role with a curated set of grants. You cannot
`CREATE TABLESPACE` against an arbitrary path because the only path
RDS will accept is under `/rdsdbdata/db/base/tablespace`, and even
then the [RDS docs][rds-tblsp] say outright:

> RDS for PostgreSQL supports tablespaces for compatibility purposes,
> but due to all storage being on a single logical volume, they cannot
> be used for I/O splitting or isolation.

In other words: you can create a tablespace, but it does literally
nothing. The dump's `TABLESPACE fast_ssd` clauses on every CREATE
TABLE in the analytics schema either fail (if you don't pre-create the
matching tablespace name) or succeed and silently lie (if you do).

`pg_dump --no-tablespaces` would have spared me, and is what I used in
the end. The fix is one flag. The annoying part was the discovery: I
spent a Friday afternoon convinced our schema dump was somehow
corrupted, looking at it line by line, before I noticed how many
tables had the `TABLESPACE` clause attached. Puppet had been
provisioning that tablespace into the bootstrapping for years. None of
us thought about it because none of us had touched it.

### 2. plperlu and plpython2u: the rewrite trail

Next discovery, courtesy of the same dump. RDS has `plperl` (trusted)
and `plpython3u` (depending on engine version). It does not have
`plperlu`, the untrusted variant, which is precisely where every
function we'd written had landed because the original author needed
`require LWP::Simple` for a one-line HTTP call from inside the
database. (Yes, I know.) From the [Aurora extensions table][aurora-ext]
explicitly: *"some extensions are no longer supported, such as
adminpack, plperlu, pltclu, pageinspect, and xml2."* The same
restriction holds for community RDS PostgreSQL on the relevant
versions.

So the eleven `plperlu` functions had to be rewritten. `plpython2u`
was worse: not only is the untrusted variant gone, plain `plpython3u`
on the destination meant porting from Python 2 to Python 3, in 2024,
years after Python 2's funeral. One of the functions was a homemade
parser for a CSV format produced by a printer in Belgium that nobody
wanted to think about. It worked. It had worked for eight years.
It used `print` as a statement.

The single `pltclu` function we deleted. It was never called.

Rewrites in priority order:

1. Functions called from triggers got `plpgsql` rewrites. Most were
   simple enough.
2. Functions called from cron-style jobs got moved out of the database
   entirely into a small Python service running on the same VPC,
   talking to the new RDS via psycopg. Better placement anyway.
3. The Belgian-printer parser got a `plpython3u` rewrite, tested
   against a 50,000-line corpus pulled from `pg_largeobject`, and
   merged with three reviewers because none of us trusted it.

This consumed seven weeks. It was not the most technically interesting
seven weeks of my career.

### 3. glibc collation, the silent corrupter

The boxes were on Debian 8, glibc 2.19. RDS PostgreSQL runs on a
managed Amazon Linux base with a much newer glibc, well past the
**2.28** boundary where glibc rewrote its locale collation tables to
match ISO 14651:2016 and Unicode 9. This is the now-famous
[glibc 2.28 collation break][crunchy-glibc] that has bitten every
serious Postgres operator who's done a major OS upgrade since 2018.

Symptoms are bad in a specific way. Indexes don't *appear* corrupt.
`pg_amcheck` may not flag them. Queries return wrong results. A
`SELECT … WHERE name = 'Müller'` finds the row on the source and
misses it on the destination, because the index was built under one
sort order and is being walked under another. The tell is sometimes:

```text
WARNING:  index "users_name_idx" contains corrupted page at block 0
DETAIL:  Failed to find parent tuple for heap-only tuple at (12, 4)
```

…but more often, no tell at all. The index just lies.

If you build the dump under jessie's collation and restore it to a
host with newer collation, every index on a `text` column with a
non-C collation is suspect. The workarounds are all painful. You
can REINDEX everything post-restore. We did. On 1.4 TiB the
initial run took 11 hours wallclock with `REINDEX (CONCURRENTLY)`,
with parallelism limited by what RDS would tolerate without the
Performance Insights graph turning red. You can build with
`lc_collate=C` on the destination, which buys you byte-order sort
and nothing else; often you cannot, because some app somewhere
relies on locale-aware sort. Or you can switch to ICU collations,
which were available since PG 10 and are versioned, so Postgres
can warn you when the version changed underneath an index. We
could not use ICU on the source because 9.6 had no usable ICU
support, but we did use it on the destination to inoculate against
the next migration. (Foreshadowing.)

I learned later that PG 15+ tracks collation versions per index and
emits `WARNING: database "x" has a collation version mismatch` in the
logs. We weren't going to PG 15 yet. We were doing a like-for-like
upgrade to 9.6 on RDS first because that's all DMS would let us
replicate cleanly with this much custom code on the source. So no
warning. Just wrong answers.

### 4. The replication slot that filled the disk

Plan was to use [native logical replication][rds-logrep] from on-prem
to RDS for the cutover, with DMS as the fallback. Native logical
replication needs PG 10+ on both ends. We were on 9.6 on the source.
Fine, says me, we can use [pglogical][pglogical] which has a
9.4-compatible decoder and is supported on RDS as an extension.

The setup looks reasonable:

```sql
-- on RDS, in the cluster parameter group
rds.logical_replication = 1
max_replication_slots   = 20
max_wal_senders         = 20

-- on source (jessie box)
wal_level               = logical
max_replication_slots   = 10
max_wal_senders         = 10
```

(Both static. Both require a restart. The reboot of the cluster
parameter group on RDS took about 90 seconds; the reboot on the
jessie primary took about 90 seconds plus thirty minutes of failover
choreography because the puppet module hadn't been told what to do
with a logical-replication-shaped postgres in 2019.)

The fun part came two days into the initial sync. A pglogical worker
on the destination side hit a malformed row (a `bytea` column whose
length on source was reported one way and on destination was decoded
another way, an interaction with `bytea_output = escape` that I won't
re-litigate here) and wedged. Default behavior: the slot stays open,
the apply worker keeps trying, WAL on the source keeps accumulating
because the slot is alive and unconsumed.

Twelve hours later the on-prem primary's `pg_xlog/` was at 340 GiB.
`max_slot_wal_keep_size` did not exist in 9.6 (that's a PG 13
parameter) so there was no soft cap. The disk filled at 04:11 local.
The primary stopped accepting writes. We failed over to the
synchronous replica (also out of WAL space, because synchronous, but
the failover worked because of how RDS doesn't, it's a Patroni thing,
shoutout to whoever set that up). Application took ~9 minutes of
errors before fully reconnecting through pgbouncer.

The lesson is simple and the docs say it plainly: an inactive
logical-replication slot retains WAL forever. RDS [says it][rds-slots],
the AWS DMS [pre-flight assessment][dms-assessment] checks
`max_slot_wal_keep_size`, the [pglogical README][pglogical] says it.
We knew. We had a runbook entry. The runbook entry was for the
destination, not the source. The destination was the safe one. RDS
will not let WAL eat its own storage past a certain point on PG 13+.
Our **source** was 9.6 and had no such governor.

After that we wrote a 5-minute cron on the source that paged if any
slot's `pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)`
exceeded 50 GiB. It paged twice more during the migration. Both times
the apply worker had wedged on something we hadn't anticipated.

### 5. REPLICA IDENTITY (or: why my deletes evaporated)

About week six of CDC, with backfill done and replica caught up to
within a second, somebody on the application team noticed that a
specific cleanup job ran on the source nightly, deleted ~50,000 rows
from a `session_log` table, and on the RDS side those rows were
still there. Insert lag: zero. Update lag: zero. Delete lag:
infinite, because the deletes simply weren't being applied.

Logical replication needs a way to identify the row being deleted on
the apply side. It looks at the source's REPLICA IDENTITY setting:

```sql
ALTER TABLE session_log REPLICA IDENTITY FULL;  -- or DEFAULT, or USING INDEX
```

`DEFAULT` means "use the primary key". The `session_log` table had no
primary key. Nine years on, it had grown a `created_at`-based
candidate but never had it promoted. With no PK, pglogical/native
logical replication can decode the DELETE from the WAL but cannot
emit it on the wire because there's nothing to put in the WHERE
clause on apply. The apply worker either drops it silently or errors,
depending on version and config. In our case, dropped. No log entry.
Nothing.

The DMS pre-flight check
[*"REPLICA IDENTITY FULL"*][dms-assessment-rep] flags this exact
case as "Detecting tables using REPLICA IDENTITY FULL and either
changing the REPLICA IDENTITY setting or switching to a test_decoding
plugin." Useful for DMS users; we weren't on DMS for this segment;
the same trap applied. We ran:

```sql
SELECT n.nspname, c.relname, c.relreplident
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND c.relreplident NOT IN ('d','i')
  AND n.nspname NOT IN ('pg_catalog','information_schema','pglogical');
```

…and then for any row where there was no PK or unique index, set
`REPLICA IDENTITY FULL`. Which makes every UPDATE/DELETE log the full
old row, which roughly **doubles the WAL volume** for those tables.
On `session_log`, which we had been deleting cheerfully at 50k/night
without thinking about it, this turned the next day's WAL into ~14
GiB of mostly-DELETE traffic, which the apply worker then chewed
through at maybe 4 MiB/s, and we were behind again for two days.

We added a `BIGSERIAL PRIMARY KEY` column to seven tables, took the
brief locks during a low-traffic window, and went back to `DEFAULT`
identity. The proper fix had been sitting in the backlog under the
title "add PKs to legacy tables" since 2017. It got merged on a
Tuesday afternoon under the title "fix CDC".

### 6. DMS, briefly, and why we left it

We did try DMS for the analytics schema, separately, because
pglogical didn't love the size of one particular partitioned table
(2,400 partitions, ~80 GiB). DMS comes with its own family of
problems, all documented if you know where to look. JSONB goes to
CLOB by default. Source has a `jsonb` column, target also has a
`jsonb` column, and DMS will happily put a stringified
representation through a CLOB pipe and either truncate or rewrite
whitespace, depending on the LOB mode. [Limited LOB mode][dms-lob]
caps individual LOBs at 100 MB and pre-allocates memory for them;
Full LOB mode handles arbitrary sizes but is dramatically slower.
We had values up to 8 MB. Limited LOB at 16 MB worked, with a
careful eye on the memory footprint of the replication instance.

Sequences are not migrated. DMS does not transfer sequence current
values; the cutover script has to `setval()` every sequence on the
target to `MAX(id) + buffer` before redirecting writes. Forget one
and you hit a primary key collision the moment the app inserts.

Materialised views must be re-created manually on the target, per
the assessment report. We had four. We forgot one. It surfaced
three weeks after cutover when a dashboard went blank.

DDL is not replicated unless you turn on a specific event trigger.
We froze schema changes for the duration and added a Slack bot
that yelled when anybody tried to `ALTER TABLE` on prod.

The combined behavior with our `bytea` and `jsonb` columns made me
nervous enough to keep DMS only for that one partitioned analytics
table where the diffs were simpler, and run pglogical for the rest.
Two replication paths, two sets of monitoring, two sets of failure
modes. Worth it for stability of the OLTP path.

### 7. Cutover night, and pgbouncer to RDS Proxy

Cutover was scheduled for a Saturday at 02:00 UTC. The plan:

```text
00:30  freeze deploys, last sanity check
01:30  switch app pgbouncer to read-only mode
01:45  drain writes, verify pglogical lag < 5s on all subscribers
02:00  flip DNS to point at RDS Proxy endpoint
02:05  sequence resync (setval everything)
02:15  unfreeze, monitor for 60 minutes
03:30  declare victory or roll back
```

The DNS flip went fine. The application reconnected fine. Latency
dashboards looked fine. Then about ten minutes in, we started seeing
weird behavior from a Java service: occasional 30-second hangs on
queries that should have taken milliseconds, then resumed. Not
errors. Hangs.

The Java service was using Hibernate, which by default likes to use
named server-side prepared statements. Hibernate had been talking to
pgbouncer in transaction-pooling mode for years, and pgbouncer in
transaction mode famously [breaks server-side prepared statements][pgb-prepared].
The team had worked around that with `prepareThreshold=0` in the JDBC
URL. Fine.

RDS Proxy has its own behavior. Per the
[RDS Proxy pinning docs][rds-pinning], for PostgreSQL the proxy
will *pin* a client connection to a backend (effectively turning
off multiplexing for that client) when it sees `SET` commands
other than transaction-scoped, prepared statement
creation/management, temporary tables, sequences, or views,
declared cursors, `LISTEN` on a notification channel, or
session-state-altering library loads. Among other things.

When a connection gets pinned, it stays bound to one backend for the
rest of the session. Under load, you get a sudden cliff: the proxy
runs out of unpinned connections to multiplex over, and new clients
queue waiting for one. The 30-second hangs were `MaxConnectionsPercent`
queueing, courtesy of an internal `SET work_mem` that Hibernate or
some library it pulled in was issuing on every connection acquire to
match what we'd had on pgbouncer.

We rolled back to a fronting pgbouncer in front of RDS Proxy
(yes, pgbouncer in front of RDS Proxy in front of RDS, three
connection layers, deeply unaesthetic, *worked*) for a week while the
app team excised the per-session SETs and moved them into the
RDS-side default parameter group. After that we removed the pgbouncer
hop. CloudWatch metric to monitor:
`DatabaseConnectionsCurrentlySessionPinned`. If that stays above zero
for any sustained period you have something issuing a pin trigger.

### 8. The LISTEN/NOTIFY queue, ghost edition

This one's small but I keep telling it because I find it funny in
retrospect.

A worker process in the background-jobs service used `LISTEN
job_ready` on a long-lived connection to receive NOTIFYs from a
trigger on the `jobs` table. Cute pattern, fine for low scale, this
was low scale.

Post-cutover the worker silently stopped processing jobs. Connection
was up, the LISTEN was registered (we checked `pg_listening_channels()`),
the trigger was firing on inserts, the NOTIFY was being issued. The
worker just never got a notification.

What it had actually done was: open a connection through RDS Proxy,
issue `LISTEN job_ready`, get its connection [pinned][rds-pinning] (LISTEN
pins a connection), and sit there. NOTIFY pushes are per-backend. The
backend the worker was pinned to was *fine*. The triggers, however,
were running on whichever backend the writer pool happened to grab
for the relevant transaction, which was a *different* backend each
time, and notifications don't cross backend boundaries except via the
shared `pg_notification_queue`. Which they do. But not in a way that
fires on a pinned proxy session in real time the way it had on
pgbouncer's stable session-mode connection on the old setup.

Resolution: move the worker to connect directly to the writer
endpoint, not through the proxy. RDS Proxy is fundamentally not built
for long-lived single-session listeners and the docs say so if you
read closely. The fix was four lines of config. Diagnosing it took an
afternoon of perplexed staring.

## Eight months on RDS

Things were fine. Latency from our app fleet (in our colo, not in
AWS) to RDS in eu-central-1 was around 11ms p50 over Direct Connect,
which was about three times what we'd had on the LAN side, and the
app teams had to retune one or two N+1-prone services, but nothing
broke that wasn't fixable. Performance Insights was genuinely
useful. The on-call burden dropped because none of us were patching
jessie kernels anymore. Storage autoscaling triggered twice when an
analytics intern ran a `SELECT INTO` against a 600 GiB table; the
[autoscaling docs][rds-autoscale] mention a six-hour cooldown between
scale events which we hit on the second one and ate a brief storage
warning before it cleared. Fine.

What was not fine was the bill.

The headline was the instance. r6g.4xlarge Multi-AZ at on-demand,
plus 2 TiB of gp3 with provisioned IOPS, plus the RDS Proxy, plus the
read replica we ended up adding, plus the DMS instance we kept around
for the analytics schema, plus Direct Connect, plus data transfer to
the app fleet, plus snapshots, plus Performance Insights long
retention, plus CloudWatch logs at vended-logs pricing. Total monthly
came in at roughly **6.4x** the fully-loaded TCO of the three KVM
boxes including hardware amortization, power, hands, and the SRE
fraction. Reserved instances would have brought it closer to 4x, but
nobody wanted to commit a 3-year RI on an architecture we weren't
sure was the long-term answer.

That, plus a separate compliance question about data residency
from one of our larger customers that turned into a legal review
that turned into a data-locality requirement that RDS in Frankfurt
technically satisfied but politically did not, ended with a
steering-committee decision in April 2024: move it back. New hardware this time,
proper Debian 12 (bookworm), Patroni from day one, ZFS snapshots,
proper monitoring. We'd been forced into doing the unmaintained
stack a favor.

## BACK from RDS, the second set of disasters

If migrating *into* RDS is hard, migrating *out* is harder. RDS gives
you exactly two ways to get your data out continuously:

1. AWS DMS, which we had already learned to fear.
2. Native logical replication, where RDS plays the publisher and the
   on-prem cluster plays the subscriber.

What it does not give you is **physical replication out**. You cannot
`pg_basebackup` an RDS instance from outside. You cannot `pg_receivewal`
its WAL stream. You can issue `pg_dump`, which we tried first for
sanity, and which on a 1.4 TiB database took eleven hours and left us
needing seventeen hours of CDC catch-up before cutover. That doesn't
work for low-downtime cutover. So: native logical replication, again,
in reverse.

### 1. The publisher setup, in reverse

Now RDS is the source. To make RDS publish, you need (we'd already
done this, ironically, for the DMS direction):

```text
rds.logical_replication = 1
```

…in the cluster parameter group, plus a publication and a user with
the `rds_replication` role (per [the docs][rds-logrep-roles]):

```sql
GRANT rds_replication TO repl_out;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO repl_out;
CREATE PUBLICATION pub_all FOR ALL TABLES;
```

Then on the destination (the new on-prem PG 15 box):

```sql
CREATE SUBSCRIPTION sub_all
  CONNECTION 'host=tentomon-prod.xxx... port=5432 user=repl_out password=... sslmode=require'
  PUBLICATION pub_all
  WITH (copy_data = true, create_slot = true);
```

This worked. It was painfully slow. The initial COPY of 1.4 TiB over
Direct Connect at our committed bandwidth came out to about 38 hours
when I'd planned for 20. The bottleneck wasn't network; it was apply
single-threadedness on the subscriber. PG 16 has parallel apply for
streamed transactions; PG 15 has it only behind the
`streaming = parallel` option, which works for in-progress
transactions but not for the initial COPY. We were stuck with the
single apply worker per subscription doing the bulk import.

Workaround: split the publication. Three publications, three
subscriptions, three apply workers running in parallel, each
responsible for a non-overlapping subset of tables. Cut the COPY time
to ~16 hours. Operationally messier; you have to coordinate which
tables go where, and you cannot have a row referenced across
publication boundaries during initial copy without ordering issues.
It worked.

### 2. The aws_s3 calls in stored procs

Eight months on RDS had let one team get clever. They'd written a
nightly job that exported a reporting view to S3 using the
[aws_s3 extension][rds-aws-s3]:

```sql
SELECT aws_s3.query_export_to_s3(
  'SELECT * FROM v_daily_report',
  aws_commons.create_s3_uri('reports-bucket','daily.csv','eu-central-1'),
  options := 'format csv'
);
```

`aws_s3` is RDS-only. It is not a community Postgres extension. It
does not exist on the on-prem destination. The function call sits in
a SQL file that lives in the application repo and has been called
from a cron job for eight months, and on cutover day it would start
returning `ERROR: function aws_s3.query_export_to_s3 does not exist`.

We ported the export to a small Python service that ran outside the
database, talked to the new on-prem cluster, and wrote to S3 via
boto3. Same shape, same schedule. The migration of one function call
was four hours of work and felt like it should have taken twenty
minutes. There were three other places `aws_s3` had crept in. We
found two during the audit and one during the post-cutover smoke
tests when a lambda failed.

This is a category of damage that is hard to predict before you do
the move. RDS-specific extensions are sticky. Once teams discover
them they use them, because they are right there and they work, and
the assumption that "we'd never go back" calcifies into code.

### 3. pg_cron, but the wrong pg_cron

Similar shape. We had moved the in-database cron to `pg_cron`,
RDS-flavored, after the original on-prem cron-on-the-primary pattern
became unworkable on a managed instance you don't have a shell on.
Community `pg_cron` exists; the RDS variant has minor behavioral
differences around the `cron.database_name` config and around how it
handles failed executions. None of them break in obvious ways, but
the on-prem extension we installed (community `pg_cron` 1.6) parsed
one of our schedule expressions slightly differently and silently
ran a job hourly that had been running every six hours. We noticed
because the daily volume of an audit log shot up by 6x. (`pg_cron`
1.6 added [second-level scheduling][pgcron] in
`*/5 * * * * *`-style six-field expressions; one of our schedules had
been written assuming the old five-field parser, but the differences
were subtle enough to matter only in one case.)

Diff your schedules across versions before you cut over. Don't trust
that the same string means the same thing.

### 4. glibc collation, again, the other way

The on-prem destination was Debian 12, glibc 2.36. RDS's underlying
Amazon Linux had been on glibc 2.34 the last time I'd checked. Both
are post-2.28, which is the cliff that matters most, but they are
not the same, and **any** glibc version skew across an index is a
risk for non-C, non-ICU collations.

I had learned my lesson the first time. The destination was
configured with **ICU collations** for everything that mattered:

```sql
CREATE COLLATION en_us_icu (provider = icu, locale = 'en-US-x-icu');
```

…and the migration plan re-declared columns to use ICU collation
during the COPY phase. PG 15+ tracks ICU collation versions per index
and emits warnings on mismatch, which means even if we screwed up we
would be told. We did not screw up. The destination was clean.

But there was still a problem: the data **on RDS** had been built
under glibc collation order for eight months, because that's all RDS
PostgreSQL 13 supported at the time. So the values were sorted on the
source according to one rule and were being received by the
destination, which would index them under a different rule. As long
as the rules agreed on equality (which they do, for the cases we
cared about), CDC apply was fine. Indexes built on the destination
were fine. Range scans across the boundary, during the cutover
window, were briefly weird. We avoided it by quiescing reads on the
old side before promoting the new side.

In retrospect: if you have any locale-sensitive data, switch to ICU
on **both** sides as early in the migration as you can. Once you've
got an ICU column on the source, you've removed glibc from the trust
chain entirely, and you can move between operating systems freely.

### 5. The egress bill

Direct Connect is not free. AWS data transfer to a Direct Connect
location is cheaper than internet egress, but it is not zero. Our
1.4 TiB initial COPY plus ~280 GiB of CDC traffic during the catch-up
window plus tail traffic during cutover came in at about $190 in
data transfer charges, which is fine, plus another $400 of related
charges I do not fully understand because the AWS billing dashboard
does not always make sense. Round it to $600. This was a forgettable
fraction of the savings from getting off the instance. It is not
forgettable if you're moving 100 TiB.

The number that's more annoying is **DMS replication instance time**
during a hypothetical re-cutover. We kept a DMS instance running at
m5.large for two weeks during the dual-running period as a safety
net. About $260. Forgettable. Add zeros for larger fleets.

### 6. The cutover that mostly worked

Cutover was a Saturday at 03:00 UTC, six weeks after we started
the re-migration. By then we had three pglogical-equivalent native
subscriptions all caught up to within 200ms of source, a pgbouncer
cluster fronting the new on-prem primary (configured in
transaction mode at first and then session mode after we re-tested
for the previous LISTEN/NOTIFY issue), a traffic-shifting plan on
the application's connection-string config that flipped a single
environment variable and cycled pgbouncer pools, and an hourly
script that ran `pg_dump --schema-only` on both sides and diffed
them in case anybody snuck a DDL in past the freeze. Nobody did.
We checked anyway.

The cutover took 14 minutes from "freeze writes on RDS" to "RDS is
read-only, on-prem is primary, app is reconnected". Sequence resync
was the slowest individual step, because we had ~470 sequences and
the script ran them serially out of an abundance of paranoia. Could
have parallelized; it didn't matter.

The first hour after, we saw `WARNING: collation version mismatch`
from PG 15 a couple of times on indexes that had survived from the
RDS side via the COPY (it was tracking the upstream glibc version on
data it had received). `REINDEX CONCURRENTLY` cleaned them up.
`ALTER COLLATION ... REFRESH VERSION` after, per the
[Postgres docs][pg-collations]. No data corruption, just a label
update.

Twelve hours in: a dashboard somewhere reported the wrong number
because a query was hitting a stale read replica that hadn't quite
caught up. We bumped the replica's apply worker priority and called
it. Twenty-eight hours in: production was production. We deleted the
RDS instance ten days later, after a pause that was mostly
psychological.

## What stuck, what I'd do again, and what I wouldn't

The bill is gone. The migration was, in absolute terms, a success.
The data is intact, the application is running, the new on-prem
cluster is properly Patroni-managed and properly puppeted by code
that has been written this decade and that I can read.

I still wonder if we should have just modernized the original cluster
in place and never moved to RDS at all. The honest answer is:
probably yes for the database itself, no for the team and the
political situation around it. The migration to RDS forced us to
clean up nine years of tablespace cargo-culting, to delete the Cyrillic
date function, to write down what every plperlu function actually
did, to rebuild our knowledge of the schema. The migration back
forced us to learn modern Postgres ops (Patroni, ICU collations,
parallel logical replication apply, proper CDC). The round trip cost
us roughly fourteen calendar months of one engineer at 60% capacity
and another at 30%, plus the cloud bill during the residency. I do
not think we would have done either of those things otherwise.

If I had to do this again and could change one thing: **switch every
text column to an ICU collation before you migrate anywhere.** It
removes glibc from the trust chain, lets you move across operating
systems without `REINDEX` marathons, and PG tracks the collation
version for you so you find out *before* a query returns wrong data
instead of after. Everything else on this list is workaroundable.
Silent collation drift is the one thing I am still nervous about, two
migrations on.

If I could change a second thing: don't use `LISTEN`/`NOTIFY` for
anything that has to survive a connection-pooler change. Use a real
queue. The pattern is cute. The next migration will hate it.

The boxes in Frankfurt are gone. The new boxes are in two different
data centers, with a third in AWS as a delayed read replica, just
in case. The Puppet module is now Ansible. Nobody under thirty knows
what FAI is. They don't need to. I just hope they don't decide we
need to consolidate onto cloud-native primitives again in 2031.

[fai]: https://fai-project.org/
[edb]: https://www.enterprisedb.com/downloads/postgres-postgresql-downloads
[rds-tblsp]: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.FeatureSupport.Tablespaces.html
[aurora-ext]: https://docs.aws.amazon.com/AmazonRDS/latest/AuroraPostgreSQLReleaseNotes/AuroraPostgreSQL.Extensions.html
[crunchy-glibc]: https://www.crunchydata.com/blog/glibc-collations-and-data-corruption
[rds-logrep]: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.FeatureSupport.LogicalReplication.html
[pglogical]: https://github.com/2ndQuadrant/pglogical
[rds-slots]: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PostgreSQL.Replication.ReadReplicas.Mechanisms-versions.html
[dms-assessment]: https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Tasks.AssessmentReport.PG.html
[dms-assessment-rep]: https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Tasks.AssessmentReport.PG.html
[dms-lob]: https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Tasks.LOBSupport.html
[pgb-prepared]: https://www.pgbouncer.org/faq.html#how-to-use-prepared-statements-with-transaction-pooling
[rds-pinning]: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-pinning.html
[rds-autoscale]: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PIOPS.StorageTypes.html#USER_PIOPS.Autoscaling
[rds-logrep-roles]: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.FeatureSupport.LogicalReplication.html
[rds-aws-s3]: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PostgreSQL.S3Import.InstallExtension.html
[pgcron]: https://github.com/citusdata/pg_cron
[pg-collations]: https://www.postgresql.org/docs/current/collation.html
