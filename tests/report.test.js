import test from "node:test";
import assert from "node:assert/strict";
import { buildExamReport, createReportFile, makeAttemptRecord, parseReportJson } from "../src/report.js";
import { appendExamReportRecord, clearExamReportRecords, getExamReportStorageKey, readExamReportRecords, writeExamReportRecords } from "../src/report-storage.js";
import { validExam } from "./fixtures.js";

test("응시자별 합격 여부와 문항 ID 기준 오답률 및 전체 통계를 집계한다", () => {
  const exam = validExam({ passingScore: 40 });
  const records = [
    { candidate: { name: "김검사" }, score: 40, maxScore: 60, items: [{ questionId: "single", status: "correct" }, { questionId: "multiple", status: "incorrect" }, { questionId: "short", status: "correct" }] },
    { candidate: { name: "이검사" }, score: 10, maxScore: 60, items: [{ questionId: "single", status: "correct" }, { questionId: "multiple", status: "unanswered" }, { questionId: "short", status: "incorrect" }] }
  ];
  const report = buildExamReport(exam, records);
  assert.equal(report.attempts[0].passed, true);
  assert.equal(report.attempts[1].passed, false);
  assert.equal(report.averageScore, 41.7);
  assert.equal(report.passRate, 50);
  assert.deepEqual(report.highWrongRate.map((item) => [item.questionId, item.wrongRate]), [["multiple", 100], ["short", 50]]);
});

test("랜덤 출제에서 실제 응시한 인원만 문항별 오답률 분모로 사용한다", () => {
  const exam = validExam({ questions: validExam().questions.slice(0, 1) });
  const records = [
    { candidate: { name: "김검사" }, score: 0, maxScore: 100, items: [{ questionId: "single", status: "incorrect", prompt: "하나를 고르세요." }] },
    { candidate: { name: "이검사" }, score: 100, maxScore: 100, items: [{ questionId: "other", status: "correct", prompt: "다른 랜덤 문항" }] }
  ];
  const stats = buildExamReport(exam, records).questionStats;
  assert.deepEqual(stats.map(({ questionId, attemptCount, wrongRate }) => [questionId, attemptCount, wrongRate]), [
    ["single", 1, 100],
    ["other", 1, 0]
  ]);
});

test("결과 저장 레코드에는 수검자와 문항 식별 정보가 포함된다", () => {
  const exam = validExam({ questions: validExam().questions.slice(0, 1) });
  const record = makeAttemptRecord({ name: "홍길동", employeeId: "A01", department: "품질" }, {
    submittedAt: "2026-06-08T00:00:00.000Z", score: 10, maxScore: 10,
    items: [{ questionId: "single", status: "correct", earnedScore: 10 }]
  }, exam);
  assert.deepEqual(record.items, [{ questionId: "single", status: "correct", prompt: "하나를 고르세요." }]);
  assert.equal(record.candidate.department, "품질");
});

test("저장한 누적 리포트 파일을 다시 파싱한다", () => {
  const report = createReportFile(validExam(), [], "2026-06-08T00:00:00.000Z");
  const parsed = parseReportJson(JSON.stringify(report));
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.examTitle, "테스트 시험");
  assert.equal(parsed.generatedAt, "2026-06-08T00:00:00.000Z");
});

test("시험지 JSON 재로드를 위해 시험별 누적 결과 저장소를 초기화한다", () => {
  const storage = new Map();
  const storageAdapter = {
    getItem: (key) => storage.get(key) ?? null,
    removeItem: (key) => storage.delete(key),
    setItem: (key, value) => storage.set(key, value)
  };
  const key = getExamReportStorageKey("exam-a");
  storage.set(key, JSON.stringify([{ candidate: { name: "기존 수검자" } }]));

  clearExamReportRecords(storageAdapter, "exam-a");

  assert.equal(storage.has(key), false);
  assert.deepEqual(readExamReportRecords(storageAdapter, "exam-a"), []);
});

test("저장소를 사용할 수 없어도 새 시험 초기화와 결과 처리를 계속한다", () => {
  const unavailableStorage = {
    getItem: () => { throw new Error("storage unavailable"); },
    removeItem: () => { throw new Error("storage unavailable"); },
    setItem: () => { throw new Error("storage unavailable"); }
  };
  const record = { candidate: { name: "오프라인 수검자" } };

  assert.equal(clearExamReportRecords(unavailableStorage, "exam-a"), false);
  assert.equal(writeExamReportRecords(unavailableStorage, "exam-a", [record]), false);
  assert.deepEqual(appendExamReportRecord(unavailableStorage, "exam-a", record), [record]);
});
