# Tekton Dashboard (Customized Version)

Tekton Dashboard는 [Tekton Pipelines](https://github.com/tektoncd/pipeline)와
[Tekton Triggers](https://github.com/tektoncd/triggers) 리소스를 관리하기 위한 범용 웹 기반 UI입니다.

**이 저장소는 공식 Tekton Dashboard를 기반으로, 운영 효율성과 사용자 편의를 위해 주요 기능을 커스터마이징한 버전입니다.**

| 항목 | 값 |
|---|---|
| Upstream 기준 | [tektoncd/dashboard `v0.72.0`](https://github.com/tektoncd/dashboard/releases/tag/v0.72.0) |
| 배포 버전 | `v0.72.0-custom` |
| 이미지 | `harbor.114-110-181-178.nip.io/nnd/tekton-custom-dashboard:v0.72.0-custom` |

---

## 주요 변경 사항 (Custom Features)

### 1. 파이프라인 재시작 로직 개선 (Smart Restart)

* **기존:** 'Start'는 Pending 상태의 PipelineRun을 실행 대기 해제하는 용도로만 동작.
* **변경:** 'Start' 클릭 시 기존 설정을 기반으로 **새로운 PipelineRun 리소스를 생성**하여 실행합니다.
  실행 이력을 보존하고 충돌 없이 즉시 재작업할 수 있습니다.
* 목록 / 상세 화면 모두 동일하게 동작하며, 액션 메뉴 순서도 **재실행 → 시작 → 편집 및 실행** 으로 통일했습니다.
* 상세 화면에서 실행하면 생성된 새 PipelineRun 링크가 알림으로 표시됩니다.

> TaskRun의 'Start'는 upstream 동작(Pending 해제)을 그대로 유지합니다.

### 2. 검색 기능 직관화 (Basic Search)

* **기존:** Label 기반의 Key-Value 검색만 가능.
* **변경:** 검색창에 **일반 텍스트(키워드)** 를 입력하면 이름·네임스페이스로 즉시 필터링됩니다.
  `labelKey:labelValue` 형식으로 입력하면 기존처럼 라벨 필터가 적용되므로 두 방식을 함께 쓸 수 있습니다.
* 검색 규칙
  * 대소문자 무시
  * 공백으로 나눈 여러 토큰은 **AND** 조건 (`fastapi deploy`)
  * 이름을 `-` `_` `.` `/` 로 분해해 매칭 (`build` → `sample_prod.build/pr`)
  * 구분자를 제거한 형태도 매칭 (`fastapibetest` → `fastapi-be-test-...`)
* 입력 후 400ms 디바운스로 적용되며, 입력을 지우면 즉시 해제됩니다.

### 3. 파이프라인 종합 현황판 (Pipeline Status View)

* About 페이지 상단에 전체 파이프라인 실행 상태를 한눈에 보는 **도넛 차트 현황판**을 추가했습니다.
* 네임스페이스(`*-cicd`) 별로 총 / 실행 중 / 최근 12시간 실행 건수를 집계하며, 수동 새로고침을 지원합니다.

### 4. 목록 페이지 사이즈 확대

* 기본 페이지 사이즈 100 → **1000**, 선택 값 `[50, 100, 500, 1000]`.

### 5. 배포 관련

* 멀티스테이지 `Dockerfile` (UI 빌드 → Go 빌드 → distroless 런타임).
* 개발 서버용 `/results-api` 프록시 설정 (`vite.config.js`).

### 6. OIDC 로그인 (ArgoCD 방식)

* `--oidc-issuer`를 설정하면 대시보드 자체 로그인 화면(**LOG IN VIA GITEA**)이 생깁니다.
* 로그인한 사용자의 k8s API 요청은 **Impersonation**으로 처리합니다. 사용자는 `<username>`, 그룹은 `gitea:<group>`으로 요청합니다.
  이 매핑은 NKS apiserver의 Gitea OIDC 매핑(kubectl 로그인 시 적용되는 규칙)과 같습니다. 따라서 기존 RoleBinding을 그대로 씁니다.
  권한은 클러스터 RoleBinding이 결정합니다. 대시보드 SA 권한이 사용자에게 그대로 넘어가지 않습니다.
* 세션은 암호화 쿠키(24h)에 저장되고, 그룹은 ID 토큰의 `groups` 클레임에서 가져옵니다. 클레임이 없으면 userinfo에서 가져옵니다.
* `--oidc-issuer`가 비어 있으면 기존 동작 그대로입니다(로그인 없음).
* 설계: `docs/superpowers/specs/2026-11-18-oidc-login-design.md`

<details>
<summary>설정 방법</summary>

1. Gitea → Site Administration → Integrations → OAuth2 Applications에서 앱을 등록합니다.
   Redirect URI는 `https://<dashboard-host>/auth/callback`입니다.
2. Secret을 생성합니다.

   ```sh
   kubectl -n tekton-pipelines create secret generic tekton-dashboard-oidc \
     --from-literal=OIDC_CLIENT_SECRET=<client-secret> \
     --from-literal=SESSION_KEY="$(openssl rand -base64 32)"
   ```
3. impersonate 권한을 부여하고 Deployment에 설정을 추가합니다.

   ```sh
   kubectl apply -f config/oidc-impersonator.yaml
   kubectl -n tekton-pipelines set env deploy/tekton-dashboard --from=secret/tekton-dashboard-oidc
   kubectl -n tekton-pipelines patch deploy tekton-dashboard --type=json -p '[
     {"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--oidc-issuer=https://gitea.example.com"},
     {"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--oidc-client-id=<client-id>"},
     {"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--oidc-redirect-url=https://<dashboard-host>/auth/callback"}
   ]'
   ```
4. 그룹에 권한을 겁니다(Gitea 그룹 형식은 `<org>` / `<org>:<team>`).

   ```sh
   # tekton_pipeline_manager(01-5.init-tekton-group-role)가 만드는 바인딩이 이미 있으면 생략
   #   tekton-editor-global   -> gitea:oauth_organization:admins
   #   tekton-reviewer-global -> gitea:oauth_organization:viewers
   # 사전 확인
   kubectl auth can-i create pipelineruns -n fastapi-cicd \
     --as=alice --as-group=gitea:oauth_organization:viewers
   ```

| 플래그 | 기본값 | 설명 |
|---|---|---|
| `--oidc-issuer` | | 설정 시 로그인 활성화 |
| `--oidc-client-id` / `--oidc-redirect-url` | | 필수. 콜백은 redirect URL의 경로에서 처리합니다. oauth2-proxy에서 넘어온다면 `https://<host>/oauth2/callback`를 그대로 써서 Gitea 등록을 재사용할 수 있습니다 |
| `--oidc-name` | `Gitea` | 로그인 버튼 문구 |
| `--oidc-username-prefix` | `""` | apiserver OIDC username prefix와 동일하게 설정. `:`가 들어간 username은 로그인 거부 |
| `--oidc-groups-prefix` | `gitea:` | apiserver OIDC groups prefix와 동일하게 설정. 빈 값 불가(`system:masters` 사칭 방지) |
| `--oidc-username-claim` / `--oidc-groups-claim` | `preferred_username` / `groups` | |
| `--oidc-ca-file` | | 자체 서명 인증서 CA(PEM) |
| `--oidc-insecure-skip-verify` | `false` | 비상용 |

필수 값이 하나라도 빠지면 대시보드가 시작되지 않습니다(fail closed).

**켜기/끄기**는 `--oidc-issuer` 값으로만 전환합니다. 빈 값이면 로그인이 꺼지고, 나머지 `--oidc-*` 인자는 무시됩니다.

```sh
# 끄기 (켜기는 반대로 issuer URL을 다시 넣음)
kubectl -n tekton-pipelines get deploy tekton-dashboard -o json \
  | sed 's|--oidc-issuer=https://gitea.example.com|--oidc-issuer=|' | kubectl apply -f -
```

* 로그인을 끄면 접속하는 누구나 대시보드 SA 권한으로 동작합니다. 앞단에 다른 인증을 두거나 내부망에서만 쓰세요.
* 로그인이 꺼져 있어도 클라이언트가 보낸 `Impersonate-*` 헤더는 항상 제거됩니다. 오래 끈 채로 쓸 거라면 impersonate 권한(`config/oidc-impersonator.yaml`)도 회수하는 편이 깔끔합니다.
* 화면에서 켜고 끄는 스위치는 일부러 두지 않았습니다.

</details>

---

## 개발

`package.json` engines 기준 **Node.js 24.16+ / npm 11.9+**, Go 백엔드는 **Go 1.26+** 가 필요합니다.

```sh
npm install
npm run lint && npm test && npm run build   # 전체 검증
go test ./...                               # 백엔드 (pkg/auth, pkg/router)
npm start                                   # 개발 서버 (기본 8000 포트)
```

### 커스텀 코드 위치

아래 파일이 커스텀의 전부이며 나머지는 upstream 그대로입니다.
upstream 갱신 시 이 파일들만 rebase 하면 됩니다.

| 파일 | 내용 |
|---|---|
| `packages/components/src/components/LabelFilter/LabelFilter.jsx` | 텍스트 검색 입력 / 디바운스 / 검색어 태그 |
| `src/api/utils.js` | `useCollection` 텍스트 필터 (`applyClientTextFilter`) |
| `src/containers/About/About.jsx` | 파이프라인 현황판 |
| `src/containers/PipelineRuns/PipelineRuns.jsx` | 목록 액션 메뉴 (Start = 신규 생성) |
| `src/containers/PipelineRun/PipelineRun.jsx` | 상세 액션 메뉴 (목록과 동일) |
| `src/containers/ListPageLayout/ListPageLayout.jsx` | 페이지 사이즈 |
| `Dockerfile`, `.dockerignore`, `vite.config.js` | 빌드 / 배포 |
| `pkg/auth/` | OIDC 로그인, 세션 쿠키, impersonation |
| `pkg/router/router.go`, `cmd/dashboard/main.go` | 보호 경로 래핑, OIDC 플래그 |
| `src/containers/Login/`, `src/containers/App/App.jsx` | 로그인 페이지와 라우트 |
| `src/api/comms.js`, `src/api/index.js` | 401 → 로그인 이동, `useCurrentUser` |
| `src/containers/HeaderBarContent/HeaderBarContent.jsx`, `src/containers/Header/_Header.scss` | 헤더 사용자 표시 |
| `src/nls/messages_{en,ko}.json` | 로그인 문구 |
| `config/oidc-impersonator.yaml` | impersonate 권한(OIDC 사용 시에만 적용) |

각 커스텀 동작에는 회귀 테스트가 붙어 있습니다 (`npm test`).

### 컨테이너 이미지 빌드 및 배포

```sh
docker build -t harbor.114-110-181-178.nip.io/nnd/tekton-custom-dashboard:v0.72.0-custom .
docker push  harbor.114-110-181-178.nip.io/nnd/tekton-custom-dashboard:v0.72.0-custom

kubectl -n tekton-pipelines rollout restart deploy/tekton-dashboard
kubectl -n tekton-pipelines rollout status  deploy/tekton-dashboard
```

* 태그를 덮어쓰는 방식이므로 Deployment의 `imagePullPolicy`는 `Always` 로 설정되어 있습니다.
* 화면에 표시되는 버전은 `dashboard-info` ConfigMap의 `version` 값입니다.

  ```sh
  kubectl -n tekton-pipelines patch cm dashboard-info --type merge -p '{"data":{"version":"v0.72.0-custom"}}'
  ```

---

## 기본 기능 (Original Features)

* `PipelineRun` 및 `TaskRun`의 실시간 상태 및 로그 조회
* 리소스 라벨 필터링
* 리소스 개요 및 YAML 명세 확인
* 전체 클러스터 조회 또는 특정 네임스페이스로 조회 범위 제한
* Git 리포지토리에서 리소스 직접 가져오기 (Import)
* 확장 프로그램(Extensions)을 통한 기능 추가

<img width="1902" height="907" alt="dashboard" src="https://github.com/user-attachments/assets/02d0051a-64bd-428b-b88a-615c12d1d33d" />

## 문서 및 가이드

* **설치 방법:** [Installing Tekton Dashboard](./docs/install.md)
* **튜토리얼:** ["Getting started" tutorial](./docs/tutorial.md)
* **확장 기능:** [Extensions](./docs/extensions.md)
* **공식 릴리즈:** [releases](https://github.com/tektoncd/dashboard/blob/main/releases.md)
* **공식 문서:** [Tekton 웹사이트](https://tekton.dev/docs)

> 한국어 메시지(`src/nls/messages_ko.json`)는 upstream 공식 번역본을 사용합니다.
> 이전 커스텀 번역본은 일괄 치환 과정에서 메시지 **키**까지 변경되어 번역이 적용되지 않는 상태였습니다.
