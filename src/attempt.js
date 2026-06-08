import { gradeSubmission } from "./grading.js";

export const AttemptState = Object.freeze({
  READY: "READY",
  IN_PROGRESS: "IN_PROGRESS",
  SUBMITTED: "SUBMITTED",
  GRADED: "GRADED"
});

function emptyValueFor(question) {
  return question.type === "multiple_choice" ? [] : "";
}

function validateAnswer(question, value) {
  if (question.type === "multiple_choice") {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new TypeError("복수 선택 답안은 문자열 배열이어야 합니다.");
    const choices = new Set(question.choices.map((choice) => choice.id));
    if (new Set(value).size !== value.length || value.some((id) => !choices.has(id))) throw new TypeError("유효하지 않은 선택지가 포함되어 있습니다.");
    return [...value];
  }
  if (typeof value !== "string") throw new TypeError("답안은 문자열이어야 합니다.");
  if (question.type === "single_choice" && value !== "" && !question.choices.some((choice) => choice.id === value)) {
    throw new TypeError("유효하지 않은 선택지입니다.");
  }
  return value;
}

export class Attempt {
  #exam;
  #questionById;
  #answers;
  #submission = null;
  #result = null;

  constructor(exam, now = new Date()) {
    this.#exam = exam;
    this.#questionById = new Map(exam.questions.map((question) => [question.id, question]));
    this.#answers = new Map(exam.questions.map((question) => [question.id, { value: emptyValueFor(question), updatedAt: null }]));
    this.state = AttemptState.READY;
    this.startedAt = null;
    this.createdAt = now.toISOString();
  }

  start(now = new Date()) {
    if (this.state !== AttemptState.READY) throw new Error("준비 상태에서만 시험을 시작할 수 있습니다.");
    this.state = AttemptState.IN_PROGRESS;
    this.startedAt = now.toISOString();
  }

  setAnswer(questionId, value, now = new Date()) {
    if (this.state !== AttemptState.IN_PROGRESS) throw new Error("시험 진행 중에만 답안을 변경할 수 있습니다.");
    const question = this.#questionById.get(questionId);
    if (!question) throw new Error(`문항 '${questionId}'을 찾을 수 없습니다.`);
    this.#answers.set(questionId, { value: validateAnswer(question, value), updatedAt: now.toISOString() });
  }

  getAnswer(questionId) {
    const answer = this.#answers.get(questionId);
    if (!answer) throw new Error(`문항 '${questionId}'을 찾을 수 없습니다.`);
    return Array.isArray(answer.value) ? [...answer.value] : answer.value;
  }

  isAnswered(questionId) {
    const value = this.getAnswer(questionId);
    return Array.isArray(value) ? value.length > 0 : value.trim().length > 0;
  }

  get unansweredCount() {
    let count = 0;
    for (const questionId of this.#questionById.keys()) if (!this.isAnswered(questionId)) count += 1;
    return count;
  }

  submit(now = new Date()) {
    if (this.state !== AttemptState.IN_PROGRESS) throw new Error("진행 중인 시험만 제출할 수 있습니다.");
    const answers = Object.fromEntries(
      [...this.#answers].map(([id, answer]) => [
        id,
        Array.isArray(answer.value) ? Object.freeze([...answer.value]) : answer.value
      ])
    );
    this.#submission = Object.freeze({ submittedAt: now.toISOString(), answers: Object.freeze(answers) });
    this.state = AttemptState.SUBMITTED;
    return this.#submission;
  }

  grade() {
    if (this.state !== AttemptState.SUBMITTED) throw new Error("제출된 시험만 채점할 수 있습니다.");
    this.#result = gradeSubmission(this.#exam, this.#submission);
    this.state = AttemptState.GRADED;
    return this.#result;
  }

  get result() {
    return this.#result;
  }
}
