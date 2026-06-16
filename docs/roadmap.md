# 구현 로드맵

## 1단계: 문서 정합성 정리

### 범위

- README와 docs의 제품 정의를 검사원 자격 인증 평가 시스템으로 정리
- SQLite를 원본 저장소로 확정
- CSV를 내보내기, 백업, 외부 제출용 보조 기능으로 재정의
- 평가 유형을 `written_exam`, `attribute_rr`, `variable_rr`, `training_verification`으로 확정
- 사진 기반 판정을 `attribute_rr.sampleMode=image`로 흡수
- 계수형·계량형 R&R 계산 기준과 인증서 발행 차단 조건 문서화
- 관련 ADR 추가

### 완료 조건

- README와 docs 간 저장 방식 설명이 일치한다.
- `image_judgment` 독립 유형을 만들지 않는다는 원칙이 명시된다.
- 문서 변경만 포함하며 구현 코드는 수정하지 않는다.

## 2단계: DB 스키마 초안

### 범위

- `qualification_types`, `assessment_plans`, `assessment_sessions`
- `attribute_rr_sets`, `attribute_rr_samples`, `attribute_rr_trials`, `attribute_rr_results`
- `variable_rr_studies`, `variable_measurements`, `variable_rr_results`
- `training_records`, `certification_decisions`, `certificates`, `audit_logs`
- 기존 필기시험 저장 흐름과의 연결

### 완료 조건

- migration이 재현 가능하다.
- 기존 필기시험 결과 저장 기능이 깨지지 않는다.
- 신규 테이블 생성 테스트가 통과한다.

## 3단계: 계수형 R&R 구현

### 범위

- `attribute_rr` 세트 생성
- 이미지 샘플과 실물 샘플 등록
- OK/NG 판정 화면과 불량 유형 선택
- 반복 샘플 제시와 반복 여부 숨김
- 제출 후 판정 잠금
- 전체 일치율, 1종 오류율, 2종 오류율, 반복 일치율 계산
- 기준 미달 시 인증서 발행 차단 연결

### 완료 조건

- 기준값이 제출 전 노출되지 않는다.
- 결과가 SQLite에 저장된다.
- 고정 테스트 벡터가 통과한다.

## 4단계: 계량형 R&R 구현

### 범위

- `variable_rr` study 생성
- 측정 항목, 계측기, 공차 등록
- 화면 입력과 CSV import
- 입력값 검증
- range 방식 EV, AV, GRR, %GRR, ndc 계산
- 기준 미달 시 인증서 발행 차단 연결

### 완료 조건

- 누락·숫자 오류 검증이 동작한다.
- 계산 공식과 테스트 벡터가 문서화된다.
- 결과가 SQLite에 저장된다.

## 5단계: 인증서 발행 검증

### 범위

- 교육 이수 기록과 증빙 검증
- `validateCertificationReadiness()` 구현
- 자격 유형별 필수 평가 누락 항목 표시
- 승인 전 인증서 발행 차단
- 승인 후 시스템 확정값 기반 인증서 발행
- SHA-256 해시 저장과 재발행·취소 이력 보존

### 완료 조건

- 필수 평가와 증빙 누락 시 인증서 발행이 차단된다.
- 점수와 평가 항목명을 수기 입력할 수 없다.
- 인증서와 SQLite 원본 결과가 일치한다.

## 6단계: 조회 및 리포트

### 범위

- 응시자별, 자격별, R&R별, 교육 누락자, 인증서별 조회
- 인증서 ID 기준 조회
- 재평가 대상 조회
- CSV export

### 완료 조건

- 로컬에서 사번 기준 이력 조회가 가능하다.
- CSV export는 SQLite 원본에서 파생된다.
- 기존 필기시험 MVP 흐름이 깨지지 않는다.
