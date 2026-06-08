export const EXAM_SCHEMA_VERSION = 1;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_QUESTIONS = 500;
export const MAX_TEXT_LENGTH = 10_000;

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

export function validateExam(candidate) {
  const errors = [];
  if (!isObject(candidate)) return { valid: false, errors: ["root: 시험지는 JSON 객체여야 합니다."] };

  if (candidate.schemaVersion !== EXAM_SCHEMA_VERSION) {
    errors.push(`schemaVersion: 지원 버전은 ${EXAM_SCHEMA_VERSION}입니다.`);
  }
  validateText(candidate.id, "id", errors);
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

export function parseExamJson(text) {
  if (typeof text !== "string") throw new TypeError("시험지 내용은 문자열이어야 합니다.");
  if (new Blob([text]).size > MAX_FILE_BYTES) throw new Error(`시험지 파일은 ${MAX_FILE_BYTES / 1024 / 1024}MB 이하여야 합니다.`);

  let candidate;
  try {
    candidate = JSON.parse(text);
  } catch {
    throw new Error("올바른 JSON 형식이 아닙니다.");
  }
  const validation = validateExam(candidate);
  if (!validation.valid) throw new Error(validation.errors.join("\n"));
  return structuredClone(candidate);
}

export function toPublicExam(exam) {
  return {
    id: exam.id,
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

export function getMaxScore(exam) {
  return exam.questions.reduce((total, question) => total + question.score, 0);
}
