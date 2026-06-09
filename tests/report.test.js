import test from "node:test";
import assert from "node:assert/strict";
import { buildExamReport, createReportCsv, makeAttemptRecord, parseReportCsv, selectReportRecords } from "../src/report.js";
import { appendExamReportRecord, clearAllExamReportRecords, clearExamReportRecords, getExamReportStorageKey, readExamReportCsv, readExamReportRecords, writeExamReportRecords } from "../src/report-storage.js";
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

test("인원별 누적 결과를 CSV 한 행씩 생성하고 다시 집계한다", () => {
  const exam = validExam({ passingScore: 40 });
  const records = [
    {
      candidate: { name: "홍,길동", employeeId: "=1+1", department: "품질\n보증" },
      submittedAt: "2026-06-08T00:00:00.000Z",
      score: 40,
      maxScore: 60,
      items: [
        { questionId: "single", status: "correct", prompt: "하나를 고르세요." },
        { questionId: "multiple", status: "incorrect", prompt: "모두 고르세요." }
      ]
    },
    {
      candidate: { name: "김검사", employeeId: "A02", department: "검사" },
      submittedAt: "2026-06-08T01:00:00.000Z",
      score: 10,
      maxScore: 60,
      items: [{ questionId: "single", status: "unanswered", prompt: "하나를 고르세요." }]
    }
  ];

  const csv = createReportCsv(exam, records, "2026-06-08T02:00:00.000Z");
  const parsed = parseReportCsv(csv);

  assert.ok(csv.startsWith("\uFEFF리포트 버전,"));
  assert.match(csv, /'\=1\+1/);
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.examTitle, "테스트 시험");
  assert.equal(parsed.generatedAt, "2026-06-08T02:00:00.000Z");
  assert.equal(parsed.examineeCount, 2);
  assert.equal(parsed.attempts[0].candidate.name, "홍,길동");
  assert.equal(parsed.attempts[0].candidate.employeeId, "=1+1");
  assert.equal(parsed.attempts[0].candidate.department, "품질\n보증");
  assert.deepEqual(parsed.attempts[0].items.map(({ questionId, status }) => [questionId, status]), [["single", "correct"], ["multiple", "incorrect"]]);
  assert.equal(parsed.passRate, 50);
});

test("누적 리포트 CSV의 형식과 행 일관성을 검증한다", () => {
  assert.throws(() => parseReportCsv("이름,점수\r\n홍길동,100\r\n"), /지원하는 누적 리포트 CSV 형식/);

  const csv = createReportCsv(validExam(), [
    {
      candidate: { name: "홍길동", employeeId: "A01", department: "품질" },
      submittedAt: "2026-06-08T00:00:00.000Z",
      score: 60,
      maxScore: 60,
      items: []
    },
    {
      candidate: { name: "김검사", employeeId: "A02", department: "검사" },
      submittedAt: "2026-06-08T01:00:00.000Z",
      score: 30,
      maxScore: 60,
      items: []
    }
  ], "2026-06-08T02:00:00.000Z");
  const inconsistent = csv.replace("테스트 시험,80,", "다른 시험,80,");
  assert.throws(() => parseReportCsv(inconsistent), /리포트 정보가 첫 번째 응시 결과와 다릅니다/);
});

test("시험별 누적 CSV 저장소를 초기화한다", () => {
  const exam = validExam();
  const storage = new Map();
  const storageAdapter = {
    getItem: (key) => storage.get(key) ?? null,
    removeItem: (key) => storage.delete(key),
    setItem: (key, value) => storage.set(key, value)
  };
  const key = getExamReportStorageKey(exam.id);
  storage.set(key, createReportCsv(exam, [{
    candidate: { name: "기존 수검자", employeeId: "A00", department: "" },
    submittedAt: "2026-06-08T00:00:00.000Z", score: 0, maxScore: 60, items: []
  }]));

  clearExamReportRecords(storageAdapter, exam.id);

  assert.equal(storage.has(key), false);
  assert.deepEqual(readExamReportRecords(storageAdapter, exam), []);
});

test("CSV가 없으면 생성하고 동일 시험의 인원별 결과를 순서대로 누적한다", () => {
  const exam = validExam();
  const storage = new Map();
  const storageAdapter = {
    getItem: (key) => storage.get(key) ?? null,
    removeItem: (key) => storage.delete(key),
    setItem: (key, value) => storage.set(key, value)
  };
  const first = {
    candidate: { name: "첫 번째 수검자", employeeId: "A01", department: "품질" },
    submittedAt: "2026-06-08T00:00:00.000Z", score: 60, maxScore: 60, items: []
  };
  const second = {
    candidate: { name: "두 번째 수검자", employeeId: "A02", department: "검사" },
    submittedAt: "2026-06-08T01:00:00.000Z", score: 30, maxScore: 60, items: []
  };

  const firstState = appendExamReportRecord(storageAdapter, exam, first, "2026-06-08T02:00:00.000Z");
  assert.equal(firstState.stored, true);
  assert.ok(firstState.csv.startsWith("\uFEFF리포트 버전,"));
  assert.equal(readExamReportCsv(storageAdapter, exam), firstState.csv);

  const secondState = appendExamReportRecord(storageAdapter, exam, second, "2026-06-08T03:00:00.000Z");
  assert.deepEqual(secondState.records.map((record) => record.candidate.name), ["첫 번째 수검자", "두 번째 수검자"]);
  assert.equal(parseReportCsv(secondState.csv).examineeCount, 2);
  assert.equal(readExamReportCsv(storageAdapter, exam), secondState.csv);
  assert.deepEqual(readExamReportRecords(storageAdapter, validExam({ id: "exam-b" })), []);
});

test("기존 JSON 누적 결과는 다음 제출 때 CSV로 마이그레이션한다", () => {
  const exam = validExam();
  const storage = new Map();
  const storageAdapter = {
    getItem: (key) => storage.get(key) ?? null,
    removeItem: (key) => storage.delete(key),
    setItem: (key, value) => storage.set(key, value)
  };
  const legacy = {
    candidate: { name: "기존 수검자", employeeId: "A00", department: "" },
    submittedAt: "2026-06-08T00:00:00.000Z", score: 60, maxScore: 60, items: []
  };
  const current = {
    candidate: { name: "신규 수검자", employeeId: "A01", department: "" },
    submittedAt: "2026-06-08T01:00:00.000Z", score: 30, maxScore: 60, items: []
  };
  storage.set(`exam-report:${exam.id}`, JSON.stringify([legacy]));

  const state = appendExamReportRecord(storageAdapter, exam, current, "2026-06-08T02:00:00.000Z");

  assert.deepEqual(state.records.map((record) => record.candidate.name), ["기존 수검자", "신규 수검자"]);
  assert.equal(storage.has(`exam-report:${exam.id}`), false);
  assert.ok(storage.get(getExamReportStorageKey(exam.id, exam.revision)).startsWith("\uFEFF리포트 버전,"));
});

test("저장소를 사용할 수 없어도 CSV 생성과 결과 처리를 계속한다", () => {
  const exam = validExam();
  const unavailableStorage = {
    getItem: () => { throw new Error("storage unavailable"); },
    removeItem: () => { throw new Error("storage unavailable"); },
    setItem: () => { throw new Error("storage unavailable"); }
  };
  const record = {
    candidate: { name: "오프라인 수검자", employeeId: "A01", department: "" },
    submittedAt: "2026-06-08T00:00:00.000Z", score: 60, maxScore: 60, items: []
  };

  assert.equal(clearExamReportRecords(unavailableStorage, exam.id), false);
  assert.equal(writeExamReportRecords(unavailableStorage, exam, [record]).stored, false);
  const state = appendExamReportRecord(unavailableStorage, exam, record);
  assert.equal(state.stored, false);
  assert.deepEqual(state.records, [record]);
  assert.equal(parseReportCsv(state.csv).examineeCount, 1);
});


test("동일 응시자의 전체·최신·최고 결과를 결정적으로 분리한다", () => {
  const records = [
    { attemptId: "a", submittedAt: "2026-06-08T00:00:00.000Z", candidate: { name: "김검사", employeeId: "A01" }, score: 30, maxScore: 60 },
    { attemptId: "b", submittedAt: "2026-06-08T01:00:00.000Z", candidate: { name: "김검사", employeeId: "A01" }, score: 20, maxScore: 60 },
    { attemptId: "c", submittedAt: "2026-06-08T02:00:00.000Z", candidate: { name: "이검사", employeeId: "A02" }, score: 40, maxScore: 60 }
  ];

  assert.equal(selectReportRecords(records, "allAttempts").length, 3);
  assert.deepEqual(selectReportRecords(records, "latestPerEmployee").map(({ attemptId }) => attemptId), ["b", "c"]);
  assert.deepEqual(selectReportRecords(records, "bestPerEmployee").map(({ attemptId }) => attemptId), ["a", "c"]);
  const report = buildExamReport(validExam(), records, "latestPerEmployee");
  assert.equal(report.totalAttemptCount, 3);
  assert.equal(report.uniqueExamineeCount, 2);
  assert.equal(report.examineeCount, 2);
});

test("동일 시험 ID의 버전별 이력을 별도 키에 저장한다", () => {
  const storage = new Map();
  const adapter = {
    get length() { return storage.size; },
    key: (index) => [...storage.keys()][index] ?? null,
    getItem: (key) => storage.get(key) ?? null,
    removeItem: (key) => storage.delete(key),
    setItem: (key, value) => storage.set(key, value)
  };
  const revision1 = validExam({ revision: 1 });
  const revision2 = validExam({ revision: 2 });
  const record = { attemptId: "a", candidate: { name: "김검사", employeeId: "A01", department: "" }, submittedAt: "2026-06-08T00:00:00.000Z", score: 60, maxScore: 60, items: [] };

  storage.set("unrelated-setting", "keep");
  writeExamReportRecords(adapter, revision1, [record]);
  writeExamReportRecords(adapter, revision2, [{ ...record, attemptId: "b" }]);
  assert.notEqual(getExamReportStorageKey(revision1.id, 1), getExamReportStorageKey(revision2.id, 2));
  assert.equal(readExamReportRecords(adapter, revision1)[0].attemptId, "a");
  assert.equal(readExamReportRecords(adapter, revision2)[0].attemptId, "b");
  assert.deepEqual(clearAllExamReportRecords(adapter), { cleared: true, count: 2 });
  assert.deepEqual([...storage.entries()], [["unrelated-setting", "keep"]]);
});
