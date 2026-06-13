#!/usr/bin/env python3
"""QQQ 로컬 시험·인증 API 서버."""

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

SCHEMA = """
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


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    return connection


def initialize_database() -> None:
    with connect() as connection:
        connection.executescript(SCHEMA)


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
            [payload["employee_id"], payload["exam_date"], str(payload["score"]), created_at, nonce]
        )
        check = hashlib.sha256(source.encode("utf-8")).hexdigest()[:4].upper()
        cert_id = f"GRR-WT-{year}-{sequence:06d}-{check}"
        exists = connection.execute(
            "SELECT 1 FROM exam_results WHERE cert_id = ?", (cert_id,)
        ).fetchone()
        if not exists:
            return cert_id
    raise RuntimeError("고유 인증 ID를 생성하지 못했습니다.")


def row_to_dict(row: sqlite3.Row) -> dict:
    result = dict(row)
    if result.get("cert_status") == "VALID" and result.get("valid_to"):
        if result["valid_to"] < datetime.now(timezone.utc).date().isoformat():
            result["cert_status"] = "EXPIRED"
    return result


def insert_result(payload: dict) -> dict:
    required = [
        "exam_type", "exam_name", "exam_version", "employee_id", "employee_name",
        "exam_date", "total_questions", "correct_count", "wrong_count", "score", "pass_score"
    ]
    missing = [key for key in required if payload.get(key) in (None, "")]
    if missing:
        raise ValueError(f"필수 항목이 없습니다: {', '.join(missing)}")

    score = float(payload["score"])
    pass_score = float(payload["pass_score"])
    grade = grade_for(score)
    passed = score >= pass_score
    issue_certificate = score >= 80 and grade in {"A", "B"}
    created_at = utc_now()

    with connect() as connection:
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
                cert_id, payload["exam_type"], payload["exam_name"], str(payload["exam_version"]),
                payload["employee_id"], payload["employee_name"], payload.get("department", ""),
                payload.get("process_name", ""), payload["exam_date"], int(payload["total_questions"]),
                int(payload["correct_count"]), int(payload["wrong_count"]), score, pass_score,
                grade, "PASS" if passed else "FAIL", payload.get("issued_date") if cert_id else None,
                payload.get("valid_from") if cert_id else None, payload.get("valid_to") if cert_id else None,
                qr_value, status, payload.get("evaluator", ""), payload.get("approver", ""),
                created_at, created_at,
            ),
        )
        row = connection.execute(
            "SELECT * FROM exam_results WHERE result_id = ?", (cursor.lastrowid,)
        ).fetchone()
        return row_to_dict(row)


def save_certificate(cert_id: str, png: bytes) -> dict:
    if not png.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("인증서 파일은 PNG 형식이어야 합니다.")
    if len(png) > 15 * 1024 * 1024:
        raise ValueError("인증서 이미지가 15MB를 초과합니다.")

    with connect() as connection:
        row = connection.execute(
            "SELECT * FROM exam_results WHERE cert_id = ?", (cert_id,)
        ).fetchone()
        if not row:
            raise LookupError("인증 ID를 찾을 수 없습니다.")
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
            """INSERT INTO certificate_status_history
               (result_id, previous_status, next_status, reason, changed_at)
               VALUES (?, ?, ?, '인증서 이미지 발행', ?)""",
            (row["result_id"], previous, next_status, now),
        )
        updated = connection.execute(
            "SELECT * FROM exam_results WHERE cert_id = ?", (cert_id,)
        ).fetchone()
        return row_to_dict(updated)


def mark_issue_failed(cert_id: str, reason: str) -> None:
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
            """INSERT INTO certificate_status_history
               (result_id, previous_status, next_status, reason, changed_at)
               VALUES (?, ?, 'ISSUE_FAILED', ?, ?)""",
            (row["result_id"], row["cert_status"], reason[:500], now),
        )


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
    return [row_to_dict(row) for row in rows]


def set_certificate_status(cert_id: str, next_status: str, reason: str) -> dict:
    if next_status not in {"CANCELLED"}:
        raise ValueError("지원하지 않는 인증 상태입니다.")
    with connect() as connection:
        row = connection.execute(
            "SELECT * FROM exam_results WHERE cert_id = ?", (cert_id,)
        ).fetchone()
        if not row:
            raise LookupError("인증 ID를 찾을 수 없습니다.")
        now = utc_now()
        connection.execute(
            "UPDATE exam_results SET cert_status = ?, updated_at = ? WHERE cert_id = ?",
            (next_status, now, cert_id),
        )
        connection.execute(
            """INSERT INTO certificate_status_history
               (result_id, previous_status, next_status, reason, changed_at)
               VALUES (?, ?, ?, ?, ?)""",
            (row["result_id"], row["cert_status"], next_status, reason[:500], now),
        )
        return row_to_dict(connection.execute(
            "SELECT * FROM exam_results WHERE cert_id = ?", (cert_id,)
        ).fetchone())


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
            raise ValueError("요청 본문이 너무 큽니다.")
        return self.rfile.read(length)

    def read_json(self) -> dict:
        try:
            value = json.loads(self.read_body())
        except json.JSONDecodeError as error:
            raise ValueError("JSON 요청 형식이 올바르지 않습니다.") from error
        if not isinstance(value, dict):
            raise ValueError("JSON 객체가 필요합니다.")
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
            with connect() as connection:
                row = connection.execute(
                    "SELECT * FROM exam_results WHERE cert_id = ?", (cert_id,)
                ).fetchone()
            if not row:
                self.send_json({"error": "인증 ID를 찾을 수 없습니다."}, HTTPStatus.NOT_FOUND)
            else:
                self.send_json({"result": row_to_dict(row)})
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
            writer.writerows(rows)
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
            if parsed.path.startswith("/api/certificates/") and parsed.path.endswith("/image"):
                cert_id = unquote(parsed.path.removeprefix("/api/certificates/").removesuffix("/image"))
                self.send_json({"result": save_certificate(cert_id, self.read_body())})
                return
            if parsed.path.startswith("/api/certificates/") and parsed.path.endswith("/issue-failed"):
                cert_id = unquote(parsed.path.removeprefix("/api/certificates/").removesuffix("/issue-failed"))
                payload = self.read_json()
                mark_issue_failed(cert_id, str(payload.get("reason", "인증서 생성 실패")))
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
            self.send_json({"error": "서버 처리 중 오류가 발생했습니다."}, HTTPStatus.INTERNAL_SERVER_ERROR)


if __name__ == "__main__":
    initialize_database()
    mimetypes.add_type("text/javascript", ".js")
    print(f"QQQ 시험툴: http://{HOST}:{PORT}")
    print(f"SQLite DB: {DB_PATH}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
