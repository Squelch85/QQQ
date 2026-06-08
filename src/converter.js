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

export function convertQuestionTable(text, options = {}) {
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
    title: options.title || "검사원 평가 시험",
    instructions: options.instructions || "각 문항을 읽고 가장 알맞은 답을 선택하세요.",
    durationMinutes: Number(options.durationMinutes ?? 30),
    expirationPolicy: "confirm",
    showExplanations: false,
    passingScore: Number(options.passingScore ?? 80),
    questions: assignEqualScores(selectedQuestions)
  };
}
