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

    def payload(self, score=90, employee_id="E001", exam_date="2026-06-13T10:00:00Z", revision="1"):
        payload = {
            "exam_type": "GRR-WT",
            "exam_name": "Inspector written exam",
            "employee_id": employee_id,
            "employee_name": "Inspector One",
            "department": "Quality",
            "process_name": "AOI",
            "exam_date": exam_date,
            "submitted_at": exam_date,
            "exam_id": "inspector-written",
            "total_questions": 40,
            "correct_count": 36,
            "wrong_count": 4,
            "score": score,
            "max_score": 100,
            "pass_score": 80,
            "issued_date": "2026-06-13",
            "valid_from": "2026-06-13",
            "valid_to": "2027-06-13",
            "evaluator": "Evaluator",
            "approver": "Approver",
            "answers": {"q1": "a"},
            "items": [{"questionId": "q1", "status": "correct"}],
        }
        if revision is not None:
            payload["exam_version"] = revision
        return payload

    def test_migrations_are_idempotent_and_keep_legacy_results_readable(self):
        self.server.initialize_database()
        self.server.initialize_database()

        with self.server.connect() as connection:
            tables = {
                row["name"]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
            }
            migrations = {
                row["version"]
                for row in connection.execute("SELECT version FROM schema_migrations").fetchall()
            }
            connection.execute(
                """INSERT INTO exam_results (
                    exam_type, exam_name, exam_version, employee_id, employee_name,
                    exam_date, total_questions, correct_count, wrong_count, score,
                    pass_score, grade, pass_status, created_at, updated_at
                ) VALUES (
                    'GRR-WT', 'Legacy', '1', 'LEGACY', 'Legacy User',
                    '2026-06-01T00:00:00Z', 1, 1, 0, 100,
                    80, 'A', 'PASS', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z'
                )"""
            )

        self.assertIn("schema_migrations", tables)
        self.assertIn("assessment_sessions", tables)
        self.assertIn("certificates", tables)
        self.assertEqual(migrations, {1, 2})
        rows = self.server.search_results({"search": ["LEGACY"]})
        self.assertEqual(rows[0]["employee_id"], "LEGACY")

    def test_assessment_schema_includes_rr_training_tables_and_locks_source_rows(self):
        with self.server.connect() as connection:
            tables = {
                row["name"]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
            }
            expected_tables = {
                "attribute_rr_sets",
                "attribute_rr_samples",
                "attribute_rr_trials",
                "attribute_rr_results",
                "variable_rr_studies",
                "variable_measurements",
                "variable_rr_results",
                "training_records",
            }
            self.assertTrue(expected_tables.issubset(tables))

            session = self.server.create_assessment_session_in_connection(
                connection,
                {
                    "employee_id": "E-RR-001",
                    "employee_name": "RR Inspector",
                    "exam_type": "AOI",
                    "exam_name": "AOI inspector",
                },
                "2026-06-14T10:00:00Z",
            )
            examinee_id = session["examinee_id"]
            rr_set_id = connection.execute(
                """INSERT INTO attribute_rr_sets (
                    rr_set_code, revision, title, sample_mode, round_count,
                    criteria_json, created_at, updated_at
                ) VALUES (
                    'AOI-ATTR', 1, 'AOI image judgment', 'image', 2,
                    '{}', '2026-06-14T10:00:00Z', '2026-06-14T10:00:00Z'
                )"""
            ).lastrowid
            sample_id = connection.execute(
                """INSERT INTO attribute_rr_samples (
                    attribute_rr_set_id, sample_code, sample_mode, image_path,
                    image_hash, reference_status, defect_type, created_at, updated_at
                ) VALUES (?, 'S-001', 'image', 'samples/s001.png', 'abc', 'NG',
                    'scratch', '2026-06-14T10:00:00Z', '2026-06-14T10:00:00Z')""",
                (rr_set_id,),
            ).lastrowid
            trial_id = connection.execute(
                """INSERT INTO attribute_rr_trials (
                    assessment_session_id, attribute_rr_set_id, attribute_rr_sample_id,
                    examinee_id, round_no, judgment, defect_type, submitted_at, created_at
                ) VALUES (?, ?, ?, ?, 1, 'NG', 'scratch',
                    '2026-06-14T10:01:00Z', '2026-06-14T10:01:00Z')""",
                (session["assessment_session_id"], rr_set_id, sample_id, examinee_id),
            ).lastrowid
            measurement_study_id = connection.execute(
                """INSERT INTO variable_rr_studies (
                    study_code, revision, measurement_item, unit, instrument,
                    part_count, trial_count, criteria_json, created_at, updated_at
                ) VALUES (
                    'DIM-RR', 1, 'Width', 'mm', 'Caliper', 10, 2, '{}',
                    '2026-06-14T10:00:00Z', '2026-06-14T10:00:00Z'
                )"""
            ).lastrowid
            measurement_id = connection.execute(
                """INSERT INTO variable_measurements (
                    assessment_session_id, variable_rr_study_id, examinee_id,
                    part_no, trial_no, measurement_value, measured_at, created_at
                ) VALUES (?, ?, ?, 1, 1, 10.25,
                    '2026-06-14T10:02:00Z', '2026-06-14T10:02:00Z')""",
                (session["assessment_session_id"], measurement_study_id, examinee_id),
            ).lastrowid

            trial = connection.execute(
                "SELECT locked FROM attribute_rr_trials WHERE attribute_rr_trial_id = ?",
                (trial_id,),
            ).fetchone()
            measurement = connection.execute(
                "SELECT locked FROM variable_measurements WHERE variable_measurement_id = ?",
                (measurement_id,),
            ).fetchone()
        self.assertEqual(trial["locked"], 1)
        self.assertEqual(measurement["locked"], 1)

    def test_pass_result_gets_unique_certificate_id_and_png_hash(self):
        first = self.server.insert_result(self.payload())
        second = self.server.insert_result(self.payload(employee_id="E002"))
        self.assertRegex(first["cert_id"], r"^GRR-WT-\d{2}-\d{6}-[0-9A-F]{4}$")
        self.assertNotEqual(first["cert_id"], second["cert_id"])
        self.assertEqual(first["cert_status"], "ISSUE_PENDING")

        png = b"\x89PNG\r\n\x1a\n" + b"certificate"
        saved = self.server.save_certificate(first["cert_id"], png)
        self.assertEqual(saved["cert_status"], "VALID")
        self.assertEqual(saved["certificate_hash"], hashlib.sha256(png).hexdigest())
        self.assertTrue(saved["certificate_path"].endswith(f"CERT_{first['cert_id']}.png"))

    def test_result_insert_creates_assessment_session_submission_grade_and_official_certificate(self):
        result = self.server.insert_result(self.payload(revision=None))

        self.assertEqual(result["exam_version"], "1")
        self.assertIsNotNone(result["assessment_session_id"])
        self.assertIsNotNone(result["submission_id"])
        self.assertIsNotNone(result["grade_result_id"])
        self.assertIsNotNone(result["certification_decision_id"])

        with self.server.connect() as connection:
            submission = connection.execute("SELECT * FROM submissions").fetchone()
            grade = connection.execute("SELECT * FROM grade_results").fetchone()
            cert = connection.execute("SELECT * FROM certificates").fetchone()
        self.assertEqual(submission["exam_revision"], 1)
        self.assertEqual(grade["result_id"], result["result_id"])
        self.assertEqual(cert["issue_mode"], "official")
        self.assertEqual(cert["cert_id"], result["cert_id"])

    def test_invalid_revision_is_rejected(self):
        with self.assertRaises(ValueError):
            self.server.insert_result(self.payload(revision="1.5"))
        with self.assertRaises(ValueError):
            self.server.insert_result(self.payload(revision="0"))

    def test_c_and_d_grades_do_not_issue_certificate(self):
        grade_c = self.server.insert_result(self.payload(75))
        grade_d = self.server.insert_result(self.payload(65, employee_id="E002"))
        self.assertEqual((grade_c["grade"], grade_c["cert_id"]), ("C", None))
        self.assertEqual((grade_d["grade"], grade_d["pass_status"]), ("D", "FAIL"))

    def test_readiness_rejects_missing_or_failed_session_and_waits_for_approval(self):
        missing = self.server.validate_certification_readiness(999)
        self.assertEqual(missing["status"], "rejected")
        self.assertIn("assessment_session_not_found", missing["blocking_reasons"])

        failed = self.server.insert_result(self.payload(70))
        failed_ready = self.server.validate_certification_readiness(failed["assessment_session_id"])
        self.assertEqual(failed_ready["status"], "rejected")
        self.assertIn("written_exam_not_passed", failed_ready["blocking_reasons"])

        session = self.server.create_assessment_session(
            {
                "employee_id": "E003",
                "employee_name": "Pending Approval",
                "exam_type": "GRR-WT",
                "exam_name": "Inspector written exam",
            }
        )
        self.server.create_submission(
            {
                "assessment_session_id": session["assessment_session_id"],
                "attempt_id": "attempt-pending",
                "exam_id": "inspector-written",
                "exam_revision": 1,
                "submitted_at": "2026-06-14T10:00:00Z",
                "score": 85,
                "max_score": 100,
                "pass_score": 80,
                "items": [],
                "answers": {},
            }
        )
        pending = self.server.validate_certification_readiness(session["assessment_session_id"])
        self.assertEqual(pending["status"], "pending")
        self.assertIn("approval_required", pending["blocking_reasons"])

        approved = self.server.create_certification_decision(
            {
                "assessment_session_id": session["assessment_session_id"],
                "decision": "approved",
                "approved_by": "QA Manager",
            }
        )
        self.assertTrue(approved["readiness"]["ready"])
        self.assertEqual(approved["readiness"]["status"], "approved")

    def test_official_certificate_is_queryable_and_local_only_is_not(self):
        result = self.server.insert_result(self.payload())
        official = self.server.get_certificate(result["cert_id"])
        self.assertEqual(official["cert_id"], result["cert_id"])

        with self.assertRaises(LookupError):
            self.server.get_certificate("LOCAL-20260613-ABCDEF123456")
        with self.assertRaises(LookupError):
            self.server.save_certificate("LOCAL-20260613-ABCDEF123456", b"\x89PNG\r\n\x1a\nlocal")

    def test_cancel_records_status_history_without_changing_result(self):
        result = self.server.insert_result(self.payload())
        cancelled = self.server.set_certificate_status(result["cert_id"], "CANCELLED", "admin cancel")
        self.assertEqual(cancelled["cert_status"], "CANCELLED")
        self.assertEqual(cancelled["score"], 90)
        with self.server.connect() as connection:
            history = connection.execute(
                "SELECT next_status, reason FROM certificate_status_history WHERE result_id = ?",
                (result["result_id"],),
            ).fetchone()
            cert = connection.execute(
                "SELECT status FROM certificates WHERE cert_id = ?", (result["cert_id"],)
            ).fetchone()
        self.assertEqual(dict(history), {"next_status": "CANCELLED", "reason": "admin cancel"})
        self.assertEqual(cert["status"], "CANCELLED")

    def test_reissuing_cancelled_certificate_keeps_id_and_cancelled_status(self):
        result = self.server.insert_result(self.payload())
        cert_id = result["cert_id"]
        self.server.set_certificate_status(cert_id, "CANCELLED", "admin cancel")

        reissued = self.server.save_certificate(cert_id, b"\x89PNG\r\n\x1a\nreissued")

        self.assertEqual(reissued["cert_id"], cert_id)
        self.assertEqual(reissued["cert_status"], "CANCELLED")
        self.assertTrue(reissued["certificate_path"].endswith(f"CERT_{cert_id}.png"))


    def test_phase6_reports_cover_history_rr_training_and_reassessment_queries(self):
        result = self.server.insert_result(self.payload())
        saved = self.server.save_certificate(result["cert_id"], b"\x89PNG\r\n\x1a\nreport")
        result["cert_status"] = saved["cert_status"]

        history = self.server.query_assessment_history({"employee_id": ["E001"]})
        self.assertEqual(history[0]["assessment_session_id"], result["assessment_session_id"])
        self.assertEqual(history[0]["qualification_code"], "GRR-WT")
        self.assertEqual(history[0]["written_pass_status"], "PASS")
        self.assertEqual(history[0]["cert_id"], result["cert_id"])

        with self.server.connect() as connection:
            session = self.server.create_assessment_session_in_connection(
                connection,
                {
                    "employee_id": "E-RPT-001",
                    "employee_name": "Report Inspector",
                    "exam_type": "AOI-RPT",
                    "exam_name": "AOI report qualification",
                },
                "2026-06-14T10:00:00Z",
            )
            plan = connection.execute(
                "SELECT assessment_plan_id FROM assessment_sessions WHERE assessment_session_id = ?",
                (session["assessment_session_id"],),
            ).fetchone()
            connection.execute(
                "UPDATE assessment_plans SET requires_training = 1 WHERE assessment_plan_id = ?",
                (plan["assessment_plan_id"],),
            )
            rr_set_id = connection.execute(
                """INSERT INTO attribute_rr_sets (
                    rr_set_code, title, sample_mode, created_at, updated_at
                ) VALUES ('RPT-ATTR', 'Report attribute R&R', 'image',
                    '2026-06-14T10:00:00Z', '2026-06-14T10:00:00Z')"""
            ).lastrowid
            connection.execute(
                """INSERT INTO attribute_rr_results (
                    assessment_session_id, attribute_rr_set_id, total_agreement_rate,
                    ok_agreement_rate, ng_detection_rate, repeat_agreement_rate,
                    type1_error_rate, type2_error_rate, defect_type_agreement_rate,
                    final_decision, calculated_at, created_at
                ) VALUES (?, ?, 0.95, 1.0, 0.9, 0.98, 0.0, 0.1, 0.88,
                    'PASS', '2026-06-14T10:05:00Z', '2026-06-14T10:05:00Z')""",
                (session["assessment_session_id"], rr_set_id),
            )

        rr = self.server.query_rr_results({"assessment_session_id": [str(session["assessment_session_id"])]})
        self.assertEqual(rr["attribute_rr_results"][0]["rr_set_code"], "RPT-ATTR")
        self.assertEqual(rr["attribute_rr_results"][0]["final_decision"], "PASS")

        missing = self.server.query_training_missing({"qualification_code": ["AOI-RPT"]})
        self.assertEqual(missing[0]["employee_id"], "E-RPT-001")

        due = self.server.query_reassessment_due({"as_of": ["2027-05-20"]})
        self.assertEqual(due[0]["cert_id"], result["cert_id"])


    def test_attribute_and_variable_rr_submission_calculate_and_readiness_blocks_until_requirements_pass(self):
        session = self.server.create_assessment_session(
            {
                "employee_id": "E-RR-FLOW",
                "employee_name": "RR Flow",
                "exam_type": "AOI-RR",
                "exam_name": "AOI RR qualification",
            }
        )
        with self.server.connect() as connection:
            connection.execute(
                """UPDATE assessment_plans
                   SET requires_written_exam = 0,
                       requires_attribute_rr = 1,
                       requires_variable_rr = 1,
                       requires_training = 1
                   WHERE assessment_plan_id = ?""",
                (session["assessment_plan_id"],),
            )
        blocked = self.server.validate_certification_readiness(session["assessment_session_id"])
        self.assertEqual(blocked["status"], "rejected")
        self.assertIn("attribute_rr", blocked["missing_requirements"])
        self.assertIn("variable_rr", blocked["missing_requirements"])
        self.assertIn("training_verification", blocked["missing_requirements"])

        rr_set = self.server.create_attribute_rr_set(
            {
                "rr_set_code": "AOI-RR-1",
                "title": "AOI attribute R&R",
                "sample_mode": "image",
                "criteria": {"min_total_agreement_rate": 0.75, "min_repeat_agreement_rate": 0.5},
                "samples": [
                    {"sample_code": "OK-1", "reference_status": "OK"},
                    {"sample_code": "NG-1", "reference_status": "NG", "defect_type": "scratch"},
                ],
            }
        )
        with self.server.connect() as connection:
            sample_ids = [
                row["attribute_rr_sample_id"]
                for row in connection.execute(
                    "SELECT attribute_rr_sample_id FROM attribute_rr_samples WHERE attribute_rr_set_id = ? ORDER BY display_order",
                    (rr_set["attribute_rr_set_id"],),
                ).fetchall()
            ]
        attr_result = self.server.submit_attribute_rr_trials(
            {
                "assessment_session_id": session["assessment_session_id"],
                "attribute_rr_set_id": rr_set["attribute_rr_set_id"],
                "trials": [
                    {"sampleId": sample_ids[0], "roundNo": 1, "judgment": "OK"},
                    {"sampleId": sample_ids[0], "roundNo": 2, "judgment": "OK"},
                    {"sampleId": sample_ids[1], "roundNo": 1, "judgment": "NG", "defectType": "scratch"},
                    {"sampleId": sample_ids[1], "roundNo": 2, "judgment": "NG", "defectType": "scratch"},
                ],
            }
        )
        self.assertEqual(attr_result["final_decision"], "PASS")
        self.assertEqual(attr_result["repeat_agreement_rate"], 1.0)

        study = self.server.create_variable_rr_study(
            {
                "study_code": "DIM-RR-1",
                "measurement_item": "Width",
                "unit": "mm",
                "instrument": "Caliper",
                "part_count": 2,
                "trial_count": 2,
                "lsl": 9,
                "usl": 13,
                "criteria": {"max_percent_grr": 20, "conditional_percent_grr": 40},
            }
        )
        var_result = self.server.submit_variable_measurements(
            {
                "assessment_session_id": session["assessment_session_id"],
                "variable_rr_study_id": study["variable_rr_study_id"],
                "measurements": [
                    {"partNo": 1, "trialNo": 1, "value": 10.00},
                    {"partNo": 1, "trialNo": 2, "value": 10.02},
                    {"partNo": 2, "trialNo": 1, "value": 12.00},
                    {"partNo": 2, "trialNo": 2, "value": 12.02},
                ],
            }
        )
        self.assertEqual(var_result["final_decision"], "PASS")

        with self.server.connect() as connection:
            connection.execute(
                """INSERT INTO training_records (
                    examinee_id, qualification_type_id, training_code, training_title,
                    completed_at, hours, verified_by, status, created_at, updated_at
                ) VALUES (?, ?, 'TR-AOI', 'AOI basics', '2026-06-14', 2, 'Trainer', 'verified',
                    '2026-06-14T10:00:00Z', '2026-06-14T10:00:00Z')""",
                (session["examinee_id"], session["qualification_type_id"]),
            )
        self.server.create_certification_decision(
            {
                "assessment_session_id": session["assessment_session_id"],
                "decision": "approved",
                "approved_by": "QA Manager",
            }
        )
        ready = self.server.validate_certification_readiness(session["assessment_session_id"])
        self.assertTrue(ready["ready"])
        self.assertEqual(ready["status"], "approved")

    def test_variable_rr_submission_rejects_duplicate_and_out_of_plan_measurements(self):
        session = self.server.create_assessment_session(
            {
                "employee_id": "E-RR-VALID",
                "employee_name": "RR Validate",
                "exam_type": "AOI-RR",
                "exam_name": "AOI RR qualification",
            }
        )
        study = self.server.create_variable_rr_study(
            {
                "study_code": "DIM-RR-VALID",
                "measurement_item": "Width",
                "part_count": 2,
                "trial_count": 2,
            }
        )

        base_payload = {
            "assessment_session_id": session["assessment_session_id"],
            "variable_rr_study_id": study["variable_rr_study_id"],
        }
        with self.assertRaisesRegex(ValueError, "duplicate part_no/trial_no"):
            self.server.submit_variable_measurements(
                {
                    **base_payload,
                    "measurements": [
                        {"partNo": 1, "trialNo": 1, "value": 10.00},
                        {"partNo": 1, "trialNo": 1, "value": 10.01},
                    ],
                }
            )
        with self.assertRaisesRegex(ValueError, "outside the study plan"):
            self.server.submit_variable_measurements(
                {
                    **base_payload,
                    "measurements": [
                        {"partNo": 3, "trialNo": 1, "value": 10.00},
                    ],
                }
            )

    def test_sqlite_result_selection_keeps_revisions_separate_and_csv_values_safe(self):
        self.server.insert_result(self.payload(80, "E100", "2026-06-13T10:00:00Z", "1"))
        best = self.server.insert_result(self.payload(95, "E100", "2026-06-14T10:00:00Z", "1"))
        revision_two = self.server.insert_result(self.payload(75, "E100", "2026-06-15T10:00:00Z", "2"))

        all_rows = self.server.search_results({"search": ["E100"], "mode": ["allAttempts"]})
        latest = self.server.search_results({"search": ["E100"], "mode": ["latestPerEmployee"]})
        selected_best = self.server.search_results({"search": ["E100"], "mode": ["bestPerEmployee"]})

        self.assertEqual(len(all_rows), 3)
        self.assertEqual({row["result_id"] for row in latest}, {best["result_id"], revision_two["result_id"]})
        self.assertEqual({row["result_id"] for row in selected_best}, {best["result_id"], revision_two["result_id"]})
        self.assertEqual(self.server.csv_safe("=SUM(1,1)"), "'=SUM(1,1)")


if __name__ == "__main__":
    unittest.main()
