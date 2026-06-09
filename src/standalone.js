// 이 파일은 npm run build로 생성됩니다. 직접 수정하지 마세요.
(() => {
"use strict";

// ---- src/exam.js ----
const EXAM_SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_QUESTIONS = 500;
const MAX_TEXT_LENGTH = 10_000;

const QUESTION_TYPES = new Set(["single_choice", "multiple_choice", "short_answer"]);
const EXPIRATION_POLICIES = new Set(["confirm", "auto_submit"]);
const NORMALIZATION_KEYS = new Set(["trim", "collapseWhitespace", "caseInsensitive"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateText(value, path, errors, { required = true } = {}) {
  if ((!required && value === undefined) || (!required && value === "")) return;
  if (!isNonEmptyString(value)) {
    errors.push(`${path}: 비어 있지 않은 문자열이어야 합니다.`);
  } else if (value.length > MAX_TEXT_LENGTH) {
    errors.push(`${path}: ${MAX_TEXT_LENGTH.toLocaleString()}자를 초과할 수 없습니다.`);
  }
}

function validateChoices(question, path, errors) {
  if (!Array.isArray(question.choices) || question.choices.length < 2) {
    errors.push(`${path}.choices: 객관식 문항에는 선택지가 2개 이상 필요합니다.`);
    return new Set();
  }

  const choiceIds = new Set();
  question.choices.forEach((choice, index) => {
    const choicePath = `${path}.choices[${index}]`;
    if (!isObject(choice)) {
      errors.push(`${choicePath}: 객체여야 합니다.`);
      return;
    }
    validateText(choice.id, `${choicePath}.id`, errors);
    validateText(choice.text, `${choicePath}.text`, errors);
    if (isNonEmptyString(choice.id) && choiceIds.has(choice.id)) {
      errors.push(`${choicePath}.id: 중복된 선택지 ID '${choice.id}'입니다.`);
    }
    if (isNonEmptyString(choice.id)) choiceIds.add(choice.id);
  });
  return choiceIds;
}

function validateScoring(question, choiceIds, path, errors) {
  const scoring = question.scoring;
  if (!isObject(scoring)) {
    errors.push(`${path}.scoring: 채점 규칙 객체가 필요합니다.`);
    return;
  }

  if (question.type === "single_choice") {
    if (!isNonEmptyString(scoring.correctChoiceId) || !choiceIds.has(scoring.correctChoiceId)) {
      errors.push(`${path}.scoring.correctChoiceId: 존재하는 선택지 ID여야 합니다.`);
    }
  } else if (question.type === "multiple_choice") {
    if (!Array.isArray(scoring.correctChoiceIds) || scoring.correctChoiceIds.length === 0) {
      errors.push(`${path}.scoring.correctChoiceIds: 정답 선택지 ID가 하나 이상 필요합니다.`);
    } else {
      const uniqueAnswers = new Set(scoring.correctChoiceIds);
      if (uniqueAnswers.size !== scoring.correctChoiceIds.length) {
        errors.push(`${path}.scoring.correctChoiceIds: 중복된 정답 ID가 있습니다.`);
      }
      for (const id of uniqueAnswers) {
        if (!choiceIds.has(id)) errors.push(`${path}.scoring.correctChoiceIds: 선택지 '${id}'가 없습니다.`);
      }
    }
  } else if (question.type === "short_answer") {
    if (!Array.isArray(scoring.acceptedAnswers) || scoring.acceptedAnswers.length === 0 || !scoring.acceptedAnswers.every(isNonEmptyString)) {
      errors.push(`${path}.scoring.acceptedAnswers: 비어 있지 않은 허용 답안이 하나 이상 필요합니다.`);
    }
    if (scoring.normalization !== undefined) {
      if (!isObject(scoring.normalization)) {
        errors.push(`${path}.scoring.normalization: 객체여야 합니다.`);
      } else {
        for (const [key, value] of Object.entries(scoring.normalization)) {
          if (!NORMALIZATION_KEYS.has(key)) errors.push(`${path}.scoring.normalization.${key}: 지원하지 않는 규칙입니다.`);
          else if (typeof value !== "boolean") errors.push(`${path}.scoring.normalization.${key}: 불리언이어야 합니다.`);
        }
      }
    }
  }
}

function validateExam(candidate) {
  const errors = [];
  if (!isObject(candidate)) return { valid: false, errors: ["root: 시험지는 JSON 객체여야 합니다."] };

  if (candidate.schemaVersion !== EXAM_SCHEMA_VERSION) {
    errors.push(`schemaVersion: 지원 버전은 ${EXAM_SCHEMA_VERSION}입니다.`);
  }
  validateText(candidate.id, "id", errors);
  if (!Number.isInteger(candidate.revision) || candidate.revision < 1) errors.push("revision: 1 이상의 정수여야 합니다.");
  validateText(candidate.title, "title", errors);
  validateText(candidate.instructions, "instructions", errors, { required: false });

  if (!Number.isInteger(candidate.durationMinutes) || candidate.durationMinutes < 0 || candidate.durationMinutes > 1_440) {
    errors.push("durationMinutes: 0~1440 사이의 정수여야 합니다. 0은 시간 제한 없음을 뜻합니다.");
  }
  if (!EXPIRATION_POLICIES.has(candidate.expirationPolicy)) {
    errors.push("expirationPolicy: 'confirm' 또는 'auto_submit'이어야 합니다.");
  }
  if (typeof candidate.showExplanations !== "boolean") {
    errors.push("showExplanations: 불리언이어야 합니다.");
  }
  if (candidate.passingScore !== undefined && (typeof candidate.passingScore !== "number" || !Number.isFinite(candidate.passingScore) || candidate.passingScore < 0)) {
    errors.push("passingScore: 0 이상의 유한한 숫자여야 합니다.");
  }
  if (!Array.isArray(candidate.questions) || candidate.questions.length === 0) {
    errors.push("questions: 문항이 하나 이상 필요합니다.");
  } else if (candidate.questions.length > MAX_QUESTIONS) {
    errors.push(`questions: 최대 ${MAX_QUESTIONS}개까지 지원합니다.`);
  } else {
    const questionIds = new Set();
    candidate.questions.forEach((question, index) => {
      const path = `questions[${index}]`;
      if (!isObject(question)) {
        errors.push(`${path}: 객체여야 합니다.`);
        return;
      }
      validateText(question.id, `${path}.id`, errors);
      validateText(question.prompt, `${path}.prompt`, errors);
      validateText(question.explanation, `${path}.explanation`, errors, { required: false });
      if (isNonEmptyString(question.id) && questionIds.has(question.id)) {
        errors.push(`${path}.id: 중복된 문항 ID '${question.id}'입니다.`);
      }
      if (isNonEmptyString(question.id)) questionIds.add(question.id);
      if (!QUESTION_TYPES.has(question.type)) errors.push(`${path}.type: 지원하지 않는 문제 유형입니다.`);
      if (typeof question.score !== "number" || !Number.isFinite(question.score) || question.score <= 0) {
        errors.push(`${path}.score: 0보다 큰 유한한 숫자여야 합니다.`);
      }
      const choiceIds = question.type === "short_answer" ? new Set() : validateChoices(question, path, errors);
      validateScoring(question, choiceIds, path, errors);
    });
  }

  return { valid: errors.length === 0, errors };
}

function parseExamJson(text) {
  if (typeof text !== "string") throw new TypeError("시험지 내용은 문자열이어야 합니다.");
  if (new Blob([text]).size > MAX_FILE_BYTES) throw new Error(`시험지 파일은 ${MAX_FILE_BYTES / 1024 / 1024}MB 이하여야 합니다.`);

  let candidate;
  try {
    candidate = JSON.parse(text);
    if (candidate && candidate.revision === undefined) candidate.revision = 1;
  } catch {
    throw new Error("올바른 JSON 형식이 아닙니다.");
  }
  const validation = validateExam(candidate);
  if (!validation.valid) throw new Error(validation.errors.join("\n"));
  return structuredClone(candidate);
}

function toPublicExam(exam) {
  return {
    id: exam.id,
    revision: exam.revision,
    title: exam.title,
    instructions: exam.instructions ?? "",
    durationMinutes: exam.durationMinutes,
    expirationPolicy: exam.expirationPolicy,
    passingScore: exam.passingScore,
    questions: exam.questions.map(({ scoring, explanation, ...question }) => ({
      ...question,
      choices: question.choices?.map((choice) => ({ ...choice }))
    }))
  };
}

function getMaxScore(exam) {
  return exam.questions.reduce((total, question) => total + question.score, 0);
}

// ---- src/grading.js ----
function normalizeShortAnswer(value, rules = {}) {
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

function gradeSubmission(exam, submission) {
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

// ---- src/attempt.js ----
const AttemptState = Object.freeze({
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

class Attempt {
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

// ---- src/converter.js ----
const HEADER_NAMES = new Set(["문항번호", "질문", "정답"]);

function parseDelimitedRows(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "\t" && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  if (quoted) throw new Error("닫히지 않은 큰따옴표가 있습니다.");
  return rows;
}

function splitPromptAndChoices(rawQuestion, rowNumber) {
  const normalized = rawQuestion.replace(/\\n/g, "\n").replace(/\r\n?/g, "\n").trim();
  const matches = [...normalized.matchAll(/(?:^|\s)(\d+)\s*\)\s*/gu)];
  if (matches.length < 2) throw new Error(`${rowNumber}행: 질문에서 '1) ... 2) ...' 형식의 선택지를 찾을 수 없습니다.`);

  const prompt = normalized.slice(0, matches[0].index).trim();
  const choices = matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? normalized.length;
    return { id: match[1], text: normalized.slice(start, end).trim() };
  });
  if (!prompt || choices.some((choice) => !choice.text)) throw new Error(`${rowNumber}행: 질문 또는 선택지 내용이 비어 있습니다.`);
  return { prompt, choices };
}

function selectRandomQuestions(questions, questionCount, random) {
  const shuffled = questions.slice();
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled.slice(0, questionCount);
}

function assignEqualScores(questions) {
  const baseScoreInCents = Math.floor(10_000 / questions.length);
  let remainder = 10_000 - baseScoreInCents * questions.length;
  return questions.map((question) => {
    const scoreInCents = baseScoreInCents + (remainder > 0 ? 1 : 0);
    remainder -= remainder > 0 ? 1 : 0;
    return { ...question, score: scoreInCents / 100 };
  });
}

function convertQuestionTable(text, options = {}) {
  if (typeof text !== "string" || !text.trim()) throw new Error("변환할 표 형식 문항을 입력하세요.");
  const rows = parseDelimitedRows(text);
  const dataRows = rows[0]?.slice(0, 3).every((cell) => HEADER_NAMES.has(cell.trim())) ? rows.slice(1) : rows;
  if (dataRows.length === 0) throw new Error("변환할 문항이 없습니다.");

  const questions = dataRows.map((row, index) => {
    if (row.length < 3) throw new Error(`${index + 1}행: 문항번호, 질문, 정답의 3개 열이 필요합니다.`);
    const id = row[0].trim();
    const { prompt, choices } = splitPromptAndChoices(row[1], index + 1);
    const correctChoiceId = row[2].trim();
    if (!id) throw new Error(`${index + 1}행: 문항번호가 비어 있습니다.`);
    if (!choices.some((choice) => choice.id === correctChoiceId)) throw new Error(`${id}: 정답 '${correctChoiceId}'에 해당하는 선택지가 없습니다.`);
    return {
      id,
      type: "single_choice",
      prompt,
      choices,
      scoring: { correctChoiceId }
    };
  });

  if (new Set(questions.map((question) => question.id)).size !== questions.length) throw new Error("중복된 문항번호가 있습니다.");

  const requestedCount = options.questionCount === undefined || options.questionCount === ""
    ? questions.length
    : Number(options.questionCount);
  if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > questions.length) {
    throw new Error(`출제 문항 수는 1~${questions.length} 사이의 정수여야 합니다.`);
  }
  const random = options.random ?? Math.random;
  if (typeof random !== "function") throw new TypeError("랜덤 함수가 올바르지 않습니다.");
  const selectedQuestions = selectRandomQuestions(questions, requestedCount, random);

  return {
    schemaVersion: 1,
    id: options.id || `converted-exam-${new Date().toISOString().slice(0, 10)}`,
    revision: Number(options.revision ?? 1),
    title: options.title || "검사원 평가 시험",
    instructions: options.instructions || "각 문항을 읽고 가장 알맞은 답을 선택하세요.",
    durationMinutes: Number(options.durationMinutes ?? 30),
    expirationPolicy: "confirm",
    showExplanations: false,
    passingScore: Number(options.passingScore ?? 80),
    questions: assignEqualScores(selectedQuestions)
  };
}

// ---- src/default-exam.js ----
const defaultExam = {
  "schemaVersion": 1,
  "id": "inspector-evaluation-2026",
  "revision": 1,
  "title": "검사원 평가 시험",
  "instructions": "각 문항을 읽고 가장 알맞은 답을 하나 선택하세요. 제출 후에는 답안을 변경할 수 없습니다.",
  "durationMinutes": 30,
  "expirationPolicy": "confirm",
  "showExplanations": false,
  "passingScore": 80,
  "questions": [
    {
      "id": "필기1",
      "type": "single_choice",
      "prompt": "현장 입장 시 반드시 착용해야 하는 것이 아닌 것은?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "제전모"
        },
        {
          "id": "2",
          "text": "제전복"
        },
        {
          "id": "3",
          "text": "제전화"
        },
        {
          "id": "4",
          "text": "귀걸이"
        }
      ],
      "scoring": {
        "correctChoiceId": "4"
      }
    },
    {
      "id": "필기2",
      "type": "single_choice",
      "prompt": "제전모 착용 시 올바른 착용 법은?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "앞머리가 돋보이도록 머리 뒤쪽으로 착용한다."
        },
        {
          "id": "2",
          "text": "긴 머리가 어깨 위로 내려오지 않도록 머리카락을 핀으로 고정 후 모자를 착용한다."
        },
        {
          "id": "3",
          "text": "머리 위에 살짝 걸쳐서 착용한다."
        },
        {
          "id": "4",
          "text": "긴 생머리가 내려오도록 착용한다."
        }
      ],
      "scoring": {
        "correctChoiceId": "2"
      }
    },
    {
      "id": "필기3",
      "type": "single_choice",
      "prompt": "작업 교대 시 인수인계 받아야 할 사항이 아닌 것은?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "생산 완료 된 제품 수량."
        },
        {
          "id": "2",
          "text": "수리 대기/수리 완료품 현황"
        },
        {
          "id": "3",
          "text": "밖에 날씨."
        },
        {
          "id": "4",
          "text": "검사 간 발생한 특이 사항"
        }
      ],
      "scoring": {
        "correctChoiceId": "3"
      }
    },
    {
      "id": "필기4",
      "type": "single_choice",
      "prompt": "검사 간 본인이 판정하기 어려운 불량이 확인되었을 경우 올바른 대처 방법은?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "그냥 적재한다."
        },
        {
          "id": "2",
          "text": "식별 Tag 부착 후 현장 AOI 담당 또는 품질 관리자에게 보고한다."
        },
        {
          "id": "3",
          "text": "다음 근무자에게 넘긴다."
        },
        {
          "id": "4",
          "text": "바로 폐기한다."
        }
      ],
      "scoring": {
        "correctChoiceId": "2"
      }
    },
    {
      "id": "필기5",
      "type": "single_choice",
      "prompt": "AOI(자동 광학 검사기) 장비가 불량이 아닌 정상 제품을 불량으로 판정하는 현상을 무엇이라 부르나요?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "가성불량"
        },
        {
          "id": "2",
          "text": "진성 불량"
        },
        {
          "id": "3",
          "text": "유출 불량"
        },
        {
          "id": "4",
          "text": "1번과 3번 모두 맞는 표현이다"
        }
      ],
      "scoring": {
        "correctChoiceId": "1"
      }
    },
    {
      "id": "필기6",
      "type": "single_choice",
      "prompt": "다음 중 '오삽(Wrong Part)'에 해당하는 경우는 무엇인가요?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "10kΩ 저항 자리에 1kΩ 저항이 장착되었다."
        },
        {
          "id": "2",
          "text": "다이오드의 방향(극성)이 반대로 장착되었다."
        },
        {
          "id": "3",
          "text": "부품이 장착되지 않고 납만 묻어있다."
        },
        {
          "id": "4",
          "text": "부품이 옆으로 돌아가서 인접 패드에 걸쳐있다."
        }
      ],
      "scoring": {
        "correctChoiceId": "1"
      }
    },
    {
      "id": "필기7",
      "type": "single_choice",
      "prompt": "작업장 내 ESD(정전기) 방지를 위한 기본 수칙으로 틀린 것은 무엇인가요?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "일반 플라스틱 컵이나 비닐봉지를 PCB 옆에 둔다."
        },
        {
          "id": "2",
          "text": "제전 바닥과 제전 매트를 설치한다."
        },
        {
          "id": "3",
          "text": "제전복과 제전화를 상시 착용한다."
        },
        {
          "id": "4",
          "text": "이동 시 PCB는 항상 제전 박스에 담아 이동한다."
        }
      ],
      "scoring": {
        "correctChoiceId": "1"
      }
    },
    {
      "id": "필기8",
      "type": "single_choice",
      "prompt": "CHIP 종류별 특성 중 옳은 것은?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "R-CHIP은 일반적으로 극성이 있다."
        },
        {
          "id": "2",
          "text": "C-CHIP은 일반적으로 좌우 방향 구분이 있다."
        },
        {
          "id": "3",
          "text": "DIODE는 극성이 있어 방향을 확인해야 한다."
        },
        {
          "id": "4",
          "text": "모든 CHIP 부품은 방향 구분이 없다."
        }
      ],
      "scoring": {
        "correctChoiceId": "3"
      }
    },
    {
      "id": "필기9",
      "type": "single_choice",
      "prompt": "리드(Lead)가 기판 패드에 닿지 않고 위로 떠 있는 불량 현상을 무엇이라 하는가?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "CNT 소납"
        },
        {
          "id": "2",
          "text": "CNT 과납"
        },
        {
          "id": "3",
          "text": "들뜸"
        },
        {
          "id": "4",
          "text": "CNT 역삽"
        }
      ],
      "scoring": {
        "correctChoiceId": "3"
      }
    },
    {
      "id": "필기10",
      "type": "single_choice",
      "prompt": "AOI 장비가 주로 검사하는 항목으로 보기 어려운 것은 무엇인가요?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "부품 누락 검사"
        },
        {
          "id": "2",
          "text": "부품 오실장 검사"
        },
        {
          "id": "3",
          "text": "부품 역방향 검사"
        },
        {
          "id": "4",
          "text": "자재 용량값"
        }
      ],
      "scoring": {
        "correctChoiceId": "4"
      }
    },
    {
      "id": "필기11",
      "type": "single_choice",
      "prompt": "열충격이나 기계적 스트레스로 인해 납땜 부위에 미세한 금이 가는 불량 현상은?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "브릿지 (Bridge)"
        },
        {
          "id": "2",
          "text": "크랙 (Crack)"
        },
        {
          "id": "3",
          "text": "들뜸 (Lifted Lead)"
        },
        {
          "id": "4",
          "text": "과납 (Excess Solder)"
        }
      ],
      "scoring": {
        "correctChoiceId": "2"
      }
    },
    {
      "id": "필기12",
      "type": "single_choice",
      "prompt": "산화나 열량 부족으로 인해 솔더가 패드나 부품 전극에 화학적 결합을 이루지 못하고 그냥 얹혀만 있어 쉽게 떨어지는 불량 현상은 무엇인가요?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "과납"
        },
        {
          "id": "2",
          "text": "소납"
        },
        {
          "id": "3",
          "text": "냉납"
        },
        {
          "id": "4",
          "text": "크랙"
        }
      ],
      "scoring": {
        "correctChoiceId": "3"
      }
    },
    {
      "id": "필기13",
      "type": "single_choice",
      "prompt": "모델 변경 시 작성하며 초/중/종물에 대한 검사 기록을 기입하는 체크시트는?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "일상점검 체크시트"
        },
        {
          "id": "2",
          "text": "3정5S 체크시트"
        },
        {
          "id": "3",
          "text": "AOI 직행률 체크시트"
        },
        {
          "id": "4",
          "text": "모델 변경 체크시트"
        }
      ],
      "scoring": {
        "correctChoiceId": "4"
      }
    },
    {
      "id": "필기14",
      "type": "single_choice",
      "prompt": "올바른 PCB 취급 방법은?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "양 모서리를 힘을 꽉 주고 잡는다."
        },
        {
          "id": "2",
          "text": "힘을 빼고 PCB 좌우를 살짝 잡는다."
        },
        {
          "id": "3",
          "text": "PCB 가운데를 힘을 주어 꽉 잡는다."
        },
        {
          "id": "4",
          "text": "PCB 한쪽 모서리 부분을 꽉 잡는다."
        }
      ],
      "scoring": {
        "correctChoiceId": "2"
      }
    },
    {
      "id": "필기15",
      "type": "single_choice",
      "prompt": "제품 취급 중 떨어뜨렸을 경우, 올바른 처리 방법은?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "AOI 재검 후 이상 없을 시 적재한다."
        },
        {
          "id": "2",
          "text": "육안 검사 후 이상 없을 시 적재한다."
        },
        {
          "id": "3",
          "text": "AOI 검사와 육안 검사를 모두 완료한 후 이상 없을 시 적재한다."
        },
        {
          "id": "4",
          "text": "폐기 처리한다."
        }
      ],
      "scoring": {
        "correctChoiceId": "4"
      }
    },
    {
      "id": "필기16",
      "type": "single_choice",
      "prompt": "자재 스펙과 다른 종류의 부품이 PCB에 실장된 불량 명칭은?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "FLUX"
        },
        {
          "id": "2",
          "text": "뒤집힘"
        },
        {
          "id": "3",
          "text": "틀어짐"
        },
        {
          "id": "4",
          "text": "오삽"
        }
      ],
      "scoring": {
        "correctChoiceId": "4"
      }
    },
    {
      "id": "필기17",
      "type": "single_choice",
      "prompt": "리플로우 오븐을 통과한 후 최종 납땜 상태와 부품 장착 여부를 광학 카메라로 검사하는 장비는 무엇인가요?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "SPI"
        },
        {
          "id": "2",
          "text": "AOI"
        },
        {
          "id": "3",
          "text": "X-RAY"
        },
        {
          "id": "4",
          "text": "마운터"
        }
      ],
      "scoring": {
        "correctChoiceId": "2"
      }
    },
    {
      "id": "필기18",
      "type": "single_choice",
      "prompt": "제품 BOX 적재 시 올바른 행동이 아닌 것은?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "적재 전 사용할 BOX 내부에 먼지나 이물이 있을 경우 제거한다."
        },
        {
          "id": "2",
          "text": "제품의 양쪽 모서리를 살짝 잡고 PCB 번호가 BOX 현품표 쪽을 향하도록 순서대로 적재한다."
        },
        {
          "id": "3",
          "text": "적재 중 제품 간 충격 발생 시 육안 확인 후 바로 적재한다."
        },
        {
          "id": "4",
          "text": "마지막 제품을 적재한 후 수량 및 방향성을 확인한다."
        }
      ],
      "scoring": {
        "correctChoiceId": "3"
      }
    },
    {
      "id": "필기19",
      "type": "single_choice",
      "prompt": "현장 검사 중 동일한 부품에서 불량이 연속으로 3장 이상 발생했다. 검사원이 취해야 할 가장 올바른 행동은?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "생산을 멈추지 않고 불량 기판만 계속 따로 모아둔다."
        },
        {
          "id": "2",
          "text": "즉시 라인 조장이나 품질 담당자에게 알리고 인쇄 상태 및 마운터 장비를 점검하도록 피드백한다."
        },
        {
          "id": "3",
          "text": "장비 조작이 귀찮으므로 교대 시간까지 기다렸다가 보고한다."
        },
        {
          "id": "4",
          "text": "불량이 발생한 해당 부품을 조각 폐기한 후 계속 검사한다."
        }
      ],
      "scoring": {
        "correctChoiceId": "2"
      }
    },
    {
      "id": "필기20",
      "type": "single_choice",
      "prompt": "리플로우 후 패드 주변에 불필요하게 흩어지는 미세한 납 알갱이들을 무엇이라 하는가?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "납볼"
        },
        {
          "id": "2",
          "text": "소납"
        },
        {
          "id": "3",
          "text": "플럭스"
        },
        {
          "id": "4",
          "text": "과납"
        }
      ],
      "scoring": {
        "correctChoiceId": "1"
      }
    },
    {
      "id": "필기21",
      "type": "single_choice",
      "prompt": "작업자가 검사 기준이 애매하다고 느낄 때 가장 올바른 행동은?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "본인 판단으로 정상 처리한다."
        },
        {
          "id": "2",
          "text": "경험이 많은 동료에게만 물어보고 기록 없이 진행한다."
        },
        {
          "id": "3",
          "text": "기준서 확인 후 품질 담당자 또는 관리자에게 확인 요청한다."
        },
        {
          "id": "4",
          "text": "전량 불량 처리한다."
        }
      ],
      "scoring": {
        "correctChoiceId": "3"
      }
    },
    {
      "id": "필기22",
      "type": "single_choice",
      "prompt": "검사 중 동일 위치에서 불량이 반복 발생할 때 올바른 행동은?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "반복되는 불량이므로 익숙하게 계속 검사한다."
        },
        {
          "id": "2",
          "text": "발생 위치와 내용을 확인하여 즉시 조장 또는 품질 담당자에게 피드백한다."
        },
        {
          "id": "3",
          "text": "불량품만 따로 모으고 생산은 계속 진행한다."
        },
        {
          "id": "4",
          "text": "교대 시간까지 기다렸다가 인수인계한다."
        }
      ],
      "scoring": {
        "correctChoiceId": "2"
      }
    },
    {
      "id": "필기23",
      "type": "single_choice",
      "prompt": "작업자가 제품을 떨어뜨렸을 때 가장 올바른 조치는?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "외관상 이상이 없으면 그대로 적재한다."
        },
        {
          "id": "2",
          "text": "AOI만 다시 통과시키고 정상 처리한다."
        },
        {
          "id": "3",
          "text": "떨어뜨린 제품임을 식별하고 기준에 따라 보고 및 처리한다."
        },
        {
          "id": "4",
          "text": "다른 제품 사이에 넣어 둔다."
        }
      ],
      "scoring": {
        "correctChoiceId": "3"
      }
    },
    {
      "id": "필기24",
      "type": "single_choice",
      "prompt": "제품 취급 시 작업자가 지켜야 할 올바른 행동은?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "PCB 중앙 부위를 강하게 잡는다."
        },
        {
          "id": "2",
          "text": "부품이 실장된 부분을 손으로 눌러 잡는다."
        },
        {
          "id": "3",
          "text": "PCB 좌우 또는 모서리를 가볍게 잡고 충격을 주지 않는다."
        },
        {
          "id": "4",
          "text": "빠른 작업을 위해 여러 장을 한 손으로 잡는다."
        }
      ],
      "scoring": {
        "correctChoiceId": "3"
      }
    },
    {
      "id": "필기25",
      "type": "single_choice",
      "prompt": "작업대 위 정리 상태로 가장 올바른 것은?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "검사 중인 제품, 불량품, 개인 물품을 함께 둔다."
        },
        {
          "id": "2",
          "text": "필요한 공구와 제품만 정해진 위치에 두고 불필요한 물품은 제거한다."
        },
        {
          "id": "3",
          "text": "자주 쓰는 컵과 비닐봉지는 PCB 옆에 둔다."
        },
        {
          "id": "4",
          "text": "불량품은 작업대 빈 곳에 올려둔다."
        }
      ],
      "scoring": {
        "correctChoiceId": "2"
      }
    },
    {
      "id": "필기26",
      "type": "single_choice",
      "prompt": "작업자가 제전복, 제전화, 제전모를 착용해야 하는 이유로 가장 적절한 것은?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "작업복 색상을 통일하기 위해"
        },
        {
          "id": "2",
          "text": "정전기와 이물로 인한 제품 손상을 줄이기 위해"
        },
        {
          "id": "3",
          "text": "작업 속도를 빠르게 하기 위해"
        },
        {
          "id": "4",
          "text": "검사 수량을 자동으로 늘리기 위해"
        }
      ],
      "scoring": {
        "correctChoiceId": "2"
      }
    },
    {
      "id": "필기27",
      "type": "single_choice",
      "prompt": "ESD 관리 구역에서 작업자가 하지 말아야 할 행동은?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "PCB를 제전 박스에 담아 이동한다."
        },
        {
          "id": "2",
          "text": "제전복과 제전화를 착용한다."
        },
        {
          "id": "3",
          "text": "일반 비닐봉지나 플라스틱 용기를 PCB 가까이에 둔다."
        },
        {
          "id": "4",
          "text": "제전 매트 상태를 확인한다."
        }
      ],
      "scoring": {
        "correctChoiceId": "3"
      }
    },
    {
      "id": "필기28",
      "type": "single_choice",
      "prompt": "검사 완료품을 BOX에 적재할 때 올바른 행동은?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "방향과 수량을 확인하며 정해진 방식으로 적재한다."
        },
        {
          "id": "2",
          "text": "빠르게 넣기 위해 방향은 신경 쓰지 않는다."
        },
        {
          "id": "3",
          "text": "BOX 안에 이물이 있어도 제품으로 덮는다."
        },
        {
          "id": "4",
          "text": "마지막 수량 확인은 생략한다."
        }
      ],
      "scoring": {
        "correctChoiceId": "1"
      }
    },
    {
      "id": "필기29",
      "type": "single_choice",
      "prompt": "BOX 내부에 먼지나 이물이 보일 때 작업자가 해야 할 행동은?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "제품을 넣으면 보이지 않으므로 그대로 사용한다."
        },
        {
          "id": "2",
          "text": "손으로 대충 밀어 넣고 적재한다."
        },
        {
          "id": "3",
          "text": "이물을 제거하거나 깨끗한 BOX로 교체 후 사용한다."
        },
        {
          "id": "4",
          "text": "불량품 BOX로만 사용한다."
        }
      ],
      "scoring": {
        "correctChoiceId": "3"
      }
    },
    {
      "id": "필기30",
      "type": "single_choice",
      "prompt": "작업자가 검사 결과를 기록할 때 가장 올바른 행동은?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "실제 검사 결과와 수량을 정확히 기록한다."
        },
        {
          "id": "2",
          "text": "전 작업자의 기록을 그대로 복사한다."
        },
        {
          "id": "3",
          "text": "불량 수량은 기록하지 않는다."
        },
        {
          "id": "4",
          "text": "수량이 맞지 않아도 대략 입력한다."
        }
      ],
      "scoring": {
        "correctChoiceId": "1"
      }
    },
    {
      "id": "필기31",
      "type": "single_choice",
      "prompt": "검사 기록을 임의로 수정하면 안 되는 이유는?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "기록지가 지저분해지기 때문에"
        },
        {
          "id": "2",
          "text": "품질 이력 추적과 원인 분석이 어려워질 수 있기 때문에"
        },
        {
          "id": "3",
          "text": "작업 시간이 늘어나기 때문에"
        },
        {
          "id": "4",
          "text": "BOX 적재가 어려워지기 때문에"
        }
      ],
      "scoring": {
        "correctChoiceId": "2"
      }
    },
    {
      "id": "필기32",
      "type": "single_choice",
      "prompt": "작업자가 모델 변경 후 가장 먼저 확인해야 할 사항은?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "작업자의 휴식 시간"
        },
        {
          "id": "2",
          "text": "모델명, 프로그램, 자재, 검사 기준, 적재 방향"
        },
        {
          "id": "3",
          "text": "작업복 색상"
        },
        {
          "id": "4",
          "text": "작업대 높이"
        }
      ],
      "scoring": {
        "correctChoiceId": "2"
      }
    },
    {
      "id": "필기33",
      "type": "single_choice",
      "prompt": "AOI 장비의 모델 프로그램을 선택할 때 올바른 행동은?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "이전 모델 프로그램을 그대로 사용한다."
        },
        {
          "id": "2",
          "text": "제품 모델명과 장비 프로그램명이 일치하는지 확인한다."
        },
        {
          "id": "3",
          "text": "장비가 자동으로 맞추므로 확인하지 않는다."
        },
        {
          "id": "4",
          "text": "불량이 적게 나오는 프로그램을 선택한다."
        }
      ],
      "scoring": {
        "correctChoiceId": "2"
      }
    },
    {
      "id": "필기34",
      "type": "single_choice",
      "prompt": "작업자가 제품을 빠르게 처리하기 위해 생략하면 안 되는 행동은?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "제품 방향 확인"
        },
        {
          "id": "2",
          "text": "정상품과 불량품 구분"
        },
        {
          "id": "3",
          "text": "검사 결과 기록"
        },
        {
          "id": "4",
          "text": "위 항목 모두"
        }
      ],
      "scoring": {
        "correctChoiceId": "4"
      }
    },
    {
      "id": "필기35",
      "type": "single_choice",
      "prompt": "작업자가 임의로 제품을 수리하면 안 되는 이유는?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "수리 이력 누락과 추가 불량 발생 가능성이 있기 때문에"
        },
        {
          "id": "2",
          "text": "제품 외관이 좋아지기 때문에"
        },
        {
          "id": "3",
          "text": "검사 시간이 단축되기 때문에"
        },
        {
          "id": "4",
          "text": "정상품 수량이 자동으로 늘어나기 때문에"
        }
      ],
      "scoring": {
        "correctChoiceId": "1"
      }
    },
    {
      "id": "필기36",
      "type": "single_choice",
      "prompt": "불량품을 보관할 때 올바른 행동은?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "정상품과 섞이지 않도록 식별 후 지정 장소에 보관한다."
        },
        {
          "id": "2",
          "text": "작업대 빈 공간에 올려둔다."
        },
        {
          "id": "3",
          "text": "수량이 부족하면 정상품 BOX에 넣는다."
        },
        {
          "id": "4",
          "text": "불량 내용은 기억하고 Tag는 붙이지 않는다."
        }
      ],
      "scoring": {
        "correctChoiceId": "1"
      }
    },
    {
      "id": "필기37",
      "type": "single_choice",
      "prompt": "작업자가 자리를 비울 때 올바른 행동은?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "검사 중인 제품 상태를 구분하고 필요 시 인수인계한다."
        },
        {
          "id": "2",
          "text": "작업 중인 제품을 그대로 흩어 놓는다."
        },
        {
          "id": "3",
          "text": "장비 알람을 꺼두고 이동한다."
        },
        {
          "id": "4",
          "text": "불량품과 정상품을 한곳에 모아 둔다."
        }
      ],
      "scoring": {
        "correctChoiceId": "1"
      }
    },
    {
      "id": "필기38",
      "type": "single_choice",
      "prompt": "자재가 평소와 다르거나 의심될 때 작업자가 해야 할 행동은?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "비슷해 보이면 그대로 사용한다."
        },
        {
          "id": "2",
          "text": "자재 식별 정보를 확인하고 담당자에게 확인 요청한다."
        },
        {
          "id": "3",
          "text": "먼저 사용하고 나중에 보고한다."
        },
        {
          "id": "4",
          "text": "수량만 맞으면 사용한다."
        }
      ],
      "scoring": {
        "correctChoiceId": "2"
      }
    },
    {
      "id": "필기39",
      "type": "single_choice",
      "prompt": "작업 중 설비나 지그에 이상이 의심될 때 올바른 행동은?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "임의로 분해하여 수리한다."
        },
        {
          "id": "2",
          "text": "이상 내용을 확인하고 담당자에게 보고한다."
        },
        {
          "id": "3",
          "text": "제품만 정상으로 보이면 계속 사용한다."
        },
        {
          "id": "4",
          "text": "다른 작업자 몰래 사용한다."
        }
      ],
      "scoring": {
        "correctChoiceId": "2"
      }
    },
    {
      "id": "필기40",
      "type": "single_choice",
      "prompt": "작업 표준과 실제 작업 방법이 다를 때 가장 올바른 행동은?",
      "score": 2.5,
      "choices": [
        {
          "id": "1",
          "text": "작업자가 편한 방법으로 계속 진행한다."
        },
        {
          "id": "2",
          "text": "표준을 무시하고 생산 수량을 우선한다."
        },
        {
          "id": "3",
          "text": "즉시 관리자에게 확인하고 승인된 방법으로 작업한다."
        },
        {
          "id": "4",
          "text": "다음 주에 보고한다."
        }
      ],
      "scoring": {
        "correctChoiceId": "3"
      }
    }
  ]
};

// ---- src/report.js ----
const REPORT_SCHEMA_VERSION = 2;
const LEGACY_CSV_FIXED_HEADERS = ["리포트 버전", "생성일시", "시험 ID", "시험 제목", "합격 점수", "응시일시", "성명", "사번", "부서", "점수", "만점", "합격 여부"];
const CSV_FIXED_HEADERS = ["리포트 버전", "생성일시", "시험 ID", "시험 버전", "시험 제목", "합격 점수", "응시 ID", "응시일시", "성명", "사번", "부서", "점수", "만점", "합격 여부"];
const QUESTION_HEADER_PREFIX = "문항 결과 ";
const STATUS_LABELS = { correct: "정답", incorrect: "오답", unanswered: "미응답", review_required: "검토 필요" };
const STATUS_VALUES = new Map(Object.entries(STATUS_LABELS).map(([value, label]) => [label, value]));
const REPORT_MODES = new Set(["allAttempts", "latestPerEmployee", "bestPerEmployee"]);

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

function selectReportRecords(records, mode = "allAttempts") {
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

function buildExamReport(exam, records, mode = "latestPerEmployee") {
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

  const questionStats = getQuestionDefinitions(exam, selectedRecords).map((question) => {
    let attemptCount = 0;
    let wrongCount = 0;
    for (const record of selectedRecords) {
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

function makeAttemptRecord(candidate, result, exam) {
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

function createReportCsv(exam, records, generatedAt = new Date().toISOString()) {
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

function parseReportCsv(text) {
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

// ---- src/report-storage.js ----
const REPORT_STORAGE_PREFIX = "exam-report:";
const STORAGE_WARNING_RECORDS = 1_000;
const STORAGE_WARNING_BYTES = 2 * 1024 * 1024;

function getExamReportStorageKey(examId, revision = 1) {
  return `${REPORT_STORAGE_PREFIX}${examId}:${revision}`;
}

function getLegacyExamReportStorageKey(examId) {
  return `${REPORT_STORAGE_PREFIX}${examId}`;
}

function readStoredValue(storage, key) {
  try {
    return storage?.getItem(key) || "";
  } catch {
    return "";
  }
}

function readLegacyJsonRecords(value) {
  try {
    const records = JSON.parse(value);
    return Array.isArray(records) ? records : [];
  } catch {
    return [];
  }
}

function reportMatchesExam(report, exam) {
  const reportQuestions = report.questionStats.map(({ questionId, prompt }) => [questionId, prompt]);
  const examQuestions = exam.questions.map(({ id, prompt }) => [id, prompt]);
  return report.examId === exam.id
    && report.examRevision === (exam.revision ?? 1)
    && report.examTitle === exam.title
    && report.passingScore === (exam.passingScore ?? 80)
    && JSON.stringify(reportQuestions) === JSON.stringify(examQuestions);
}

function migrateLegacyStorage(storage, exam) {
  if (!storage || (exam.revision ?? 1) !== 1) return "";
  const legacyKey = getLegacyExamReportStorageKey(exam.id);
  const value = readStoredValue(storage, legacyKey);
  if (!value) return "";

  let csv = value;
  if (value.trimStart().startsWith("[")) csv = createReportCsv(exam, readLegacyJsonRecords(value));
  else {
    try {
      const report = parseReportCsv(value);
      if (!reportMatchesExam(report, exam)) return "";
      csv = createReportCsv(exam, report.attempts);
    } catch {
      return "";
    }
  }

  try {
    storage.setItem(getExamReportStorageKey(exam.id, exam.revision), csv);
    storage.removeItem(legacyKey);
    return csv;
  } catch {
    return value;
  }
}

function readExamValue(storage, exam) {
  const key = getExamReportStorageKey(exam.id, exam.revision);
  return readStoredValue(storage, key) || migrateLegacyStorage(storage, exam);
}

function readExamReportCsv(storage, exam) {
  const value = readExamValue(storage, exam);
  if (!value || value.trimStart().startsWith("[")) return "";
  try {
    const report = parseReportCsv(value);
    return reportMatchesExam(report, exam) ? value : "";
  } catch {
    return "";
  }
}

function readExamReportRecords(storage, exam) {
  const value = readExamValue(storage, exam);
  if (!value) return [];
  if (value.trimStart().startsWith("[")) return readLegacyJsonRecords(value);
  try {
    const report = parseReportCsv(value);
    return reportMatchesExam(report, exam) ? report.attempts : [];
  } catch {
    return [];
  }
}

function storageErrorType(error) {
  if (error?.name === "QuotaExceededError") return "quota_exceeded";
  if (error?.name === "SecurityError") return "access_denied";
  return "storage_unavailable";
}

function getReportStorageUsage(csv, recordCount) {
  const bytes = new TextEncoder().encode(csv).byteLength;
  return {
    bytes,
    recordCount,
    warning: recordCount >= STORAGE_WARNING_RECORDS || bytes >= STORAGE_WARNING_BYTES
  };
}

function writeExamReportRecords(storage, exam, records, generatedAt) {
  const csv = createReportCsv(exam, records, generatedAt);
  const usage = getReportStorageUsage(csv, records.length);
  if (!storage) return { csv, stored: false, errorType: "storage_unavailable", usage };
  try {
    storage.setItem(getExamReportStorageKey(exam.id, exam.revision), csv);
    return { csv, stored: true, errorType: null, usage };
  } catch (error) {
    return { csv, stored: false, errorType: storageErrorType(error), usage };
  }
}

function appendExamReportRecord(storage, exam, record, generatedAt) {
  const records = readExamReportRecords(storage, exam);
  records.push(record);
  const state = writeExamReportRecords(storage, exam, records, generatedAt);
  return { records, ...state };
}

function clearExamReportRecords(storage, examId, revision = 1) {
  if (!storage) return false;
  try {
    storage.removeItem(getExamReportStorageKey(examId, revision));
    if (revision === 1) storage.removeItem(getLegacyExamReportStorageKey(examId));
    return true;
  } catch {
    return false;
  }
}

function clearAllExamReportRecords(storage) {
  if (!storage) return { cleared: false, count: 0 };
  try {
    const keys = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(REPORT_STORAGE_PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
    return { cleared: true, count: keys.length };
  } catch {
    return { cleared: false, count: 0 };
  }
}

// ---- src/report-file-storage.js ----
const REPORT_ROOT_DIRECTORY = "exam-reports";

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function sanitizeFileSegment(value, fallback = "unknown") {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 80);
  return normalized || fallback;
}

function candidateIdentity(record) {
  return record.candidate?.employeeId?.trim() || record.candidate?.name?.trim() || record.attemptId || "unknown";
}

function getCandidateReportFilename(record) {
  const identity = candidateIdentity(record);
  const label = sanitizeFileSegment(record.candidate?.employeeId || record.candidate?.name, "candidate");
  return `${label}-${stableHash(identity)}.csv`;
}

async function getReportRevisionDirectory(storageManager, exam, create) {
  if (!storageManager?.getDirectory) throw new Error("origin_private_file_system_unavailable");
  const root = await storageManager.getDirectory();
  const reports = await root.getDirectoryHandle(REPORT_ROOT_DIRECTORY, { create });
  const examDirectoryName = `${sanitizeFileSegment(exam.id, "exam")}-${stableHash(exam.id)}`;
  const examDirectory = await reports.getDirectoryHandle(examDirectoryName, { create });
  return examDirectory.getDirectoryHandle(`revision-${exam.revision ?? 1}`, { create });
}

async function writeTextFile(directory, filename, contents) {
  const file = await directory.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  await writable.write(contents);
  await writable.close();
}

async function readCandidateIndex(directory) {
  try {
    const handle = await directory.getFileHandle("index.json");
    const file = await handle.getFile();
    const value = JSON.parse(await file.text());
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

async function persistReportFiles(storageManager, exam, records, aggregateCsv = createReportCsv(exam, records)) {
  try {
    const revisionDirectory = await getReportRevisionDirectory(storageManager, exam, true);
    const candidatesDirectory = await revisionDirectory.getDirectoryHandle("candidates", { create: true });
    const latestRecord = records.at(-1);
    if (!latestRecord) return { stored: false, errorType: "empty_records", paths: [] };

    const recordsByCandidate = new Map();
    for (const record of records) {
      const identity = candidateIdentity(record);
      if (!recordsByCandidate.has(identity)) recordsByCandidate.set(identity, []);
      recordsByCandidate.get(identity).push(record);
    }
    const candidateIndex = await readCandidateIndex(candidatesDirectory);
    const candidateWrites = [];
    const writtenCandidatePaths = [];
    for (const candidateRecords of recordsByCandidate.values()) {
      const lastRecord = candidateRecords.at(-1);
      const filename = getCandidateReportFilename(lastRecord);
      if (candidateIndex[filename] === lastRecord.attemptId) continue;
      candidateWrites.push(writeTextFile(candidatesDirectory, filename, createReportCsv(exam, candidateRecords)));
      candidateIndex[filename] = lastRecord.attemptId;
      writtenCandidatePaths.push(filename);
    }
    await Promise.all([
      writeTextFile(revisionDirectory, "all-attempts.csv", aggregateCsv),
      ...candidateWrites
    ]);
    await writeTextFile(candidatesDirectory, "index.json", JSON.stringify(candidateIndex, null, 2));
    const basePath = `${REPORT_ROOT_DIRECTORY}/${sanitizeFileSegment(exam.id, "exam")}-${stableHash(exam.id)}/revision-${exam.revision ?? 1}`;
    return {
      stored: true,
      errorType: null,
      paths: [`${basePath}/all-attempts.csv`, ...writtenCandidatePaths.map((filename) => `${basePath}/candidates/${filename}`)]
    };
  } catch (error) {
    return { stored: false, errorType: error?.message || "file_storage_unavailable", paths: [] };
  }
}

async function clearReportFiles(storageManager, exam) {
  try {
    const root = await storageManager.getDirectory();
    const reports = await root.getDirectoryHandle(REPORT_ROOT_DIRECTORY);
    const examDirectoryName = `${sanitizeFileSegment(exam.id, "exam")}-${stableHash(exam.id)}`;
    const examDirectory = await reports.getDirectoryHandle(examDirectoryName);
    await examDirectory.removeEntry(`revision-${exam.revision ?? 1}`, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

async function clearAllReportFiles(storageManager) {
  try {
    const root = await storageManager.getDirectory();
    await root.removeEntry(REPORT_ROOT_DIRECTORY, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

// ---- src/app.js ----
const viewIds = ["load-view", "converter-view", "ready-view", "exam-view", "result-view", "report-view"];
const views = viewIds.map((id) => document.getElementById(id));
const fileInput = document.getElementById("exam-file");
const fileError = document.getElementById("file-error");
const timer = document.getElementById("timer");
const liveStatus = document.getElementById("live-status");
const submitDialog = document.getElementById("submit-dialog");
const reportStorage = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();
let exam = null;
let publicExam = null;
let attempt = null;
let candidate = null;
let currentQuestionIndex = 0;
let timerId = null;
let deadline = null;
let reportMode = "latestPerEmployee";

function showView(id) {
  for (const view of views) view.hidden = view.id !== id;
  window.scrollTo({ top: 0, behavior: "instant" });
}

function announce(message) {
  liveStatus.textContent = "";
  requestAnimationFrame(() => { liveStatus.textContent = message; });
}

function formatDuration(minutes) {
  return minutes === 0 ? "시간 제한 없음" : `${minutes}분`;
}

function showCurrentExamReady() {
  if (!exam) return;
  attempt = new Attempt(exam);
  candidate = null;
  currentQuestionIndex = 0;
  document.getElementById("exam-title").textContent = publicExam.title;
  const passingScore = exam.passingScore ?? getMaxScore(exam) * 0.8;
  document.getElementById("exam-meta").textContent = `버전 ${publicExam.revision} · ${publicExam.questions.length}문항 · ${formatDuration(publicExam.durationMinutes)} · 합격 ${passingScore}점 이상`;
  document.getElementById("exam-instructions").textContent = publicExam.instructions || "별도 유의사항이 없습니다.";
  document.getElementById("candidate-form").reset();
  updateHistoryStorageSummary();
  const storedRecords = getStoredRecords();
  if (storedRecords.length > 0) void persistReportFiles(navigator.storage, exam, storedRecords);
  showView("ready-view");
  document.getElementById("exam-title").focus({ preventScroll: true });
}

function prepareExam(nextExam) {
  exam = structuredClone(nextExam);
  publicExam = toPublicExam(exam);
  showCurrentExamReady();
}

function showExamSelection() {
  if (timerId) clearInterval(timerId);
  timerId = null;
  timer.hidden = true;
  attempt = null;
  candidate = null;
  fileInput.value = "";
  const currentExamPanel = document.getElementById("current-exam-panel");
  currentExamPanel.hidden = !exam;
  if (exam) document.getElementById("current-exam-summary").textContent = `${exam.title} · 버전 ${exam.revision} · ${exam.questions.length}문항`;
  showView("load-view");
}

async function loadSelectedFile(file) {
  fileError.hidden = true;
  if (!file) return;
  try {
    if (file.size > MAX_FILE_BYTES) throw new Error(`시험지 파일은 ${MAX_FILE_BYTES / 1024 / 1024}MB 이하여야 합니다.`);
    prepareExam(parseExamJson(await file.text()));
  } catch (error) {
    fileError.textContent = error instanceof Error ? error.message : "시험지를 열 수 없습니다.";
    fileError.hidden = false;
    fileInput.value = "";
  }
}

function renderQuestionNavigation() {
  const list = document.getElementById("question-list");
  list.replaceChildren(...publicExam.questions.map((question, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    const answered = attempt.isAnswered(question.id);
    button.type = "button";
    button.textContent = String(index + 1);
    button.classList.toggle("active", index === currentQuestionIndex);
    button.classList.toggle("answered", answered);
    button.setAttribute("aria-label", `${index + 1}번 문항${answered ? ", 응답 완료" : ", 미응답"}`);
    button.setAttribute("aria-current", index === currentQuestionIndex ? "step" : "false");
    button.addEventListener("click", () => renderQuestion(index));
    item.append(button);
    return item;
  }));
}

function buildChoice(question, choice, inputType, selected) {
  const label = document.createElement("label");
  label.className = "choice";
  const input = document.createElement("input");
  input.type = inputType;
  input.name = "answer";
  input.value = choice.id;
  input.checked = selected;
  input.addEventListener("change", () => {
    if (inputType === "radio") attempt.setAnswer(question.id, input.value);
    else {
      const selectedIds = [...document.querySelectorAll('#answer-form input[type="checkbox"]:checked')].map((element) => element.value);
      attempt.setAnswer(question.id, selectedIds);
    }
    updateProgress();
  });
  const text = document.createElement("span");
  text.textContent = choice.text;
  label.append(input, text);
  return label;
}

function renderQuestion(index, focus = true) {
  currentQuestionIndex = index;
  const question = publicExam.questions[index];
  const value = attempt.getAnswer(question.id);
  document.getElementById("question-number").textContent = `QUESTION ${String(index + 1).padStart(2, "0")}`;
  document.getElementById("question-score").textContent = `${question.score}점`;
  const heading = document.getElementById("question-heading");
  heading.textContent = question.prompt;
  const form = document.getElementById("answer-form");
  form.replaceChildren();
  if (question.type === "short_answer") {
    const label = document.createElement("label");
    label.className = "visually-hidden";
    label.htmlFor = "short-answer-input";
    label.textContent = "단답형 답안";
    const input = document.createElement("input");
    input.id = "short-answer-input";
    input.className = "short-answer";
    input.type = "text";
    input.value = value;
    input.placeholder = "답안을 입력하세요";
    input.maxLength = 10_000;
    input.addEventListener("input", () => { attempt.setAnswer(question.id, input.value); updateProgress(); });
    form.append(label, input);
  } else {
    const inputType = question.type === "single_choice" ? "radio" : "checkbox";
    for (const choice of question.choices) {
      const selected = Array.isArray(value) ? value.includes(choice.id) : value === choice.id;
      form.append(buildChoice(question, choice, inputType, selected));
    }
  }
  document.getElementById("previous-button").disabled = index === 0;
  document.getElementById("next-button").disabled = index === publicExam.questions.length - 1;
  renderQuestionNavigation();
  if (focus) heading.focus();
}

function updateProgress() {
  const answered = publicExam.questions.length - attempt.unansweredCount;
  document.getElementById("answered-count").textContent = String(answered);
  document.getElementById("question-count").textContent = String(publicExam.questions.length);
  document.getElementById("submit-summary").textContent = attempt.unansweredCount === 0 ? "모든 문항에 응답했습니다." : `미응답 ${attempt.unansweredCount}문항`;
  renderQuestionNavigation();
}

function startTimer() {
  if (publicExam.durationMinutes === 0) return;
  deadline = performance.now() + publicExam.durationMinutes * 60_000;
  timer.hidden = false;
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
    timer.textContent = `남은 시간 ${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`;
    if (remaining === 0) {
      clearInterval(timerId);
      announce("시험 시간이 만료되었습니다.");
      if (exam.expirationPolicy === "auto_submit") finalizeSubmission();
      else openSubmitDialog("시험 시간이 만료되었습니다. 현재 답안을 제출해 주세요.");
    }
  };
  tick();
  timerId = setInterval(tick, 250);
}

function openSubmitDialog(message) {
  document.getElementById("submit-dialog-copy").textContent = message ?? (attempt.unansweredCount === 0 ? "모든 문항에 응답했습니다." : `아직 답하지 않은 문항이 ${attempt.unansweredCount}개 있습니다.`);
  submitDialog.showModal();
}

function statusLabel(status) {
  return { correct: "정답", incorrect: "오답", unanswered: "미응답", review_required: "검토 필요" }[status];
}

function getStoredRecords() {
  return readExamReportRecords(reportStorage, exam);
}

function storeResult(result) {
  return appendExamReportRecord(reportStorage, exam, makeAttemptRecord(candidate, result, exam));
}

function renderReportData(report, target = "result") {
  const prefix = target === "result" ? "report" : "loaded-report";
  document.getElementById(`${prefix}-count`).textContent = `선택 ${report.examineeCount}건 · 전체 ${report.totalAttemptCount}건 · 고유 ${report.uniqueExamineeCount}명`;
  document.getElementById(`${prefix}-version`).textContent = `시험 ID ${report.examId} · 버전 ${report.examRevision}`;
  document.getElementById(`${prefix}-average`).textContent = `${report.averageScore}점`;
  document.getElementById(`${prefix}-pass-rate`).textContent = `${report.passRate}% (${report.passedCount}명)`;
  const summary = document.getElementById(`${prefix}-wrong-summary`);
  if (report.highWrongRate.length === 0) summary.textContent = "현재 오답이 집계된 문항이 없습니다.";
  else summary.replaceChildren(...report.highWrongRate.map((item) => {
    const card = document.createElement("div");
    const label = item.questionNumber ? `${item.questionNumber}번` : item.questionId;
    const name = document.createElement("span");
    name.textContent = label;
    name.title = item.prompt || item.questionId;
    const rate = document.createElement("strong");
    rate.textContent = `${item.wrongRate}%`;
    const count = document.createElement("small");
    count.textContent = `${item.wrongCount}/${item.attemptCount}명 오답`;
    card.append(name, rate, count);
    return card;
  }));
  document.getElementById(`${prefix}-body`).replaceChildren(...report.attempts.slice().reverse().map((record) => {
    const row = document.createElement("tr");
    const values = [new Date(record.submittedAt).toLocaleString("ko-KR"), record.candidate.name, record.candidate.employeeId, record.candidate.department || "-", `${record.score}/${record.maxScore}`, record.passed ? "합격" : "불합격"];
    for (const value of values) { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); }
    row.lastElementChild.className = record.passed ? "status-correct" : "status-incorrect";
    return row;
  }));
}

function renderReport(records) {
  const report = buildExamReport(exam, records, reportMode);
  renderReportData(report);
  return report;
}

function renderResult(result, records) {
  const passed = result.score >= (exam.passingScore ?? result.maxScore * 0.8);
  document.getElementById("candidate-result").textContent = `${candidate.name} · ${candidate.employeeId}${candidate.department ? ` · ${candidate.department}` : ""}`;
  document.getElementById("result-score").textContent = String(result.score);
  document.getElementById("result-max-score").textContent = `/ ${result.maxScore}점`;
  const badge = document.getElementById("pass-badge");
  badge.textContent = passed ? "합격" : "불합격";
  badge.className = passed ? "pass" : "fail";
  const items = result.items.map((item, index) => {
    const li = document.createElement("li");
    const top = document.createElement("div");
    top.className = "result-item-top";
    const title = document.createElement("strong");
    title.textContent = `${index + 1}. ${publicExam.questions[index].prompt}`;
    const status = document.createElement("span");
    status.className = `status-${item.status}`;
    status.textContent = `${statusLabel(item.status)} · ${item.earnedScore}/${item.maxScore}점`;
    top.append(title, status);
    li.append(top);
    return li;
  });
  document.getElementById("result-items").replaceChildren(...items);
  renderReport(records);
  showView("result-view");
  document.getElementById("result-title").focus({ preventScroll: true });
  announce(`채점 완료. ${result.maxScore}점 만점에 ${result.score}점, ${passed ? "합격" : "불합격"}입니다.`);
}

async function finalizeSubmission() {
  if (timerId) clearInterval(timerId);
  timer.hidden = true;
  attempt.submit();
  const result = attempt.grade();
  const reportState = storeResult(result);
  const fileState = await persistReportFiles(navigator.storage, exam, reportState.records, reportState.csv);
  const status = document.getElementById("report-storage-status");
  if (!reportState.stored && !fileState.stored) status.textContent = "자동 저장소에 보관하지 못했습니다. 누적 리포트 CSV 다시 저장을 눌러 파일을 보관하세요.";
  else if (!fileState.stored) status.textContent = "브라우저 기록은 저장했지만 내부 CSV 디렉터리를 사용할 수 없습니다. 필요하면 CSV를 직접 저장하세요.";
  else if (reportState.usage.warning) status.textContent = `내부 CSV 디렉터리 자동 저장 완료 · ${reportState.usage.recordCount}건 · ${formatBytes(reportState.usage.bytes)}. 이전 기록 정리를 권장합니다.`;
  else status.textContent = `저장 창 없이 내부 CSV 디렉터리에 자동 저장했습니다 · ${reportState.usage.recordCount}건 · ${formatBytes(reportState.usage.bytes)}`;
  renderResult(result, reportState.records);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function updateHistoryStorageSummary() {
  const summary = document.getElementById("history-storage-summary");
  if (!summary || !exam) return;
  const records = getStoredRecords();
  const csv = readExamReportCsv(reportStorage, exam) || (records.length ? createReportCsv(exam, records) : "");
  const usage = getReportStorageUsage(csv, records.length);
  summary.textContent = `${exam.title} · 버전 ${exam.revision} · ${records.length}건 · ${formatBytes(usage.bytes)}`;
  document.getElementById("backup-clear-button").disabled = records.length === 0;
}

async function backupAndClearCurrentHistory() {
  const records = getStoredRecords();
  if (records.length === 0) return;
  downloadReport();
  const message = `${exam.title} (ID: ${exam.id}, 버전: ${exam.revision})의 응시 기록 ${records.length}건을 삭제합니다. CSV 다운로드가 시작되었는지 확인하세요. 삭제 후 복구할 수 없습니다.`;
  if (!window.confirm(message)) return;
  const browserCleared = clearExamReportRecords(reportStorage, exam.id, exam.revision);
  const filesCleared = await clearReportFiles(navigator.storage, exam);
  announce(browserCleared || filesCleared ? "현재 시험 기록을 삭제했습니다." : "시험 기록을 삭제하지 못했습니다.");
  updateHistoryStorageSummary();
}

async function clearAllHistory() {
  if (!window.confirm("이 브라우저의 모든 시험 버전 기록을 삭제합니다. 개별 CSV로 백업하지 않은 기록은 복구할 수 없습니다.")) return;
  const result = clearAllExamReportRecords(reportStorage);
  const filesCleared = await clearAllReportFiles(navigator.storage);
  announce(result.cleared || filesCleared ? `시험 기록 저장 키 ${result.count}개와 내부 CSV 디렉터리를 삭제했습니다.` : "전체 시험 기록을 삭제하지 못했습니다.");
  updateHistoryStorageSummary();
}

function downloadJson(data, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
}

function downloadReport(csv = readExamReportCsv(reportStorage, exam) || createReportCsv(exam, getStoredRecords())) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${exam.id}-report.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

fileInput.addEventListener("change", () => loadSelectedFile(fileInput.files[0]));
document.getElementById("report-file").addEventListener("change", async (event) => {
  const input = event.currentTarget;
  const errorBox = document.getElementById("report-file-error");
  const file = input.files[0];
  if (!file) return;
  try {
    if (file.size > MAX_FILE_BYTES) throw new Error(`리포트 파일은 ${MAX_FILE_BYTES / 1024 / 1024}MB 이하여야 합니다.`);
    const report = parseReportCsv(await file.text());
    document.getElementById("loaded-report-title").textContent = report.examTitle;
    document.getElementById("loaded-report-generated-at").textContent = report.generatedAt
      ? `생성일시 ${new Date(report.generatedAt).toLocaleString("ko-KR")}`
      : "";
    renderReportData(report, "loaded");
    errorBox.hidden = true;
    showView("report-view");
    document.getElementById("loaded-report-title").focus({ preventScroll: true });
  } catch (error) {
    errorBox.textContent = error instanceof Error ? error.message : "리포트를 열 수 없습니다.";
    errorBox.hidden = false;
    input.value = "";
  }
});

document.getElementById("home-link").addEventListener("click", (event) => { event.preventDefault(); showExamSelection(); });
document.getElementById("default-exam-button").addEventListener("click", () => prepareExam(defaultExam));
document.getElementById("resume-exam-button").addEventListener("click", showCurrentExamReady);
document.getElementById("show-converter-button").addEventListener("click", () => { showView("converter-view"); document.getElementById("converter-title").focus(); });
document.getElementById("convert-button").addEventListener("click", () => {
  const errorBox = document.getElementById("converter-error");
  try {
    const converted = convertQuestionTable(document.getElementById("converter-source").value, {
      title: document.getElementById("converter-exam-title").value,
      durationMinutes: document.getElementById("converter-duration").value,
      passingScore: document.getElementById("converter-passing-score").value,
      questionCount: document.getElementById("converter-question-count").value
    });
    parseExamJson(JSON.stringify(converted));
    errorBox.hidden = true;
    downloadJson(converted, "converted-exam.json");
  } catch (error) {
    errorBox.textContent = error instanceof Error ? error.message : "문항을 변환할 수 없습니다.";
    errorBox.hidden = false;
  }
});
document.getElementById("candidate-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  candidate = Object.fromEntries(formData);
  attempt.start(); showView("exam-view"); renderQuestion(0); updateProgress(); startTimer();
});
document.getElementById("previous-button").addEventListener("click", () => renderQuestion(currentQuestionIndex - 1));
document.getElementById("next-button").addEventListener("click", () => renderQuestion(currentQuestionIndex + 1));
document.getElementById("submit-button").addEventListener("click", () => openSubmitDialog());
document.getElementById("confirm-submit").addEventListener("click", finalizeSubmission);
document.getElementById("download-button").addEventListener("click", () => downloadReport());
document.getElementById("report-mode").addEventListener("change", (event) => { reportMode = event.currentTarget.value; renderReport(getStoredRecords()); });
document.getElementById("backup-clear-button").addEventListener("click", backupAndClearCurrentHistory);
document.getElementById("clear-all-button").addEventListener("click", clearAllHistory);
document.getElementById("print-button").addEventListener("click", () => window.print());
for (const button of document.querySelectorAll(".select-exam-button")) button.addEventListener("click", showExamSelection);
document.getElementById("restart-exam-button").addEventListener("click", showCurrentExamReady);

})();
