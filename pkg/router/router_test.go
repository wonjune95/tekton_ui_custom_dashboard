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
	"net/http"
	"net/http/httptest"
	"testing"

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
