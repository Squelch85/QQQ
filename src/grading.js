import { getMaxScore } from "./exam.js";

export function normalizeShortAnswer(value, rules = {}) {
  let normalized = String(value ?? "");
  if (rules.trim) normalized = normalized.trim();
  if (rules.collapseWhitespace) normalized = normalized.replace(/\s+/gu, " ");
  if (rules.caseInsensitive) normalized = normalized.toLocaleLowerCase();
  return normalized;
}

function hasAnswer(question, value) {
  if (question.type === "multiple_choice") return Array.isArray(value) && value.length > 0;
  return typeof value === "string" && value.trim().length > 0;
}

function isCorrect(question, value) {
  if (question.type === "single_choice") return value === question.scoring.correctChoiceId;
  if (question.type === "multiple_choice") {
    const actual = new Set(value);
    const expected = question.scoring.correctChoiceIds;
    return actual.size === expected.length && expected.every((id) => actual.has(id));
  }
  const normalized = normalizeShortAnswer(value, question.scoring.normalization);
  return question.scoring.acceptedAnswers.some(
    (answer) => normalizeShortAnswer(answer, question.scoring.normalization) === normalized
  );
}

export function gradeSubmission(exam, submission) {
  const items = exam.questions.map((question) => {
    const answer = submission.answers[question.id];
    const answered = hasAnswer(question, answer);
    const correct = answered && isCorrect(question, answer);
    const status = !answered ? "unanswered" : correct ? "correct" : "incorrect";
    const item = {
      questionId: question.id,
      status,
      earnedScore: correct ? question.score : 0,
      maxScore: question.score
    };
    if (exam.showExplanations && question.explanation) item.explanation = question.explanation;
    return item;
  });
  const score = items.reduce((total, item) => total + item.earnedScore, 0);
  return Object.freeze({
    examId: exam.id,
    submittedAt: submission.submittedAt,
    score,
    maxScore: getMaxScore(exam),
    requiresReview: false,
    items: Object.freeze(items.map(Object.freeze))
  });
}
