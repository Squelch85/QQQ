import test from "node:test";
import assert from "node:assert/strict";
import { gradeSubmission, normalizeShortAnswer } from "../src/grading.js";
import { validExam } from "./fixtures.js";

test("단답형은 명시된 규칙만 적용해 정규화한다", () => {
  assert.equal(normalizeShortAnswer("  HELLO   world  ", {
    trim: true,
    collapseWhitespace: true,
    caseInsensitive: true
  }), "hello world");
  assert.equal(normalizeShortAnswer(" A  B ", {}), " A  B ");
});

test("세 문제 유형을 결정적으로 채점한다", () => {
  const exam = validExam();
  const submission = {
    submittedAt: "2026-06-08T10:00:00.000Z",
    answers: { single: "a", multiple: ["c", "a"], short: "  hello   WORLD " }
  };
  const first = gradeSubmission(exam, submission);
  const second = gradeSubmission(exam, submission);
  assert.deepEqual(first, second);
  assert.equal(first.score, 60);
  assert.equal(first.maxScore, 60);
  assert.deepEqual(first.items.map((item) => item.status), ["correct", "correct", "correct"]);
});

test("미응답과 불완전한 복수 선택은 점수를 부여하지 않는다", () => {
  const result = gradeSubmission(validExam(), {
    submittedAt: "2026-06-08T10:00:00.000Z",
    answers: { single: "", multiple: ["a"], short: "" }
  });
  assert.equal(result.score, 0);
  assert.deepEqual(result.items.map((item) => item.status), ["unanswered", "incorrect", "unanswered"]);
});
