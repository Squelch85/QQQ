import { createReportCsv, parseReportCsv } from "./report.js";

const REPORT_STORAGE_PREFIX = "exam-report:";

export function getExamReportStorageKey(examId) {
  return `${REPORT_STORAGE_PREFIX}${examId}`;
}

function readStoredValue(storage, examId) {
  try {
    return storage?.getItem(getExamReportStorageKey(examId)) || "";
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

export function readExamReportCsv(storage, exam) {
  const value = readStoredValue(storage, exam.id);
  if (!value || value.trimStart().startsWith("[")) return "";
  try {
    const report = parseReportCsv(value);
    return report.examId === exam.id ? value : "";
  } catch {
    return "";
  }
}

export function readExamReportRecords(storage, exam) {
  const value = readStoredValue(storage, exam.id);
  if (!value) return [];
  if (value.trimStart().startsWith("[")) return readLegacyJsonRecords(value);
  try {
    const report = parseReportCsv(value);
    return report.examId === exam.id ? report.attempts : [];
  } catch {
    return [];
  }
}

export function writeExamReportRecords(storage, exam, records, generatedAt) {
  const csv = createReportCsv(exam, records, generatedAt);
  if (!storage) return { csv, stored: false };
  try {
    storage.setItem(getExamReportStorageKey(exam.id), csv);
    return { csv, stored: true };
  } catch {
    return { csv, stored: false };
  }
}

export function appendExamReportRecord(storage, exam, record, generatedAt) {
  const records = readExamReportRecords(storage, exam);
  records.push(record);
  const { csv, stored } = writeExamReportRecords(storage, exam, records, generatedAt);
  return { records, csv, stored };
}

export function clearExamReportRecords(storage, examId) {
  if (!storage) return false;
  try {
    storage.removeItem(getExamReportStorageKey(examId));
    return true;
  } catch {
    return false;
  }
}
