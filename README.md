# Tekton Dashboard (Customized Version)

Tekton Dashboard는 [Tekton Pipelines](https://www.google.com/search?q=https://github.com/tektoncd/pipeline)와 [Tekton Triggers](https://github.com/tektoncd/triggers) 리소스를 관리하기 위한 범용 웹 기반 UI입니다.

**이 저장소는 공식 Tekton Dashboard를 기반으로, 운영 효율성과 사용자 편의를 위해 주요 기능을 커스터마이징한 버전입니다.**

* **Upstream 기준 버전:** [tektoncd/dashboard `v0.72.0`](https://github.com/tektoncd/dashboard/releases/tag/v0.72.0)
* 커스텀 코드는 아래 "주요 변경 사항" 항목이 전부이며, 나머지는 upstream 그대로입니다.
  업스트림 갱신 시 이 파일들만 다시 rebase 하면 됩니다:
  `packages/components/src/components/LabelFilter/LabelFilter.jsx`, `src/api/utils.js`,
  `src/containers/About/About.jsx`, `src/containers/PipelineRuns/PipelineRuns.jsx`,
  `src/containers/ListPageLayout/ListPageLayout.jsx`, `Dockerfile`, `vite.config.js`

### 빌드 요구 사항

`package.json` engines 기준으로 **Node.js 24.16+ / npm 11.9+**, Go 백엔드는 **Go 1.26+** 가 필요합니다.

```sh
npm install
npm run lint && npm test && npm run build
```

---

## 주요 변경 사항 (Custom Features)

이 커스텀 버전에는 다음과 같은 기능이 수정 및 추가되었습니다.

### 1. 파이프라인 재시작 로직 개선 (Smart Restart)

* **기존:** 'Start' 버튼 클릭 시 기존 리소스를 단순히 재실행.
* **변경:** 'Start' 버튼 클릭 시, 기존 설정을 기반으로 **새로운 PipelineRun 리소스를 생성**하여 실행합니다. 이를 통해 실행 이력을 보존하고 충돌 없이 즉시 재작업을 수행할 수 있습니다.

### 2. 검색 기능 직관화 (Basic Search)

* **기존:** Label 기반의 Key-Value 검색 방식.
* **변경:** 사용자가 더 쉽게 접근할 수 있도록 **일반 텍스트(키워드) 기반 검색** 방식으로 변경했습니다. 복잡한 셀렉터 문법 없이 이름이나 키워드로 리소스를 찾을 수 있습니다.

### 3. 파이프라인 종합 현황판 (Pipeline Status View)

* About 페이지 상단에 전체 파이프라인의 실행 상태를 한눈에 파악할 수 있는 **도넛 차트 현황판**을 추가했습니다.
* 네임스페이스(`*-cicd`) 별로 총/실행 중/최근 12시간 실행 건수를 집계하며, 수동 새로고침을 지원합니다.

### 4. 목록 페이지 사이즈 확대

* 기본 페이지 사이즈를 100 → **1000**, 선택 가능한 값을 `[50, 100, 500, 1000]`으로 변경했습니다.

### 5. 배포 관련

* 멀티스테이지 `Dockerfile` (UI 빌드 → Go 빌드 → distroless 런타임) 추가.
* 개발 서버용 `/results-api` 프록시 설정을 `vite.config.js`에 추가.

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

> 참고: 한국어 메시지(`src/nls/messages_ko.json`)는 upstream 공식 번역본을 사용합니다.
> 이전 커스텀 번역본은 일괄 치환 과정에서 메시지 **키**까지 바뀌어 번역이 적용되지 않는 상태였습니다.

공식 문서 및 버전별 링크는 [Tekton 웹사이트](https://www.google.com/search?q=https://tekton.dev/docs)에서 확인할 수 있습니다.
