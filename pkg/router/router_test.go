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

package router

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tektoncd/dashboard/pkg/auth"
	"github.com/tektoncd/dashboard/pkg/endpoints"
	"github.com/tektoncd/dashboard/pkg/logging"
	"k8s.io/client-go/rest"
)

// Without OIDC the service account still may hold the impersonate permission,
// so client-supplied impersonation headers must never reach the API server.
func TestProxyStripsClientIdentityWithoutAuth(t *testing.T) {
	logging.InitLogger("error", "console")
	var got http.Header
	apiServer := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
	}))
	defer apiServer.Close()

	server, err := Register(endpoints.Resource{}, &rest.Config{Host: apiServer.URL}, nil)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/apis/tekton.dev/v1/pipelineruns", nil)
	req.Header.Set("Impersonate-User", "kubernetes-admin")
	req.Header.Set("Impersonate-Group", "system:masters")
	server.handler.ServeHTTP(httptest.NewRecorder(), req)

	if got == nil {
		t.Fatal("request was not proxied")
	}
	if got.Get("Impersonate-User") != "" || got.Get("Impersonate-Group") != "" {
		t.Fatalf("impersonation headers reached the API server: %v", got)
	}
}

func TestProtectedRoutesRequireLogin(t *testing.T) {
	logging.InitLogger("error", "console")
	var issuer string
	idp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"issuer":                 issuer,
			"authorization_endpoint": issuer + "/authorize",
			"token_endpoint":         issuer + "/token",
			"jwks_uri":               issuer + "/keys",
		})
	}))
	defer idp.Close()
	issuer = idp.URL

	apiCalled := false
	apiServer := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { apiCalled = true }))
	defer apiServer.Close()

	a, err := auth.New(context.Background(), auth.Config{
		Issuer: issuer, ClientID: "c", ClientSecret: "s", RedirectURL: "https://d/auth/callback",
		Prefix: "gitea:", SessionKey: bytes.Repeat([]byte{1}, 32),
	})
	if err != nil {
		t.Fatal(err)
	}
	r := endpoints.Resource{Options: endpoints.Options{ExternalLogsURL: "http://logs"}}
	server, err := Register(r, &rest.Config{Host: apiServer.URL}, a)
	if err != nil {
		t.Fatal(err)
	}

	for path, want := range map[string]int{
		"/api/v1/namespaces":            http.StatusUnauthorized,
		"/apis/tekton.dev/v1/pipelines": http.StatusUnauthorized,
		"/v1/properties":                http.StatusUnauthorized,
		"/v1/logs-proxy/ns/pod/step":    http.StatusUnauthorized,
		"/auth/me":                      http.StatusUnauthorized,
		"/auth/login":                   http.StatusFound,
		"/health":                       http.StatusOK,
	} {
		rec := httptest.NewRecorder()
		server.handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != want {
			t.Errorf("GET %s = %d, want %d", path, rec.Code, want)
		}
	}
	if apiCalled {
		t.Error("an unauthenticated request reached the API server")
	}
}
