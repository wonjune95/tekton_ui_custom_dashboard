/*
Copyright 2019-2024 The Tekton Authors
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

package main

import (
	"context"
	"encoding/base64"
	"flag"
	"os"
	"strings"

	"github.com/tektoncd/dashboard/pkg/auth"
	"github.com/tektoncd/dashboard/pkg/endpoints"
	"github.com/tektoncd/dashboard/pkg/logging"
	"github.com/tektoncd/dashboard/pkg/router"
	k8sclientset "k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

var (
	pipelinesNamespace = flag.String("pipelines-namespace", "", "Namespace where Tekton pipelines is installed (assumes same namespace as dashboard if not specified)")
	triggersNamespace  = flag.String("triggers-namespace", "", "Namespace where Tekton triggers is installed (assumes same namespace as dashboard if not specified)")
	portNumber         = flag.Int("port", 8080, "Dashboard port number")
	readOnly           = flag.Bool("read-only", true, "Enable or disable read-only mode")
	logoutURL          = flag.String("logout-url", "", "If set, enables logout on the frontend and binds the logout button to this URL")
	defaultNamespace   = flag.String("default-namespace", "", "If set, configures the default selected namespace to the provided namespace instead of 'All Namespaces'")
	tenantNamespaces   = flag.String("namespaces", "", "If set, limits the scope of resources displayed to this comma-separated list of namespaces only")
	logLevel           = flag.String("log-level", "info", "Minimum log level output by the logger")
	logFormat          = flag.String("log-format", "json", "Format for log output (json or console)")
	streamLogs         = flag.Bool("stream-logs", true, "Enable log streaming instead of polling")
	externalLogs       = flag.String("external-logs", "", "External logs provider URL")
	xFrameOptions      = flag.String("x-frame-options", "DENY", "Value for the X-Frame-Options response header, set '' to omit it")

	oidcIssuer        = flag.String("oidc-issuer", "", "OIDC issuer URL. If set, enables login and Kubernetes impersonation of the logged in user. Requires the OIDC_CLIENT_SECRET and SESSION_KEY environment variables")
	oidcName          = flag.String("oidc-name", "Gitea", "Provider name shown on the login button")
	oidcClientID      = flag.String("oidc-client-id", "", "OIDC client ID")
	oidcRedirectURL   = flag.String("oidc-redirect-url", "", "OIDC redirect URL, e.g. https://dashboard.example.com/auth/callback")
	oidcUsernameClaim = flag.String("oidc-username-claim", "preferred_username", "ID token claim used as the username")
	oidcGroupsClaim   = flag.String("oidc-groups-claim", "groups", "ID token or userinfo claim used as the groups")
	oidcPrefix        = flag.String("oidc-prefix", "gitea:", "Prefix added to the username and every group when impersonating. Must not be empty")
	oidcCAFile        = flag.String("oidc-ca-file", "", "PEM file with CA certificates trusted for the OIDC issuer")
	oidcInsecure      = flag.Bool("oidc-insecure-skip-verify", false, "Skip TLS verification of the OIDC issuer (not recommended)")
)

func main() {
	flag.Parse()
	installNamespace := os.Getenv("INSTALLED_NAMESPACE")
	logging.InitLogger(*logLevel, *logFormat)

	var cfg *rest.Config
	var err error
	if cfg, err = rest.InClusterConfig(); err != nil {
		logging.Log.Errorf("Error building kubeconfig: %s", err.Error())
	}

	k8sClient, err := k8sclientset.NewForConfig(cfg)
	if err != nil {
		logging.Log.Errorf("Error building k8s clientset: %s", err.Error())
	}

	// use FieldsFunc instead of Split as Split returns an array containing an empty string
	// instead of the desired empty array when there is no delimeter (i.e. empty string or single namespace)
	splitByComma := func(c rune) bool {
		return c == ','
	}
	tenants := strings.FieldsFunc(*tenantNamespaces, splitByComma)

	options := endpoints.Options{
		InstallNamespace:   installNamespace,
		PipelinesNamespace: *pipelinesNamespace,
		TriggersNamespace:  *triggersNamespace,
		TenantNamespaces:   tenants,
		DefaultNamespace:   *defaultNamespace,
		ReadOnly:           *readOnly,
		LogoutURL:          *logoutURL,
		StreamLogs:         *streamLogs,
		ExternalLogsURL:    *externalLogs,
		XFrameOptions:      *xFrameOptions,
	}

	var authenticator *auth.Auth
	if *oidcIssuer != "" {
		sessionKey, err := base64.StdEncoding.DecodeString(os.Getenv("SESSION_KEY"))
		if err != nil {
			logging.Log.Fatalf("SESSION_KEY must be base64 encoded: %s", err.Error())
		}
		authenticator, err = auth.New(context.Background(), auth.Config{
			Issuer:             *oidcIssuer,
			Name:               *oidcName,
			ClientID:           *oidcClientID,
			ClientSecret:       os.Getenv("OIDC_CLIENT_SECRET"),
			RedirectURL:        *oidcRedirectURL,
			UsernameClaim:      *oidcUsernameClaim,
			GroupsClaim:        *oidcGroupsClaim,
			Prefix:             *oidcPrefix,
			CAFile:             *oidcCAFile,
			InsecureSkipVerify: *oidcInsecure,
			SessionKey:         sessionKey,
		})
		if err != nil {
			logging.Log.Fatalf("Error configuring OIDC login: %s", err.Error())
		}
		options.LogoutURL = "/auth/logout"
	}

	resource := endpoints.Resource{
		Config:    cfg,
		K8sClient: k8sClient,
		Options:   options,
	}

	server, err := router.Register(resource, cfg, authenticator)

	if err != nil {
		logging.Log.Errorf("Error creating proxy: %s", err.Error())
		return
	}

	l, err := server.Listen("", *portNumber)
	if err != nil {
		logging.Log.Errorf("Error listening: %s", err.Error())
		return
	}

	logging.Log.Infof("Tekton Dashboard version %s", resource.GetDashboardVersion())
	logging.Log.Infof("Starting to serve on %s", l.Addr().String())
	logging.Log.Fatal(server.ServeOnListener(l))
}
