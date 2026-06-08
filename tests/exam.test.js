import test from "node:test";
import assert from "node:assert/strict";
import { parseExamJson, toPublicExam, validateExam } from "../src/exam.js";
import { validExam } from "./fixtures.js";

test("유효한 시험지를 검증하고 독립된 객체로 파싱한다", () => {
  const source = validExam();
  const parsed = parseExamJson(JSON.stringify(source));
  assert.equal(validateExam(parsed).valid, true);
  assert.notStrictEqual(parsed, source);
  assert.equal(parsed.questions.length, 3);
});

test("중복 문항 ID와 존재하지 않는 정답 선택지를 거부한다", () => {
  const exam = validExam();
  exam.questions[1].id = "single";
  exam.questions[0].scoring.correctChoiceId = "missing";
  const result = validateExam(exam);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /중복된 문항 ID/);
  assert.match(result.errors.join("\n"), /존재하는 선택지 ID/);
});

test("응시 화면 모델에서 정답, 채점 규칙, 해설을 제거한다", () => {
  const publicExam = toPublicExam(validExam());
  assert.equal("scoring" in publicExam.questions[0], false);
  assert.equal("explanation" in publicExam.questions[0], false);
  assert.deepEqual(publicExam.questions[0].choices, [{ id: "a", text: "A" }, { id: "b", text: "B" }]);
});

test("잘못된 JSON은 수정 가능한 오류로 변환한다", () => {
  assert.throws(() => parseExamJson("{"), /올바른 JSON 형식/);
});
