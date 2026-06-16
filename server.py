#!/usr/bin/env python3
"""Local API server for QQQ exam results and certification records."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import mimetypes
import os
import secrets
import sqlite3
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("QQQ_DATA_DIR", ROOT / "data"))
DB_PATH = DATA_DIR / "exam_results.sqlite3"
CERTIFICATE_DIR = ROOT / "certificates"
HOST = os.environ.get("QQQ_HOST", "127.0.0.1")
PORT = int(os.environ.get("QQQ_PORT", "4173"))

DEFAULT_QUALIFICATION_CODE = "GRR-WT"
DEFAULT_QUALIFICATION_NAME = "Written inspector assessment"
CSV_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")

LEGACY_SCHEMA = """
CREATE TABLE IF NOT EXISTS exam_results (
    result_id INTEGER PRIMARY KEY AUTOINCREMENT,
    cert_id TEXT UNIQUE,
    exam_type TEXT NOT NULL,
    exam_name TEXT NOT NULL,
    exam_version TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    employee_name TEXT NOT NULL,
    department TEXT NOT NULL DEFAULT '',
    process_name TEXT NOT NULL DEFAULT '',
    exam_date TEXT NOT NULL,
    total_questions INTEGER NOT NULL,
    correct_count INTEGER NOT NULL,
    wrong_count INTEGER NOT NULL,
    score REAL NOT NULL,
    pass_score REAL NOT NULL,
    grade TEXT NOT NULL CHECK (grade IN ('A', 'B', 'C', 'D')),
    pass_status TEXT NOT NULL CHECK (pass_status IN ('PASS', 'FAIL')),
    issued_date TEXT,
    valid_from TEXT,
    valid_to TEXT,
    certificate_path TEXT,
    certificate_hash TEXT,
    qr_value TEXT,
    cert_status TEXT CHECK (cert_status IN ('VALID', 'EXPIRED', 'CANCELLED', 'ISSUE_PENDING', 'ISSUE_FAILED')),
    evaluator TEXT NOT NULL DEFAULT '',
    approver TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exam_results_exam_date ON exam_results(exam_date);
CREATE INDEX IF NOT EXISTS idx_exam_results_employee_id ON exam_results(employee_id);
CREATE INDEX IF NOT EXISTS idx_exam_results_employee_name ON exam_results(employee_name);
CREATE INDEX IF NOT EXISTS idx_exam_results_pass_status ON exam_results(pass_status);

CREATE TABLE IF NOT EXISTS certificate_status_history (
    history_id INTEGER PRIMARY KEY AUTOINCREMENT,
    result_id INTEGER NOT NULL REFERENCES exam_results(result_id),
    previous_status TEXT,
    next_status TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    changed_at TEXT NOT NULL
);
"""

ASSESSMENT_SCHEMA = """
CREATE TABLE IF NOT EXISTS examinees (
    examinee_id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT NOT NULL UNIQUE,
    employee_name TEXT NOT NULL,
    department TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS qualification_types (
    qualification_type_id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assessment_plans (
    assessment_plan_id INTEGER PRIMARY KEY AUTOINCREMENT,
    qualification_type_id INTEGER NOT NULL REFERENCES qualification_types(qualification_type_id),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    requires_written_exam INTEGER NOT NULL DEFAULT 1 CHECK (requires_written_exam IN (0, 1)),
    requires_attribute_rr INTEGER NOT NULL DEFAULT 0 CHECK (requires_attribute_rr IN (0, 1)),
    requires_variable_rr INTEGER NOT NULL DEFAULT 0 CHECK (requires_variable_rr IN (0, 1)),
    requires_training INTEGER NOT NULL DEFAULT 0 CHECK (requires_training IN (0, 1)),
    pass_rule_json TEXT NOT NULL DEFAULT '{}',
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (qualification_type_id, revision)
);

CREATE TABLE IF NOT EXISTS assessment_sessions (
    assessment_session_id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_code TEXT NOT NULL UNIQUE,
    examinee_id INTEGER NOT NULL REFERENCES examinees(examinee_id),
    qualification_type_id INTEGER NOT NULL REFERENCES qualification_types(qualification_type_id),
    assessment_plan_id INTEGER NOT NULL REFERENCES assessment_plans(assessment_plan_id),
    status TEXT NOT NULL DEFAULT 'IN_PROGRESS'
        CHECK (status IN ('IN_PROGRESS', 'SUBMITTED', 'APPROVED', 'REJECTED')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assessment_sessions_examinee ON assessment_sessions(examinee_id);
CREATE INDEX IF NOT EXISTS idx_assessment_sessions_qualification ON assessment_sessions(qualification_type_id);

CREATE TABLE IF NOT EXISTS submissions (
    submission_id INTEGER PRIMARY KEY AUTOINCREMENT,
    assessment_session_id INTEGER NOT NULL REFERENCES assessment_sessions(assessment_session_id),
    attempt_id TEXT NOT NULL UNIQUE,
    exam_id TEXT NOT NULL,
    exam_revision INTEGER NOT NULL DEFAULT 1 CHECK (exam_revision >= 1),
    answers_json TEXT NOT NULL,
    locked INTEGER NOT NULL DEFAULT 1 CHECK (locked IN (0, 1)),
    submitted_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_submissions_session ON submissions(assessment_session_id);
CREATE INDEX IF NOT EXISTS idx_submissions_exam_revision ON submissions(exam_id, exam_revision);

CREATE TABLE IF NOT EXISTS grade_results (
    grade_result_id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL REFERENCES submissions(submission_id),
    result_id INTEGER REFERENCES exam_results(result_id),
    score REAL NOT NULL,
    max_score REAL NOT NULL,
    pass_score REAL NOT NULL,
    pass_status TEXT NOT NULL CHECK (pass_status IN ('PASS', 'FAIL')),
    grade TEXT NOT NULL CHECK (grade IN ('A', 'B', 'C', 'D')),
    items_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_grade_results_submission ON grade_results(submission_id);
CREATE INDEX IF NOT EXISTS idx_grade_results_result ON grade_results(result_id);

CREATE TABLE IF NOT EXISTS certification_decisions (
    certification_decision_id INTEGER PRIMARY KEY AUTOINCREMENT,
    assessment_session_id INTEGER NOT NULL REFERENCES assessment_sessions(assessment_session_id),
    decision TEXT NOT NULL CHECK (decision IN ('pending', 'approved', 'rejected')),
    missing_requirements_json TEXT NOT NULL DEFAULT '[]',
    blocking_reasons_json TEXT NOT NULL DEFAULT '[]',
    warnings_json TEXT NOT NULL DEFAULT '[]',
    approved_by TEXT NOT NULL DEFAULT '',
    decided_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_certification_decisions_session
    ON certification_decisions(assessment_session_id, certification_decision_id);

CREATE TABLE IF NOT EXISTS certificates (
    certificate_id INTEGER PRIMARY KEY AUTOINCREMENT,
    cert_id TEXT NOT NULL UNIQUE,
    result_id INTEGER REFERENCES exam_results(result_id),
    assessment_session_id INTEGER REFERENCES assessment_sessions(assessment_session_id),
    certification_decision_id INTEGER REFERENCES certification_decisions(certification_decision_id),
    issue_mode TEXT NOT NULL DEFAULT 'official' CHECK (issue_mode IN ('official', 'local_only')),
    certificate_path TEXT,
    certificate_hash TEXT,
    status TEXT NOT NULL DEFAULT 'ISSUE_PENDING'
        CHECK (status IN ('VALID', 'EXPIRED', 'CANCELLED', 'ISSUE_PENDING', 'ISSUE_FAILED')),
    issued_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_certificates_lookup ON certificates(cert_id, issue_mode);
CREATE INDEX IF NOT EXISTS idx_certificates_session ON certificates(assessment_session_id);

CREATE TABLE IF NOT EXISTS audit_logs (
    audit_log_id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    redacted_before_json TEXT NOT NULL DEFAULT '{}',
    redacted_after_json TEXT NOT NULL DEFAULT '{}',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
"""

MIGRATIONS = [
    (1, "legacy_exam_results", LEGACY_SCHEMA),
    (2, "assessment_source_of_truth", ASSESSMENT_SCHEMA),
]


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, exc_type, exc_value, traceback):
        result = super().__exit__(exc_type, exc_value, traceback)
        self.close()
        return result


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, factory=ClosingConnection)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    return connection


def initialize_database() -> None:
    with connect() as connection:
        connection.execute(
            """CREATE TABLE IF NOT EXISTS schema_migrations (
               version INTEGER PRIMARY KEY,
               name TEXT NOT NULL,
               applied_at TEXT NOT NULL
            )"""
        )
        applied = {
            int(row["version"])
            for row in connection.execute("SELECT version FROM schema_migrations").fetchall()
        }
        for version, name, script in MIGRATIONS:
            connection.executescript(script)
            if version not in applied:
                connection.execute(
                    "INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
                    (version, name, utc_now()),
                )


def grade_for(score: float) -> str:
    if score >= 90:
        return "A"
    if score >= 80:
        return "B"
    if score >= 70:
        return "C"
    return "D"


def annual_sequence(connection: sqlite3.Connection, year: str) -> int:
    prefix = f"GRR-WT-{year}-%"
    row = connection.execute(
        "SELECT COUNT(*) AS count FROM exam_results WHERE cert_id LIKE ?", (prefix,)
    ).fetchone()
    return int(row["count"]) + 1


def create_cert_id(connection: sqlite3.Connection, payload: dict, created_at: str) -> str:
    year = created_at[2:4]
    for _ in range(20):
        sequence = annual_sequence(connection, year)
        nonce = secrets.token_hex(8)
        source = "|".join(
            [str(payload["employee_id"]), str(payload["exam_date"]), str(payload["score"]), created_at, nonce]
        )
        check = hashlib.sha256(source.encode("utf-8")).hexdigest()[:4].upper()
        cert_id = f"GRR-WT-{year}-{sequence:06d}-{check}"
        exists = connection.execute(
            "SELECT 1 FROM exam_results WHERE cert_id = ?", (cert_id,)
        ).fetchone()
        if not exists:
            return cert_id
    raise RuntimeError("Could not create a unique certificate ID.")


def row_to_dict(row: sqlite3.Row) -> dict:
    result = dict(row)
    if result.get("cert_status") == "VALID" and result.get("valid_to"):
        if result["valid_to"] < datetime.now(timezone.utc).date().isoformat():
            result["cert_status"] = "EXPIRED"
    return result


def payload_value(payload: dict, *keys: str, default=None):
    for key in keys:
        value = payload.get(key)
        if value not in (None, ""):
            return value
    return default


def text_value(payload: dict, *keys: str, default: str = "", required: bool = False) -> str:
    value = payload_value(payload, *keys, default=default)
    text = str(value).strip() if value is not None else ""
    if required and not text:
        raise ValueError(f"Missing required field: {keys[0]}")
    return text


def int_value(value, *, default=None) -> int | None:
    if value in (None, ""):
        return default
    if isinstance(value, bool):
        raise ValueError("Integer field must not be a boolean.")
    try:
        return int(value)
    except (TypeError, ValueError) as error:
        raise ValueError("Integer field has an invalid value.") from error


def float_value(value, *, default=None) -> float | None:
    if value in (None, ""):
        return default
    try:
        return float(value)
    except (TypeError, ValueError) as error:
        raise ValueError("Numeric field has an invalid value.") from error


def validate_exam_revision(value) -> int:
    if value in (None, ""):
        return 1
    if isinstance(value, bool):
        raise ValueError("exam.revision must be an integer greater than or equal to 1.")
    if isinstance(value, int):
        revision = value
    elif isinstance(value, str):
        text = value.strip()
        if not text.isdecimal():
            raise ValueError("exam.revision must be an integer greater than or equal to 1.")
        revision = int(text)
    else:
        raise ValueError("exam.revision must be an integer greater than or equal to 1.")
    if revision < 1:
        raise ValueError("exam.revision must be an integer greater than or equal to 1.")
    return revision


def json_text(value, default) -> str:
    if value is None:
        value = default
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return json.dumps(default, ensure_ascii=False, separators=(",", ":"))
        try:
            json.loads(text)
        except json.JSONDecodeError as error:
            raise ValueError("JSON field has an invalid value.") from error
        return text
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def json_list(value) -> list:
    if value in (None, ""):
        return []
    if isinstance(value, str):
        parsed = json.loads(value)
    else:
        parsed = value
    if not isinstance(parsed, list):
        raise ValueError("Expected a JSON array.")
    return parsed


def make_session_code(connection: sqlite3.Connection, now: str) -> str:
    year = now[:4]
    for _ in range(20):
        code = f"AS-{year}-{secrets.token_hex(5).upper()}"
        exists = connection.execute(
            "SELECT 1 FROM assessment_sessions WHERE session_code = ?", (code,)
        ).fetchone()
        if not exists:
            return code
    raise RuntimeError("Could not create a unique assessment session code.")


def ensure_examinee(connection: sqlite3.Connection, payload: dict, now: str) -> sqlite3.Row:
    employee_id = text_value(payload, "employee_id", "employeeId", required=True)
    employee_name = text_value(payload, "employee_name", "employeeName", "name", required=True)
    department = text_value(payload, "department", default="")
    existing = connection.execute(
        "SELECT * FROM examinees WHERE employee_id = ?", (employee_id,)
    ).fetchone()
    if existing:
        connection.execute(
            """UPDATE examinees SET employee_name = ?, department = ?, updated_at = ?
               WHERE examinee_id = ?""",
            (employee_name, department, now, existing["examinee_id"]),
        )
        return connection.execute(
            "SELECT * FROM examinees WHERE examinee_id = ?", (existing["examinee_id"],)
        ).fetchone()
    cursor = connection.execute(
        """INSERT INTO examinees (employee_id, employee_name, department, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)""",
        (employee_id, employee_name, department, now, now),
    )
    return connection.execute(
        "SELECT * FROM examinees WHERE examinee_id = ?", (cursor.lastrowid,)
    ).fetchone()


def ensure_qualification_type(connection: sqlite3.Connection, payload: dict, now: str) -> sqlite3.Row:
    qualification_type_id = int_value(
        payload_value(payload, "qualification_type_id", "qualificationTypeId"), default=None
    )
    if qualification_type_id:
        row = connection.execute(
            "SELECT * FROM qualification_types WHERE qualification_type_id = ?",
            (qualification_type_id,),
        ).fetchone()
        if not row:
            raise ValueError("qualification_type_id was not found.")
        return row

    code = text_value(
        payload,
        "qualification_type_code",
        "qualificationTypeCode",
        "exam_type",
        default=DEFAULT_QUALIFICATION_CODE,
    )
    name = text_value(
        payload,
        "qualification_type_name",
        "qualificationTypeName",
        "exam_name",
        default=DEFAULT_QUALIFICATION_NAME,
    )
    existing = connection.execute(
        "SELECT * FROM qualification_types WHERE code = ?", (code,)
    ).fetchone()
    if existing:
        connection.execute(
            """UPDATE qualification_types SET name = ?, active = 1, updated_at = ?
               WHERE qualification_type_id = ?""",
            (name, now, existing["qualification_type_id"]),
        )
        return connection.execute(
            "SELECT * FROM qualification_types WHERE qualification_type_id = ?",
            (existing["qualification_type_id"],),
        ).fetchone()
    cursor = connection.execute(
        """INSERT INTO qualification_types (code, name, created_at, updated_at)
           VALUES (?, ?, ?, ?)""",
        (code, name, now, now),
    )
    return connection.execute(
        "SELECT * FROM qualification_types WHERE qualification_type_id = ?", (cursor.lastrowid,)
    ).fetchone()


def ensure_assessment_plan(
    connection: sqlite3.Connection,
    payload: dict,
    qualification_type_id: int,
    now: str,
) -> sqlite3.Row:
    assessment_plan_id = int_value(
        payload_value(payload, "assessment_plan_id", "assessmentPlanId"), default=None
    )
    if assessment_plan_id:
        row = connection.execute(
            "SELECT * FROM assessment_plans WHERE assessment_plan_id = ?",
            (assessment_plan_id,),
        ).fetchone()
        if not row:
            raise ValueError("assessment_plan_id was not found.")
        return row

    revision = validate_exam_revision(
        payload_value(payload, "assessment_plan_revision", "exam_revision", "exam_version", default=1)
    )
    pass_score = float_value(payload_value(payload, "pass_score", "passScore"), default=80.0)
    pass_rule = json_text(
        payload_value(payload, "pass_rule_json", "passRule"),
        {
            "written_exam": {
                "pass_score": pass_score,
                "certificate_min_score": 80,
            }
        },
    )
    existing = connection.execute(
        """SELECT * FROM assessment_plans
           WHERE qualification_type_id = ? AND revision = ?""",
        (qualification_type_id, revision),
    ).fetchone()
    if existing:
        return existing
    cursor = connection.execute(
        """INSERT INTO assessment_plans (
             qualification_type_id, revision, pass_rule_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?)""",
        (qualification_type_id, revision, pass_rule, now, now),
    )
    return connection.execute(
        "SELECT * FROM assessment_plans WHERE assessment_plan_id = ?", (cursor.lastrowid,)
    ).fetchone()


def create_assessment_session_in_connection(
    connection: sqlite3.Connection,
    payload: dict,
    now: str,
    *,
    default_status: str = "IN_PROGRESS",
) -> sqlite3.Row:
    examinee = ensure_examinee(connection, payload, now)
    qualification = ensure_qualification_type(connection, payload, now)
    plan = ensure_assessment_plan(connection, payload, qualification["qualification_type_id"], now)
    status = text_value(payload, "status", default=default_status).upper()
    if status not in {"IN_PROGRESS", "SUBMITTED", "APPROVED", "REJECTED"}:
        raise ValueError("Unsupported assessment session status.")
    session_code = text_value(payload, "session_code", "sessionCode", default="")
    if not session_code:
        session_code = make_session_code(connection, now)
    cursor = connection.execute(
        """INSERT INTO assessment_sessions (
             session_code, examinee_id, qualification_type_id, assessment_plan_id,
             status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (
            session_code,
            examinee["examinee_id"],
            qualification["qualification_type_id"],
            plan["assessment_plan_id"],
            status,
            now,
            now,
        ),
    )
    return connection.execute(
        "SELECT * FROM assessment_sessions WHERE assessment_session_id = ?",
        (cursor.lastrowid,),
    ).fetchone()


def ensure_session_for_payload(
    connection: sqlite3.Connection,
    payload: dict,
    now: str,
    *,
    default_status: str = "SUBMITTED",
) -> sqlite3.Row:
    session_id = int_value(payload_value(payload, "assessment_session_id", "session_id"), default=None)
    if session_id:
        row = connection.execute(
            "SELECT * FROM assessment_sessions WHERE assessment_session_id = ?", (session_id,)
        ).fetchone()
        if not row:
            raise ValueError("assessment_session_id was not found.")
        if row["status"] == "IN_PROGRESS" and default_status != "IN_PROGRESS":
            connection.execute(
                "UPDATE assessment_sessions SET status = ?, updated_at = ? WHERE assessment_session_id = ?",
                (default_status, now, session_id),
            )
            row = connection.execute(
                "SELECT * FROM assessment_sessions WHERE assessment_session_id = ?", (session_id,)
            ).fetchone()
        return row
    return create_assessment_session_in_connection(
        connection, payload, now, default_status=default_status
    )


def create_submission_in_connection(
    connection: sqlite3.Connection,
    session_id: int,
    payload: dict,
    now: str,
    *,
    result_id: int | None = None,
) -> sqlite3.Row:
    exam_id = text_value(payload, "exam_id", "examId", "exam_type", default=DEFAULT_QUALIFICATION_CODE)
    exam_revision = validate_exam_revision(payload_value(payload, "exam_revision", "exam_version", default=1))
    submitted_at = text_value(payload, "submitted_at", "submittedAt", "exam_date", default=now)
    attempt_id = text_value(payload, "attempt_id", "attemptId", default="")
    if not attempt_id:
        seed = result_id if result_id is not None else secrets.token_hex(6)
        attempt_id = f"{exam_id}-r{exam_revision}-{session_id}-{seed}"
    answers = json_text(payload_value(payload, "answers_json", "answers"), {})
    try:
        cursor = connection.execute(
            """INSERT INTO submissions (
                 assessment_session_id, attempt_id, exam_id, exam_revision,
                 answers_json, locked, submitted_at, created_at
               ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)""",
            (session_id, attempt_id, exam_id, exam_revision, answers, submitted_at, now),
        )
    except sqlite3.IntegrityError as error:
        raise ValueError("attempt_id already exists.") from error

    connection.execute(
        """UPDATE assessment_sessions SET status = 'SUBMITTED', updated_at = ?
           WHERE assessment_session_id = ? AND status = 'IN_PROGRESS'""",
        (now, session_id),
    )
    return connection.execute(
        "SELECT * FROM submissions WHERE submission_id = ?", (cursor.lastrowid,)
    ).fetchone()


def create_grade_result_in_connection(
    connection: sqlite3.Connection,
    submission_id: int,
    payload: dict,
    now: str,
    *,
    result_id: int | None = None,
) -> sqlite3.Row | None:
    if payload_value(payload, "score") in (None, ""):
        return None
    score = float_value(payload_value(payload, "score"))
    pass_score = float_value(payload_value(payload, "pass_score", "passScore"), default=80.0)
    max_score = float_value(payload_value(payload, "max_score", "maxScore"), default=None)
    if max_score is None or max_score <= 0:
        max_score = max(100.0, score or 0.0, pass_score or 0.0)
    grade = text_value(payload, "grade", default=grade_for(score))
    pass_status = text_value(
        payload,
        "pass_status",
        "passStatus",
        default="PASS" if score >= pass_score else "FAIL",
    ).upper()
    if pass_status not in {"PASS", "FAIL"}:
        raise ValueError("Unsupported pass_status.")
    items = json_text(payload_value(payload, "items_json", "items"), [])
    cursor = connection.execute(
        """INSERT INTO grade_results (
             submission_id, result_id, score, max_score, pass_score,
             pass_status, grade, items_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (submission_id, result_id, score, max_score, pass_score, pass_status, grade, items, now),
    )
    return connection.execute(
        "SELECT * FROM grade_results WHERE grade_result_id = ?", (cursor.lastrowid,)
    ).fetchone()


def record_audit_log(
    connection: sqlite3.Connection,
    entity_type: str,
    entity_id: str,
    action: str,
    *,
    actor: str = "",
    reason: str = "",
    metadata: dict | None = None,
    now: str | None = None,
) -> None:
    connection.execute(
        """INSERT INTO audit_logs (
             entity_type, entity_id, action, actor, reason,
             redacted_before_json, redacted_after_json, metadata_json, created_at
           ) VALUES (?, ?, ?, ?, ?, '{}', '{}', ?, ?)""",
        (
            entity_type,
            str(entity_id),
            action,
            actor,
            reason,
            json_text(metadata or {}, {}),
            now or utc_now(),
        ),
    )


def latest_decision(connection: sqlite3.Connection, session_id: int) -> sqlite3.Row | None:
    return connection.execute(
        """SELECT * FROM certification_decisions
           WHERE assessment_session_id = ?
           ORDER BY certification_decision_id DESC
           LIMIT 1""",
        (session_id,),
    ).fetchone()


def passing_written_exam(connection: sqlite3.Connection, session_id: int) -> sqlite3.Row | None:
    return connection.execute(
        """SELECT gr.*, s.exam_id, s.exam_revision
           FROM grade_results gr
           JOIN submissions s ON s.submission_id = gr.submission_id
           WHERE s.assessment_session_id = ?
             AND gr.pass_status = 'PASS'
             AND gr.score >= gr.pass_score
           ORDER BY gr.grade_result_id DESC
           LIMIT 1""",
        (session_id,),
    ).fetchone()


def any_written_grade(connection: sqlite3.Connection, session_id: int) -> sqlite3.Row | None:
    return connection.execute(
        """SELECT gr.*
           FROM grade_results gr
           JOIN submissions s ON s.submission_id = gr.submission_id
           WHERE s.assessment_session_id = ?
           ORDER BY gr.grade_result_id DESC
           LIMIT 1""",
        (session_id,),
    ).fetchone()


def validate_certification_readiness_in_connection(
    connection: sqlite3.Connection,
    session_id: int | None,
    qualification_type_id: int | None = None,
    examinee_id: int | None = None,
) -> dict:
    if not session_id:
        return {
            "ready": False,
            "status": "rejected",
            "assessment_session_id": None,
            "missing_requirements": ["assessment_session"],
            "blocking_reasons": ["assessment_session_required"],
            "warnings": [],
        }

    session = connection.execute(
        "SELECT * FROM assessment_sessions WHERE assessment_session_id = ?", (session_id,)
    ).fetchone()
    if not session:
        return {
            "ready": False,
            "status": "rejected",
            "assessment_session_id": session_id,
            "missing_requirements": ["assessment_session"],
            "blocking_reasons": ["assessment_session_not_found"],
            "warnings": [],
        }

    blocking: list[str] = []
    if qualification_type_id and int(session["qualification_type_id"]) != int(qualification_type_id):
        blocking.append("qualification_type_mismatch")
    if examinee_id and int(session["examinee_id"]) != int(examinee_id):
        blocking.append("examinee_mismatch")
    if blocking:
        return {
            "ready": False,
            "status": "rejected",
            "assessment_session_id": session_id,
            "qualification_type_id": session["qualification_type_id"],
            "examinee_id": session["examinee_id"],
            "missing_requirements": [],
            "blocking_reasons": blocking,
            "warnings": [],
        }

    pass_row = passing_written_exam(connection, session_id)
    if not pass_row:
        grade_row = any_written_grade(connection, session_id)
        return {
            "ready": False,
            "status": "rejected",
            "assessment_session_id": session_id,
            "qualification_type_id": session["qualification_type_id"],
            "examinee_id": session["examinee_id"],
            "missing_requirements": ["written_exam"],
            "blocking_reasons": ["written_exam_not_passed" if grade_row else "written_exam_missing"],
            "warnings": [],
        }

    decision = latest_decision(connection, session_id)
    if not decision or decision["decision"] != "approved":
        return {
            "ready": False,
            "status": "pending",
            "assessment_session_id": session_id,
            "qualification_type_id": session["qualification_type_id"],
            "examinee_id": session["examinee_id"],
            "missing_requirements": ["certification_approval"],
            "blocking_reasons": ["approval_required"],
            "warnings": [],
            "written_exam": row_to_dict(pass_row),
            "latest_decision": row_to_dict(decision) if decision else None,
        }

    return {
        "ready": True,
        "status": "approved",
        "assessment_session_id": session_id,
        "qualification_type_id": session["qualification_type_id"],
        "examinee_id": session["examinee_id"],
        "missing_requirements": [],
        "blocking_reasons": [],
        "warnings": [],
        "written_exam": row_to_dict(pass_row),
        "latest_decision": row_to_dict(decision),
    }


def validate_certification_readiness(
    session_id,
    qualification_type_id=None,
    examinee_id=None,
) -> dict:
    with connect() as connection:
        return validate_certification_readiness_in_connection(
            connection,
            int_value(session_id, default=None),
            int_value(qualification_type_id, default=None),
            int_value(examinee_id, default=None),
        )


def record_certification_decision_in_connection(
    connection: sqlite3.Connection,
    session_id: int,
    decision: str,
    now: str,
    *,
    missing_requirements: list | None = None,
    blocking_reasons: list | None = None,
    warnings: list | None = None,
    approved_by: str = "",
) -> sqlite3.Row:
    if decision not in {"pending", "approved", "rejected"}:
        raise ValueError("Unsupported certification decision.")
    cursor = connection.execute(
        """INSERT INTO certification_decisions (
             assessment_session_id, decision, missing_requirements_json,
             blocking_reasons_json, warnings_json, approved_by, decided_at,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            session_id,
            decision,
            json_text(missing_requirements or [], []),
            json_text(blocking_reasons or [], []),
            json_text(warnings or [], []),
            approved_by,
            now if decision in {"approved", "rejected"} else None,
            now,
            now,
        ),
    )
    if decision == "approved":
        connection.execute(
            "UPDATE assessment_sessions SET status = 'APPROVED', updated_at = ? WHERE assessment_session_id = ?",
            (now, session_id),
        )
    elif decision == "rejected":
        connection.execute(
            "UPDATE assessment_sessions SET status = 'REJECTED', updated_at = ? WHERE assessment_session_id = ?",
            (now, session_id),
        )
    return connection.execute(
        "SELECT * FROM certification_decisions WHERE certification_decision_id = ?",
        (cursor.lastrowid,),
    ).fetchone()


def create_assessment_session(payload: dict) -> dict:
    now = utc_now()
    with connect() as connection:
        row = create_assessment_session_in_connection(connection, payload, now)
        record_audit_log(
            connection,
            "assessment_session",
            row["assessment_session_id"],
            "created",
            actor=text_value(payload, "actor", default=""),
            now=now,
        )
        return row_to_dict(row)


def create_submission(payload: dict) -> dict:
    now = utc_now()
    with connect() as connection:
        session = ensure_session_for_payload(connection, payload, now, default_status="SUBMITTED")
        submission = create_submission_in_connection(
            connection, session["assessment_session_id"], payload, now
        )
        grade = create_grade_result_in_connection(
            connection, submission["submission_id"], payload, now
        )
        record_audit_log(
            connection,
            "submission",
            submission["submission_id"],
            "created",
            actor=text_value(payload, "actor", default=""),
            metadata={
                "assessment_session_id": session["assessment_session_id"],
                "grade_result_id": grade["grade_result_id"] if grade else None,
            },
            now=now,
        )
        return {
            "session": row_to_dict(session),
            "submission": row_to_dict(submission),
            "grade_result": row_to_dict(grade) if grade else None,
        }


def create_certification_decision(payload: dict) -> dict:
    session_id = int_value(payload_value(payload, "assessment_session_id", "session_id"), default=None)
    if not session_id:
        raise ValueError("assessment_session_id is required.")
    decision = text_value(payload, "decision", default="pending").lower()
    now = utc_now()
    with connect() as connection:
        readiness_before = validate_certification_readiness_in_connection(connection, session_id)
        if decision == "approved" and "written_exam" in readiness_before["missing_requirements"]:
            raise ValueError("Cannot approve certification before a passing written exam exists.")
        missing = json_list(payload_value(payload, "missing_requirements", "missing_requirements_json"))
        blocking = json_list(payload_value(payload, "blocking_reasons", "blocking_reasons_json"))
        warnings = json_list(payload_value(payload, "warnings", "warnings_json"))
        if not missing and decision != "approved":
            missing = readiness_before.get("missing_requirements", [])
        if not blocking and decision != "approved":
            blocking = readiness_before.get("blocking_reasons", [])
        row = record_certification_decision_in_connection(
            connection,
            session_id,
            decision,
            now,
            missing_requirements=[] if decision == "approved" else missing,
            blocking_reasons=[] if decision == "approved" else blocking,
            warnings=warnings,
            approved_by=text_value(payload, "approved_by", "approver", default=""),
        )
        record_audit_log(
            connection,
            "certification_decision",
            row["certification_decision_id"],
            decision,
            actor=text_value(payload, "actor", "approved_by", "approver", default=""),
            now=now,
        )
        readiness_after = validate_certification_readiness_in_connection(connection, session_id)
        return {"decision": row_to_dict(row), "readiness": readiness_after}


def insert_result(payload: dict) -> dict:
    required = [
        "exam_type", "exam_name", "employee_id", "employee_name",
        "exam_date", "total_questions", "correct_count", "wrong_count", "score", "pass_score"
    ]
    missing = [key for key in required if payload.get(key) in (None, "")]
    if missing:
        raise ValueError(f"Missing required fields: {', '.join(missing)}")

    exam_revision = validate_exam_revision(payload_value(payload, "exam_revision", "exam_version", default=1))
    score = float(payload["score"])
    pass_score = float(payload["pass_score"])
    grade = grade_for(score)
    passed = score >= pass_score
    issue_certificate = passed and score >= 80 and grade in {"A", "B"}
    created_at = utc_now()

    with connect() as connection:
        session = ensure_session_for_payload(connection, payload, created_at, default_status="SUBMITTED")
        cert_id = create_cert_id(connection, payload, created_at) if issue_certificate else None
        qr_value = f"/api/certificates/{cert_id}" if cert_id else None
        status = "ISSUE_PENDING" if cert_id else None
        cursor = connection.execute(
            """INSERT INTO exam_results (
                cert_id, exam_type, exam_name, exam_version, employee_id, employee_name,
                department, process_name, exam_date, total_questions, correct_count,
                wrong_count, score, pass_score, grade, pass_status, issued_date,
                valid_from, valid_to, qr_value, cert_status, evaluator, approver,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                cert_id, payload["exam_type"], payload["exam_name"], str(exam_revision),
                payload["employee_id"], payload["employee_name"], payload.get("department", ""),
                payload.get("process_name", ""), payload["exam_date"], int(payload["total_questions"]),
                int(payload["correct_count"]), int(payload["wrong_count"]), score, pass_score,
                grade, "PASS" if passed else "FAIL", payload.get("issued_date") if cert_id else None,
                payload.get("valid_from") if cert_id else None, payload.get("valid_to") if cert_id else None,
                qr_value, status, payload.get("evaluator", ""), payload.get("approver", ""),
                created_at, created_at,
            ),
        )
        result_id = cursor.lastrowid
        submission = create_submission_in_connection(
            connection,
            session["assessment_session_id"],
            {**payload, "exam_revision": exam_revision},
            created_at,
            result_id=result_id,
        )
        grade_row = create_grade_result_in_connection(
            connection,
            submission["submission_id"],
            {**payload, "grade": grade, "pass_status": "PASS" if passed else "FAIL"},
            created_at,
            result_id=result_id,
        )
        decision = None
        if issue_certificate:
            readiness = validate_certification_readiness_in_connection(
                connection, session["assessment_session_id"]
            )
            if "written_exam" in readiness["missing_requirements"]:
                raise ValueError("Cannot issue an official certificate before written exam readiness is met.")
            decision = record_certification_decision_in_connection(
                connection,
                session["assessment_session_id"],
                "approved",
                created_at,
                approved_by=text_value(payload, "approver", default=""),
            )
            connection.execute(
                """INSERT INTO certificates (
                     cert_id, result_id, assessment_session_id, certification_decision_id,
                     issue_mode, status, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, 'official', 'ISSUE_PENDING', ?, ?)""",
                (
                    cert_id,
                    result_id,
                    session["assessment_session_id"],
                    decision["certification_decision_id"],
                    created_at,
                    created_at,
                ),
            )
        record_audit_log(
            connection,
            "exam_result",
            result_id,
            "created",
            actor=text_value(payload, "evaluator", default=""),
            metadata={
                "assessment_session_id": session["assessment_session_id"],
                "submission_id": submission["submission_id"],
                "grade_result_id": grade_row["grade_result_id"] if grade_row else None,
                "cert_id": cert_id,
            },
            now=created_at,
        )
        row = connection.execute(
            "SELECT * FROM exam_results WHERE result_id = ?", (result_id,)
        ).fetchone()
        result = row_to_dict(row)
        result.update(
            {
                "assessment_session_id": session["assessment_session_id"],
                "submission_id": submission["submission_id"],
                "grade_result_id": grade_row["grade_result_id"] if grade_row else None,
                "certification_decision_id": decision["certification_decision_id"] if decision else None,
            }
        )
        return result


def get_certificate(cert_id: str) -> dict:
    if cert_id.startswith("LOCAL-"):
        raise LookupError("Certificate ID was not found.")
    with connect() as connection:
        row = connection.execute(
            """SELECT er.*
               FROM exam_results er
               LEFT JOIN certificates c ON c.cert_id = er.cert_id
               WHERE er.cert_id = ?
                 AND COALESCE(c.issue_mode, 'official') = 'official'""",
            (cert_id,),
        ).fetchone()
    if not row:
        raise LookupError("Certificate ID was not found.")
    return row_to_dict(row)


def save_certificate(cert_id: str, png: bytes) -> dict:
    if cert_id.startswith("LOCAL-"):
        raise LookupError("LOCAL_ONLY output is not an official certificate.")
    if not png.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("Certificate image must be a PNG file.")
    if len(png) > 15 * 1024 * 1024:
        raise ValueError("Certificate image exceeds 15MB.")

    with connect() as connection:
        row = connection.execute(
            """SELECT er.*, c.issue_mode
               FROM exam_results er
               LEFT JOIN certificates c ON c.cert_id = er.cert_id
               WHERE er.cert_id = ?""",
            (cert_id,),
        ).fetchone()
        if not row or row["issue_mode"] == "local_only":
            raise LookupError("Certificate ID was not found.")
        year = row["issued_date"][:4] if row["issued_date"] else row["created_at"][:4]
        relative = Path("certificates") / year / f"CERT_{cert_id}.png"
        destination = CERTIFICATE_DIR / year / f"CERT_{cert_id}.png"
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(".tmp")
        temporary.write_bytes(png)
        temporary.replace(destination)
        digest = hashlib.sha256(png).hexdigest()
        previous = row["cert_status"]
        next_status = "CANCELLED" if previous == "CANCELLED" else "VALID"
        now = utc_now()
        connection.execute(
            """UPDATE exam_results SET certificate_path = ?, certificate_hash = ?,
               cert_status = ?, updated_at = ? WHERE cert_id = ?""",
            (relative.as_posix(), digest, next_status, now, cert_id),
        )
        connection.execute(
            """UPDATE certificates
               SET certificate_path = ?, certificate_hash = ?, status = ?,
                   issued_at = COALESCE(issued_at, ?), updated_at = ?
               WHERE cert_id = ? AND issue_mode = 'official'""",
            (relative.as_posix(), digest, next_status, now, now, cert_id),
        )
        connection.execute(
            """INSERT INTO certificate_status_history
               (result_id, previous_status, next_status, reason, changed_at)
               VALUES (?, ?, ?, 'certificate image issued', ?)""",
            (row["result_id"], previous, next_status, now),
        )
        record_audit_log(
            connection,
            "certificate",
            cert_id,
            "image_saved",
            metadata={"status": next_status},
            now=now,
        )
        updated = connection.execute(
            "SELECT * FROM exam_results WHERE cert_id = ?", (cert_id,)
        ).fetchone()
        return row_to_dict(updated)


def mark_issue_failed(cert_id: str, reason: str) -> None:
    if cert_id.startswith("LOCAL-"):
        return
    with connect() as connection:
        row = connection.execute(
            "SELECT result_id, cert_status FROM exam_results WHERE cert_id = ?", (cert_id,)
        ).fetchone()
        if not row:
            return
        now = utc_now()
        connection.execute(
            "UPDATE exam_results SET cert_status = 'ISSUE_FAILED', updated_at = ? WHERE cert_id = ?",
            (now, cert_id),
        )
        connection.execute(
            "UPDATE certificates SET status = 'ISSUE_FAILED', updated_at = ? WHERE cert_id = ?",
            (now, cert_id),
        )
        connection.execute(
            """INSERT INTO certificate_status_history
               (result_id, previous_status, next_status, reason, changed_at)
               VALUES (?, ?, 'ISSUE_FAILED', ?, ?)""",
            (row["result_id"], row["cert_status"], reason[:500], now),
        )


def select_result_records(rows: list[dict], mode: str) -> list[dict]:
    normalized = (mode or "allAttempts").strip()
    if normalized in {"all", "allAttempts"}:
        return rows
    if normalized not in {"latest", "latestPerEmployee", "best", "bestPerEmployee"}:
        raise ValueError("Unsupported result selection mode.")

    selected: dict[tuple[str, str, str], dict] = {}
    for row in rows:
        key = (row["employee_id"], row["exam_type"], str(row["exam_version"]))
        current = selected.get(key)
        if current is None:
            selected[key] = row
            continue
        if normalized in {"latest", "latestPerEmployee"}:
            current_rank = (current["exam_date"], current["result_id"])
            row_rank = (row["exam_date"], row["result_id"])
        else:
            current_rank = (current["score"], current["exam_date"], current["result_id"])
            row_rank = (row["score"], row["exam_date"], row["result_id"])
        if row_rank > current_rank:
            selected[key] = row
    return sorted(selected.values(), key=lambda item: (item["exam_date"], item["result_id"]), reverse=True)


def search_results(query: dict) -> list[dict]:
    conditions, parameters = [], []
    search = query.get("search", [""])[0].strip()
    if search:
        conditions.append("(employee_id LIKE ? OR employee_name LIKE ? OR cert_id LIKE ?)")
        parameters.extend([f"%{search}%"] * 3)
    status = query.get("pass_status", [""])[0]
    if status in {"PASS", "FAIL"}:
        conditions.append("pass_status = ?")
        parameters.append(status)
    date_from = query.get("date_from", [""])[0]
    date_to = query.get("date_to", [""])[0]
    if date_from:
        conditions.append("exam_date >= ?")
        parameters.append(date_from)
    if date_to:
        conditions.append("exam_date < date(?, '+1 day')")
        parameters.append(date_to)
    where = f" WHERE {' AND '.join(conditions)}" if conditions else ""
    with connect() as connection:
        rows = connection.execute(
            f"SELECT * FROM exam_results{where} ORDER BY exam_date DESC, result_id DESC LIMIT 1000",
            parameters,
        ).fetchall()
    records = [row_to_dict(row) for row in rows]
    mode = query.get("mode", ["allAttempts"])[0]
    return select_result_records(records, mode)


def set_certificate_status(cert_id: str, next_status: str, reason: str) -> dict:
    if cert_id.startswith("LOCAL-"):
        raise LookupError("LOCAL_ONLY output is not an official certificate.")
    if next_status not in {"CANCELLED"}:
        raise ValueError("Unsupported certificate status.")
    with connect() as connection:
        row = connection.execute(
            "SELECT * FROM exam_results WHERE cert_id = ?", (cert_id,)
        ).fetchone()
        if not row:
            raise LookupError("Certificate ID was not found.")
        now = utc_now()
        connection.execute(
            "UPDATE exam_results SET cert_status = ?, updated_at = ? WHERE cert_id = ?",
            (next_status, now, cert_id),
        )
        connection.execute(
            "UPDATE certificates SET status = ?, updated_at = ? WHERE cert_id = ?",
            (next_status, now, cert_id),
        )
        connection.execute(
            """INSERT INTO certificate_status_history
               (result_id, previous_status, next_status, reason, changed_at)
               VALUES (?, ?, ?, ?, ?)""",
            (row["result_id"], row["cert_status"], next_status, reason[:500], now),
        )
        record_audit_log(
            connection,
            "certificate",
            cert_id,
            "cancelled",
            reason=reason[:500],
            now=now,
        )
        return row_to_dict(connection.execute(
            "SELECT * FROM exam_results WHERE cert_id = ?", (cert_id,)
        ).fetchone())


def csv_safe(value):
    if isinstance(value, str) and value.startswith(CSV_FORMULA_PREFIXES):
        return f"'{value}"
    return value


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_json(self, value: object, status: int = 200) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 15 * 1024 * 1024:
            raise ValueError("Request body is too large.")
        return self.rfile.read(length)

    def read_json(self) -> dict:
        try:
            value = json.loads(self.read_body())
        except json.JSONDecodeError as error:
            raise ValueError("Invalid JSON request.") from error
        if not isinstance(value, dict):
            raise ValueError("JSON object is required.")
        return value

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self.send_json({"ok": True, "database": str(DB_PATH)})
            return
        if parsed.path == "/api/results":
            self.send_json({"results": search_results(parse_qs(parsed.query))})
            return
        if parsed.path.startswith("/api/certificates/"):
            cert_id = unquote(parsed.path.removeprefix("/api/certificates/"))
            try:
                self.send_json({"result": get_certificate(cert_id)})
            except LookupError as error:
                self.send_json({"error": str(error)}, HTTPStatus.NOT_FOUND)
            return
        if parsed.path == "/api/results.csv":
            rows = search_results(parse_qs(parsed.query))
            output = io.StringIO()
            fields = list(rows[0].keys()) if rows else [
                "result_id", "cert_id", "exam_type", "exam_name", "employee_id",
                "employee_name", "exam_date", "score", "grade", "pass_status", "cert_status"
            ]
            writer = csv.DictWriter(output, fieldnames=fields)
            writer.writeheader()
            writer.writerows([{key: csv_safe(value) for key, value in row.items()} for row in rows])
            body = ("\ufeff" + output.getvalue()).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", 'attachment; filename="exam-results.csv"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/results":
                self.send_json({"result": insert_result(self.read_json())}, HTTPStatus.CREATED)
                return
            if parsed.path == "/api/assessment-sessions":
                self.send_json({"session": create_assessment_session(self.read_json())}, HTTPStatus.CREATED)
                return
            if parsed.path == "/api/submissions":
                self.send_json(create_submission(self.read_json()), HTTPStatus.CREATED)
                return
            if parsed.path == "/api/certification/readiness":
                payload = self.read_json()
                readiness = validate_certification_readiness(
                    payload_value(payload, "assessment_session_id", "session_id"),
                    payload_value(payload, "qualification_type_id", "qualificationTypeId"),
                    payload_value(payload, "examinee_id", "examineeId"),
                )
                self.send_json({"readiness": readiness})
                return
            if parsed.path == "/api/certification-decisions":
                self.send_json(create_certification_decision(self.read_json()), HTTPStatus.CREATED)
                return
            if parsed.path.startswith("/api/certificates/") and parsed.path.endswith("/image"):
                cert_id = unquote(parsed.path.removeprefix("/api/certificates/").removesuffix("/image"))
                self.send_json({"result": save_certificate(cert_id, self.read_body())})
                return
            if parsed.path.startswith("/api/certificates/") and parsed.path.endswith("/issue-failed"):
                cert_id = unquote(parsed.path.removeprefix("/api/certificates/").removesuffix("/issue-failed"))
                payload = self.read_json()
                mark_issue_failed(cert_id, str(payload.get("reason", "certificate generation failed")))
                self.send_json({"ok": True})
                return
            if parsed.path.startswith("/api/certificates/") and parsed.path.endswith("/cancel"):
                cert_id = unquote(parsed.path.removeprefix("/api/certificates/").removesuffix("/cancel"))
                payload = self.read_json()
                self.send_json({"result": set_certificate_status(cert_id, "CANCELLED", str(payload.get("reason", "")))})
                return
            self.send_error(HTTPStatus.NOT_FOUND)
        except ValueError as error:
            self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        except LookupError as error:
            self.send_json({"error": str(error)}, HTTPStatus.NOT_FOUND)
        except Exception as error:
            self.log_error("API error: %s", error)
            self.send_json({"error": "Server error while processing the request."}, HTTPStatus.INTERNAL_SERVER_ERROR)


if __name__ == "__main__":
    initialize_database()
    mimetypes.add_type("text/javascript", ".js")
    print(f"QQQ exam server: http://{HOST}:{PORT}")
    print(f"SQLite DB: {DB_PATH}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
