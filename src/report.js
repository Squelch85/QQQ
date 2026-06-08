const REPORT_SCHEMA_VERSION = 1;
const CSV_FIXED_HEADERS = ["리포트 버전", "생성일시", "시험 ID", "시험 제목", "합격 점수", "응시일시", "성명", "사번", "부서", "점수", "만점", "합격 여부"];
const QUESTION_HEADER_PREFIX = "문항 결과 ";
const STATUS_LABELS = { correct: "정답", incorrect: "오답", unanswered: "미응답", review_required: "검토 필요" };
const STATUS_VALUES = new Map(Object.entries(STATUS_LABELS).map(([value, label]) => [label, value]));

function roundRate(value) {
  return Math.round(value * 10) / 10;
}

function getQuestionDefinitions(exam, records) {
  const definitions = new Map(exam.questions.map((question, index) => [question.id, {
    questionId: question.id,
    questionNumber: index + 1,
    prompt: question.prompt
  }]));
  for (const record of records) {
    for (const item of record.items ?? []) {
      if (!definitions.has(item.questionId)) {
        definitions.set(item.questionId, {
          questionId: item.questionId,
          questionNumber: null,
          prompt: item.prompt || item.questionId
        });
      }
    }
  }
  return [...definitions.values()];
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

  const questionStats = getQuestionDefinitions(exam, records).map((question) => {
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

function protectSpreadsheetFormula(value) {
  const text = String(value ?? "");
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function restoreSpreadsheetFormula(value) {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function makeQuestionHeader(question) {
  return `${QUESTION_HEADER_PREFIX}[${encodeURIComponent(question.questionId)}] ${question.prompt}`;
}

export function createReportCsv(exam, records, generatedAt = new Date().toISOString()) {
  const questions = getQuestionDefinitions(exam, records);
  const headers = [...CSV_FIXED_HEADERS, ...questions.map(makeQuestionHeader)];
  const passingScore = exam.passingScore ?? 80;
  const rows = records.map((record) => {
    const itemByQuestionId = new Map((record.items ?? []).map((item) => [item.questionId, item]));
    const values = [
      REPORT_SCHEMA_VERSION,
      generatedAt,
      protectSpreadsheetFormula(exam.id),
      protectSpreadsheetFormula(exam.title),
      passingScore,
      record.submittedAt,
      protectSpreadsheetFormula(record.candidate?.name),
      protectSpreadsheetFormula(record.candidate?.employeeId),
      protectSpreadsheetFormula(record.candidate?.department),
      record.score,
      record.maxScore,
      record.score >= passingScore ? "합격" : "불합격",
      ...questions.map(({ questionId }) => STATUS_LABELS[itemByQuestionId.get(questionId)?.status] ?? "")
    ];
    return values.map(escapeCsvCell).join(",");
  });
  return `\uFEFF${[headers.map(escapeCsvCell).join(","), ...rows].join("\r\n")}\r\n`;
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"' && cell === "") quoted = true;
    else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += character;
  }
  if (quoted) throw new Error("CSV 따옴표가 올바르게 닫히지 않았습니다.");
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value !== "")) rows.push(row);
  }
  return rows;
}

function parseRequiredNumber(value, label) {
  const number = Number(value);
  if (value === "" || !Number.isFinite(number)) throw new Error(`${label} 값이 올바르지 않습니다.`);
  return number;
}

export function parseReportCsv(text) {
  const rows = parseCsvRows(text);
  if (rows.length < 2) throw new Error("리포트 CSV에 응시 결과가 없습니다.");
  const [headers, ...dataRows] = rows;
  if (!CSV_FIXED_HEADERS.every((header, index) => headers[index] === header)) throw new Error("지원하는 누적 리포트 CSV 형식이 아닙니다.");

  const questions = headers.slice(CSV_FIXED_HEADERS.length).map((header, index) => {
    const match = header.match(/^문항 결과 \[([^\]]+)\] (.+)$/s);
    if (!match) throw new Error(`${index + 1}번째 문항 열 형식이 올바르지 않습니다.`);
    let questionId;
    try {
      questionId = decodeURIComponent(match[1]);
    } catch {
      throw new Error(`${index + 1}번째 문항 ID가 올바르지 않습니다.`);
    }
    return { id: questionId, prompt: match[2] };
  });

  const first = dataRows[0];
  const schemaVersion = parseRequiredNumber(first[0], "리포트 버전");
  if (schemaVersion !== REPORT_SCHEMA_VERSION) throw new Error(`지원하는 리포트 버전은 ${REPORT_SCHEMA_VERSION}입니다.`);
  const generatedAt = first[1];
  const exam = {
    id: restoreSpreadsheetFormula(first[2]),
    title: restoreSpreadsheetFormula(first[3]),
    passingScore: parseRequiredNumber(first[4], "합격 점수"),
    questions
  };
  if (!exam.title.trim()) throw new Error("리포트에 시험 제목이 없습니다.");

  const records = dataRows.map((values, rowIndex) => {
    if (values.length !== headers.length) throw new Error(`${rowIndex + 2}행의 열 개수가 헤더와 다릅니다.`);
    if (Number(values[0]) !== schemaVersion || values[1] !== generatedAt || restoreSpreadsheetFormula(values[2]) !== exam.id || restoreSpreadsheetFormula(values[3]) !== exam.title || Number(values[4]) !== exam.passingScore) {
      throw new Error(`${rowIndex + 2}행의 리포트 정보가 첫 번째 응시 결과와 다릅니다.`);
    }
    const items = questions.flatMap((question, questionIndex) => {
      const label = values[CSV_FIXED_HEADERS.length + questionIndex];
      if (!label) return [];
      const status = STATUS_VALUES.get(label);
      if (!status) throw new Error(`${rowIndex + 2}행의 문항 결과 '${label}'을(를) 지원하지 않습니다.`);
      return [{ questionId: question.id, status, prompt: question.prompt }];
    });
    return {
      submittedAt: values[5],
      candidate: {
        name: restoreSpreadsheetFormula(values[6]),
        employeeId: restoreSpreadsheetFormula(values[7]),
        department: restoreSpreadsheetFormula(values[8])
      },
      score: parseRequiredNumber(values[9], `${rowIndex + 2}행 점수`),
      maxScore: parseRequiredNumber(values[10], `${rowIndex + 2}행 만점`),
      items
    };
  });

  return { schemaVersion, generatedAt, ...buildExamReport(exam, records) };
}
