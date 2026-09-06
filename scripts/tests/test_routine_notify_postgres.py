"""Opt-in real Postgres regression suite, restricted to a disposable test database.

Run on Beelink: OPENBOT_NOTIFY_POSTGRES_TEST=1 python3 -m unittest discover
-s scripts/tests -p test_routine_notify_postgres.py -v
Uses an isolated schema cloned from the migrated test DB, then drops ONLY that
new schema. No credentials are read and all remote-report IO is disabled.
"""
import concurrent.futures
import importlib.util
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import uuid

spec = importlib.util.spec_from_file_location('routine_notify_pg', Path(__file__).parents[1] / 'routine-notify.py')
n = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = n
spec.loader.exec_module(n)
DATABASE = 'openbot_codex_20260906'


class IsolatedStore(n.Store):
    def __init__(self, schema, **options):
        super().__init__(n.Config(database=DATABASE, **options))
        self.schema = schema

    def query(self, sql):
        if self.config.database != DATABASE or not self.schema.startswith('notify_test_') or not self.schema.replace('_', '').isalnum():
            raise AssertionError('isolated database/schema guard failed')
        return super().query(f'SET search_path TO "{self.schema}";\n' + sql)


@unittest.skipUnless(os.environ.get('OPENBOT_NOTIFY_POSTGRES_TEST') == '1', 'explicit isolated Postgres opt-in required')
class PostgresNotifierTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.schema = 'notify_test_' + uuid.uuid4().hex
        cls.base = n.Store(n.Config(database=DATABASE))
        current = cls.base.query("SELECT json_build_array(json_build_object('database',current_database()));")
        if current != [{'database': DATABASE}]:
            raise AssertionError('refusing to touch any other database')
        cls.block_network = patch.object(n.urllib.request, 'urlopen', side_effect=AssertionError('MCP/Telegram prohibited in DB tests'))
        cls.block_network.start()
        # Copy actual migrated column types/defaults/checks/indexes, without touching
        # another integration suite's public fixtures or notification rows.
        tables = ('users', 'agents', 'routines', 'routine_runs', 'routine_notifications', 'channels', 'openbot_service_health')
        ddl = '\n'.join(f'CREATE TABLE "{cls.schema}".{table} (LIKE public.{table} INCLUDING ALL);' for table in tables)
        cls.base.query(f'CREATE SCHEMA "{cls.schema}";\n' + ddl + "\nSELECT '[]'::json;")
        cls.store = IsolatedStore(cls.schema)
        cls.store.query("""
ALTER TABLE routine_notifications ADD FOREIGN KEY(run_id) REFERENCES routine_runs(id) ON DELETE CASCADE;
ALTER TABLE routine_runs ADD FOREIGN KEY(routine_id) REFERENCES routines(id) ON DELETE CASCADE;
INSERT INTO users(id,email) VALUES ('notify-test-user','notify-test@example.invalid');
INSERT INTO agents(id,name,type,configuration) VALUES ('notify-test-agent','News','built_in','{}');
INSERT INTO routines(id,owner_user_id,agent_id,channel_id,instruction,cron,next_run_at)
VALUES ('notify-test-routine','notify-test-user','notify-test-agent','notify-test-channel','Briefing original','0 7 * * *',now());
SELECT '[]'::json;
""")

    @classmethod
    def tearDownClass(cls):
        cls.base.query(f'DROP SCHEMA "{cls.schema}" CASCADE; SELECT \'[]\'::json;')
        cls.block_network.stop()

    def setUp(self):
        # Exact fixture routine only. Cascading FK removes only its test deliveries.
        self.store.query("DELETE FROM routine_runs WHERE routine_id='notify-test-routine'; SELECT '[]'::json;")

    def seed(self, count=1):
        self.store.query(f"""
WITH runs AS (
 INSERT INTO routine_runs(id,routine_id,status,finished_at,reply_text,instruction_snapshot,channel_id_snapshot)
 SELECT 'notify-test-run-'||i,'notify-test-routine','succeeded',now(),
 E'Fatos: primeiro | item\\nOpinião: autor e fonte\\nÚltima linha', 'Original snapshot', 'original-channel'
 FROM generate_series(1,{int(count)}) AS i RETURNING id
) INSERT INTO routine_notifications(run_id) SELECT id FROM runs;
SELECT '[]'::json;
""")

    def state(self):
        return self.store.query("SELECT coalesce(json_agg(row_to_json(n)), '[]'::json) FROM routine_notifications n;")

    def test_201_rows_deliver_once_and_multiline_remains_intact(self):
        self.seed(201)
        sent = []
        def report_mock(config, **payload):
            sent.append(payload)
            return {'acknowledged_by': 'offline-test'}
        for _ in range(6):
            n.tick(self.store, n.Config(batch_size=50), send=report_mock)
        self.assertEqual(len(sent), 201)
        self.assertTrue(all('Opinião: autor e fonte\nÚltima linha' in x['text'] for x in sent))
        self.assertTrue(all(x['status'] == 'sent' and x['attempts'] == 1 for x in self.state()))
        self.assertEqual(n.tick(self.store, n.Config(), send=report_mock), 0)

    def test_simultaneous_claim_collision_and_ack_failure_race(self):
        self.seed()
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as workers:
            claims = list(workers.map(lambda _: IsolatedStore(self.schema).claim(), range(8)))
        winners = [claim for claim in claims if claim]
        self.assertEqual(len(winners), 1)
        row = winners[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as workers:
            ack = workers.submit(self.store.finish, row, receipt={'ack': True})
            fail = workers.submit(IsolatedStore(self.schema).finish, row, error='TimeoutError')
            outcomes = [ack.result(), fail.result()]
        self.assertEqual(sum(outcomes), 1)
        self.assertIn(self.state()[0]['status'], ('sent', 'pending'))

    def test_expired_lease_reclaims_and_rejects_stale_sender(self):
        self.seed()
        first = self.store.claim()
        self.store.query("UPDATE routine_notifications SET lease_until=now()-interval '1 second' WHERE run_id='notify-test-run-1'; SELECT '[]'::json;")
        self.assertFalse(self.store.finish(first, receipt={'late': True}))
        second = self.store.claim()
        self.assertEqual(second['attempts'], 2)
        self.assertFalse(self.store.finish(first, error='TimeoutError'))
        self.assertTrue(self.store.finish(second, receipt={'ack': True}))
        self.assertEqual(self.state()[0]['status'], 'sent')

    def test_retry_backoff_and_final_failure_are_persisted(self):
        self.seed()
        store = IsolatedStore(self.schema, max_attempts=2)
        first = store.claim()
        self.assertTrue(store.finish(first, error='TimeoutError'))
        self.assertIsNone(store.claim())
        self.assertEqual(self.state()[0]['status'], 'pending')
        self.store.query("UPDATE routine_notifications SET next_attempt_at=now()-interval '1 second' WHERE run_id='notify-test-run-1'; SELECT '[]'::json;")
        second = store.claim()
        self.assertEqual(second['attempts'], 2)
        self.assertTrue(store.finish(second, error='ValueError'))
        self.assertEqual(self.state()[0]['status'], 'failed')
        self.assertIsNone(store.claim())

    def test_last_attempt_crash_becomes_visible_failed(self):
        self.seed()
        store = IsolatedStore(self.schema, max_attempts=1)
        store.claim()
        self.store.query("UPDATE routine_notifications SET lease_until=now()-interval '1 second' WHERE run_id='notify-test-run-1'; SELECT '[]'::json;")
        self.assertIsNone(store.claim())
        self.assertEqual(self.state()[0]['status'], 'failed')
        self.assertIn('unknown', self.state()[0]['last_error'])

    def test_snapshot_survives_routine_edits_and_empty_poll_heartbeats(self):
        self.seed()
        claim = self.store.claim()
        self.assertEqual(claim['instruction'], 'Original snapshot')
        self.assertEqual(claim['channel_id'], 'original-channel')
        self.store.finish(claim, receipt={'ack': True})
        n.tick(self.store, n.Config(), send=lambda *a, **kw: self.fail('unexpected send'))
        rows = self.store.query("SELECT json_agg(row_to_json(h)) FROM openbot_service_health h WHERE name='routine-notifier';")
        self.assertIsNotNone(rows[0]['last_ok_at'])


if __name__ == '__main__':
    unittest.main()
