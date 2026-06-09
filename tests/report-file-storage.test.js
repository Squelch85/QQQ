import test from "node:test";
import assert from "node:assert/strict";
import { clearAllReportFiles, clearReportFiles, getCandidateReportFilename, persistReportFiles, sanitizeFileSegment } from "../src/report-file-storage.js";
import { parseReportCsv } from "../src/report.js";
import { validExam } from "./fixtures.js";

class FakeFileHandle {
  constructor() {
    this.contents = "";
    this.writeCount = 0;
  }

  async createWritable() {
    return {
      write: async (contents) => { this.contents = contents; this.writeCount += 1; },
      close: async () => {}
    };
  }

  async getFile() {
    return { text: async () => this.contents };
  }
}

class FakeDirectoryHandle {
  constructor() {
    this.directories = new Map();
    this.files = new Map();
  }

  async getDirectoryHandle(name, { create = false } = {}) {
    if (!this.directories.has(name)) {
      if (!create) throw new Error("directory_not_found");
      this.directories.set(name, new FakeDirectoryHandle());
    }
    return this.directories.get(name);
  }

  async getFileHandle(name, { create = false } = {}) {
    if (!this.files.has(name)) {
      if (!create) throw new Error("file_not_found");
      this.files.set(name, new FakeFileHandle());
    }
    return this.files.get(name);
  }

  async removeEntry(name) {
    if (!this.directories.delete(name) && !this.files.delete(name)) throw new Error("entry_not_found");
  }
}

function record(attemptId, employeeId, submittedAt) {
  return {
    attemptId,
    submittedAt,
    candidate: { name: `수검자 ${employeeId}`, employeeId, department: "품질" },
    score: 60,
    maxScore: 60,
    items: []
  };
}

test("저장 창 없이 시험 버전 디렉터리에 전체 및 인원별 CSV를 누적 저장한다", async () => {
  const root = new FakeDirectoryHandle();
  const storageManager = { getDirectory: async () => root };
  const exam = validExam({ id: "exam:quality/1", revision: 2 });
  const records = [
    record("a", "A01", "2026-06-08T00:00:00.000Z"),
    record("b", "A02", "2026-06-08T01:00:00.000Z"),
    record("c", "A01", "2026-06-08T02:00:00.000Z")
  ];

  const result = await persistReportFiles(storageManager, exam, records);

  assert.equal(result.stored, true);
  assert.equal(result.paths.length, 3);
  const reports = await root.getDirectoryHandle("exam-reports");
  const examDirectoryName = [...reports.directories.keys()][0];
  assert.doesNotMatch(examDirectoryName, /[:/]/);
  const revision = await (await reports.getDirectoryHandle(examDirectoryName)).getDirectoryHandle("revision-2");
  assert.equal(parseReportCsv(revision.files.get("all-attempts.csv").contents).totalAttemptCount, 3);
  const candidates = await revision.getDirectoryHandle("candidates");
  const candidateCsv = candidates.files.get(getCandidateReportFilename(records.at(-1))).contents;
  assert.equal(parseReportCsv(candidateCsv).totalAttemptCount, 2);
});


test("인원별 인덱스로 변경되지 않은 CSV의 중복 쓰기를 피한다", async () => {
  const root = new FakeDirectoryHandle();
  const storageManager = { getDirectory: async () => root };
  const exam = validExam();
  const firstRecords = [
    record("a", "A01", "2026-06-08T00:00:00.000Z"),
    record("b", "A02", "2026-06-08T01:00:00.000Z")
  ];
  await persistReportFiles(storageManager, exam, firstRecords);
  const reports = await root.getDirectoryHandle("exam-reports");
  const examDirectory = await reports.getDirectoryHandle([...reports.directories.keys()][0]);
  const candidates = await (await examDirectory.getDirectoryHandle("revision-1")).getDirectoryHandle("candidates");
  const unchangedFile = candidates.files.get(getCandidateReportFilename(firstRecords[1]));

  await persistReportFiles(storageManager, exam, [...firstRecords, record("c", "A01", "2026-06-08T02:00:00.000Z")]);

  assert.equal(unchangedFile.writeCount, 1);
  assert.equal(candidates.files.get(getCandidateReportFilename(firstRecords[0])).writeCount, 2);
});

test("파일명 금지 문자를 제거하고 시험 버전 또는 전체 디렉터리를 삭제한다", async () => {
  assert.equal(sanitizeFileSegment('A:01/검사*? '), "A-01-검사--");
  const root = new FakeDirectoryHandle();
  const storageManager = { getDirectory: async () => root };
  const exam = validExam();
  const records = [record("a", "A01", "2026-06-08T00:00:00.000Z")];

  await persistReportFiles(storageManager, exam, records);
  assert.equal(await clearReportFiles(storageManager, exam), true);
  await persistReportFiles(storageManager, exam, records);
  assert.equal(await clearAllReportFiles(storageManager), true);
  assert.equal(root.directories.has("exam-reports"), false);
});

test("Origin Private File System을 사용할 수 없으면 저장 실패 상태를 반환한다", async () => {
  const result = await persistReportFiles(null, validExam(), [record("a", "A01", "2026-06-08T00:00:00.000Z")]);
  assert.equal(result.stored, false);
  assert.equal(result.errorType, "origin_private_file_system_unavailable");
});
