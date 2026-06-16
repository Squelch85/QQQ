# 답안·판정·측정값 처리 설계

## 1. 목표

필기 답안, 계수형 R&R 판정값, 계량형 R&R 측정값, 교육 증빙 확인 결과를 제출 또는 확정 시점에 잠그고 SQLite 원본 저장소에 보존한다. 동일 입력은 동일 결과를 생성해야 하며, 제출 전 정답·기준값·채점 규칙은 노출하지 않는다.

## 2. 공통 처리 원칙

- 제출 또는 확정 전 입력값은 로컬 상태로 관리한다.
- 제출 또는 확정 시점의 값을 스냅샷으로 고정한다.
- 고정된 원본은 수정하지 않고 재응시, 재평가, 취소 이력으로 관리한다.
- 원본 저장소는 SQLite다.
- CSV는 계량형 측정값 import 편의와 결과 export/백업 용도로만 사용한다.

## 3. 필기시험 처리

1. 시험지를 읽고 `Exam.revision`과 채점 규칙을 검증한다.
2. 응시자는 객관식 단일 선택, 객관식 복수 선택, 단답형 답안을 입력한다.
3. 제출 시 `Submission.answers_json`을 생성하고 `locked=true`로 저장한다.
4. `gradeSubmission`은 단일 선택, 복수 선택, 단답형 정규화 규칙을 적용해 `GradeResult`를 생성한다.
5. 채점 결과는 자격 평가 세션의 `written_exam` 충족 여부 판단에 사용한다.

## 4. 계수형 R&R 처리

`calculateAttributeRrResult(trials, samples, criteria)`는 순수 함수로 구현한다.

처리 흐름은 다음과 같다.

1. `AttributeRrSet.sampleMode`에 따라 이미지, 실물, 혼합 샘플을 제시한다.
2. 이미지 샘플은 `image_path`와 `image_hash`를 사용하되 기준 OK/NG와 기준 설명은 숨긴다.
3. 응시자는 OK/NG와 필요 시 불량 유형을 입력한다.
4. 반복 샘플 여부는 응시 화면에 표시하지 않는다.
5. 제출 시 `AttributeRrTrial.locked=true`로 판정 원본을 저장한다.
6. 전체 일치율, OK 일치율, NG 검출률, 1종 오류율, 2종 오류율, 반복 일치율, 불량 유형 일치율을 계산한다.
7. 기준 미달 결과는 인증서 발행 차단 사유가 된다.

사진 기반 판정은 독립 시험이 아니라 `attribute_rr`의 `sampleMode=image` 처리다.

## 5. 계량형 R&R 처리

`calculateVariableRrResult(measurements, studyPlan, criteria)`는 순수 함수로 구현한다. 초기 구현은 `range` 방식을 우선한다.

처리 흐름은 다음과 같다.

1. `VariableRrStudy`에서 측정 항목, 단위, 계측기, 공차, 부품 수, 반복 수, 계산 방식을 확인한다.
2. 측정값은 화면 입력 또는 CSV import로 수집한다.
3. 누락, 숫자 형식 오류, 부품·반복 수 불일치를 검증한다.
4. 확정 시 `VariableMeasurement.locked=true`로 SQLite에 저장한다.
5. EV, AV, GRR, %GRR, Part Variation, Total Variation, ndc, 공차 대비 변동을 계산한다.
6. 기준 미달 결과는 인증서 발행 차단 사유가 된다.

## 6. 교육 이수 처리

교육 이수는 `TrainingRecord`로 관리한다. 교육명, 이수 일자, 이수 시간, 증빙 경로, 확인자, 확인 시각, 상태를 저장한다. 필수 교육 누락, 최소 시간 미달, 증빙 누락은 인증서 발행 차단 사유다.

## 7. 자격 판정 처리

`validateCertificationReadiness(assessmentSessionId, qualificationTypeId, examineeId)`는 다음을 반환한다.

```text
decision
missingRequirements
blockingReasons
warnings
```

필수 평가 또는 필수 증빙이 하나라도 미충족이면 `approved`가 될 수 없고 인증서 발행을 차단한다.
