const REPORT_SCHEMA_VERSION = 1;

function roundRate(value) {
  return Math.round(value * 10) / 10;
}

export function buildExamReport(exam, records) {
  const passingScore = exam.passingScore ?? 80;
  const attempts = records.map((record) => {
    const maxScore = record.maxScore || 100;
    return {
      ...record,
      scoreRate: maxScore === 0 ? 0 : roundRate((record.score / maxScore) * 100),
      passed: record.score >= passingScore
    };
  });

  const questionDefinitions = new Map(exam.questions.map((question, index) => [question.id, {
    questionId: question.id,
    questionNumber: index + 1,
    prompt: question.prompt
  }]));
  for (const record of records) {
    for (const item of record.items ?? []) {
      if (!questionDefinitions.has(item.questionId)) {
        questionDefinitions.set(item.questionId, {
          questionId: item.questionId,
          questionNumber: null,
          prompt: item.prompt || item.questionId
        });
      }
    }
  }

  const questionStats = [...questionDefinitions.values()].map((question) => {
    let attemptCount = 0;
    let wrongCount = 0;
    for (const record of records) {
      const item = record.items?.find((candidate) => candidate.questionId === question.questionId);
      if (!item) continue;
      attemptCount += 1;
      if (item.status !== "correct") wrongCount += 1;
    }
    return {
      ...question,
      attemptCount,
      wrongCount,
      wrongRate: attemptCount === 0 ? 0 : roundRate((wrongCount / attemptCount) * 100)
    };
  });
  const highWrongRate = questionStats
    .filter((item) => item.wrongCount > 0)
    .sort((left, right) => right.wrongRate - left.wrongRate || right.attemptCount - left.attemptCount || left.questionId.localeCompare(right.questionId, "ko"))
    .slice(0, 5);
  const passedCount = attempts.filter((attempt) => attempt.passed).length;
  const averageScore = attempts.length === 0 ? 0 : roundRate(attempts.reduce((sum, attempt) => sum + attempt.scoreRate, 0) / attempts.length);

  return {
    examId: exam.id,
    examTitle: exam.title,
    passingScore,
    examineeCount: attempts.length,
    passedCount,
    passRate: attempts.length === 0 ? 0 : roundRate((passedCount / attempts.length) * 100),
    averageScore,
    attempts,
    questionStats,
    highWrongRate
  };
}

export function makeAttemptRecord(candidate, result, exam) {
  const questionsById = new Map((exam?.questions ?? []).map((question) => [question.id, question]));
  return {
    candidate: { name: candidate.name, employeeId: candidate.employeeId, department: candidate.department || "" },
    submittedAt: result.submittedAt,
    score: result.score,
    maxScore: result.maxScore,
    items: result.items.map(({ questionId, status }) => ({
      questionId,
      status,
      ...(questionsById.get(questionId)?.prompt ? { prompt: questionsById.get(questionId).prompt } : {})
    }))
  };
}

export function createReportFile(exam, records, generatedAt = new Date().toISOString()) {
  return { schemaVersion: REPORT_SCHEMA_VERSION, generatedAt, ...buildExamReport(exam, records) };
}

export function parseReportJson(text) {
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    throw new Error("올바른 리포트 JSON 형식이 아닙니다.");
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("리포트는 JSON 객체여야 합니다.");
  if (report.schemaVersion !== REPORT_SCHEMA_VERSION) throw new Error(`지원하는 리포트 버전은 ${REPORT_SCHEMA_VERSION}입니다.`);
  if (typeof report.examTitle !== "string" || !report.examTitle.trim()) throw new Error("리포트에 시험 제목이 없습니다.");
  if (!Array.isArray(report.attempts) || !Array.isArray(report.highWrongRate)) throw new Error("리포트 응시 결과 또는 문항 통계가 올바르지 않습니다.");
  return structuredClone(report);
}
