# OIDC 로그인 + k8s Impersonation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 대시보드에 Gitea OIDC 로그인을 내장하고, k8s 프록시 요청을 로그인 사용자로 impersonate한다.

**Architecture:** 새 패키지 `pkg/auth`가 담당하는 일은 다음과 같다.
- `/auth/*` 핸들러
- AES-GCM 세션 쿠키
- 보호 미들웨어(`Require`, `Impersonate`)

`router.Register`는 등록할 때 보호 대상 핸들러를 감싼다. 프론트엔드는 401을 받으면 `#/login`으로 보내고, 로그인 페이지와 사용자 표시만 추가한다.

**Tech Stack:** Go 1.26, `github.com/coreos/go-oidc/v3`, `golang.org/x/oauth2`, `github.com/go-jose/go-jose/v4`(go-oidc 의존성으로 들어오며 테스트 서명에 사용), React 19 + Carbon + vitest

**Spec:** `docs/superpowers/specs/2026-11-18-oidc-login-design.md`

## Global Constraints

- `--oidc-issuer`가 비어 있으면 인증 OFF. 이때 upstream 동작은 바뀌지 않는다. 예외는 클라이언트 `Impersonate-*`/`Authorization` 헤더 제거로, 이것만 항상 적용한다.
- prefix: `--oidc-username-prefix`(기본 `""`), `--oidc-groups-prefix`(기본 `gitea:`, 빈 값이면 시작 에러). apiserver OIDC 매핑과 같게 둔다. (2026-11-19 변경: 처음에는 user·group 공통 `--oidc-prefix`였음)
- 세션 쿠키는 `tkn-session`, 24h, `HttpOnly; Secure; SameSite=Lax; Path=/`다.
- flow 쿠키는 `tkn-auth-flow`, 5분이다.
- `SESSION_KEY` env는 32바이트를 base64로 인코딩한 값이다(`openssl rand -base64 32`).
- 인증이 켜져 있는데 필수 설정이 빠지면 시작 실패다(fail closed).
- 커스텀 파일은 README "커스텀 코드 위치" 표에 반드시 추가한다.

---

### Task 1: `pkg/auth` — 세션 sealer, return 검증, 헤더 제거

**Files:**
- Create: `pkg/auth/session.go`
- Test: `pkg/auth/session_test.go`

**Interfaces:**
- Produces: `type Session struct{User string; Groups []string; Exp int64}`, `newSealer(key []byte) (*sealer, error)`, `(*sealer).seal(name string, v any) (string, error)`, `(*sealer).open(name, value string, v any) error`, `safeReturn(string) string`, `StripIdentityHeaders(http.Header)`, `StripIdentity(http.Handler) http.Handler`

- [ ] Step 1: 테스트 작성. 확인할 항목:
  - 왕복 결과 동일
  - 1바이트 변조 시 에러
  - 다른 쿠키 이름(AAD)으로 열면 에러
  - 키 길이 31 → 에러
  - `safeReturn` 테이블: `""`, `/`, `/#/x`, `//evil`, `/\evil`, `https://evil`, `evil`
  - `StripIdentityHeaders`: `Authorization`, `Impersonate-User`, `Impersonate-Group`, `Impersonate-Uid`, `Impersonate-Extra-Scopes`(소문자로 입력한 것 포함) 제거, `Accept` 유지
- [ ] Step 2: `go test ./pkg/auth/` → FAIL(undefined)
- [ ] Step 3: 구현한다(아래 코드).
- [ ] Step 4: `go test ./pkg/auth/` → PASS
- [ ] Step 5: commit `auth: session sealer, return-path and identity header helpers`

```go
// session.go 핵심
func (s *sealer) seal(name string, v any) (string, error) {
	b, err := json.Marshal(v)
	if err != nil { return "", err }
	nonce := make([]byte, s.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil { return "", err }
	return base64.RawURLEncoding.EncodeToString(s.aead.Seal(nonce, nonce, b, []byte(name))), nil
}
func safeReturn(p string) string {
	if !strings.HasPrefix(p, "/") || strings.HasPrefix(p, "//") || strings.HasPrefix(p, "/\\") { return "/" }
	return p
}
func StripIdentityHeaders(h http.Header) {
	h.Del("Authorization")
	for k := range h { if strings.HasPrefix(k, "Impersonate-") { delete(h, k) } } // http.Header 키는 canonical
}
```

### Task 2: `pkg/auth` — Auth 생성, 미들웨어, 핸들러

**Files:**
- Create: `pkg/auth/auth.go`
- Test: `pkg/auth/auth_test.go` (httptest 가짜 OIDC 서버: discovery, `/keys`, `/token`, `/userinfo`. RSA 키로 go-jose 서명)

**Interfaces:**
- Consumes: Task 1의 함수들
- Produces:
  - `type Config struct{Issuer, Name, ClientID, ClientSecret, RedirectURL, UsernameClaim, GroupsClaim, UsernamePrefix, GroupsPrefix, CAFile string; InsecureSkipVerify bool; SessionKey []byte}`
  - `New(ctx context.Context, cfg Config) (*Auth, error)`
  - `(*Auth).Register(mux *http.ServeMux)`
  - `(*Auth).Require(http.Handler) http.Handler`
  - `(*Auth).Impersonate(http.Handler) http.Handler`

- [ ] Step 1: 테스트 작성. 시나리오:
  - `New` 검증: secret 없음, prefix 빈 값, key 길이 오류 → 에러
  - `Require`: 쿠키 없음 → 401, 유효 세션 → 통과
  - `Impersonate`: 클라이언트 `Impersonate-Group: system:masters`, `Authorization`, `Cookie` 제거 → `Impersonate-User: alice`, `Impersonate-Group: [gitea:org, gitea:org:admins]`
  - 만료 세션 → 401
  - 전체 흐름: `/auth/login?return=/%23/pipelineruns` → 302(authorize URL, flow 쿠키) → 가짜 서버가 id_token(groups 포함) 발급 → `/auth/callback?code=c&state=<state>` → 302 `/#/pipelineruns` + `tkn-session` → 그 쿠키로 `/auth/me` 200 `{"user":"alice","groups":[...]}`
  - id_token에 groups가 없으면 userinfo의 groups 사용
  - state 불일치 → 302 `/#/login?error=invalid_state`
  - `/auth/me` 쿠키 없음 → 401 `{"oidcName":"Gitea"}`
  - `/auth/logout` → 쿠키 MaxAge<0, 302 `/#/login`
- [ ] Step 2: `go test ./pkg/auth/` → FAIL
- [ ] Step 3: 구현한다. 콜백 처리 순서:
  1. flow 쿠키를 열고 만료를 확인한다.
  2. state를 비교하고, `error` 파라미터를 확인한다.
  3. `Exchange(ctx, code, oauth2.VerifierOption(verifier))`
  4. `verifier.Verify` 후 nonce를 비교한다.
  5. claims에서 username(빈 값이면 에러)과 groups를 꺼낸다. groups가 없으면 `provider.UserInfo`로 조회한다.
  6. 세션을 seal한다. 3800바이트를 넘으면 `session_too_large`.

  HTTP client는 다음과 같이 만든다.
  - `CAFile`이 있으면 SystemCertPool에 추가한다.
  - `InsecureSkipVerify` 플래그를 반영한다.
  - 요청마다 `oidc.ClientContext(r.Context(), a.client)`를 사용한다.
- [ ] Step 4: `go test ./pkg/auth/` → PASS
- [ ] Step 5: commit `auth: OIDC login/callback/logout/me and impersonation middleware`

### Task 3: 백엔드 연결 — main 플래그, router, properties

**Files:**
- Modify: `cmd/dashboard/main.go` (플래그와 env, `auth.New`, `router.Register(resource, cfg, a)`)
- Modify: `pkg/router/router.go` (`Register` 시그니처에 `a *auth.Auth` 추가, 보호 대상 래핑)

**Interfaces:**
- Consumes: Task 2의 `auth.New`, `Register`, `Require`, `Impersonate`, Task 1의 `StripIdentity`

- [ ] Step 1: `router.Register`에서 다음과 같이 래핑한다.
  ```go
  protect := func(h http.Handler) http.Handler { return h }
  impersonate := auth.StripIdentity
  if a != nil { protect, impersonate = a.Require, a.Impersonate; a.Register(mux) }
  mux.Handle(apiProxyPrefix, impersonate(proxyHandler))
  mux.Handle(apisProxyPrefix, impersonate(proxyHandler))
  mux.Handle("/v1/properties", protect(http.HandlerFunc(r.GetProperties)))
  // logs-proxy도 protect
  ```
- [ ] Step 2: main에 플래그 `--oidc-issuer`, `--oidc-name`(Gitea), `--oidc-client-id`, `--oidc-redirect-url`, `--oidc-username-claim`(preferred_username), `--oidc-groups-claim`(groups), `--oidc-username-prefix`(""), `--oidc-groups-prefix`(gitea:), `--oidc-ca-file`, `--oidc-insecure-skip-verify`를 추가한다.
  - env `OIDC_CLIENT_SECRET`과 `SESSION_KEY`(base64 decode)를 읽는다.
  - issuer가 설정돼 있으면 `auth.New`를 호출하고, 실패하면 `Fatalf`로 종료한다.
  - 이때 `options.LogoutURL = "/auth/logout"`로 설정한다.
- [ ] Step 3: `go build ./... && go vet ./... && go test ./...` → PASS
- [ ] Step 4: commit `dashboard: wire OIDC auth into the router and flags`

### Task 4: 프론트엔드 — 401 리다이렉트, 로그인 페이지, 사용자 표시

**Files:**
- Modify: `src/api/comms.js` (`checkStatus`), `src/api/comms.test.js`
- Modify: `src/api/index.js` (`useCurrentUser`)
- Create: `src/containers/Login/{Login.jsx,index.js,Login.test.jsx}`
- Modify: `src/containers/index.js`, `src/containers/App/App.jsx` (최상위 `/login` 라우트)
- Modify: `src/containers/HeaderBarContent/HeaderBarContent.jsx` (username)
- Modify: `src/nls/messages_en.json`, `src/nls/messages_ko.json`

- [ ] Step 1: 테스트 작성
  - `checkStatus` 401 → `window.location.assign`이 `/#/login?return=%2F%23%2Fpipelineruns` 형태로 호출되고 에러를 throw한다.
  - 현재 hash가 `#/login`이면 assign을 호출하지 않는다.
  - `Login`: msw로 `/auth/me`가 401 `{oidcName:'Gitea'}`를 반환하게 한다 → 버튼 "LOG IN VIA GITEA", href `/auth/login?return=...`. `?error=invalid_state`이면 에러 알림을 표시한다.
- [ ] Step 2: `npx vitest run src/api/comms.test.js src/containers/Login` → FAIL
- [ ] Step 3: 구현한다.
  ```js
  if (response.status === 401 && !window.location.hash.startsWith('#/login')) {
    const ret = `/${window.location.hash || '#/'}`;
    window.location.assign(`/#/login?return=${encodeURIComponent(ret)}`);
  }
  ```
  - `Login`은 `fetch('/auth/me')`를 직접 호출한다(checkStatus를 우회해야 무한 루프가 생기지 않는다).
    - 200이면 `return` 경로로 이동한다.
    - 401이면 본문에서 oidcName을 읽어 버튼을 렌더링한다.
  - `useCurrentUser`: `useQuery(['currentUser'], …)`. 404는 null로 처리한다(인증 OFF).
- [ ] Step 4: `npm run lint && npx vitest run` → PASS
- [ ] Step 5: commit `ui: login page, 401 redirect and current user in the header`

### Task 5: 매니페스트와 문서

**Files:**
- Create: `config/oidc-impersonator.yaml`(ClusterRole과 ClusterRoleBinding). OIDC를 쓸 때만 적용하므로 kustomization에는 넣지 않음
- Deployment는 수정하지 않음(installer/rebase 영향 최소화). args·env 적용은 README의 `kubectl set env`/`patch` 명령으로 처리
- Modify: `README.md` (기능 6, 커스텀 파일 표, Secret 생성, 바인딩 예시, 전환 절차 요약)

- [ ] Step 1: 매니페스트를 작성한 뒤 `kubectl kustomize config >/dev/null`로 검증한다.
- [ ] Step 2: README를 갱신한다.
- [ ] Step 3: 전체 검증: `go test ./... && npm run lint && npx vitest run && npm run build`
- [ ] Step 4: commit `config, docs: impersonator RBAC, OIDC deployment wiring, README`

## 범위 밖 (spec 6장 클러스터 전환)

Gitea 앱 등록, Secret 생성, 이미지 push, 라우트 교체, oauth2-proxy 삭제는 공유 클러스터를 바꾸는 작업이다. 그래서 코드 완료 후 사용자에게 확인을 받고 진행한다.
