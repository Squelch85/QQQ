import test from "node:test";
import assert from "node:assert/strict";
import { Attempt, AttemptState } from "../src/attempt.js";
import { validExam } from "./fixtures.js";

const at = (iso) => new Date(iso);

test("응시 생명주기는 READY에서 GRADED까지 순서대로 전이한다", () => {
  const attempt = new Attempt(validExam(), at("2026-06-08T09:00:00Z"));
  assert.equal(attempt.state, AttemptState.READY);
  attempt.start(at("2026-06-08T09:01:00Z"));
  attempt.setAnswer("single", "a", at("2026-06-08T09:02:00Z"));
  assert.equal(attempt.unansweredCount, 2);
  const submission = attempt.submit(at("2026-06-08T09:03:00Z"));
  assert.equal(attempt.state, AttemptState.SUBMITTED);
  assert.equal(submission.answers.single, "a");
  const result = attempt.grade();
  assert.equal(attempt.state, AttemptState.GRADED);
  assert.equal(result.score, 10);
});

test("진행 전과 제출 후 답안 변경을 차단한다", () => {
  const attempt = new Attempt(validExam());
  assert.throws(() => attempt.setAnswer("single", "a"), /진행 중/);
  attempt.start();
  attempt.setAnswer("single", "a");
  attempt.submit();
  assert.throws(() => attempt.setAnswer("single", "b"), /진행 중/);
  assert.equal(attempt.getAnswer("single"), "a");
});

test("제출 스냅샷은 복수 선택 배열의 이후 변경과 분리된다", () => {
  const attempt = new Attempt(validExam());
  const selected = ["a", "c"];
  attempt.start();
  attempt.setAnswer("multiple", selected);
  selected.pop();
  const submission = attempt.submit();
  assert.deepEqual(submission.answers.multiple, ["a", "c"]);
  assert.throws(() => submission.answers.multiple.push("b"));
});

test("문제 유형에 맞지 않는 답안을 거부한다", () => {
  const attempt = new Attempt(validExam());
  attempt.start();
  assert.throws(() => attempt.setAnswer("single", "missing"), /유효하지 않은 선택지/);
  assert.throws(() => attempt.setAnswer("multiple", ["a", "a"]), /유효하지 않은 선택지/);
  assert.throws(() => attempt.setAnswer("short", ["text"]), /문자열/);
});
