const REPORT_STORAGE_PREFIX = "exam-report:";

export function getExamReportStorageKey(examId) {
  return `${REPORT_STORAGE_PREFIX}${examId}`;
}

export function readExamReportRecords(storage, examId) {
  try {
    const records = JSON.parse(storage.getItem(getExamReportStorageKey(examId)) || "[]");
    return Array.isArray(records) ? records : [];
  } catch {
    return [];
  }
}

export function writeExamReportRecords(storage, examId, records) {
  try {
    storage.setItem(getExamReportStorageKey(examId), JSON.stringify(records));
    return true;
  } catch {
    return false;
  }
}

export function appendExamReportRecord(storage, examId, record) {
  const records = readExamReportRecords(storage, examId);
  records.push(record);
  writeExamReportRecords(storage, examId, records);
  return records;
}

export function clearExamReportRecords(storage, examId) {
  try {
    storage.removeItem(getExamReportStorageKey(examId));
    return true;
  } catch {
    return false;
  }
}
