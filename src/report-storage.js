import { createReportCsv, parseReportCsv } from "./report.js";

export const REPORT_STORAGE_PREFIX = "exam-report:";
const STORAGE_WARNING_RECORDS = 1_000;
const STORAGE_WARNING_BYTES = 2 * 1024 * 1024;

export function getExamReportStorageKey(examId, revision = 1) {
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
  if (report.examId !== exam.id
    || report.examRevision !== (exam.revision ?? 1)
    || report.examTitle !== exam.title
    || report.passingScore !== (exam.passingScore ?? 80)) return false;

  if (!Array.isArray(report.questionStats) || report.questionStats.length !== exam.questions.length) return false;
  return report.questionStats.every((question, index) => {
    const examQuestion = exam.questions[index];
    return question.questionId === examQuestion.id && question.prompt === examQuestion.prompt;
  });
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

export function readExamReportCsv(storage, exam) {
  const value = readExamValue(storage, exam);
  if (!value || value.trimStart().startsWith("[")) return "";
  try {
    const report = parseReportCsv(value);
    return reportMatchesExam(report, exam) ? value : "";
  } catch {
    return "";
  }
}

export function readExamReportRecords(storage, exam) {
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

export function getReportStorageUsage(csv, recordCount) {
  const bytes = new TextEncoder().encode(csv).byteLength;
  return {
    bytes,
    recordCount,
    warning: recordCount >= STORAGE_WARNING_RECORDS || bytes >= STORAGE_WARNING_BYTES
  };
}

export function writeExamReportRecords(storage, exam, records, generatedAt) {
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

export function appendExamReportRecord(storage, exam, record, generatedAt) {
  const records = readExamReportRecords(storage, exam);
  records.push(record);
  const state = writeExamReportRecords(storage, exam, records, generatedAt);
  return { records, ...state };
}

export function clearExamReportRecords(storage, examId, revision = 1) {
  if (!storage) return false;
  try {
    storage.removeItem(getExamReportStorageKey(examId, revision));
    if (revision === 1) storage.removeItem(getLegacyExamReportStorageKey(examId));
    return true;
  } catch {
    return false;
  }
}

export function clearAllExamReportRecords(storage) {
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
