import test from "node:test";
import assert from "node:assert/strict";
import {
  makeLocalCertificateResult,
  makeResultPayload,
  validateCertificationReadiness
} from "../src/result-api.js";

const candidate = { employeeId: "E001", name: "홍길동", department: "품질" };
const exam = { title: "검사원 평가", revision: 1, passingScore: 80, certificateValidityYears: 1 };
const result = {
  submittedAt: "2026-06-13T01:02:03.000Z",
  score: 85,
  maxScore: 100,
  items: [{ status: "correct" }, { status: "incorrect" }]
};

test("DB 없이도 합격 결과로 로컬 인증서 발행 정보를 만든다", () => {
  const local = makeLocalCertificateResult(candidate, result, exam);

  assert.equal(local.cert_status, "LOCAL_ONLY");
  assert.equal(local.grade, "B");
  assert.equal(local.pass_status, "PASS");
  assert.match(local.cert_id, /^LOCAL-20260613-/);
  assert.equal(local.qr_value, null);
});

test("발행 기준 미충족 결과에는 로컬 인증 ID를 만들지 않는다", () => {
  const local = makeLocalCertificateResult(candidate, { ...result, score: 75 }, exam);

  assert.equal(local.cert_status, "NOT_ELIGIBLE");
  assert.equal(local.cert_id, undefined);
});

test("결과 payload는 시험 revision과 제출 답안을 함께 보낸다", () => {
  const payload = makeResultPayload(candidate, result, { ...exam, id: "exam-1", revision: 3 }, {
    submittedAt: result.submittedAt,
    answers: { q1: "a" }
  });

  assert.equal(payload.exam_id, "exam-1");
  assert.equal(payload.exam_revision, 3);
  assert.deepEqual(payload.answers, { q1: "a" });
  assert.deepEqual(payload.items, result.items);
});

test("인증 준비도 API wrapper는 readiness 응답을 반환한다", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let requestBody = null;
    globalThis.fetch = async (path, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ readiness: { ready: true, assessment_session_id: 42 } })
      };
    };

    const readiness = await validateCertificationReadiness(42, null, undefined);

    assert.equal(readiness.ready, true);
    assert.equal(readiness.assessment_session_id, 42);
    assert.deepEqual(requestBody, { assessment_session_id: 42 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
