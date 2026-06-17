const REPORT_SCHEMA_VERSION = 2;
const LEGACY_CSV_FIXED_HEADERS = ["리포트 버전", "생성일시", "시험 ID", "시험 제목", "합격 점수", "응시일시", "성명", "사번", "부서", "점수", "만점", "합격 여부"];
const CSV_FIXED_HEADERS = ["리포트 버전", "생성일시", "시험 ID", "시험 버전", "시험 제목", "합격 점수", "응시 ID", "응시일시", "성명", "사번", "부서", "점수", "만점", "합격 여부"];
const QUESTION_HEADER_PREFIX = "문항 결과 ";
const STATUS_LABELS = { correct: "정답", incorrect: "오답", unanswered: "미응답", review_required: "검토 필요" };
const STATUS_VALUES = new Map(Object.entries(STATUS_LABELS).map(([value, label]) => [label, value]));
export const REPORT_MODES = new Set(["allAttempts", "latestPerEmployee", "bestPerEmployee"]);

function roundRate(value) {
  return Math.round(value * 10) / 10;
}

function compareAttempts(left, right) {
  const timeDifference = Date.parse(left.submittedAt) - Date.parse(right.submittedAt);
  if (Number.isFinite(timeDifference) && timeDifference !== 0) return timeDifference;
  return String(left.attemptId ?? "").localeCompare(String(right.attemptId ?? ""));
}

function candidateKey(record) {
  return record.candidate?.employeeId?.trim() || `name:${record.candidate?.name?.trim() || record.attemptId}`;
}

export function selectReportRecords(records, mode = "allAttempts") {
  if (!REPORT_MODES.has(mode)) throw new Error(`지원하지 않는 리포트 집계 방식입니다: ${mode}`);
  if (mode === "allAttempts") return [...records];

  const selected = new Map();
  for (const record of records) {
    const key = candidateKey(record);
    const current = selected.get(key);
    if (!current) {
      selected.set(key, record);
      continue;
    }
    if (mode === "latestPerEmployee" && compareAttempts(current, record) <= 0) selected.set(key, record);
    if (mode === "bestPerEmployee") {
      const currentRate = current.maxScore ? current.score / current.maxScore : 0;
      const nextRate = record.maxScore ? record.score / record.maxScore : 0;
      if (nextRate > currentRate || (nextRate === currentRate && compareAttempts(current, record) <= 0)) selected.set(key, record);
    }
  }
  return [...selected.values()].sort(compareAttempts);
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

export function buildExamReport(exam, records, mode = "latestPerEmployee") {
  const passingScore = exam.passingScore ?? 80;
  const selectedRecords = selectReportRecords(records, mode);
  const attempts = selectedRecords.map((record) => {
    const maxScore = record.maxScore || 100;
    return {
      ...record,
      scoreRate: maxScore === 0 ? 0 : roundRate((record.score / maxScore) * 100),
      passed: record.score >= passingScore
    };
  });

  const questionCounters = new Map();
  for (const record of selectedRecords) {
    for (const item of record.items ?? []) {
      const counter = questionCounters.get(item.questionId) ?? { attemptCount: 0, wrongCount: 0 };
      counter.attemptCount += 1;
      if (item.status !== "correct") counter.wrongCount += 1;
      questionCounters.set(item.questionId, counter);
    }
  }

  const questionStats = getQuestionDefinitions(exam, selectedRecords).map((question) => {
    const counter = questionCounters.get(question.questionId) ?? { attemptCount: 0, wrongCount: 0 };
    return {
      ...question,
      attemptCount: counter.attemptCount,
      wrongCount: counter.wrongCount,
      wrongRate: counter.attemptCount === 0 ? 0 : roundRate((counter.wrongCount / counter.attemptCount) * 100)
    };
  });
  const highWrongRate = questionStats
    .filter((item) => item.wrongCount > 0)
    .sort((left, right) => right.wrongRate - left.wrongRate || right.attemptCount - left.attemptCount || left.questionId.localeCompare(right.questionId, "ko"))
    .slice(0, 5);
  const passedCount = attempts.filter((attempt) => attempt.passed).length;
  const averageScore = attempts.length === 0 ? 0 : roundRate(attempts.reduce((sum, attempt) => sum + attempt.scoreRate, 0) / attempts.length);
  const uniqueExamineeCount = new Set(records.map(candidateKey)).size;

  return {
    examId: exam.id,
    examRevision: exam.revision ?? 1,
    examTitle: exam.title,
    passingScore,
    mode,
    totalAttemptCount: records.length,
    uniqueExamineeCount,
    examineeCount: attempts.length,
    passedCount,
    passRate: attempts.length === 0 ? 0 : roundRate((passedCount / attempts.length) * 100),
    averageScore,
    attempts,
    questionStats,
    highWrongRate
  };
}

function createAttemptId(exam, candidate, submittedAt) {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const identity = `${exam?.id ?? "exam"}-${exam?.revision ?? 1}-${candidate.employeeId || candidate.name}-${submittedAt}`;
  let hash = 2166136261;
  for (const character of identity) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `attempt-${submittedAt}-${(hash >>> 0).toString(16)}`;
}

export function makeAttemptRecord(candidate, result, exam) {
  const questionsById = new Map((exam?.questions ?? []).map((question) => [question.id, question]));
  return {
    attemptId: createAttemptId(exam, candidate, result.submittedAt),
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
      exam.revision ?? 1,
      protectSpreadsheetFormula(exam.title),
      passingScore,
      protectSpreadsheetFormula(record.attemptId),
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
  if (quoted) throw new Error("리포트 CSV의 큰따옴표가 닫히지 않았습니다.");
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

function parseQuestions(headers, fixedHeaderCount) {
  return headers.slice(fixedHeaderCount).map((header, index) => {
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
}

export function parseReportCsv(text) {
  const rows = parseCsvRows(text);
  if (rows.length < 2) throw new Error("리포트 CSV에 응시 결과가 없습니다.");
  const [headers, ...dataRows] = rows;
  const currentFormat = CSV_FIXED_HEADERS.every((header, index) => headers[index] === header);
  const legacyFormat = LEGACY_CSV_FIXED_HEADERS.every((header, index) => headers[index] === header);
  if (!currentFormat && !legacyFormat) throw new Error("지원하는 누적 리포트 CSV 형식이 아닙니다.");

  const fixedHeaders = currentFormat ? CSV_FIXED_HEADERS : LEGACY_CSV_FIXED_HEADERS;
  const questions = parseQuestions(headers, fixedHeaders.length);
  const first = dataRows[0];
  const schemaVersion = parseRequiredNumber(first[0], "리포트 버전");
  if (currentFormat && schemaVersion !== REPORT_SCHEMA_VERSION) throw new Error(`지원하는 리포트 버전은 ${REPORT_SCHEMA_VERSION}입니다.`);
  if (legacyFormat && schemaVersion !== 1) throw new Error("지원하는 기존 리포트 버전은 1입니다.");

  const generatedAt = first[1];
  const indexes = currentFormat
    ? { revision: 3, title: 4, passingScore: 5, attemptId: 6, submittedAt: 7, name: 8, employeeId: 9, department: 10, score: 11, maxScore: 12 }
    : { title: 3, passingScore: 4, submittedAt: 5, name: 6, employeeId: 7, department: 8, score: 9, maxScore: 10 };
  const exam = {
    id: restoreSpreadsheetFormula(first[2]),
    revision: currentFormat ? parseRequiredNumber(first[indexes.revision], "시험 버전") : 1,
    title: restoreSpreadsheetFormula(first[indexes.title]),
    passingScore: parseRequiredNumber(first[indexes.passingScore], "합격 점수"),
    questions
  };
  if (!exam.title.trim()) throw new Error("리포트에 시험 제목이 없습니다.");

  const records = dataRows.map((values, rowIndex) => {
    if (values.length !== headers.length) throw new Error(`${rowIndex + 2}행의 열 개수가 헤더와 다릅니다.`);
    const sameRevision = !currentFormat || Number(values[indexes.revision]) === exam.revision;
    if (Number(values[0]) !== schemaVersion || values[1] !== generatedAt || restoreSpreadsheetFormula(values[2]) !== exam.id || !sameRevision || restoreSpreadsheetFormula(values[indexes.title]) !== exam.title || Number(values[indexes.passingScore]) !== exam.passingScore) {
      throw new Error(`${rowIndex + 2}행의 리포트 정보가 첫 번째 응시 결과와 다릅니다.`);
    }
    const items = questions.flatMap((question, questionIndex) => {
      const label = values[fixedHeaders.length + questionIndex];
      if (!label) return [];
      const status = STATUS_VALUES.get(label);
      if (!status) throw new Error(`${rowIndex + 2}행의 문항 결과 '${label}'을(를) 지원하지 않습니다.`);
      return [{ questionId: question.id, status, prompt: question.prompt }];
    });
    const submittedAt = values[indexes.submittedAt];
    return {
      attemptId: currentFormat ? restoreSpreadsheetFormula(values[indexes.attemptId]) : `legacy-${rowIndex + 1}-${submittedAt}`,
      submittedAt,
      candidate: {
        name: restoreSpreadsheetFormula(values[indexes.name]),
        employeeId: restoreSpreadsheetFormula(values[indexes.employeeId]),
        department: restoreSpreadsheetFormula(values[indexes.department])
      },
      score: parseRequiredNumber(values[indexes.score], `${rowIndex + 2}행 점수`),
      maxScore: parseRequiredNumber(values[indexes.maxScore], `${rowIndex + 2}행 만점`),
      items
    };
  });

  return { schemaVersion, generatedAt, ...buildExamReport(exam, records, "allAttempts") };
}
