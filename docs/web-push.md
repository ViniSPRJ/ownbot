# Browser notifications

Ownbot can deliver a generic browser notification for a **new** inbox entry after a signed-in person opts in on that browser. The ordinary Ownbot session owns the subscription; no extra account is required. Browser permission is requested by the interface after the user presses its activation button. Permission and device registration cannot be completed by deploying the server alone.

The encrypted payload contains only `title: "ownbot"`, `body: "Há uma nova atualização no seu projeto."` and a bounded notification identifier. It never contains the inbox summary, document text, channel, agent, task title or credentials. Clicking opens `/notifications`, where the normal login and owner checks apply. Apple, Google, Mozilla or Microsoft push infrastructure is still an external delivery dependency; this is optional and is separate from local inference or private document storage.

## Operator configuration

Install the locked dependencies and run the normal database migration runner, including `0030_web_push.sql`. Generate one stable VAPID P-256 key pair with the installed `web-push` package on the server; write it directly to a protected file instead of printing it to shell history or logs. The JSON file has exactly these properties:

```json
{"subject":"https://github.com/ViniSPRJ/ownbot","publicKey":"<public VAPID key>","privateKey":"<private VAPID key>"}
```

Set `OPENBOT_WEB_PUSH_CONFIG` to its absolute path. The file must be a regular file with no group/world permission bits (normally mode `0600`) and remain outside the checkout. The server verifies the key pair. Missing, unreadable or invalid configuration reports push disabled and prevents registration and sending. Existing subscriptions can still be revoked. Preserve both VAPID and the existing credential encryption key across restarts. VAPID rotation requires browsers to register again; queued subscriptions bound to another key fail closed.

`TRUSTED_ORIGINS` and/or `OPENBOT_APP_URL` must include the browser's actual HTTPS origin. The API uses these configured origins for authenticated subscription writes behind the UI proxy. Browser support and installation requirements vary; the UI describes unsupported or missing-permission states without claiming delivery.

## Application integration

`createPushStore(database, config.keyEncryptionKey)` constructs the SQL-backed store. Pass it as the final optional `createApp` argument, after `localEnrollment`. `app.ts` mounts authenticated routes using `readPushConfig` and configured trusted origins. Start one `startPushWorker(pushStore)` per API process and await its `stop()` during shutdown; multiple replicas are supported by database leases. A supplied `onError` callback must log a generic worker failure, never the subscription or upstream error body.

The browser contract is:

- `GET /api/notifications/push` returns `{push:{enabled,publicKey,subscriptions:[{id,endpointHash}]}}`; the private VAPID key, endpoint and encryption keys are never returned.
- `POST /api/notifications/push/subscriptions` accepts `PushSubscription.toJSON()` and returns `{ok:true,id}`.
- `DELETE /api/notifications/push/subscriptions` accepts `{endpoint}` and returns `{ok:true}`. It is idempotent and only affects the current user's device.

Endpoints must use HTTPS and match the exact supported vendor host/path allowlist. Requests cannot redirect or use arbitrary private/Tailnet hosts. The delivery transport uses the maintained `web-push` encryption/VAPID implementation, a ten-second absolute timeout and a 16 KiB discarded response bound. Endpoint and browser keys are encrypted at rest using the existing credential encryption; endpoint SHA-256 hashes identify subscriptions without exposing capability URLs. An endpoint cannot silently transfer to another account, including after revocation. Each owner is limited to 32 stored devices.

## Durability and revocation

An SQL insert trigger enqueues the notification and subscription pair in the inbox transaction. Registration does not backfill existing notifications. Only the matching owner's active subscriptions whose opt-in precedes the new notification are eligible. A unique pair key prevents duplicate queue entries; generation numbers prevent opt-out/re-enrollment from reviving older work.

Workers lease jobs for thirty seconds, retry transport failures, HTTP 408/429 and server errors up to five attempts with exponential backoff, and disable devices on 404/410. Other permanent responses stop retrying. Pending jobs expire after 24 hours and terminal receipts are retained for thirty days. Subscription row locks serialize revocation with dispatch: after revocation returns, queued work cannot begin sending. A delivery already accepted externally cannot be recalled.

External delivery is at least once: a process crash after vendor acceptance but before the receipt commits can cause a retry. The notification/device key, push topic and service-worker tag bound duplicate presentation; they do not provide an exactly-once vendor guarantee. Inbox persistence remains independent of push availability. The current worker reports errors through a generic callback; delivery receipts can be inspected locally in `push_outbox` without exposing notification content or endpoints.

## Verification

`bun test server/tests/push.test.ts` verifies authentication, exact route mounting, trusted origins, endpoint/key validation, protected operator config and the generic payload. With a migrated isolated PostgreSQL database whose name includes `test`, run `bun test server/tests/push.integration.test.ts` to verify encryption, owner isolation, transactional enqueue, no history replay, concurrent leases, lease recovery, opt-out and retry/expiry. These tests use synthetic subscriptions and a fake sender: they do not register devices or contact push vendors. Final device acceptance requires user opt-in followed by a new inbox event on that device.
