import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("fx_status", Path(__file__).parents[1] / "ownbot_fx_status.py")
fx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fx)
NOW = dt.datetime(2026, 9, 7, 21, 0, tzinfo=dt.timezone.utc)


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.audit = self.root / "runner-audit.jsonl"
        self.decisions = self.root / "decisions"
        self.quotes = self.root / "quotes"
        self.decisions.mkdir()
        self.uid = patch.object(fx, "SOURCE_UID", os.getuid())
        self.uid.start()
        self.addCleanup(self.uid.stop)
        self.rows = []
        for symbol in fx.SYMBOLS:
            self.rows.append({"schema_version": "tch.isolated_fx_runner_audit.v1", "source": "codex-fx", "symbol": symbol,
                              "recorded_at_utc": "2026-09-07T20:59:30Z", "decision_id": "receipt-" + symbol,
                              "decision": "hold_persisted", "ok": True, "carrier_emitted": False,
                              "secret": "MUST_NOT_LEAVE_NEXUS"})
            (self.decisions / (symbol + ".json")).write_text(json.dumps({"source": "codex-fx", "symbol": symbol,
                "decision_id": "receipt-" + symbol, "issued_at_utc": "2026-09-07T20:59:25Z", "rationale": "PRIVATE_POSITION"}))
            directory = self.quotes / symbol
            directory.mkdir(parents=True)
            (directory / "quote.json").write_text(json.dumps({"symbol": symbol, "observed_at": "2026-09-07T20:59:55Z",
                "generated_at": "2026-09-07T20:59:59Z", "valid": True, "tick_age_seconds": 4, "account_token": "SECRET"}))
        self.write_rows()

    def write_rows(self):
        self.audit.write_text("".join(json.dumps(r) + "\n" for r in self.rows))

    def build(self):
        return fx.build_snapshot(NOW, self.audit, self.decisions, self.quotes)

    def test_projection_preserves_source_receipt_and_excludes_private_fields(self):
        before = {str(p): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        value = self.build()
        self.assertEqual(value["status"], "ok")
        self.assertEqual(value["source"], "codex-fx")
        self.assertEqual(value["receipts"][0]["state"], "hold_persisted")
        self.assertFalse(value["receipts"][0]["carrierEmitted"])
        self.assertEqual(value["receipts"][0]["timestamp"], "2026-09-07T20:59:30Z")
        self.assertLess(len(fx.encoded(value)), 20 * 1024)
        for secret in ("MUST_NOT_LEAVE_NEXUS", "PRIVATE_POSITION", "account_token"):
            self.assertNotIn(secret, fx.encoded(value).decode())
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.root.rglob("*") if p.is_file()})

    def test_hold_does_not_hide_invalid_or_stale_quote(self):
        p = self.quotes / "EURUSD" / "quote.json"
        q = json.loads(p.read_text())
        q.update(valid=False, invalid_reason="broker_tick_stale", observed_at="2026-09-07T20:50:00Z")
        p.write_text(json.dumps(q))
        value = self.build()
        self.assertEqual(value["status"], "degraded")
        self.assertEqual(value["receipts"][0]["quote"]["invalidReason"], "broker_tick_stale")
        self.assertIn("quote_observation_stale", value["receipts"][0]["warnings"])

    def test_missing_or_malformed_receipts_are_unknown_not_paused_or_healthy(self):
        self.audit.unlink()
        self.assertEqual(self.build()["status"], "unknown")
        self.audit.write_text('{"x":1,"x":2}\n')
        self.assertEqual(self.build()["status"], "unknown")

    def test_other_source_cannot_be_presented_as_codex(self):
        for row in self.rows:
            row["source"] = "grok"
        self.write_rows()
        self.assertEqual(self.build()["status"], "unknown")

    def test_new_decision_without_matching_receipt_is_explicit(self):
        p = self.decisions / "EURUSD.json"
        row = json.loads(p.read_text())
        row["decision_id"] = "next-decision"
        p.write_text(json.dumps(row))
        self.assertIn("latest_decision_receipt_not_confirmed", self.build()["receipts"][0]["warnings"])

    def test_symlink_oversize_fifo_and_writable_sources_refused(self):
        p = self.root / "bad"
        p.symlink_to(self.audit)
        with self.assertRaises(OSError):
            fx.read_bytes(p, 100)
        p.unlink()
        p.write_bytes(b"x" * 101)
        with self.assertRaises(ValueError):
            fx.read_bytes(p, 100)
        p.chmod(0o666)
        with self.assertRaises(ValueError):
            fx.read_bytes(p, 1000)
        p.unlink()
        os.mkfifo(p)
        with self.assertRaises(ValueError):
            fx.read_bytes(p, 100)

    def test_bounded_tail_keeps_complete_records_and_ignores_in_progress_append(self):
        self.audit.write_text("x" * fx.MAX_TAIL + "\n" + json.dumps(self.rows[0]) + "\n" + '{"unfinished":')
        self.assertEqual(list(fx.latest_receipts(self.audit)[0]), ["EURUSD"])

    def test_invalid_historical_record_does_not_hide_new_receipt_but_reports_gap(self):
        self.audit.write_text('{"bad":"historical"}\n' + self.audit.read_text())
        value = self.build()
        self.assertEqual(value["status"], "degraded")
        self.assertEqual(value["receipts"][0]["id"], "receipt-EURUSD")
        self.assertIn("receipt_history_contains_unreadable_records", value["warnings"])

    def test_ssh_reader_rejects_arbitrary_commands_and_marks_stale_snapshot(self):
        p = self.root / "status.json"
        p.write_bytes(fx.encoded(self.build()))
        with patch.object(fx, "SNAPSHOT", p):
            for command in ("", "sh", "ownbot-fx-status; id", "ownbot-fx-status --path /etc/shadow", "submit_fx_decision"):
                with patch.dict(os.environ, {"SSH_ORIGINAL_COMMAND": command}):
                    with self.assertRaises(ValueError):
                        fx.read_snapshot(NOW)
            with patch.dict(os.environ, {"SSH_ORIGINAL_COMMAND": "ownbot-fx-status"}):
                self.assertEqual(json.loads(fx.read_snapshot(NOW))["status"], "ok")
                stale = json.loads(fx.read_snapshot(NOW + dt.timedelta(minutes=3)))
                self.assertEqual(stale["status"], "unknown")
                self.assertEqual(stale["observedAt"], "2026-09-07T21:00:00Z")
                self.assertIn("snapshot_stale", stale["warnings"])

    def test_failure_future_timestamp_and_missing_fields_do_not_claim_health(self):
        self.rows[0].update(ok=False, recorded_at_utc="2026-09-08T21:00:00Z")
        self.rows[1].pop("decision")
        self.write_rows()
        value = self.build()
        self.assertEqual(value["status"], "degraded")
        self.assertIn("receipt_timestamp_in_future", value["receipts"][0]["warnings"])
        self.assertIn("receipt_reported_failure", value["receipts"][0]["warnings"])
        self.assertIn("receipt_state_unknown", value["receipts"][1]["warnings"])


if __name__ == "__main__":
    unittest.main()
