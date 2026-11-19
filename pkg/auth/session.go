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
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

const (
	sessionCookie = "tkn-session"
	flowCookie    = "tkn-auth-flow"
)

// Session is the identity carried in the encrypted session cookie.
type Session struct {
	User   string   `json:"u"`
	Groups []string `json:"g,omitempty"`
	Exp    int64    `json:"exp"`
}

// sealer encrypts cookie values with AES-256-GCM. The cookie name is bound as
// additional data so a value sealed for one cookie can't be replayed as another.
type sealer struct{ aead cipher.AEAD }

func newSealer(key []byte) (*sealer, error) {
	if len(key) != 32 {
		return nil, errors.New("session key must be 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &sealer{aead}, nil
}

func (s *sealer) seal(name string, v any) (string, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, s.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(s.aead.Seal(nonce, nonce, b, []byte(name))), nil
}

func (s *sealer) open(name, value string, v any) error {
	b, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return err
	}
	n := s.aead.NonceSize()
	if len(b) < n {
		return errors.New("cookie value too short")
	}
	plain, err := s.aead.Open(nil, b[:n], b[n:], []byte(name))
	if err != nil {
		return err
	}
	return json.Unmarshal(plain, v)
}

// safeReturn only allows same-origin absolute paths, preventing open redirects.
// Browsers drop tab/newline and treat \ as / while parsing URLs, so
// "/\t/evil" or "/\\evil" would become "//evil": reject control characters,
// spaces and backslashes anywhere.
func safeReturn(p string) string {
	if !strings.HasPrefix(p, "/") || strings.HasPrefix(p, "//") {
		return "/"
	}
	for _, c := range p {
		if c <= ' ' || c == 0x7f || c == '\\' {
			return "/"
		}
	}
	return p
}

// StripIdentityHeaders removes any credentials or impersonation headers the
// client sent, so the only identity reaching the API server is the one we set.
func StripIdentityHeaders(h http.Header) {
	h.Del("Authorization")
	for k := range h {
		if strings.HasPrefix(http.CanonicalHeaderKey(k), "Impersonate-") {
			delete(h, k)
		}
	}
}

// StripIdentity is used when OIDC login is off. Requests carrying their own
// Authorization (upstream's auth-proxy mode) pass untouched: the API server
// checks any impersonation against those credentials. Without Authorization
// the Dashboard's service account token is used, so Impersonate-* headers are
// dropped in case that service account holds the impersonate permission.
func StripIdentity(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			StripIdentityHeaders(r.Header)
		}
		h.ServeHTTP(w, r)
	})
}
