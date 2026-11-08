# Verification recovery intervals (automatic, no user action)

Website-only verification completes in one request: the OAuth callback runs
eligibility, awaits the Verified Member role grant, persists the completed
record, and queues the completed audit event before responding. No second
visit, refresh, or sign-in is needed for a normal completion.

When an operation is interrupted between the Discord role grant and the
persisted completion (network drop, function restart, transient Discord or
database error), recovery is automatic and bounded:

1. **Immediate (seconds).** The member's own next page load runs
   `/api/verify/refresh` (the frontend calls it when the page opens and on its
   bounded timer), which completes the same operation id without re-posting
   audit events.
2. **Prompt (< 5 minutes), no member activity required.** Any production
   request — any visitor's page load — runs `scheduleRecovery`, which executes
   `verification.reconcileStuck` in the background (Vercel `waitUntil`) at most
   once per 5 minutes per instance. It confirms the role in Discord, grants it
   if missing and the member is eligible, persists completion, and enqueues the
   deduplicated completed audit event.
3. **Traffic-independent backstop (daily).** The Vercel cron
   `/api/delivery-retry` (02:41 UTC on the Hobby plan — the plan only allows
   once-daily crons) runs the same sweep and then flushes deliveries. An
   authorized operator can trigger it any time with `CRON_SECRET`:

   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" \
     "https://bananatradehub.vercel.app/api/delivery-retry"
   ```

   The response reports per-record outcomes (`reconciliation.records`), and
   `?member=<discordId>` / `?stats=1` add a read-only record, event, delivery,
   and table-count view for triage.

## Properties

- **Idempotent and repeatable:** the completed event deduplicates on its
  `event_key` (`signin:<discordId>:<operationId>-complete`), and the outbox
  queue deduplicates on `(event_key, user_id)`. Repeated sweeps, double
  cron runs, and concurrent instances cannot duplicate grants, events, or
  deliveries.
- **Age guard:** records fresher than 120 seconds are not swept, so an
  in-flight callback is never raced.
- **Audit delivery is independent:** a failed embed post is recorded as a
  durable, retryable delivery job (with `last_error` and bounded backoff) and
  never marks a verified member unverified or rolls back the grant.
- **Eligibility is re-checked on every recovery attempt** (account age, guild
  membership age, screening, timeout, suspension). Members who are not yet
  eligible are left for the normal flow with the reason recorded; transient
  Discord failures are retried on the next sweep with the cause reported.
