import hashlib
import os
import tempfile
import unittest
from pathlib import Path


class ServerStorageTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        os.environ["QQQ_DATA_DIR"] = self.temp.name
        import server
        server.DATA_DIR = Path(self.temp.name)
        server.DB_PATH = server.DATA_DIR / "exam_results.sqlite3"
        server.CERTIFICATE_DIR = server.DATA_DIR / "certificates"
        server.initialize_database()
        self.server = server

    def tearDown(self):
        self.temp.cleanup()

    def payload(self, score=90):
        return {
            "exam_type": "GRR-WT",
            "exam_name": "검사원 자격인증 Gauge R&R 필기평가",
            "exam_version": "1",
            "employee_id": "E001",
            "employee_name": "홍길동",
            "department": "품질",
            "process_name": "AOI",
            "exam_date": "2026-06-13T10:00:00Z",
            "total_questions": 40,
            "correct_count": 36,
            "wrong_count": 4,
            "score": score,
            "pass_score": 80,
            "issued_date": "2026-06-13",
            "valid_from": "2026-06-13",
            "valid_to": "2027-06-13",
            "evaluator": "평가자",
            "approver": "승인자",
        }

    def test_pass_result_gets_unique_certificate_id_and_png_hash(self):
        first = self.server.insert_result(self.payload())
        second = self.server.insert_result({**self.payload(), "employee_id": "E002"})
        self.assertRegex(first["cert_id"], r"^GRR-WT-\d{2}-\d{6}-[0-9A-F]{4}$")
        self.assertNotEqual(first["cert_id"], second["cert_id"])
        self.assertEqual(first["cert_status"], "ISSUE_PENDING")

        png = b"\x89PNG\r\n\x1a\n" + b"certificate"
        saved = self.server.save_certificate(first["cert_id"], png)
        self.assertEqual(saved["cert_status"], "VALID")
        self.assertEqual(saved["certificate_hash"], hashlib.sha256(png).hexdigest())
        self.assertTrue(saved["certificate_path"].endswith(f"CERT_{first['cert_id']}.png"))

    def test_c_and_d_grades_do_not_issue_certificate(self):
        grade_c = self.server.insert_result(self.payload(75))
        grade_d = self.server.insert_result(self.payload(65))
        self.assertEqual((grade_c["grade"], grade_c["cert_id"]), ("C", None))
        self.assertEqual((grade_d["grade"], grade_d["pass_status"]), ("D", "FAIL"))

    def test_cancel_records_status_history_without_changing_result(self):
        result = self.server.insert_result(self.payload())
        cancelled = self.server.set_certificate_status(result["cert_id"], "CANCELLED", "관리자 취소")
        self.assertEqual(cancelled["cert_status"], "CANCELLED")
        self.assertEqual(cancelled["score"], 90)
        with self.server.connect() as connection:
            history = connection.execute(
                "SELECT next_status, reason FROM certificate_status_history WHERE result_id = ?",
                (result["result_id"],),
            ).fetchone()
        self.assertEqual(dict(history), {"next_status": "CANCELLED", "reason": "관리자 취소"})


if __name__ == "__main__":
    unittest.main()
