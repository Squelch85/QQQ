import test from "node:test";
import assert from "node:assert/strict";
import { buildExamReport, makeAttemptRecord } from "../src/report.js";
import { validExam } from "./fixtures.js";

test("응시자별 합격 여부와 오답률 상위 문항을 집계한다", () => {
  const exam = validExam({ passingScore: 40 });
  const records = [
    { candidate: { name: "김검사" }, score: 40, items: [{ status: "correct" }, { status: "incorrect" }, { status: "correct" }] },
    { candidate: { name: "이검사" }, score: 10, items: [{ status: "correct" }, { status: "unanswered" }, { status: "incorrect" }] }
  ];
  const report = buildExamReport(exam, records);
  assert.equal(report.attempts[0].passed, true);
  assert.equal(report.attempts[1].passed, false);
  assert.deepEqual(report.highWrongRate.map((item) => [item.questionNumber, item.wrongRate]), [[2, 100], [3, 50]]);
});

test("결과 저장 레코드에는 수검자와 최소 문항 결과만 포함한다", () => {
  const record = makeAttemptRecord({ name: "홍길동", employeeId: "A01", department: "품질" }, {
    submittedAt: "2026-06-08T00:00:00.000Z", score: 10, maxScore: 10,
    items: [{ questionId: "q1", status: "correct", earnedScore: 10 }]
  });
  assert.deepEqual(record.items, [{ questionId: "q1", status: "correct" }]);
  assert.equal(record.candidate.department, "품질");
});
