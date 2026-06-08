import test from "node:test";
import assert from "node:assert/strict";
import { convertQuestionTable } from "../src/converter.js";

const SOURCE = [
  "문항번호\t질문\t정답",
  '필기1\t"착용해야 하는 것은?\n1) 모자  2) 귀걸이"\t1',
  "필기2\t두 번째 질문? 1) A 2) B\t2",
  "필기3\t세 번째 질문? 1) A 2) B\t1"
].join("\n");

test("탭과 인용된 여러 줄 질문을 시험 JSON으로 변환한다", () => {
  const exam = convertQuestionTable(SOURCE, { title: "검사원 평가 시험", questionCount: 3, random: () => 0.999 });
  const first = exam.questions.find((question) => question.id === "필기1");
  assert.equal(first.prompt, "착용해야 하는 것은?");
  assert.deepEqual(first.choices, [{ id: "1", text: "모자" }, { id: "2", text: "귀걸이" }]);
  assert.equal(first.scoring.correctChoiceId, "1");
  assert.equal(exam.questions.reduce((sum, question) => sum + question.score, 0), 100);
});

test("요청한 문항 수를 무작위 추출하고 100점을 최대한 균등 배점한다", () => {
  const exam = convertQuestionTable(SOURCE, { questionCount: 2, random: () => 0 });
  assert.deepEqual(exam.questions.map((question) => question.id), ["필기2", "필기3"]);
  assert.deepEqual(exam.questions.map((question) => question.score), [50, 50]);
});

test("나누어떨어지지 않는 문항 수도 센트 단위로 합계 100점을 유지한다", () => {
  const exam = convertQuestionTable(SOURCE, { questionCount: 3, random: () => 0.5 });
  assert.deepEqual(exam.questions.map((question) => question.score), [33.34, 33.33, 33.33]);
  assert.equal(exam.questions.reduce((sum, question) => sum + question.score, 0), 100);
});

test("보유 문항보다 많은 출제 문항 수를 거부한다", () => {
  assert.throws(() => convertQuestionTable(SOURCE, { questionCount: 4 }), /1~3 사이의 정수/);
});

test("존재하지 않는 정답 번호를 거부한다", () => {
  assert.throws(() => convertQuestionTable("필기1\t질문? 1) A 2) B\t3"), /해당하는 선택지가/);
});
