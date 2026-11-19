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

// Package auth implements OIDC login for the Dashboard. Logged in users reach
// the Kubernetes API through impersonation, so their access is decided by the
// cluster's RBAC rather than by the Dashboard's own service account.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/tektoncd/dashboard/pkg/logging"
	"golang.org/x/oauth2"
)

// LoginHeader marks 401 responses that mean "log in to the Dashboard", as
// opposed to 401s passed through from the API server.
const LoginHeader = "Tekton-Login"

const (
	sessionTTL = 24 * time.Hour
	flowTTL    = 5 * time.Minute
	// Browsers cap a cookie at 4096 bytes including its name and attributes.
	maxCookieValue = 3800
)

// Config holds the OIDC settings.
type Config struct {
	Issuer             string
	Name               string // shown on the login button, e.g. "Gitea"
	ClientID           string
	ClientSecret       string
	RedirectURL        string
	UsernameClaim      string
	GroupsClaim        string
	UsernamePrefix     string // prepended to the username when impersonating, may be empty
	GroupsPrefix       string // prepended to every group when impersonating, required
	CAFile             string
	InsecureSkipVerify bool
	SessionKey         []byte
	LogoutRedirect     string // where /auth/logout goes after clearing the session, default /#/login
}

// Auth serves the /auth/ endpoints and guards the rest of the Dashboard.
type Auth struct {
	cfg      Config
	callback string // path of RedirectURL
	sealer   *sealer
	client   *http.Client
	provider *oidc.Provider
	verifier *oidc.IDTokenVerifier
	oauth2   oauth2.Config
	now      func() time.Time
}

type flow struct {
	State    string `json:"s"`
	Nonce    string `json:"n"`
	Verifier string `json:"v"`
	Return   string `json:"r"`
	Exp      int64  `json:"exp"`
}

// New validates cfg and discovers the issuer. Any missing setting is an error
// so a misconfigured Dashboard fails to start instead of running unprotected.
func New(ctx context.Context, cfg Config) (*Auth, error) {
	switch {
	case cfg.Issuer == "":
		return nil, errors.New("oidc issuer is required")
	case cfg.ClientID == "":
		return nil, errors.New("oidc client id is required")
	case cfg.ClientSecret == "":
		return nil, errors.New("oidc client secret is required")
	case cfg.RedirectURL == "":
		return nil, errors.New("oidc redirect url is required")
	case cfg.GroupsPrefix == "":
		// Without a prefix an IdP group named e.g. system:masters would map to a
		// privileged Kubernetes group.
		return nil, errors.New("oidc groups prefix must not be empty")
	}
	redirect, err := url.Parse(cfg.RedirectURL)
	if err != nil {
		return nil, fmt.Errorf("oidc redirect url: %w", err)
	}
	// The callback is served at this path, so keep it out of the UI, probe and
	// API routes. Reusing e.g. oauth2-proxy's /oauth2/callback is fine.
	switch p := redirect.Path; {
	case !strings.HasPrefix(p, "/auth/") && !strings.HasPrefix(p, "/oauth2/"),
		p == "/auth/login", p == "/auth/logout", p == "/auth/me":
		return nil, fmt.Errorf("oidc redirect url path %q must be under /auth/ or /oauth2/ and not an existing /auth/ endpoint", p)
	}
	// Session cookies are Secure; browsers only keep them over https (or localhost).
	if redirect.Scheme != "https" && !isLocalhost(redirect.Hostname()) {
		return nil, fmt.Errorf("oidc redirect url must use https, got %q", cfg.RedirectURL)
	}

	if cfg.UsernameClaim == "" {
		cfg.UsernameClaim = "preferred_username"
	}
	if cfg.GroupsClaim == "" {
		cfg.GroupsClaim = "groups"
	}
	if cfg.Name == "" {
		cfg.Name = "OIDC"
	}

	s, err := newSealer(cfg.SessionKey)
	if err != nil {
		return nil, err
	}
	client, err := httpClient(cfg)
	if err != nil {
		return nil, err
	}
	provider, err := oidc.NewProvider(oidc.ClientContext(ctx, client), cfg.Issuer)
	if err != nil {
		return nil, fmt.Errorf("oidc discovery for %s: %w", cfg.Issuer, err)
	}

	return &Auth{
		cfg:      cfg,
		callback: redirect.Path,
		sealer:   s,
		client:   client,
		provider: provider,
		verifier: provider.Verifier(&oidc.Config{ClientID: cfg.ClientID}),
		oauth2: oauth2.Config{
			ClientID:     cfg.ClientID,
			ClientSecret: cfg.ClientSecret,
			RedirectURL:  cfg.RedirectURL,
			Endpoint:     provider.Endpoint(),
			Scopes:       []string{oidc.ScopeOpenID, "profile", "email", "groups"},
		},
		now: time.Now,
	}, nil
}

func isLocalhost(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func unauthorized(w http.ResponseWriter) {
	w.Header().Set(LoginHeader, "required")
	http.Error(w, "Unauthorized", http.StatusUnauthorized)
}

func httpClient(cfg Config) (*http.Client, error) {
	tlsConfig := &tls.Config{InsecureSkipVerify: cfg.InsecureSkipVerify} //nolint:gosec // opt-in flag, mirrors ArgoCD's oidc.tls.insecure.skip.verify
	if cfg.CAFile != "" {
		pem, err := os.ReadFile(cfg.CAFile)
		if err != nil {
			return nil, err
		}
		pool, err := x509.SystemCertPool()
		if err != nil {
			pool = x509.NewCertPool()
		}
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("no certificates found in %s", cfg.CAFile)
		}
		tlsConfig.RootCAs = pool
	}
	return &http.Client{
		Timeout:   30 * time.Second,
		Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, TLSClientConfig: tlsConfig},
	}, nil
}

// Register adds the /auth/ endpoints to mux.
func (a *Auth) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /auth/login", a.login)
	mux.HandleFunc("GET "+a.callback, a.handleCallback)
	mux.HandleFunc("GET /auth/logout", a.logout)
	mux.HandleFunc("GET /auth/me", a.me)
}

// Require rejects requests without a valid session.
func (a *Auth) Require(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := a.session(r); !ok {
			unauthorized(w)
			return
		}
		h.ServeHTTP(w, r)
	})
}

// Impersonate rejects requests without a valid session and otherwise replaces
// any client-supplied identity with the session user and groups.
func (a *Auth) Impersonate(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s, ok := a.session(r)
		if !ok {
			unauthorized(w)
			return
		}
		StripIdentityHeaders(r.Header)
		r.Header.Del("Cookie") // the API server has no use for the session cookie
		r.Header.Set("Impersonate-User", a.cfg.UsernamePrefix+s.User)
		for _, g := range s.Groups {
			r.Header.Add("Impersonate-Group", a.cfg.GroupsPrefix+g)
		}
		h.ServeHTTP(w, r)
	})
}

func (a *Auth) session(r *http.Request) (Session, bool) {
	var s Session
	c, err := r.Cookie(sessionCookie)
	if err != nil || a.sealer.open(sessionCookie, c.Value, &s) != nil {
		return Session{}, false
	}
	if s.User == "" || a.now().Unix() >= s.Exp {
		return Session{}, false
	}
	return s, true
}

func (a *Auth) login(w http.ResponseWriter, r *http.Request) {
	f := flow{
		State:    rand.Text(),
		Nonce:    rand.Text(),
		Verifier: oauth2.GenerateVerifier(),
		Return:   safeReturn(r.URL.Query().Get("return")),
		Exp:      a.now().Add(flowTTL).Unix(),
	}
	v, err := a.sealer.seal(flowCookie, f)
	if err != nil {
		logging.Log.Errorf("auth: sealing login state: %v", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}
	setCookie(w, flowCookie, v, flowTTL)
	http.Redirect(w, r, a.oauth2.AuthCodeURL(f.State, oidc.Nonce(f.Nonce), oauth2.S256ChallengeOption(f.Verifier)), http.StatusFound)
}

func (a *Auth) handleCallback(w http.ResponseWriter, r *http.Request) {
	fail := func(code string, err error) {
		logging.Log.Warnf("auth: login failed (%s): %v", code, err)
		setCookie(w, flowCookie, "", -1)
		http.Redirect(w, r, "/#/login?error="+url.QueryEscape(code), http.StatusFound)
	}

	var f flow
	c, err := r.Cookie(flowCookie)
	if err == nil {
		err = a.sealer.open(flowCookie, c.Value, &f)
	}
	q := r.URL.Query()
	switch {
	case err != nil:
		fail("invalid_state", err)
		return
	case a.now().Unix() >= f.Exp || q.Get("state") != f.State:
		fail("invalid_state", errors.New("state expired or mismatched"))
		return
	case q.Get("error") != "":
		fail("idp_error", fmt.Errorf("%s: %s", q.Get("error"), q.Get("error_description")))
		return
	}

	ctx := oidc.ClientContext(r.Context(), a.client)
	tok, err := a.oauth2.Exchange(ctx, q.Get("code"), oauth2.VerifierOption(f.Verifier))
	if err != nil {
		fail("exchange_failed", err)
		return
	}
	rawIDToken, _ := tok.Extra("id_token").(string)
	if rawIDToken == "" {
		fail("invalid_token", errors.New("no id_token in token response"))
		return
	}
	idToken, err := a.verifier.Verify(ctx, rawIDToken)
	if err != nil {
		fail("invalid_token", err)
		return
	}
	if idToken.Nonce != f.Nonce {
		fail("invalid_token", errors.New("nonce mismatch"))
		return
	}

	var claims map[string]any
	if err := idToken.Claims(&claims); err != nil {
		fail("invalid_token", err)
		return
	}
	user, _ := claims[a.cfg.UsernameClaim].(string)
	if user == "" {
		fail("no_username", fmt.Errorf("claim %q missing", a.cfg.UsernameClaim))
		return
	}
	if strings.Contains(user, ":") {
		// Keeps users out of the reserved system: namespace even without a username prefix
		fail("invalid_username", fmt.Errorf("username %q contains ':'", user))
		return
	}
	groups, found := stringSlice(claims[a.cfg.GroupsClaim])
	if !found {
		// Same fallback as ArgoCD's enableUserInfoGroups.
		groups, err = a.userInfoGroups(ctx, tok)
		if err != nil {
			fail("userinfo_failed", err)
			return
		}
	}

	v, err := a.sealer.seal(sessionCookie, Session{User: user, Groups: groups, Exp: a.now().Add(sessionTTL).Unix()})
	if err != nil {
		fail("internal_error", err)
		return
	}
	if len(v) > maxCookieValue {
		fail("session_too_large", fmt.Errorf("%d groups do not fit in a cookie", len(groups)))
		return
	}
	setCookie(w, flowCookie, "", -1)
	setCookie(w, sessionCookie, v, sessionTTL)
	logging.Log.Infof("auth: %s logged in with groups %v", user, groups)
	http.Redirect(w, r, f.Return, http.StatusFound)
}

func (a *Auth) userInfoGroups(ctx context.Context, tok *oauth2.Token) ([]string, error) {
	info, err := a.provider.UserInfo(ctx, oauth2.StaticTokenSource(tok))
	if err != nil {
		return nil, err
	}
	var claims map[string]any
	if err := info.Claims(&claims); err != nil {
		return nil, err
	}
	groups, _ := stringSlice(claims[a.cfg.GroupsClaim])
	return groups, nil
}

func (a *Auth) logout(w http.ResponseWriter, r *http.Request) {
	setCookie(w, sessionCookie, "", -1)
	target := a.cfg.LogoutRedirect
	if target == "" {
		target = "/#/login"
	}
	http.Redirect(w, r, target, http.StatusFound)
}

func (a *Auth) me(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	s, ok := a.session(r)
	if !ok {
		// The login page reads the provider name from here, before any session exists.
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]string{"oidcName": a.cfg.Name})
		return
	}
	groups := s.Groups
	if groups == nil {
		groups = []string{}
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"user": s.User, "groups": groups})
}

func setCookie(w http.ResponseWriter, name, value string, maxAge time.Duration) {
	seconds := int(maxAge.Seconds())
	if maxAge < 0 {
		seconds = -1
	}
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		MaxAge:   seconds,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
	})
}

// stringSlice converts a JSON array claim to []string. found is false when the
// claim is absent so the caller can fall back to the userinfo endpoint.
func stringSlice(v any) (out []string, found bool) {
	switch t := v.(type) {
	case []any:
		for _, item := range t {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
		return out, true
	case string:
		return []string{t}, true
	}
	return nil, false
}
