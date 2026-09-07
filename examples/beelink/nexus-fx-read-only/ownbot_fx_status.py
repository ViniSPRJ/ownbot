#!/usr/bin/python3
"""Fixed-source FX receipt projection. Never imports or invokes trading code."""
import datetime as dt
import json
import math
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

HOST = "nexus-ops-vps.tail3c3777.ts.net"
SOURCE = "codex-fx"
SYMBOLS = ("EURUSD", "GBPUSD", "USDCAD", "USDCHF", "USDJPY")
AUDIT = Path("/var/lib/tch-isolated-fx/runner-audit.jsonl")
DECISIONS = Path("/var/lib/tch-isolated-fx-decisions/latest/codex-fx")
QUOTES = Path("/var/lib/tch-carrier-state/fxpro")
SNAPSHOT = Path("/var/lib/ownbot-fx-status/status.json")
MAX_OUTPUT = 20 * 1024
MAX_TAIL = 256 * 1024
STALE_SNAPSHOT_SECONDS = 120
SOURCE_UID = 0


def stamp(value):
    if not isinstance(value, str) or len(value) > 40:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.astimezone(dt.timezone.utc) if parsed.tzinfo else None
    except ValueError:
        return None


def iso(value):
    return value.isoformat(timespec="seconds").replace("+00:00", "Z")


def code(value):
    return value if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:/-]{1,160}", value) else None


def number(value):
    return value if type(value) in (int, float) and math.isfinite(value) and value >= 0 else None


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_json_key")
        result[key] = value
    return result


def decode(raw):
    value = json.loads(raw, object_pairs_hook=unique,
                       parse_constant=lambda _: (_ for _ in ()).throw(ValueError("invalid_number")))
    if not isinstance(value, dict):
        raise ValueError("object_required")
    return value


def read_bytes(path, maximum, tail=False):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != SOURCE_UID or before.st_mode & 0o022:
            raise ValueError("unsafe_source")
        if not tail and before.st_size > maximum:
            raise ValueError("source_too_large")
        start = max(0, before.st_size - maximum) if tail else 0
        os.lseek(descriptor, start, os.SEEK_SET)
        raw = os.read(descriptor, maximum + (0 if tail else 1))
        if not tail and len(raw) > maximum:
            raise ValueError("source_too_large")
        # The beginning may be half a JSONL record when only the bounded tail is read.
        if start:
            raw = raw.partition(b"\n")[2]
        # In-progress append: read the completed prefix, never an unfinished receipt.
        if tail and raw and not raw.endswith(b"\n"):
            raw = raw.rpartition(b"\n")[0] + b"\n"
        return raw
    finally:
        os.close(descriptor)


def read_object(path):
    return decode(read_bytes(path, 65536))


def latest_receipts(path):
    found = {}
    incomplete = False
    for line in read_bytes(path, MAX_TAIL, tail=True).splitlines():
        if not line.strip():
            continue
        try:
            row = decode(line)
        except (ValueError, UnicodeError):
            incomplete = True
            continue
        if row.get("schema_version") != "tch.isolated_fx_runner_audit.v1":
            incomplete = True
            continue
        if row.get("source") != SOURCE or row.get("symbol") not in SYMBOLS:
            continue
        timestamp = stamp(row.get("recorded_at_utc"))
        if timestamp is None or code(row.get("decision_id")) is None:
            incomplete = True
            continue
        prior = found.get(row["symbol"])
        if prior is None or timestamp >= stamp(prior["recorded_at_utc"]):
            found[row["symbol"]] = row
    return found, incomplete


def build_snapshot(now=None, audit=AUDIT, decisions=DECISIONS, quotes=QUOTES):
    now = now or dt.datetime.now(dt.timezone.utc)
    warnings = []
    try:
        rows, incomplete = latest_receipts(audit)
        if incomplete:
            warnings.append("receipt_history_contains_unreadable_records")
    except (OSError, ValueError, UnicodeError):
        rows = {}
        warnings.append("receipt_source_unavailable")
    receipts = []
    for symbol in SYMBOLS:
        row = rows.get(symbol, {})
        issues = []
        try:
            decision = read_object(decisions / (symbol + ".json"))
            if decision.get("source") != SOURCE or decision.get("symbol") != symbol:
                raise ValueError("wrong_decision_identity")
        except (OSError, ValueError, UnicodeError):
            decision = {}
            issues.append("decision_unavailable")
        try:
            quote = read_object(quotes / symbol / "quote.json")
            if quote.get("symbol") != symbol:
                raise ValueError("wrong_quote_identity")
        except (OSError, ValueError, UnicodeError):
            quote = {}
            issues.append("quote_unavailable")
        observed = stamp(quote.get("observed_at"))
        issued = stamp(decision.get("issued_at_utc"))
        recorded = stamp(row.get("recorded_at_utc"))
        if not row:
            issues.append("receipt_unavailable")
        elif code(row.get("decision")) is None or type(row.get("carrier_emitted")) is not bool:
            issues.append("receipt_state_unknown")
        if issued is None:
            issues.append("decision_timestamp_unknown")
        if recorded is not None and (now - recorded).total_seconds() > 3600:
            issues.append("receipt_older_than_one_hour")
        if recorded is not None and recorded > now + dt.timedelta(seconds=30):
            issues.append("receipt_timestamp_in_future")
        if decision and decision.get("decision_id") != row.get("decision_id"):
            issues.append("latest_decision_receipt_not_confirmed")
        if observed is None or observed > now + dt.timedelta(seconds=30):
            issues.append("quote_timestamp_unknown")
        elif (now - observed).total_seconds() > 120:
            issues.append("quote_observation_stale")
        if quote.get("valid") is not True:
            issues.append("quote_not_valid")
        if row and (row.get("ok") is not True or (type(row.get("gateway_status")) is int and row["gateway_status"] >= 400)):
            issues.append("receipt_reported_failure")
        receipts.append({
            "id": code(row.get("decision_id")), "timestamp": iso(recorded) if recorded else None,
            "symbol": symbol, "source": SOURCE, "state": code(row.get("decision")),
            "carrierEmitted": row.get("carrier_emitted") if type(row.get("carrier_emitted")) is bool else None,
            "gatewayStatus": row.get("gateway_status") if type(row.get("gateway_status")) is int and 100 <= row["gateway_status"] <= 599 else None,
            "gatewayDecision": code(row.get("gateway_decision")), "gatewayReason": code(row.get("gateway_reason")),
            "decisionIssuedAt": iso(issued) if issued else None,
            "quote": {"observedAt": iso(observed) if observed else None,
                      "generatedAt": iso(stamp(quote.get("generated_at"))) if stamp(quote.get("generated_at")) else None,
                      "valid": quote.get("valid") if type(quote.get("valid")) is bool else None,
                      "invalidReason": code(quote.get("invalid_reason")),
                      "tickAgeSeconds": number(quote.get("tick_age_seconds"))},
            "warnings": issues,
        })
    return {"schemaVersion": 1, "observedAt": iso(now), "host": HOST, "source": SOURCE,
            "status": "unknown" if not rows else "degraded" if warnings or any(r["warnings"] for r in receipts) else "ok",
            "receipts": receipts, "warnings": warnings}


def encoded(snapshot):
    raw = (json.dumps(snapshot, ensure_ascii=True, allow_nan=False, separators=(",", ":")) + "\n").encode()
    if len(raw) > MAX_OUTPUT:
        raise ValueError("snapshot_too_large")
    return raw


def export_snapshot():
    if os.geteuid() != 0:
        raise ValueError("export_requires_local_service")
    directory = SNAPSHOT.parent.lstat()
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 0 or directory.st_mode & 0o022:
        raise ValueError("unsafe_snapshot_directory")
    raw = encoded(build_snapshot())
    descriptor, temporary = tempfile.mkstemp(prefix=".snapshot-", dir=SNAPSHOT.parent)
    try:
        with os.fdopen(descriptor, "wb") as output:
            os.fchmod(output.fileno(), 0o640)
            os.fchown(output.fileno(), 0, directory.st_gid)
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, SNAPSHOT)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_snapshot(now=None):
    if os.environ.get("SSH_ORIGINAL_COMMAND") != "ownbot-fx-status":
        raise ValueError("unsupported_command")
    snapshot = decode(read_bytes(SNAPSHOT, MAX_OUTPUT))
    if snapshot.get("schemaVersion") != 1 or snapshot.get("source") != SOURCE or snapshot.get("host") != HOST:
        raise ValueError("invalid_snapshot")
    observed = stamp(snapshot.get("observedAt"))
    now = now or dt.datetime.now(dt.timezone.utc)
    if observed is None or not -30 <= (now - observed).total_seconds() <= STALE_SNAPSHOT_SECONDS:
        snapshot["status"] = "unknown"
        snapshot["warnings"] = list(dict.fromkeys([*snapshot.get("warnings", []), "snapshot_stale"]))
    return encoded(snapshot)


def main():
    try:
        if sys.argv[1:] == ["--export"] and not os.environ.get("SSH_CONNECTION"):
            export_snapshot()
        elif sys.argv[1:] == ["--read"]:
            sys.stdout.buffer.write(read_snapshot())
        else:
            raise ValueError("unsupported_command")
    except (OSError, ValueError, UnicodeError):
        print('{"error":"fx_status_unavailable"}', file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
