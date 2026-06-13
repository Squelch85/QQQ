const CERTIFICATE_WIDTH = 1600;
const CERTIFICATE_HEIGHT = 900;

function gfMultiply(left, right) {
  let result = 0;
  while (right) {
    if (right & 1) result ^= left;
    left = left & 0x80 ? (left << 1) ^ 0x11d : left << 1;
    right >>= 1;
  }
  return result;
}

function reedSolomon(data, count) {
  let generator = [1];
  let root = 1;
  for (let index = 0; index < count; index += 1) {
    generator = [...generator, 0].map((value, position, values) =>
      value ^ (position ? gfMultiply(values[position - 1], root) : 0));
    root = gfMultiply(root, 2);
  }
  const remainder = Array(count).fill(0);
  for (const value of data) {
    const factor = value ^ remainder.shift();
    remainder.push(0);
    for (let index = 0; index < count; index += 1) remainder[index] ^= gfMultiply(generator[index + 1], factor);
  }
  return remainder;
}

function appendBits(target, value, length) {
  for (let bit = length - 1; bit >= 0; bit -= 1) target.push((value >>> bit) & 1);
}

function makeQrCode(value) {
  const bytes = [...new TextEncoder().encode(value)];
  if (bytes.length > 106) throw new Error("QR 코드 값이 너무 깁니다.");
  const bits = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, 8);
  for (const byte of bytes) appendBits(bits, byte, 8);
  appendBits(bits, 0, Math.min(4, 864 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let index = 0; index < bits.length; index += 8) data.push(Number.parseInt(bits.slice(index, index + 8).join(""), 2));
  for (let pad = 0; data.length < 108; pad += 1) data.push(pad % 2 ? 0x11 : 0xec);
  const codewords = [...data, ...reedSolomon(data, 26)];
  const size = 37;
  const modules = Array.from({ length: size }, () => Array(size).fill(null));

  const setFunction = (row, column, dark) => {
    if (row >= 0 && row < size && column >= 0 && column < size) modules[row][column] = dark;
  };
  const finder = (row, column) => {
    for (let y = -1; y <= 7; y += 1) for (let x = -1; x <= 7; x += 1) {
      const dark = x >= 0 && x <= 6 && y >= 0 && y <= 6
        && (x === 0 || x === 6 || y === 0 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4));
      setFunction(row + y, column + x, dark);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let index = 8; index < size - 8; index += 1) {
    if (modules[6][index] === null) modules[6][index] = index % 2 === 0;
    if (modules[index][6] === null) modules[index][6] = index % 2 === 0;
  }
  for (let y = -2; y <= 2; y += 1) for (let x = -2; x <= 2; x += 1) {
    setFunction(30 + y, 30 + x, Math.max(Math.abs(x), Math.abs(y)) !== 1);
  }
  const format = 0x77c4;
  for (let index = 0; index < 15; index += 1) {
    const dark = ((format >>> index) & 1) !== 0;
    const first = index < 6 ? [index, 8] : index < 8 ? [index + 1, 8] : index === 8 ? [8, 7] : [8, 14 - index];
    const second = index < 8 ? [8, size - index - 1] : [size - 15 + index, 8];
    setFunction(first[0], first[1], dark);
    setFunction(second[0], second[1], dark);
  }
  setFunction(size - 8, 8, true);

  const payload = codewords.flatMap((byte) => Array.from({ length: 8 }, (_, bit) => (byte >>> (7 - bit)) & 1));
  let payloadIndex = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let offset = 0; offset < size; offset += 1) {
      const row = upward ? size - 1 - offset : offset;
      for (let columnOffset = 0; columnOffset < 2; columnOffset += 1) {
        const column = right - columnOffset;
        if (modules[row][column] !== null) continue;
        const raw = payload[payloadIndex++] || 0;
        modules[row][column] = Boolean(raw ^ ((row + column) % 2 === 0));
      }
    }
    upward = !upward;
  }
  return modules;
}

function drawField(context, label, value, x, y) {
  context.fillStyle = "#64748b";
  context.font = "22px sans-serif";
  context.fillText(label, x, y);
  context.fillStyle = "#172033";
  context.font = "bold 28px sans-serif";
  context.fillText(String(value || "-"), x + 145, y);
}

function drawQr(context, value, x, y, size) {
  const modules = makeQrCode(value);
  const quiet = 4;
  const cell = size / (modules.length + quiet * 2);
  context.fillStyle = "#fff";
  context.fillRect(x, y, size, size);
  context.fillStyle = "#111827";
  modules.forEach((row, rowIndex) => row.forEach((dark, columnIndex) => {
    if (dark) context.fillRect(x + (columnIndex + quiet) * cell, y + (rowIndex + quiet) * cell, Math.ceil(cell), Math.ceil(cell));
  }));
}

export async function createCertificatePng(result, verificationUrl) {
  const canvas = document.createElement("canvas");
  canvas.width = CERTIFICATE_WIDTH;
  canvas.height = CERTIFICATE_HEIGHT;
  const context = canvas.getContext("2d");
  context.fillStyle = "#f8fafc";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#17345f";
  context.lineWidth = 12;
  context.strokeRect(30, 30, canvas.width - 60, canvas.height - 60);
  context.strokeStyle = "#c6a15b";
  context.lineWidth = 3;
  context.strokeRect(50, 50, canvas.width - 100, canvas.height - 100);

  context.textAlign = "center";
  context.fillStyle = "#17345f";
  context.font = "bold 54px sans-serif";
  context.fillText("검사원 자격인증 필기평가 인증서", 800, 130);
  context.font = "28px sans-serif";
  context.fillStyle = "#64748b";
  context.fillText("Gauge R&R 이해도 평가", 800, 175);
  context.textAlign = "left";

  drawField(context, "성명", result.employee_name, 120, 250);
  drawField(context, "사번", result.employee_id, 820, 250);
  drawField(context, "부서", result.department, 120, 300);
  drawField(context, "공정명", result.process_name, 820, 300);
  drawField(context, "평가명", result.exam_name, 120, 350);
  drawField(context, "평가일자", result.exam_date.slice(0, 10), 820, 350);
  drawField(context, "시험버전", result.exam_version, 120, 400);
  drawField(context, "문항 수", `${result.total_questions}문항`, 820, 400);
  drawField(context, "취득점수", `${result.score}점`, 120, 450);
  drawField(context, "합격기준", `${result.pass_score}점`, 820, 450);
  drawField(context, "판정 / 등급", `${result.pass_status} / ${result.grade}`, 120, 500);
  drawField(context, "유효기간", `${result.valid_from} ~ ${result.valid_to}`, 820, 500);

  context.fillStyle = "#334155";
  context.font = "23px sans-serif";
  const lines = [
    "상기 인원은 검사원 자격인증을 위한 Gauge R&R 필기평가에서 요구 기준을 충족하였으므로,",
    "측정시스템분석 및 검사 신뢰성 관리에 대한 기본 이해도를 보유하였음을 인증합니다.",
    "본 인증은 필기평가 결과에 대한 인증이며, 최종 자격은 공정 교육·실기평가·관리자 승인 충족 시 부여됩니다.",
    result.cert_status === "LOCAL_ONLY"
      ? "DB 장애로 로컬 발행된 인증서이며 중앙 조회·취소·감사 이력을 제공하지 않습니다."
      : "본 인증서는 검사 인증툴의 원본 평가기록과 인증 ID 조회 결과가 일치할 때 유효합니다."
  ];
  lines.forEach((line, index) => context.fillText(line, 120, 570 + index * 35));
  drawField(context, "평가 담당자", result.evaluator, 120, 750);
  drawField(context, "승인자", result.approver, 620, 750);
  context.fillStyle = "#17345f";
  context.font = "bold 25px monospace";
  context.fillText(`인증 ID  ${result.cert_id}`, 120, 815);
  context.fillStyle = "#64748b";
  context.font = "20px sans-serif";
  context.fillText(`발행일자 ${result.issued_date}`, 830, 815);
  if (verificationUrl) drawQr(context, verificationUrl, 1330, 650, 170);
  else {
    context.fillStyle = "#64748b";
    context.font = "bold 22px sans-serif";
    context.fillText("LOCAL ONLY", 1360, 740);
  }

  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error("PNG 이미지를 만들지 못했습니다.")),
    "image/png"
  ));
}
