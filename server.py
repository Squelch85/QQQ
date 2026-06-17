#!/usr/bin/env python3
"""Local API server for QQQ exam results and certification records."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import mimetypes
import os
import math
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
CREATE INDEX IF NOT EXISTS idx_exam_results_reassessment_due
    ON exam_results(cert_status, valid_to, result_id)
    WHERE cert_id IS NOT NULL AND valid_to IS NOT NULL;

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
    attribute_rr_required_mode TEXT NOT NULL DEFAULT '',
    variable_rr_required_condition TEXT NOT NULL DEFAULT '',
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

CREATE TABLE IF NOT EXISTS attribute_rr_sets (
    attribute_rr_set_id INTEGER PRIMARY KEY AUTOINCREMENT,
    rr_set_code TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    title TEXT NOT NULL,
    sample_mode TEXT NOT NULL CHECK (sample_mode IN ('image', 'physical_sample', 'mixed')),
    round_count INTEGER NOT NULL DEFAULT 2 CHECK (round_count >= 1),
    criteria_json TEXT NOT NULL DEFAULT '{}',
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (rr_set_code, revision)
);

CREATE TABLE IF NOT EXISTS attribute_rr_samples (
    attribute_rr_sample_id INTEGER PRIMARY KEY AUTOINCREMENT,
    attribute_rr_set_id INTEGER NOT NULL REFERENCES attribute_rr_sets(attribute_rr_set_id),
    sample_code TEXT NOT NULL,
    sample_mode TEXT NOT NULL CHECK (sample_mode IN ('image', 'physical_sample')),
    image_path TEXT NOT NULL DEFAULT '',
    image_hash TEXT NOT NULL DEFAULT '',
    physical_sample_code TEXT NOT NULL DEFAULT '',
    reference_status TEXT NOT NULL CHECK (reference_status IN ('OK', 'NG')),
    defect_type TEXT NOT NULL DEFAULT '',
    reference_note TEXT NOT NULL DEFAULT '',
    display_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (attribute_rr_set_id, sample_code)
);
CREATE INDEX IF NOT EXISTS idx_attribute_rr_samples_set
    ON attribute_rr_samples(attribute_rr_set_id, display_order);

CREATE TABLE IF NOT EXISTS attribute_rr_trials (
    attribute_rr_trial_id INTEGER PRIMARY KEY AUTOINCREMENT,
    assessment_session_id INTEGER NOT NULL REFERENCES assessment_sessions(assessment_session_id),
    attribute_rr_set_id INTEGER NOT NULL REFERENCES attribute_rr_sets(attribute_rr_set_id),
    attribute_rr_sample_id INTEGER NOT NULL REFERENCES attribute_rr_samples(attribute_rr_sample_id),
    examinee_id INTEGER NOT NULL REFERENCES examinees(examinee_id),
    round_no INTEGER NOT NULL CHECK (round_no >= 1),
    judgment TEXT NOT NULL CHECK (judgment IN ('OK', 'NG')),
    defect_type TEXT NOT NULL DEFAULT '',
    locked INTEGER NOT NULL DEFAULT 1 CHECK (locked IN (0, 1)),
    submitted_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (assessment_session_id, attribute_rr_sample_id, round_no)
);
CREATE INDEX IF NOT EXISTS idx_attribute_rr_trials_session
    ON attribute_rr_trials(assessment_session_id, attribute_rr_set_id);

CREATE TABLE IF NOT EXISTS attribute_rr_results (
    attribute_rr_result_id INTEGER PRIMARY KEY AUTOINCREMENT,
    assessment_session_id INTEGER NOT NULL REFERENCES assessment_sessions(assessment_session_id),
    attribute_rr_set_id INTEGER NOT NULL REFERENCES attribute_rr_sets(attribute_rr_set_id),
    total_agreement_rate REAL NOT NULL,
    ok_agreement_rate REAL NOT NULL,
    ng_detection_rate REAL NOT NULL,
    repeat_agreement_rate REAL NOT NULL,
    type1_error_rate REAL NOT NULL,
    type2_error_rate REAL NOT NULL,
    defect_type_agreement_rate REAL NOT NULL,
    final_decision TEXT NOT NULL CHECK (final_decision IN ('PASS', 'FAIL')),
    calculated_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (assessment_session_id, attribute_rr_set_id)
);

CREATE TABLE IF NOT EXISTS variable_rr_studies (
    variable_rr_study_id INTEGER PRIMARY KEY AUTOINCREMENT,
    study_code TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    study_purpose TEXT NOT NULL DEFAULT 'inspector_qualification'
        CHECK (study_purpose IN ('process_msa', 'inspector_qualification')),
    measurement_item TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT '',
    instrument TEXT NOT NULL DEFAULT '',
    lsl REAL,
    usl REAL,
    part_count INTEGER NOT NULL CHECK (part_count >= 2),
    trial_count INTEGER NOT NULL CHECK (trial_count >= 2),
    method TEXT NOT NULL DEFAULT 'range' CHECK (method IN ('range')),
    criteria_json TEXT NOT NULL DEFAULT '{}',
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (study_code, revision)
);

CREATE TABLE IF NOT EXISTS variable_measurements (
    variable_measurement_id INTEGER PRIMARY KEY AUTOINCREMENT,
    assessment_session_id INTEGER NOT NULL REFERENCES assessment_sessions(assessment_session_id),
    variable_rr_study_id INTEGER NOT NULL REFERENCES variable_rr_studies(variable_rr_study_id),
    examinee_id INTEGER NOT NULL REFERENCES examinees(examinee_id),
    part_no INTEGER NOT NULL CHECK (part_no >= 1),
    trial_no INTEGER NOT NULL CHECK (trial_no >= 1),
    measurement_value REAL NOT NULL,
    locked INTEGER NOT NULL DEFAULT 1 CHECK (locked IN (0, 1)),
    measured_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (assessment_session_id, variable_rr_study_id, part_no, trial_no)
);
CREATE INDEX IF NOT EXISTS idx_variable_measurements_session
    ON variable_measurements(assessment_session_id, variable_rr_study_id);

CREATE TABLE IF NOT EXISTS variable_rr_results (
    variable_rr_result_id INTEGER PRIMARY KEY AUTOINCREMENT,
    assessment_session_id INTEGER NOT NULL REFERENCES assessment_sessions(assessment_session_id),
    variable_rr_study_id INTEGER NOT NULL REFERENCES variable_rr_studies(variable_rr_study_id),
    ev REAL NOT NULL,
    av REAL NOT NULL,
    grr REAL NOT NULL,
    part_variation REAL NOT NULL,
    total_variation REAL NOT NULL,
    percent_grr REAL NOT NULL,
    ndc REAL NOT NULL,
    tolerance REAL,
    percent_tolerance REAL,
    final_decision TEXT NOT NULL CHECK (final_decision IN ('PASS', 'CONDITIONAL', 'FAIL')),
    calculated_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (assessment_session_id, variable_rr_study_id)
);

CREATE TABLE IF NOT EXISTS training_records (
    training_record_id INTEGER PRIMARY KEY AUTOINCREMENT,
    examinee_id INTEGER NOT NULL REFERENCES examinees(examinee_id),
    qualification_type_id INTEGER NOT NULL REFERENCES qualification_types(qualification_type_id),
    training_code TEXT NOT NULL,
    training_title TEXT NOT NULL DEFAULT '',
    completed_at TEXT NOT NULL,
    hours REAL NOT NULL DEFAULT 0 CHECK (hours >= 0),
    evidence_path TEXT NOT NULL DEFAULT '',
    evidence_hash TEXT NOT NULL DEFAULT '',
    verified_by TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'verified', 'rejected')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (examinee_id, qualification_type_id, training_code, completed_at)
);
CREATE INDEX IF NOT EXISTS idx_training_records_lookup
    ON training_records(examinee_id, qualification_type_id, status);

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

ASSESSMENT_SCHEMA_REPAIRS = [
    "ALTER TABLE assessment_plans ADD COLUMN attribute_rr_required_mode TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE assessment_plans ADD COLUMN variable_rr_required_condition TEXT NOT NULL DEFAULT ''",
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
        for statement in ASSESSMENT_SCHEMA_REPAIRS:
            try:
                connection.execute(statement)
            except sqlite3.OperationalError as error:
                if "duplicate column name" not in str(error).lower():
                    raise


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

    plan = connection.execute(
        "SELECT * FROM assessment_plans WHERE assessment_plan_id = ?",
        (session["assessment_plan_id"],),
    ).fetchone()

    missing_requirements: list[str] = []
    blocking_reasons: list[str] = []
    warnings: list[str] = []

    pass_row = passing_written_exam(connection, session_id)
    if plan["requires_written_exam"] and not pass_row:
        grade_row = any_written_grade(connection, session_id)
        missing_requirements.append("written_exam")
        blocking_reasons.append("written_exam_not_passed" if grade_row else "written_exam_missing")

    if plan["requires_attribute_rr"]:
        attribute_row = connection.execute(
            """SELECT 1 FROM attribute_rr_results
               WHERE assessment_session_id = ? AND final_decision = 'PASS'
               LIMIT 1""",
            (session_id,),
        ).fetchone()
        if not attribute_row:
            missing_requirements.append("attribute_rr")
            blocking_reasons.append("attribute_rr_not_passed_or_missing")

    if plan["requires_variable_rr"]:
        variable_row = connection.execute(
            """SELECT 1 FROM variable_rr_results
               WHERE assessment_session_id = ? AND final_decision IN ('PASS', 'CONDITIONAL')
               LIMIT 1""",
            (session_id,),
        ).fetchone()
        if not variable_row:
            missing_requirements.append("variable_rr")
            blocking_reasons.append("variable_rr_not_accepted_or_missing")

    if plan["requires_training"]:
        training_row = connection.execute(
            """SELECT 1 FROM training_records
               WHERE examinee_id = ? AND qualification_type_id = ? AND status = 'verified'
               LIMIT 1""",
            (session["examinee_id"], session["qualification_type_id"]),
        ).fetchone()
        if not training_row:
            missing_requirements.append("training_verification")
            blocking_reasons.append("training_not_verified")

    if blocking_reasons:
        return {
            "ready": False,
            "status": "rejected",
            "assessment_session_id": session_id,
            "qualification_type_id": session["qualification_type_id"],
            "examinee_id": session["examinee_id"],
            "missing_requirements": missing_requirements,
            "blocking_reasons": blocking_reasons,
            "warnings": warnings,
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
            "warnings": warnings,
            "written_exam": row_to_dict(pass_row) if pass_row else None,
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
        "warnings": warnings,
        "written_exam": row_to_dict(pass_row) if pass_row else None,
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



def _json_object(value, default=None) -> dict:
    if value in (None, ""):
        return dict(default or {})
    parsed = json.loads(value) if isinstance(value, str) else value
    if not isinstance(parsed, dict):
        raise ValueError("Expected a JSON object.")
    return parsed


def create_attribute_rr_set(payload: dict) -> dict:
    now = utc_now()
    samples = payload_value(payload, "samples", default=[])
    if not isinstance(samples, list) or not samples:
        raise ValueError("samples must be a non-empty array.")
    with connect() as connection:
        cursor = connection.execute(
            """INSERT INTO attribute_rr_sets (
                 rr_set_code, revision, title, sample_mode, round_count,
                 criteria_json, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                text_value(payload, "rr_set_code", "rrSetCode", required=True),
                validate_exam_revision(payload_value(payload, "revision", default=1)),
                text_value(payload, "title", required=True),
                text_value(payload, "sample_mode", "sampleMode", default="image"),
                int_value(payload_value(payload, "round_count", "roundCount"), default=2),
                json_text(payload_value(payload, "criteria", "criteria_json"), {}),
                now,
                now,
            ),
        )
        rr_set_id = cursor.lastrowid
        for index, sample in enumerate(samples, start=1):
            connection.execute(
                """INSERT INTO attribute_rr_samples (
                     attribute_rr_set_id, sample_code, sample_mode, image_path,
                     image_hash, physical_sample_code, reference_status, defect_type,
                     reference_note, display_order, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    rr_set_id,
                    text_value(sample, "sample_code", "sampleCode", required=True),
                    text_value(sample, "sample_mode", "sampleMode", default=text_value(payload, "sample_mode", "sampleMode", default="image") if text_value(payload, "sample_mode", "sampleMode", default="image") != "mixed" else "image"),
                    text_value(sample, "image_path", "imagePath", default=""),
                    text_value(sample, "image_hash", "imageHash", default=""),
                    text_value(sample, "physical_sample_code", "physicalSampleCode", default=""),
                    text_value(sample, "reference_status", "referenceStatus", required=True).upper(),
                    text_value(sample, "defect_type", "defectType", default=""),
                    text_value(sample, "reference_note", "referenceNote", default=""),
                    int_value(payload_value(sample, "display_order", "displayOrder"), default=index),
                    now,
                    now,
                ),
            )
        record_audit_log(connection, "attribute_rr_set", rr_set_id, "created", now=now)
        return row_to_dict(connection.execute("SELECT * FROM attribute_rr_sets WHERE attribute_rr_set_id = ?", (rr_set_id,)).fetchone())


def submit_attribute_rr_trials(payload: dict) -> dict:
    now = utc_now()
    session_id = int_value(payload_value(payload, "assessment_session_id", "sessionId"))
    rr_set_id = int_value(payload_value(payload, "attribute_rr_set_id", "rrSetId"))
    if not session_id or not rr_set_id:
        raise ValueError("assessment_session_id and attribute_rr_set_id are required.")
    trials = payload_value(payload, "trials", default=[])
    if not isinstance(trials, list) or not trials:
        raise ValueError("trials must be a non-empty array.")
    with connect() as connection:
        session = connection.execute("SELECT * FROM assessment_sessions WHERE assessment_session_id = ?", (session_id,)).fetchone()
        if not session:
            raise ValueError("assessment_session_id was not found.")
        for trial in trials:
            connection.execute(
                """INSERT INTO attribute_rr_trials (
                     assessment_session_id, attribute_rr_set_id, attribute_rr_sample_id,
                     examinee_id, round_no, judgment, defect_type, submitted_at, created_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    session_id, rr_set_id,
                    int_value(payload_value(trial, "attribute_rr_sample_id", "sampleId")),
                    session["examinee_id"],
                    int_value(payload_value(trial, "round_no", "roundNo")),
                    text_value(trial, "judgment", required=True).upper(),
                    text_value(trial, "defect_type", "defectType", default=""),
                    text_value(trial, "submitted_at", "submittedAt", default=now), now,
                ),
            )
        return calculate_attribute_rr_result_in_connection(connection, session_id, rr_set_id, now)


def calculate_attribute_rr_result_in_connection(connection, session_id: int, rr_set_id: int, now: str) -> dict:
    rows = connection.execute(
        """SELECT s.attribute_rr_sample_id, s.reference_status, s.defect_type AS reference_defect_type,
                  t.round_no, t.judgment, t.defect_type
           FROM attribute_rr_samples s
           LEFT JOIN attribute_rr_trials t ON t.attribute_rr_sample_id = s.attribute_rr_sample_id
                AND t.assessment_session_id = ?
           WHERE s.attribute_rr_set_id = ? AND s.active = 1
           ORDER BY s.display_order, s.attribute_rr_sample_id, t.round_no""", (session_id, rr_set_id)).fetchall()
    if not rows or any(row["judgment"] is None for row in rows):
        raise ValueError("All active samples must have submitted trials before calculation.")
    total = len(rows)
    matches = sum(1 for r in rows if r["judgment"] == r["reference_status"])
    ok_rows = [r for r in rows if r["reference_status"] == "OK"]
    ng_rows = [r for r in rows if r["reference_status"] == "NG"]
    type1 = sum(1 for r in ok_rows if r["judgment"] == "NG") / len(ok_rows) if ok_rows else 0.0
    type2 = sum(1 for r in ng_rows if r["judgment"] == "OK") / len(ng_rows) if ng_rows else 0.0
    ng_detect = sum(1 for r in ng_rows if r["judgment"] == "NG") / len(ng_rows) if ng_rows else 1.0
    ok_agree = sum(1 for r in ok_rows if r["judgment"] == "OK") / len(ok_rows) if ok_rows else 1.0
    defect_rows = [r for r in ng_rows if r["reference_defect_type"]]
    defect_agree = sum(1 for r in defect_rows if r["judgment"] == "NG" and r["defect_type"] == r["reference_defect_type"]) / len(defect_rows) if defect_rows else 1.0
    by_sample = {}
    for r in rows:
        by_sample.setdefault(r["attribute_rr_sample_id"], set()).add(r["judgment"])
    repeat_agree = sum(1 for judgments in by_sample.values() if len(judgments) == 1) / len(by_sample)
    criteria = _json_object(connection.execute("SELECT criteria_json FROM attribute_rr_sets WHERE attribute_rr_set_id = ?", (rr_set_id,)).fetchone()["criteria_json"])
    final = "PASS" if (matches / total >= float(criteria.get("min_total_agreement_rate", 0.9)) and repeat_agree >= float(criteria.get("min_repeat_agreement_rate", 0.9)) and type1 <= float(criteria.get("max_type1_error_rate", 0.05)) and type2 <= float(criteria.get("max_type2_error_rate", 0.1))) else "FAIL"
    values = (session_id, rr_set_id, matches / total, ok_agree, ng_detect, repeat_agree, type1, type2, defect_agree, final, now, now)
    connection.execute(
        """INSERT INTO attribute_rr_results (
             assessment_session_id, attribute_rr_set_id, total_agreement_rate, ok_agreement_rate,
             ng_detection_rate, repeat_agreement_rate, type1_error_rate, type2_error_rate,
             defect_type_agreement_rate, final_decision, calculated_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(assessment_session_id, attribute_rr_set_id) DO UPDATE SET
             total_agreement_rate=excluded.total_agreement_rate, ok_agreement_rate=excluded.ok_agreement_rate,
             ng_detection_rate=excluded.ng_detection_rate, repeat_agreement_rate=excluded.repeat_agreement_rate,
             type1_error_rate=excluded.type1_error_rate, type2_error_rate=excluded.type2_error_rate,
             defect_type_agreement_rate=excluded.defect_type_agreement_rate, final_decision=excluded.final_decision,
             calculated_at=excluded.calculated_at""", values)
    record_audit_log(connection, "attribute_rr_result", f"{session_id}:{rr_set_id}", "calculated", metadata={"final_decision": final}, now=now)
    return row_to_dict(connection.execute("SELECT * FROM attribute_rr_results WHERE assessment_session_id = ? AND attribute_rr_set_id = ?", (session_id, rr_set_id)).fetchone())


def create_variable_rr_study(payload: dict) -> dict:
    now = utc_now()
    with connect() as connection:
        cursor = connection.execute(
            """INSERT INTO variable_rr_studies (
                 study_code, revision, study_purpose, measurement_item, unit, instrument,
                 lsl, usl, part_count, trial_count, criteria_json, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (text_value(payload, "study_code", "studyCode", required=True), validate_exam_revision(payload_value(payload, "revision", default=1)), text_value(payload, "study_purpose", "studyPurpose", default="inspector_qualification"), text_value(payload, "measurement_item", "measurementItem", required=True), text_value(payload, "unit", default=""), text_value(payload, "instrument", default=""), float_value(payload_value(payload, "lsl"), default=None), float_value(payload_value(payload, "usl"), default=None), int_value(payload_value(payload, "part_count", "partCount")), int_value(payload_value(payload, "trial_count", "trialCount")), json_text(payload_value(payload, "criteria", "criteria_json"), {}), now, now))
        record_audit_log(connection, "variable_rr_study", cursor.lastrowid, "created", now=now)
        return row_to_dict(connection.execute("SELECT * FROM variable_rr_studies WHERE variable_rr_study_id = ?", (cursor.lastrowid,)).fetchone())



def parse_variable_measurements_csv(csv_text: str) -> list[dict]:
    if not isinstance(csv_text, str) or not csv_text.strip():
        raise ValueError("csv_text must be a non-empty string.")
    reader = csv.DictReader(io.StringIO(csv_text.lstrip("\ufeff")))
    if not reader.fieldnames:
        raise ValueError("CSV header is required.")

    normalized_headers = {str(name).strip().lower(): name for name in reader.fieldnames}

    def header(*names: str) -> str:
        for name in names:
            if name in normalized_headers:
                return normalized_headers[name]
        raise ValueError(f"CSV header is missing: {names[0]}")

    part_header = header("part_no", "partno", "part", "부품", "부품번호")
    trial_header = header("trial_no", "trialno", "trial", "반복", "반복번호")
    value_header = header("measurement_value", "value", "measurement", "측정값")
    measured_at_header = normalized_headers.get("measured_at") or normalized_headers.get("measuredat")

    measurements = []
    for row_number, row in enumerate(reader, start=2):
        if not any(str(value or "").strip() for value in row.values()):
            continue
        try:
            item = {
                "part_no": int_value(row.get(part_header)),
                "trial_no": int_value(row.get(trial_header)),
                "measurement_value": float_value(row.get(value_header)),
            }
        except ValueError as error:
            raise ValueError(f"CSV row {row_number} has an invalid measurement value.") from error
        if measured_at_header and str(row.get(measured_at_header, "")).strip():
            item["measured_at"] = str(row[measured_at_header]).strip()
        measurements.append(item)
    if not measurements:
        raise ValueError("CSV must contain at least one measurement row.")
    return measurements


def submit_variable_measurements_csv(payload: dict) -> dict:
    csv_text = payload_value(payload, "csv_text", "csvText", "csv")
    return submit_variable_measurements({
        **payload,
        "measurements": parse_variable_measurements_csv(csv_text),
    })

def submit_variable_measurements(payload: dict) -> dict:
    now = utc_now()
    session_id = int_value(payload_value(payload, "assessment_session_id", "sessionId"))
    study_id = int_value(payload_value(payload, "variable_rr_study_id", "studyId"))
    if not session_id or not study_id:
        raise ValueError("assessment_session_id and variable_rr_study_id are required.")
    measurements = payload_value(payload, "measurements", default=[])
    if not isinstance(measurements, list) or not measurements:
        raise ValueError("measurements must be a non-empty array.")
    with connect() as connection:
        session = connection.execute("SELECT * FROM assessment_sessions WHERE assessment_session_id = ?", (session_id,)).fetchone()
        if not session:
            raise ValueError("assessment_session_id was not found.")
        study = connection.execute("SELECT part_count, trial_count FROM variable_rr_studies WHERE variable_rr_study_id = ?", (study_id,)).fetchone()
        if not study:
            raise ValueError("variable_rr_study_id was not found.")
        part_count = int(study["part_count"])
        trial_count = int(study["trial_count"])
        seen_measurements = set()
        prepared_measurements = []
        for item in measurements:
            part_no = int_value(payload_value(item, "part_no", "partNo"))
            trial_no = int_value(payload_value(item, "trial_no", "trialNo"))
            if part_no < 1 or part_no > part_count or trial_no < 1 or trial_no > trial_count:
                raise ValueError("measurement part_no/trial_no is outside the study plan.")
            measurement_key = (part_no, trial_no)
            if measurement_key in seen_measurements:
                raise ValueError("duplicate part_no/trial_no measurements are not allowed.")
            seen_measurements.add(measurement_key)
            prepared_measurements.append((
                session_id,
                study_id,
                session["examinee_id"],
                part_no,
                trial_no,
                float_value(payload_value(item, "measurement_value", "value")),
                text_value(item, "measured_at", "measuredAt", default=now),
                now,
            ))
        for prepared in prepared_measurements:
            connection.execute(
                """INSERT INTO variable_measurements (
                     assessment_session_id, variable_rr_study_id, examinee_id,
                     part_no, trial_no, measurement_value, measured_at, created_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                prepared,
            )
        return calculate_variable_rr_result_in_connection(connection, session_id, study_id, now)


def calculate_variable_rr_result_in_connection(connection, session_id: int, study_id: int, now: str) -> dict:
    study = connection.execute("SELECT * FROM variable_rr_studies WHERE variable_rr_study_id = ?", (study_id,)).fetchone()
    if not study:
        raise ValueError("variable_rr_study_id was not found.")
    rows = connection.execute("SELECT part_no, trial_no, measurement_value FROM variable_measurements WHERE assessment_session_id = ? AND variable_rr_study_id = ?", (session_id, study_id)).fetchall()
    expected = int(study["part_count"]) * int(study["trial_count"])
    if len(rows) != expected:
        raise ValueError("All part/trial measurements are required before calculation.")
    by_part = {}
    for row in rows:
        by_part.setdefault(row["part_no"], []).append(float(row["measurement_value"]))
    ranges = [max(values) - min(values) for values in by_part.values()]
    averages = [sum(values) / len(values) for values in by_part.values()]
    rbar = sum(ranges) / len(ranges)
    xbar_range = max(averages) - min(averages)
    d2 = {2: 1.128, 3: 1.693, 4: 2.059, 5: 2.326}.get(int(study["trial_count"]), 1.128)
    d2_parts = {2: 1.128, 3: 1.693, 4: 2.059, 5: 2.326, 6: 2.534, 7: 2.704, 8: 2.847, 9: 2.970, 10: 3.078}.get(int(study["part_count"]), 3.078)
    ev = rbar / d2
    av = 0.0
    grr = math.sqrt(ev * ev + av * av)
    part_variation = xbar_range / d2_parts
    total_variation = math.sqrt(grr * grr + part_variation * part_variation)
    percent_grr = (grr / total_variation * 100.0) if total_variation else 100.0
    ndc = 1.41 * (part_variation / grr) if grr else 999.0
    tolerance = (float(study["usl"]) - float(study["lsl"])) if study["usl"] is not None and study["lsl"] is not None else None
    percent_tolerance = (grr / tolerance * 100.0) if tolerance and tolerance > 0 else None
    criteria = _json_object(study["criteria_json"])
    pass_limit = float(criteria.get("max_percent_grr", 10.0))
    conditional_limit = float(criteria.get("conditional_percent_grr", 30.0))
    final = "PASS" if percent_grr <= pass_limit else "CONDITIONAL" if percent_grr <= conditional_limit else "FAIL"
    connection.execute(
        """INSERT INTO variable_rr_results (
             assessment_session_id, variable_rr_study_id, ev, av, grr, part_variation,
             total_variation, percent_grr, ndc, tolerance, percent_tolerance,
             final_decision, calculated_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(assessment_session_id, variable_rr_study_id) DO UPDATE SET
             ev=excluded.ev, av=excluded.av, grr=excluded.grr, part_variation=excluded.part_variation,
             total_variation=excluded.total_variation, percent_grr=excluded.percent_grr, ndc=excluded.ndc,
             tolerance=excluded.tolerance, percent_tolerance=excluded.percent_tolerance,
             final_decision=excluded.final_decision, calculated_at=excluded.calculated_at""",
        (session_id, study_id, ev, av, grr, part_variation, total_variation, percent_grr, ndc, tolerance, percent_tolerance, final, now, now),
    )
    record_audit_log(connection, "variable_rr_result", f"{session_id}:{study_id}", "calculated", metadata={"final_decision": final}, now=now)
    return row_to_dict(connection.execute("SELECT * FROM variable_rr_results WHERE assessment_session_id = ? AND variable_rr_study_id = ?", (session_id, study_id)).fetchone())

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



def query_assessment_history(query: dict) -> list[dict]:
    conditions, parameters = [], []
    employee_id = query.get("employee_id", [""])[0].strip()
    qualification_code = query.get("qualification_code", [""])[0].strip()
    if employee_id:
        conditions.append("e.employee_id = ?")
        parameters.append(employee_id)
    if qualification_code:
        conditions.append("qt.code = ?")
        parameters.append(qualification_code)
    where = f" WHERE {' AND '.join(conditions)}" if conditions else ""
    with connect() as connection:
        rows = connection.execute(
            f"""SELECT
                   s.assessment_session_id, s.session_code, s.status, s.created_at, s.updated_at,
                   e.employee_id, e.employee_name, e.department,
                   qt.code AS qualification_code, qt.name AS qualification_name,
                   ap.revision AS assessment_plan_revision,
                   gr.score AS written_score, gr.pass_status AS written_pass_status,
                   cd.decision AS certification_decision, c.cert_id, c.status AS certificate_status
               FROM assessment_sessions s
               JOIN examinees e ON e.examinee_id = s.examinee_id
               JOIN qualification_types qt ON qt.qualification_type_id = s.qualification_type_id
               JOIN assessment_plans ap ON ap.assessment_plan_id = s.assessment_plan_id
               LEFT JOIN submissions sub ON sub.assessment_session_id = s.assessment_session_id
               LEFT JOIN grade_results gr ON gr.submission_id = sub.submission_id
               LEFT JOIN certification_decisions cd ON cd.certification_decision_id = (
                   SELECT cd2.certification_decision_id FROM certification_decisions cd2
                   WHERE cd2.assessment_session_id = s.assessment_session_id
                   ORDER BY cd2.certification_decision_id DESC LIMIT 1
               )
               LEFT JOIN certificates c ON c.assessment_session_id = s.assessment_session_id
                    AND c.issue_mode = 'official'
               {where}
               ORDER BY s.created_at DESC, s.assessment_session_id DESC
               LIMIT 1000""",
            parameters,
        ).fetchall()
    return [row_to_dict(row) for row in rows]


def query_rr_results(query: dict) -> dict:
    session_id = int_value(query.get("assessment_session_id", [None])[0], default=None)
    if not session_id:
        raise ValueError("assessment_session_id is required.")
    with connect() as connection:
        attribute_rows = connection.execute(
            """SELECT ars.rr_set_code, ars.title, arr.*
               FROM attribute_rr_results arr
               JOIN attribute_rr_sets ars ON ars.attribute_rr_set_id = arr.attribute_rr_set_id
               WHERE arr.assessment_session_id = ?
               ORDER BY arr.calculated_at DESC""",
            (session_id,),
        ).fetchall()
        variable_rows = connection.execute(
            """SELECT vrs.study_code, vrs.measurement_item, vrs.unit, vrr.*
               FROM variable_rr_results vrr
               JOIN variable_rr_studies vrs ON vrs.variable_rr_study_id = vrr.variable_rr_study_id
               WHERE vrr.assessment_session_id = ?
               ORDER BY vrr.calculated_at DESC""",
            (session_id,),
        ).fetchall()
    return {
        "assessment_session_id": session_id,
        "attribute_rr_results": [row_to_dict(row) for row in attribute_rows],
        "variable_rr_results": [row_to_dict(row) for row in variable_rows],
    }


def query_training_missing(query: dict) -> list[dict]:
    qualification_code = query.get("qualification_code", [""])[0].strip()
    conditions = ["ap.requires_training = 1"]
    parameters = []
    if qualification_code:
        conditions.append("qt.code = ?")
        parameters.append(qualification_code)
    with connect() as connection:
        rows = connection.execute(
            f"""SELECT s.assessment_session_id, s.session_code, e.employee_id, e.employee_name,
                      qt.code AS qualification_code, qt.name AS qualification_name
               FROM assessment_sessions s
               JOIN examinees e ON e.examinee_id = s.examinee_id
               JOIN qualification_types qt ON qt.qualification_type_id = s.qualification_type_id
               JOIN assessment_plans ap ON ap.assessment_plan_id = s.assessment_plan_id
               LEFT JOIN training_records tr ON tr.examinee_id = s.examinee_id
                    AND tr.qualification_type_id = s.qualification_type_id
                    AND tr.status = 'verified'
               WHERE {' AND '.join(conditions)} AND tr.training_record_id IS NULL
               ORDER BY s.created_at DESC, s.assessment_session_id DESC
               LIMIT 1000""",
            parameters,
        ).fetchall()
    return [row_to_dict(row) for row in rows]


def query_reassessment_due(query: dict) -> list[dict]:
    as_of = query.get("as_of", [datetime.now(timezone.utc).date().isoformat()])[0]
    with connect() as connection:
        rows = connection.execute(
            """SELECT er.result_id, er.cert_id, er.exam_type, er.exam_name, er.employee_id,
                      er.employee_name, er.valid_to, er.cert_status, c.assessment_session_id
               FROM exam_results er
               LEFT JOIN certificates c ON c.cert_id = er.cert_id AND c.issue_mode = 'official'
               WHERE er.cert_id IS NOT NULL
                 AND er.valid_to IS NOT NULL
                 AND er.cert_status IN ('VALID', 'EXPIRED')
                 AND er.valid_to <= date(?, '+30 day')
               ORDER BY er.valid_to ASC, er.result_id ASC
               LIMIT 1000""",
            (as_of,),
        ).fetchall()
    return [row_to_dict(row) for row in rows]

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
        if parsed.path == "/api/reports/assessment-history":
            self.send_json({"sessions": query_assessment_history(parse_qs(parsed.query))})
            return
        if parsed.path == "/api/reports/rr":
            try:
                self.send_json(query_rr_results(parse_qs(parsed.query)))
            except ValueError as error:
                self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/api/reports/training-missing":
            self.send_json({"sessions": query_training_missing(parse_qs(parsed.query))})
            return
        if parsed.path == "/api/reports/reassessment-due":
            self.send_json({"results": query_reassessment_due(parse_qs(parsed.query))})
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
            if parsed.path == "/api/attribute-rr/sets":
                self.send_json({"rr_set": create_attribute_rr_set(self.read_json())}, HTTPStatus.CREATED)
                return
            if parsed.path == "/api/attribute-rr/trials":
                self.send_json({"result": submit_attribute_rr_trials(self.read_json())}, HTTPStatus.CREATED)
                return
            if parsed.path == "/api/variable-rr/studies":
                self.send_json({"study": create_variable_rr_study(self.read_json())}, HTTPStatus.CREATED)
                return
            if parsed.path == "/api/variable-rr/measurements":
                self.send_json({"result": submit_variable_measurements(self.read_json())}, HTTPStatus.CREATED)
                return
            if parsed.path == "/api/variable-rr/measurements.csv":
                self.send_json({"result": submit_variable_measurements_csv(self.read_json())}, HTTPStatus.CREATED)
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
