export function buildExamReport(exam, records) {
  const maxScore = exam.questions.reduce((sum, question) => sum + question.score, 0);
  const attempts = records.map((record) => ({
    ...record,
    scoreRate: maxScore === 0 ? 0 : Math.round((record.score / maxScore) * 1000) / 10,
    passed: record.score >= (exam.passingScore ?? maxScore * 0.8)
  }));
  const questionStats = exam.questions.map((question, index) => {
    const wrongCount = records.reduce((count, record) => count + (record.items[index]?.status === "correct" ? 0 : 1), 0);
    return {
      questionId: question.id,
      questionNumber: index + 1,
      wrongCount,
      wrongRate: records.length === 0 ? 0 : Math.round((wrongCount / records.length) * 1000) / 10
    };
  });
  const highWrongRate = questionStats
    .filter((item) => item.wrongCount > 0)
    .sort((left, right) => right.wrongRate - left.wrongRate || left.questionNumber - right.questionNumber)
    .slice(0, 5);
  return { examId: exam.id, examineeCount: attempts.length, attempts, questionStats, highWrongRate };
}

export function makeAttemptRecord(candidate, result) {
  return {
    candidate: { name: candidate.name, employeeId: candidate.employeeId, department: candidate.department || "" },
    submittedAt: result.submittedAt,
    score: result.score,
    maxScore: result.maxScore,
    items: result.items.map(({ questionId, status }) => ({ questionId, status }))
  };
}
