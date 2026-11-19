/*
Copyright 2026 The Tekton Authors
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
		http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/tektoncd/dashboard/pkg/logging"
)

func init() {
	logging.InitLogger("error", "console")
}

// fakeIdP is a minimal OIDC provider: discovery, JWKS, token and userinfo.
type fakeIdP struct {
	srv            *httptest.Server
	key            *rsa.PrivateKey
	nonce          string // copied from the authorize URL by the test
	badNonce       bool
	username       string // preferred_username, defaults to alice
	tokenGroups    []string
	userinfoGroups []string
}

func newFakeIdP(t *testing.T) *fakeIdP {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeIdP{key: key}
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer":                                f.srv.URL,
			"authorization_endpoint":                f.srv.URL + "/authorize",
			"token_endpoint":                        f.srv.URL + "/token",
			"jwks_uri":                              f.srv.URL + "/keys",
			"userinfo_endpoint":                     f.srv.URL + "/userinfo",
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/keys", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{
			{Key: &key.PublicKey, KeyID: "k1", Algorithm: "RS256", Use: "sig"},
		}})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.Form.Get("code_verifier") == "" {
			http.Error(w, "missing PKCE verifier", http.StatusBadRequest)
			return
		}
		claims := map[string]any{
			"iss":                f.srv.URL,
			"aud":                "dashboard",
			"sub":                "1",
			"exp":                time.Now().Add(time.Hour).Unix(),
			"iat":                time.Now().Unix(),
			"nonce":              f.nonce,
			"preferred_username": "alice",
		}
		if f.username != "" {
			claims["preferred_username"] = f.username
		}
		if f.badNonce {
			claims["nonce"] = "replayed"
		}
		if f.tokenGroups != nil {
			claims["groups"] = f.tokenGroups
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": "at",
			"token_type":   "Bearer",
			"id_token":     f.sign(t, claims),
		})
	})
	mux.HandleFunc("/userinfo", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"sub": "1", "groups": f.userinfoGroups})
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeIdP) sign(t *testing.T, claims map[string]any) string {
	t.Helper()
	signer, err := jose.NewSigner(
		jose.SigningKey{Algorithm: jose.RS256, Key: jose.JSONWebKey{Key: f.key, KeyID: "k1"}},
		(&jose.SignerOptions{}).WithType("JWT"),
	)
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(claims)
	jws, err := signer.Sign(payload)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := jws.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func testConfig(issuer string) Config {
	return Config{
		Issuer:       issuer,
		Name:         "Gitea",
		ClientID:     "dashboard",
		ClientSecret: "secret",
		RedirectURL:  "https://dashboard.example/auth/callback",
		GroupsPrefix: "gitea:",
		SessionKey:   testKey,
	}
}

func newTestAuth(t *testing.T, idp *fakeIdP) (*Auth, *http.ServeMux) {
	t.Helper()
	a, err := New(context.Background(), testConfig(idp.srv.URL))
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	a.Register(mux)
	return a, mux
}

func cookie(t *testing.T, rec *httptest.ResponseRecorder, name string) *http.Cookie {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		if c.Name == name {
			return c
		}
	}
	t.Fatalf("cookie %s not set", name)
	return nil
}

func serve(h http.Handler, target string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, target, nil)
	for _, c := range cookies {
		req.AddCookie(c)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// login runs /auth/login and /auth/callback and returns the callback response.
func login(t *testing.T, idp *fakeIdP, mux http.Handler, tamperState bool) *httptest.ResponseRecorder {
	t.Helper()
	rec := serve(mux, "/auth/login?return="+url.QueryEscape("/#/pipelineruns"))
	if rec.Code != http.StatusFound {
		t.Fatalf("login status %d", rec.Code)
	}
	authorize, _ := url.Parse(rec.Header().Get("Location"))
	q := authorize.Query()
	if q.Get("code_challenge_method") != "S256" {
		t.Errorf("PKCE not requested: %s", authorize)
	}
	idp.nonce = q.Get("nonce")
	state := q.Get("state")
	if tamperState {
		state += "x"
	}
	return serve(mux, "/auth/callback?code=c&state="+url.QueryEscape(state), cookie(t, rec, flowCookie))
}

// The callback is served at the redirect URL's path, so an existing
// registration such as oauth2-proxy's /oauth2/callback can be reused.
func TestCallbackServedAtRedirectURLPath(t *testing.T) {
	idp := newFakeIdP(t)
	cfg := testConfig(idp.srv.URL)
	cfg.RedirectURL = "https://dashboard.example/oauth2/callback"
	a, err := New(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	a.Register(mux)

	rec := serve(mux, "/oauth2/callback?code=c&state=s")
	if loc := rec.Header().Get("Location"); loc != "/#/login?error=invalid_state" {
		t.Fatalf("callback not served at /oauth2/callback: %d %q", rec.Code, loc)
	}
}

func TestNewRejectsIncompleteConfig(t *testing.T) {
	idp := newFakeIdP(t)
	for name, mutate := range map[string]func(*Config){
		"redirect without path":  func(c *Config) { c.RedirectURL = "https://dashboard.example/" },
		"redirect on login path": func(c *Config) { c.RedirectURL = "https://dashboard.example/auth/login" },
		"redirect on probe path": func(c *Config) { c.RedirectURL = "https://dashboard.example/health" },
		"redirect on api path":   func(c *Config) { c.RedirectURL = "https://dashboard.example/apis/callback" },
		// Secure cookies are dropped over plain http, login could never finish
		"plain http redirect": func(c *Config) { c.RedirectURL = "http://dashboard.example/auth/callback" },
		"no secret":           func(c *Config) { c.ClientSecret = "" },
		"no redirect":         func(c *Config) { c.RedirectURL = "" },
		"no groups prefix":    func(c *Config) { c.GroupsPrefix = "" },
		"short key":           func(c *Config) { c.SessionKey = testKey[:16] },
	} {
		cfg := testConfig(idp.srv.URL)
		mutate(&cfg)
		if _, err := New(context.Background(), cfg); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
	// guard against the cases passing for an unrelated reason
	if _, err := New(context.Background(), testConfig(idp.srv.URL)); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
}

func TestLoginFlowWithGroupsInIDToken(t *testing.T) {
	idp := newFakeIdP(t)
	idp.tokenGroups = []string{"oauth_organization", "oauth_organization:admins"}
	_, mux := newTestAuth(t, idp)

	rec := login(t, idp, mux, false)
	if rec.Code != http.StatusFound || rec.Header().Get("Location") != "/#/pipelineruns" {
		t.Fatalf("callback: %d %s", rec.Code, rec.Header().Get("Location"))
	}
	session := cookie(t, rec, sessionCookie)
	if !session.HttpOnly || !session.Secure || session.SameSite != http.SameSiteLaxMode {
		t.Errorf("insecure session cookie: %+v", session)
	}

	me := serve(mux, "/auth/me", session)
	var body struct {
		User   string   `json:"user"`
		Groups []string `json:"groups"`
	}
	_ = json.NewDecoder(me.Body).Decode(&body)
	if me.Code != http.StatusOK || body.User != "alice" || !reflect.DeepEqual(body.Groups, idp.tokenGroups) {
		t.Fatalf("/auth/me: %d %+v", me.Code, body)
	}
}

func TestLoginFlowFallsBackToUserInfoGroups(t *testing.T) {
	idp := newFakeIdP(t)
	idp.userinfoGroups = []string{"oauth_organization:viewers"}
	a, mux := newTestAuth(t, idp)

	session := cookie(t, login(t, idp, mux, false), sessionCookie)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.AddCookie(session)
	s, ok := a.session(req)
	if !ok || !reflect.DeepEqual(s.Groups, idp.userinfoGroups) {
		t.Fatalf("session %+v ok=%v", s, ok)
	}
}

func TestCallbackRejectsStateMismatch(t *testing.T) {
	idp := newFakeIdP(t)
	_, mux := newTestAuth(t, idp)

	rec := login(t, idp, mux, true)
	if loc := rec.Header().Get("Location"); loc != "/#/login?error=invalid_state" {
		t.Fatalf("Location = %q", loc)
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionCookie && c.MaxAge >= 0 {
			t.Fatal("session cookie issued despite state mismatch")
		}
	}
}

func TestCallbackRejectsNonceMismatch(t *testing.T) {
	idp := newFakeIdP(t)
	idp.badNonce = true
	_, mux := newTestAuth(t, idp)

	if loc := login(t, idp, mux, false).Header().Get("Location"); loc != "/#/login?error=invalid_token" {
		t.Fatalf("Location = %q", loc)
	}
}

// Kubernetes reserves "system:" names; with no username prefix (matching the
// API server's OIDC mapping) a colon would allow e.g. system:kube-controller-manager.
func TestCallbackRejectsUsernameWithColon(t *testing.T) {
	idp := newFakeIdP(t)
	idp.username = "system:kube-controller-manager"
	_, mux := newTestAuth(t, idp)

	if loc := login(t, idp, mux, false).Header().Get("Location"); loc != "/#/login?error=invalid_username" {
		t.Fatalf("Location = %q", loc)
	}
}

func TestMeWithoutSession(t *testing.T) {
	idp := newFakeIdP(t)
	_, mux := newTestAuth(t, idp)
	rec := serve(mux, "/auth/me")
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), `"oidcName":"Gitea"`) {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
}

func TestNewAllowsHTTPForLocalhost(t *testing.T) {
	idp := newFakeIdP(t)
	cfg := testConfig(idp.srv.URL)
	cfg.RedirectURL = "http://localhost:8000/auth/callback"
	if _, err := New(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
}

func TestLogoutContinuesToConfiguredURL(t *testing.T) {
	idp := newFakeIdP(t)
	cfg := testConfig(idp.srv.URL)
	cfg.LogoutRedirect = "https://idp.example/logout"
	a, err := New(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	a.Register(mux)
	rec := serve(mux, "/auth/logout")
	if rec.Header().Get("Location") != "https://idp.example/logout" || cookie(t, rec, sessionCookie).MaxAge >= 0 {
		t.Fatalf("logout: %v", rec.Header())
	}
}

func TestLogoutClearsSession(t *testing.T) {
	idp := newFakeIdP(t)
	_, mux := newTestAuth(t, idp)
	rec := serve(mux, "/auth/logout")
	if rec.Header().Get("Location") != "/#/login" || cookie(t, rec, sessionCookie).MaxAge >= 0 {
		t.Fatalf("logout did not clear the session: %v", rec.Header())
	}
}

func sessionCookieFor(t *testing.T, a *Auth, s Session) *http.Cookie {
	t.Helper()
	v, err := a.sealer.seal(sessionCookie, s)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Cookie{Name: sessionCookie, Value: v}
}

func TestImpersonateReplacesClientIdentity(t *testing.T) {
	idp := newFakeIdP(t)
	a, _ := newTestAuth(t, idp)

	var got http.Header
	h := a.Impersonate(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { got = r.Header.Clone() }))

	req := httptest.NewRequest(http.MethodGet, "/apis/tekton.dev/v1/pipelineruns", nil)
	req.Header.Set("Authorization", "Bearer stolen")
	req.Header.Set("Impersonate-User", "kubernetes-admin")
	req.Header.Add("Impersonate-Group", "system:masters")
	req.Header.Set("Impersonate-Extra-Scopes", "x")
	req.AddCookie(sessionCookieFor(t, a, Session{User: "alice", Groups: []string{"org", "org:admins"}, Exp: time.Now().Add(time.Hour).Unix()}))
	h.ServeHTTP(httptest.NewRecorder(), req)

	if got == nil {
		t.Fatal("handler not called")
	}
	if got.Get("Authorization") != "" || got.Get("Cookie") != "" || got.Get("Impersonate-Extra-Scopes") != "" {
		t.Errorf("client identity leaked: %v", got)
	}
	// Same mapping as the API server's OIDC config: bare username, prefixed groups
	if u := got.Values("Impersonate-User"); !reflect.DeepEqual(u, []string{"alice"}) {
		t.Errorf("Impersonate-User = %v", u)
	}
	if g := got.Values("Impersonate-Group"); !reflect.DeepEqual(g, []string{"gitea:org", "gitea:org:admins"}) {
		t.Errorf("Impersonate-Group = %v", g)
	}

	a.cfg.UsernamePrefix = "oidc:"
	req = httptest.NewRequest(http.MethodGet, "/apis/tekton.dev/v1/pipelineruns", nil)
	req.AddCookie(sessionCookieFor(t, a, Session{User: "alice", Exp: time.Now().Add(time.Hour).Unix()}))
	h.ServeHTTP(httptest.NewRecorder(), req)
	if u := got.Get("Impersonate-User"); u != "oidc:alice" {
		t.Errorf("Impersonate-User with username prefix = %q", u)
	}
}

func TestGuardsRejectMissingOrExpiredSession(t *testing.T) {
	idp := newFakeIdP(t)
	a, _ := newTestAuth(t, idp)
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	expired := sessionCookieFor(t, a, Session{User: "alice", Exp: time.Now().Add(-time.Second).Unix()})
	valid := sessionCookieFor(t, a, Session{User: "alice", Exp: time.Now().Add(time.Hour).Unix()})

	for name, h := range map[string]http.Handler{"Require": a.Require(ok), "Impersonate": a.Impersonate(ok)} {
		rec := serve(h, "/v1/properties")
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s without cookie: %d", name, rec.Code)
		}
		// The UI only redirects to the login page for 401s carrying this marker,
		// not for 401s coming from the API server itself.
		if rec.Header().Get(LoginHeader) != "required" {
			t.Errorf("%s 401 without %s header", name, LoginHeader)
		}
		if rec := serve(h, "/v1/properties", expired); rec.Code != http.StatusUnauthorized {
			t.Errorf("%s with expired cookie: %d", name, rec.Code)
		}
		if rec := serve(h, "/v1/properties", valid); rec.Code != http.StatusTeapot {
			t.Errorf("%s with valid cookie: %d", name, rec.Code)
		}
	}
}
