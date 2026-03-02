# Tekton Dashboard (Customized Version)

Tekton Dashboard는 [Tekton Pipelines](https://www.google.com/search?q=https://github.com/tektoncd/pipeline)와 [Tekton Triggers](https://github.com/tektoncd/triggers) 리소스를 관리하기 위한 범용 웹 기반 UI입니다.

**이 저장소는 공식 Tekton Dashboard를 기반으로, 운영 효율성과 사용자 편의를 위해 주요 기능을 커스터마이징한 버전입니다.**

---

## 주요 변경 사항 (Custom Features)

이 커스텀 버전에는 다음과 같은 기능이 수정 및 추가되었습니다.

### 1. 글로벌 대기열(Global Queue) 모니터링 통합

* **기존:** 네임스페이스 내의 개별 PipelineRun 리소스 상태만 확인 가능.
* **변경:** 커스텀 큐 컨트롤러 및 `GlobalLimit` CRD와 연동하여, **클러스터 전체의 파이프라인 동시 실행 쿼터(Limit) 및 대기열(Pending Queue) 현황을 시각적으로 모니터링**할 수 있는 전용 뷰를 추가했습니다. 시스템 과부하 상태와 스케줄링 대기 순번을 한눈에 파악할 수 있습니다.
<img width="1901" height="908" alt="스크린샷 2026-03-02 190526" src="https://github.com/user-attachments/assets/db32c0ce-2721-46b9-883a-c32e557d5e8a" />
🔗 https://github.com/wonjune95/tekton_queue_contoller.git

### 2. 파이프라인 재시작 로직 개선 (Smart Restart)

* **기존:** 'Start' 버튼 클릭 시 기존 리소스를 단순히 재실행.
* **변경:** 'Start' 버튼 클릭 시, 기존 설정을 기반으로 **새로운 PipelineRun 리소스를 생성**하여 실행합니다. 이를 통해 실행 이력을 보존하고 충돌 없이 즉시 재작업을 수행할 수 있습니다.

### 3. 검색 기능 직관화 (Basic Search)

* **기존:** Label 기반의 Key-Value 검색 방식.
* **변경:** 사용자가 더 쉽게 접근할 수 있도록 **일반 텍스트(키워드) 기반 검색** 방식으로 변경했습니다. 복잡한 셀렉터 문법 없이 이름이나 키워드로 리소스를 찾을 수 있습니다.

### 4. 파이프라인 종합 현황판 (Pipeline Status View)

* 전체 파이프라인의 실행 상태와 성공/실패 여부를 한눈에 파악할 수 있는 **시각화된 현황 대시보드**를 추가했습니다.

---

## 기본 기능 (Original Features)

Tekton Dashboard는 기본적으로 다음과 같은 기능을 제공합니다.

* `PipelineRun` 및 `TaskRun`의 실시간 상태 및 로그 조회
* 리소스 라벨 필터링
* 리소스 개요 및 YAML 명세 확인
* 전체 클러스터 조회 또는 특정 네임스페이스(Namespace)로 조회 범위 제한
* Git 리포지토리에서 리소스 직접 가져오기 (Import)
* 확장 프로그램(Extensions)을 통한 기능 추가
<img width="1902" height="907" alt="image" src="https://github.com/user-attachments/assets/02d0051a-64bd-428b-b88a-615c12d1d33d" />


## 문서 및 가이드

* **설치 방법:** [Installing Tekton Dashboard](https://www.google.com/search?q=./install.md)
* **튜토리얼:** ["Getting started" tutorial](https://www.google.com/search?q=./tutorial.md)
* **공식 릴리즈:** [releases](https://github.com/tektoncd/dashboard/blob/main/releases.md)

공식 문서 및 버전별 링크는 [Tekton 웹사이트](https://www.google.com/search?q=https://tekton.dev/docs)에서 확인할 수 있습니다.
