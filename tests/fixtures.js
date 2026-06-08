export function validExam(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "exam-1",
    revision: 1,
    title: "테스트 시험",
    instructions: "차분히 푸세요.",
    durationMinutes: 30,
    expirationPolicy: "confirm",
    showExplanations: true,
    questions: [
      {
        id: "single",
        type: "single_choice",
        prompt: "하나를 고르세요.",
        score: 10,
        choices: [{ id: "a", text: "A" }, { id: "b", text: "B" }],
        scoring: { correctChoiceId: "a" },
        explanation: "A가 정답입니다."
      },
      {
        id: "multiple",
        type: "multiple_choice",
        prompt: "둘을 고르세요.",
        score: 20,
        choices: [{ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" }],
        scoring: { correctChoiceIds: ["a", "c"] }
      },
      {
        id: "short",
        type: "short_answer",
        prompt: "정답을 쓰세요.",
        score: 30,
        scoring: {
          acceptedAnswers: ["Hello World"],
          normalization: { trim: true, collapseWhitespace: true, caseInsensitive: true }
        }
      }
    ],
    ...overrides
  };
}
