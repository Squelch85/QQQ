import test from "node:test";
import assert from "node:assert/strict";
import {
  getCandidateReportFilename,
  sanitizeFilenamePart,
  selectCandidateRecords,
  writeCandidateReport
} from "../src/directory-report-storage.js";
import { parseReportCsv } from "../src/report.js";
import { validExam } from "./fixtures.js";

const records = [
  { attemptId: "a", candidate: { name: "김검사", employeeId: "A01", department: "검사" }, submittedAt: "2026-06-08T00:00:00.000Z", score: 60, maxScore: 60, items: [] },
  { attemptId: "b", candidate: { name: "이검사", employeeId: "A02", department: "검사" }, submittedAt: "2026-06-08T01:00:00.000Z", score: 30, maxScore: 60, items: [] },
  { attemptId: "c", candidate: { name: "김검사", employeeId: "A01", department: "검사" }, submittedAt: "2026-06-08T02:00:00.000Z", score: 50, maxScore: 60, items: [] }
];

test("응시자 사번별 누적 기록만 선택한다", () => {
  assert.deepEqual(selectCandidateRecords(records, { employeeId: "A01" }).map(({ attemptId }) => attemptId), ["a", "c"]);
});

test("운영체제에서 사용할 수 없는 파일명 문자를 안전하게 치환한다", () => {
  assert.equal(sanitizeFilenamePart(' A:01/검사. '), "A_01_검사");
  assert.equal(getCandidateReportFilename(validExam({ id: "exam/test", revision: 2 }), { employeeId: "A:01", name: "김/검사" }), "A_01_김_검사__exam_test_v2.csv");
});

test("권한이 승인된 디렉터리에 응시자별 누적 CSV를 저장한다", async () => {
  let written = "";
  let requestedFilename = "";
  const directory = {
    queryPermission: async () => "granted",
    getFileHandle: async (filename, options) => {
      requestedFilename = filename;
      assert.deepEqual(options, { create: true });
      return {
        createWritable: async () => ({
          write: async (value) => { written = value; },
          close: async () => {}
        })
      };
    }
  };

  const state = await writeCandidateReport(directory, validExam(), records, records[0].candidate, "2026-06-09T00:00:00.000Z");

  assert.equal(state.saved, true);
  assert.equal(state.recordCount, 2);
  assert.equal(requestedFilename, state.filename);
  assert.deepEqual(parseReportCsv(written).attempts.map(({ attemptId }) => attemptId), ["a", "c"]);
});

test("제출 시 디렉터리 권한 요청 창을 띄우지 않는다", async () => {
  let permissionRequested = false;
  const directory = {
    queryPermission: async () => "prompt",
    requestPermission: async () => { permissionRequested = true; return "granted"; }
  };

  const state = await writeCandidateReport(directory, validExam(), records, records[0].candidate);

  assert.deepEqual(state, { saved: false, reason: "permission_required" });
  assert.equal(permissionRequested, false);
});
