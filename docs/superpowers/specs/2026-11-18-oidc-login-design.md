# OIDC 로그인 + k8s Impersonation 설계

- 작성일: 2026-11-18
- 상태: 검토 대기
- 참고: ArgoCD(`devops-tools/argocd-cm`)의 Gitea OIDC 연동 방식

## 1. 목표 / 비목표

**목표**
- ArgoCD처럼 대시보드 자체 로그인 화면에서 Gitea OIDC로 로그인한다.
- 로그인 사용자의 k8s 권한은 **k8s Impersonation**으로 처리한다. 무엇을 할 수 있는지는 클러스터 RoleBinding이 결정한다.
- 현재 대시보드 앞단의 oauth2-proxy(`tekton-pipelines/oauth2-proxy`)를 대체한다.

**비목표 (이번 범위 밖)**
- 로컬 계정 로그인 (OIDC만 지원)
- refresh token / 세션 자동 연장
- Gitea 측 로그아웃(end-session)
- 권한에 따른 UI 버튼 숨김(SelfSubjectAccessReview). 권한이 없으면 403이 기존 에러 알림으로 표시된다.
- oauth2-proxy 헤더 신뢰 모드. 필요해지면 미들웨어의 identity 소스만 추가하면 된다.

## 2. 핵심 결정

| 항목 | 결정 | 이유 |
|---|---|---|
| 구현 위치 | Go 백엔드에 OIDC 내장 | ArgoCD와 같은 자체 로그인 화면. 별도 컴포넌트가 없다. |
| 권한 모델 | k8s Impersonation | 권한 판단을 k8s RBAC에 위임한다. 대시보드에 정책 엔진이 필요 없다. |
| user/group prefix | 둘 다 `gitea:` | Gitea 조직·팀 이름으로 `system:masters` 같은 k8s 내부 그룹이나 사용자를 사칭하지 못하게 막는다. 기존 바인딩 `gitea:oauth_organization`과 형식이 같다. |
| 세션 | AES-GCM 암호화 쿠키, 24h 고정 | ArgoCD 기본값과 같다. 서버에 상태가 없어 replica 확장이 자유롭다. stdlib만 사용한다. |
| 그룹 소스 | ID 토큰 `groups` → 없으면 userinfo | ArgoCD `enableUserInfoGroups`와 같은 방식 |
| 인증 OFF | `--oidc-issuer`가 비어 있으면 upstream 동작 그대로 | 로컬 개발과 upstream rebase를 쉽게 유지한다 |

## 3. 백엔드

### 3.1 새 패키지 `pkg/auth`

| 엔드포인트 | 동작 |
|---|---|
| `GET /auth/login?return=<path>` | state, nonce, PKCE verifier를 단기 쿠키(`tkn-auth-flow`, 5분, HttpOnly)에 저장한다 → Gitea authorize URL로 302 |
| `GET /auth/callback` | state 대조 → code 교환(PKCE) → ID 토큰 검증(서명/iss/aud/exp/nonce) → username·groups 추출 → 세션 쿠키 발급 → `return`으로 302. 실패하면 `/#/login?error=<code>`로 302 |
| `GET /auth/logout` | 세션 쿠키 삭제 → `/#/login`으로 302 |
| `GET /auth/me` | `{"user": "...", "groups": [...]}` (prefix 붙기 전 원본 값). 세션이 없으면 401 |

- scope: `openid profile email groups`
- username claim은 `preferred_username`, groups claim은 `groups`다. 둘 다 플래그로 변경할 수 있다.
- **`return` 검증**: `/`로 시작하고 `//`나 `/\`로 시작하지 않는 경로만 허용한다. 그 외는 `/`로 처리한다(오픈 리다이렉트 방지).

### 3.2 세션 쿠키

- 이름 `tkn-session`, 값 = base64(AES-256-GCM(json `{u, g, exp}`)), 키는 `SESSION_KEY`(32바이트)다.
- 쿠키 속성은 `HttpOnly; Secure; SameSite=Lax; Path=/`다.
  - Lax는 IdP에서 돌아오는 top-level GET 리다이렉트를 허용하기 위해서다.
  - 상태를 바꾸는 요청은 기존 `Tekton-Client` 헤더 CSRF 검사가 계속 막는다.
- 복호화에 실패하거나 `exp`가 지나면 세션이 없는 것으로 취급한다.
- 쿠키 크기는 4KB 한도다. 그룹이 수십 개 수준이면 충분하다.
  - 한도를 넘기면 로그인 시 에러(`error=session_too_large`)를 낸다. 조용히 잘라내지 않는다.

### 3.3 보호 대상과 Impersonation

`router.Register`에서 등록할 때 핸들러를 직접 감싼다. 공개/보호 경로를 등록하는 자리에서 바로 알 수 있다.

- **보호(세션 필수, 없으면 401)**: `/api/`, `/apis/`(k8s 프록시), `/v1/properties`, `/v1/logs-proxy/`
- **공개**: 정적 파일(`/`), `/auth/*`, `/health`, `/readiness`

k8s 프록시 요청은 기존 `protectWebSocket` 래퍼 안에서 다음 순서로 처리한다.

1. 들어온 요청에서 `Authorization`과 `Impersonate-*` 헤더(대소문자 무관, `Impersonate-Extra-*` 포함)를 **모두 제거**한다.
2. `Impersonate-User: gitea:<user>`를 붙인다.
3. 그룹마다 `Impersonate-Group: gitea:<group>`을 붙인다.

- 웹소켓 업그레이드(로그 스트리밍, watch)는 `proxy.MirrorRequest`로 헤더가 그대로 전달되므로 같은 방식으로 적용된다.
- apiserver는 impersonate된 사용자에게 `system:authenticated`를 자동으로 붙인다. 따라서 기존 `tekton-dashboard-info` Role(system:authenticated 대상)은 그대로 동작한다.
- `/v1/properties`와 `/v1/logs-proxy/`는 지금처럼 SA 권한으로 동작한다. 세션 검사만 추가한다.
- 인증이 켜져 있으면 `/v1/properties`의 `logoutURL`은 `/auth/logout`이 된다. 기존 `LogoutButton`이 코드 변경 없이 동작한다.

### 3.4 설정

| 플래그 / env | 기본값 | 설명 |
|---|---|---|
| `--oidc-issuer` | `""` | 비어 있으면 인증 OFF |
| `--oidc-name` | `Gitea` | 로그인 버튼 문구("LOG IN VIA GITEA") |
| `--oidc-client-id` | | |
| `--oidc-redirect-url` | | 예: `https://tekton.180-210-89-135.nip.io/auth/callback` |
| `--oidc-username-claim` | `preferred_username` | |
| `--oidc-groups-claim` | `groups` | |
| `--oidc-prefix` | `gitea:` | user와 group 모두에 적용. 빈 값은 허용하지 않는다(시작 시 에러) |
| `--oidc-ca-file` | `""` | 자체 서명 인증서용 CA |
| `--oidc-insecure-skip-verify` | `false` | ArgoCD `oidc.tls.insecure.skip.verify`에 해당하는 비상 옵션 |
| env `OIDC_CLIENT_SECRET` | | Secret `tekton-dashboard-oidc`에서 주입 |
| env `SESSION_KEY` | | 32바이트. 같은 Secret에서 주입 |

- 인증이 켜져 있는데 필수 값(client-id, redirect-url, secret, 32바이트 key)이 없으면 **시작에 실패**한다(fail closed).
- 로그인 버튼 문구(`oidcName`)는 `/auth/me`의 401 응답 본문 `{"oidcName": "Gitea"}`로 전달한다. `/v1/properties`는 보호 대상이라 로그인 화면에서 읽을 수 없기 때문이다.

### 3.5 의존성

- `github.com/coreos/go-oidc/v3`, `golang.org/x/oauth2` 두 개만 추가한다.

## 4. 프론트엔드

1. **401 처리**: `src/api/comms.js`의 `checkStatus`를 수정한다.
   - 응답이 401이고 현재 hash가 `#/login`으로 시작하지 않으면 `window.location.assign('/#/login?return=' + encodeURIComponent(현재 hash 경로))`로 이동한다.
2. **로그인 페이지**: `src/containers/Login/Login.jsx`를 새로 만든다.
   - `createHashRouter`의 최상위 라우트로 `/login`을 추가한다(`Root` 밖, 헤더·사이드바 없음).
   - 화면은 Tekton 로고와 "LOG IN VIA {oidcName}" 버튼으로 구성한다. 버튼을 누르면 `/auth/login?return=…`으로 페이지 이동한다.
   - `?error=`가 있으면 Carbon `InlineNotification`으로 표시한다.
   - 이미 로그인 상태(`/auth/me` 200)면 `return`(없으면 `/`)으로 이동한다.
3. **사용자 표시**: `HeaderBarContent.jsx`에서 `LogoutButton` 옆에 `/auth/me`의 username을 표시한다. 인증이 꺼져 있으면(404) 표시하지 않는다.
4. **로그인 전 properties**: 로그인 전에는 `/v1/properties`가 401을 받는다. 기존 catch 로직이 `{isReadOnly: true}`로 떨어지므로 앱 셸은 로드된다.
   - 로그인 후 `/auth/callback`이 전체 페이지를 리다이렉트하므로 properties를 다시 불러온다.
5. **문구**: `messages_en.json`과 `messages_ko.json`에 키를 추가한다(로그인 버튼, 에러 문구 등).

## 5. RBAC / 매니페스트 (`config/`)

- **신규 `ClusterRole tekton-dashboard-impersonator`**: `users`, `groups`에 `impersonate` 권한을 주고 SA `tekton-pipelines/tekton-dashboard`에 바인딩한다.
  - ⚠️ **한계**: k8s RBAC로는 impersonate 대상을 prefix로 제한할 수 없다.
  - 따라서 SA 토큰이 탈취되면 cluster-admin과 같은 위험이 있고, 실제 방어선은 3.3의 헤더 제거와 prefix 강제 코드다. 이 코드에는 반드시 테스트를 둔다.
- **Deployment**: OIDC 플래그를 추가하고 Secret `tekton-dashboard-oidc`의 env를 연결한다. Secret은 커밋하지 않고 README에 생성 명령만 적는다.
- **예시 바인딩** (`config/` 밖, README 예시로만 둔다):
  - `gitea:oauth_organization:admins` → `tekton-dashboard-backend-edit` (ClusterRoleBinding)
  - `gitea:oauth_organization:viewers` → `tekton-dashboard-backend-view`
  - 네임스페이스 단위 실행 권한은 기존처럼 `tekton-dashboard-tenant-runners` RoleBinding에 `gitea:<user>` 또는 `gitea:<group>`으로 건다.

## 6. 전환 절차 (클러스터)

1. Gitea에 OAuth2 앱을 새로 등록한다(redirect `https://tekton.180-210-89-135.nip.io/auth/callback`). 이어서 Secret `tekton-dashboard-oidc`를 생성한다.
2. 새 이미지와 RBAC를 배포한다. 이 시점에는 oauth2-proxy가 앞에 있으므로 사용자 영향이 없다.
3. 기존 runners RoleBinding 4개(`fastapi-cicd`, `petclinic-cicd`, `react-template-cicd`, `tekton-catalog`)의 사용자 `cicdbot`, `devopsmanager`를 `gitea:cicdbot`, `gitea:devopsmanager`로 바꾼다. admins/viewers 그룹 바인딩도 추가한다.
4. `kubectl auth can-i ... --as=gitea:<user> --as-group=gitea:oauth_organization:<team>`으로 권한을 미리 확인한다.
5. `tekton-route`의 backendRef를 `tekton-dashboard:9097`로 변경하고 `oauth2-route`를 삭제한다.
6. admins 계정과 viewers 계정으로 각각 로그인해 동작을 확인한다. 확인되면 oauth2-proxy Deployment, Service, ConfigMap을 삭제한다.
7. tenant와 tenant-runners 바인딩에서 SA `tekton-dashboard`를 제거한다. SA에는 impersonator와 `backend-view`(properties용)만 남긴다.

- **롤백**: `tekton-route`를 oauth2-proxy로 되돌리고 이전 이미지로 롤백한다. 6단계 전까지는 즉시 롤백할 수 있다.

## 7. 테스트

**Go (`pkg/auth`, `pkg/router`)**
- 세션이 없으면 보호 경로는 401, 공개 경로는 통과
- 클라이언트가 보낸 `Authorization`, `Impersonate-User`, `Impersonate-Group`, `Impersonate-Extra-*`가 제거되고 `gitea:` prefix 값으로 대체됨
- 세션 쿠키: 정상 왕복, 변조 시 거부, 만료 시 거부
- `return` 검증: `/x` 허용, `//evil`, `/\evil`, `https://evil`은 `/`로 처리
- callback 정상 흐름: httptest로 가짜 OIDC 서버(discovery, JWKS, token)를 띄워 1건 검증. state 불일치 시 에러 리다이렉트도 1건 검증
- 인증 ON + 필수 설정 누락 → 시작 에러
- 인증 OFF → 기존 동작 그대로(impersonate 헤더 없음)

**프론트 (vitest)**
- `checkStatus` 401 → 리다이렉트, `#/login`에서는 리다이렉트하지 않음
- `Login` 렌더링, 에러 표시, 버튼 href

**수동**
- 6장의 4·6단계

**전체 검증**
- `npm run lint && npm test && npm run build`, `go test ./...`

## 8. 변경 파일 요약

| 파일 | 내용 |
|---|---|
| `pkg/auth/*.go` (신규) | OIDC 핸들러, 세션, 미들웨어, impersonation |
| `cmd/dashboard/main.go` | 플래그 |
| `pkg/router/router.go` | 보호 대상 래핑, `/auth/*` 등록 |
| `pkg/endpoints/types.go`, `dashboard.go` | logoutURL 연동 |
| `src/api/comms.js` | 401 리다이렉트 |
| `src/containers/Login/` (신규), `App.jsx` | 로그인 페이지와 라우트 |
| `src/containers/HeaderBarContent/HeaderBarContent.jsx` | 사용자 표시 |
| `src/nls/messages_{en,ko}.json` | 문구 |
| `config/` | impersonator ClusterRole·Binding, Deployment env/args |
| `README.md` | 커스텀 기능 6번, 커스텀 파일 표, Secret 생성·바인딩 예시 |
