import test from "node:test";
import assert from "node:assert/strict";
import { convertQuestionTable } from "../src/converter.js";

test("탭과 인용된 여러 줄 질문을 시험 JSON으로 변환한다", () => {
  const source = '문항번호\t질문\t정답\n필기1\t"착용해야 하는 것은?\n1) 모자  2) 귀걸이"\t1';
  const exam = convertQuestionTable(source, { title: "검사원 평가 시험", scorePerQuestion: 5 });
  assert.equal(exam.questions[0].prompt, "착용해야 하는 것은?");
  assert.deepEqual(exam.questions[0].choices, [{ id: "1", text: "모자" }, { id: "2", text: "귀걸이" }]);
  assert.equal(exam.questions[0].scoring.correctChoiceId, "1");
  assert.equal(exam.questions[0].score, 5);
});

test("존재하지 않는 정답 번호를 거부한다", () => {
  assert.throws(() => convertQuestionTable("필기1\t질문? 1) A 2) B\t3"), /해당하는 선택지가/);
});
